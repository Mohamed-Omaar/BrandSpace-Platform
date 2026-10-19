import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuthRateLimiter, isRateLimited } from '@brandspace/auth';
import {
  withAiAppToken,
  withWorkspace,
  writeAuditEvent,
  type TenantScopedClient,
} from '@brandspace/database';
import { createLogger, internalErrorFields, requestContext } from '@brandspace/shared';
import { route } from '../route-contract';
import { aiAppsContext, aiAppsRefusal, aiAppsSettings, type AiAppsContext } from './context';
import {
  authorizationServerMetadata,
  isAcceptableRedirectUri,
  looksLike,
  newSecret,
  pkceS256Matches,
  protectedResourceMetadata,
  resourceUrl,
  scopeString,
  sha256Hex,
} from './oauth-core';

const log = createLogger({ context: { component: 'api.ai-apps.oauth' } });

/**
 * D-566 — THE AUTHORIZATION SERVER'S PUBLIC ENDPOINTS.
 *
 *   GET  /.well-known/oauth-protected-resource[/mcp]  RFC 9728
 *   GET  /.well-known/oauth-authorization-server      RFC 8414
 *   POST /oauth/register                              RFC 7591 (public clients only)
 *   POST /oauth/token                                 RFC 6749 + PKCE (RFC 7636) + RFC 8707
 *   POST /oauth/revoke                                RFC 7009
 *
 * The authorization endpoint itself is on the DASHBOARD (`/oauth/authorize`),
 * because the customer's sign-in cookie lives there; it reaches this API's
 * consent routes (`consent-routes.ts`) with that session.
 *
 * NOTHING HERE EVER LOGS OR RETURNS A TOKEN, A CODE OR A VERIFIER beyond the one
 * response that issues a token. Errors are RFC 6749 §5.2 codes with a fixed
 * description; none echoes the request.
 */

function oauthError(
  reply: FastifyReply,
  status: number,
  error: string,
  description: string,
): FastifyReply {
  return reply
    .code(status)
    .header('cache-control', 'no-store')
    .header('pragma', 'no-cache')
    .send({ error, error_description: description });
}

function sourceOf(req: FastifyRequest) {
  return requestContext({ headers: req.headers, socketAddress: req.ip });
}

async function limitOrRefuse(
  ctx: AiAppsContext,
  req: FastifyRequest,
  reply: FastifyReply,
  scope: 'ai-apps-register:ip' | 'ai-apps-token:ip',
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  try {
    await new AuthRateLimiter({ prisma: ctx.tenant, clock: ctx.clock }).enforce(
      scope,
      sourceOf(req).ip,
      limit,
      windowSeconds,
    );
    return true;
  } catch (error: unknown) {
    if (isRateLimited(error)) {
      reply.header('retry-after', String(error.retryAfterSeconds));
      oauthError(reply, 429, 'slow_down', 'Too many requests. Try again in a minute.');
      return false;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

function metadataRoutes(app: FastifyInstance): void {
  const serve =
    (build: (ctx: AiAppsContext) => unknown) =>
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const addresses = aiAppsContext().addresses();
      if (!addresses) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
      return (
        reply
          .header('cache-control', 'public, max-age=300')
          // Public documents with nothing in them a browser client should not read.
          .header('access-control-allow-origin', '*')
          .send(build(aiAppsContext()))
      );
    };
  const resource = serve((ctx) => protectedResourceMetadata(ctx.addresses()!));
  const server = serve((ctx) => authorizationServerMetadata(ctx.addresses()!));

  route(app, 'GET', '/.well-known/oauth-protected-resource', { scope: 'public' }, resource);
  route(app, 'GET', '/.well-known/oauth-protected-resource/mcp', { scope: 'public' }, resource);
  route(app, 'GET', '/.well-known/oauth-authorization-server', { scope: 'public' }, server);
}

// ---------------------------------------------------------------------------
// RFC 7591 — dynamic client registration
// ---------------------------------------------------------------------------

const registration = z.object({
  client_name: z.string().trim().min(1).optional(),
  redirect_uris: z.array(z.string()).min(1).max(10),
  grant_types: z.array(z.string()).max(10).optional(),
  response_types: z.array(z.string()).max(10).optional(),
  token_endpoint_auth_method: z.string().max(60).optional(),
  software_id: z.string().max(200).optional(),
  software_version: z.string().max(100).optional(),
  client_uri: z.string().max(500).optional(),
  logo_uri: z.string().max(500).optional(),
});

function httpsOrNull(value: string | undefined): string | null {
  if (!value || !/^https:\/\//.test(value)) return null;
  try {
    return new URL(value).toString().slice(0, 500);
  } catch {
    return null;
  }
}

function registerRoute(app: FastifyInstance): void {
  route(
    app,
    'POST',
    '/oauth/register',
    { scope: 'public', rateLimit: 'ai-apps.oauth.registrationPerIpPerHour' },
    async (req, reply) => {
      const ctx = aiAppsContext();
      const settings = await aiAppsSettings(ctx);
      if (
        !(await limitOrRefuse(
          ctx,
          req,
          reply,
          'ai-apps-register:ip',
          settings.oauth.registrationPerIpPerHour,
          3_600,
        ))
      ) {
        return reply;
      }
      const parsed = registration.safeParse(req.body);
      if (!parsed.success) {
        return oauthError(reply, 400, 'invalid_client_metadata', 'The registration is not valid.');
      }
      const body = parsed.data;
      if (!body.redirect_uris.every(isAcceptableRedirectUri)) {
        return oauthError(
          reply,
          400,
          'invalid_redirect_uri',
          'Every redirect URI must be https, or http to localhost.',
        );
      }
      const grants = body.grant_types ?? ['authorization_code', 'refresh_token'];
      if (!grants.every((grant) => grant === 'authorization_code' || grant === 'refresh_token')) {
        return oauthError(
          reply,
          400,
          'invalid_client_metadata',
          'Only the authorization code flow is supported.',
        );
      }
      if (body.response_types && !body.response_types.every((type) => type === 'code')) {
        return oauthError(
          reply,
          400,
          'invalid_client_metadata',
          'Only the authorization code flow is supported.',
        );
      }

      const clientId = newSecret('client');
      const name = (body.client_name ?? 'AI app').slice(0, 100);
      const created = await ctx.platform.aiAppClient.create({
        data: {
          clientId,
          clientName: name,
          redirectUris: [...new Set(body.redirect_uris)],
          softwareId: body.software_id ?? null,
          softwareVersion: body.software_version ?? null,
          clientUri: httpsOrNull(body.client_uri),
          logoUri: httpsOrNull(body.logo_uri),
        },
      });
      // A registration belongs to no workspace: a platform-level audit row,
      // naming the app and where it sends people back — never the client id.
      await ctx.platform.auditEvent.create({
        data: {
          workspaceId: null,
          actorType: 'SYSTEM',
          action: 'ai_app.client.registered',
          resourceType: 'ai_app_client',
          resourceId: created.id,
          after: {
            clientName: name,
            redirectHosts: [...new Set(body.redirect_uris.map((uri) => new URL(uri).host))],
          },
          ip: sourceOf(req).ip ?? null,
          userAgent: sourceOf(req).userAgent ?? null,
        },
      });
      return reply
        .code(201)
        .header('cache-control', 'no-store')
        .send({
          client_id: clientId,
          client_id_issued_at: Math.floor(created.createdAt.getTime() / 1000),
          client_name: name,
          redirect_uris: created.redirectUris,
          grant_types: grants,
          response_types: ['code'],
          // Public client: PKCE is its proof, and it gets no secret (RFC 7591 §2).
          token_endpoint_auth_method: 'none',
        });
    },
  );
}

// ---------------------------------------------------------------------------
// The token endpoint
// ---------------------------------------------------------------------------

interface IssuedTokens {
  readonly access: string;
  readonly refresh: string | null;
  readonly expiresIn: number;
  readonly scopes: readonly string[];
}

async function issueTokens(
  db: TenantScopedClient,
  ctx: AiAppsContext,
  connection: { readonly id: string; readonly workspaceId: string },
  scopes: readonly string[],
  resource: string,
  ttl: { readonly accessSeconds: number; readonly refreshDays: number },
): Promise<IssuedTokens & { readonly refreshId: string | null }> {
  const now = ctx.clock.now();
  const access = newSecret('access');
  await db.aiAppToken.create({
    data: {
      workspaceId: connection.workspaceId,
      connectionId: connection.id,
      kind: 'ACCESS',
      tokenHash: sha256Hex(access),
      resource,
      scopes: [...scopes],
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttl.accessSeconds * 1000),
    },
  });
  let refresh: string | null = null;
  let refreshId: string | null = null;
  if (scopes.includes('offline_access')) {
    refresh = newSecret('refresh');
    const row = await db.aiAppToken.create({
      data: {
        workspaceId: connection.workspaceId,
        connectionId: connection.id,
        kind: 'REFRESH',
        tokenHash: sha256Hex(refresh),
        resource,
        scopes: [...scopes],
        createdAt: now,
        expiresAt: new Date(now.getTime() + ttl.refreshDays * 86_400_000),
      },
      select: { id: true },
    });
    refreshId = row.id;
  }
  return { access, refresh, refreshId, expiresIn: ttl.accessSeconds, scopes };
}

/**
 * Revoke a whole connection: every token at once. Used for a revoked grant, a
 * refresh token presented again after rotation, and an authorization code
 * presented twice (RFC 6749 §4.1.2, OAuth 2.1 §4.3.1).
 */
export async function revokeConnection(
  db: TenantScopedClient,
  ctx: AiAppsContext,
  connectionId: string,
  reason: string,
  byUserId: string | null,
): Promise<boolean> {
  const now = ctx.clock.now();
  const changed = await db.aiAppConnection.updateMany({
    where: { id: connectionId, status: 'ACTIVE' },
    data: { status: 'REVOKED', revokedAt: now, revokedReason: reason, revokedByUserId: byUserId },
  });
  await db.aiAppToken.updateMany({
    where: { connectionId, revokedAt: null },
    data: { revokedAt: now },
  });
  return changed.count > 0;
}

const tokenRequest = z.object({
  grant_type: z.string().max(60),
  code: z.string().max(200).optional(),
  redirect_uri: z.string().max(500).optional(),
  client_id: z.string().max(120).optional(),
  code_verifier: z.string().max(200).optional(),
  refresh_token: z.string().max(200).optional(),
  resource: z.string().max(500).optional(),
  scope: z.string().max(200).optional(),
});

function tokenRoute(app: FastifyInstance): void {
  route(
    app,
    'POST',
    '/oauth/token',
    { scope: 'public', rateLimit: 'ai-apps.oauth.tokenPerIpPerMinute', idempotent: false },
    async (req, reply) => {
      const ctx = aiAppsContext();
      const settings = await aiAppsSettings(ctx);
      if (
        !(await limitOrRefuse(
          ctx,
          req,
          reply,
          'ai-apps-token:ip',
          settings.oauth.tokenPerIpPerMinute,
          60,
        ))
      ) {
        return reply;
      }
      const addresses = ctx.addresses();
      const parsed = tokenRequest.safeParse(req.body);
      if (!addresses || !parsed.success) {
        return oauthError(reply, 400, 'invalid_request', 'The token request is not valid.');
      }
      const body = parsed.data;
      const expectedResource = resourceUrl(addresses);
      if (body.resource !== undefined && body.resource !== expectedResource) {
        return oauthError(
          reply,
          400,
          'invalid_target',
          'This token is only for the Brandspace MCP server.',
        );
      }
      const ttl = {
        accessSeconds: settings.oauth.accessTokenTtlSeconds,
        refreshDays: settings.oauth.refreshTokenTtlDays,
      };
      try {
        if (body.grant_type === 'authorization_code') {
          return await exchangeCode(ctx, reply, body, expectedResource, ttl, settings);
        }
        if (body.grant_type === 'refresh_token') {
          return await refreshTokens(ctx, reply, body, expectedResource, ttl, settings);
        }
        return oauthError(
          reply,
          400,
          'unsupported_grant_type',
          'Use authorization_code or refresh_token.',
        );
      } catch (error: unknown) {
        log.error('the token endpoint failed', internalErrorFields(error));
        return oauthError(reply, 500, 'server_error', 'Something went wrong. Try again.');
      }
    },
  );
}

type TokenBody = z.infer<typeof tokenRequest>;
const INVALID_GRANT = 'The code or token is not valid any more. Connect Brandspace again.';

async function exchangeCode(
  ctx: AiAppsContext,
  reply: FastifyReply,
  body: TokenBody,
  resource: string,
  ttl: { accessSeconds: number; refreshDays: number },
  settings: Awaited<ReturnType<typeof aiAppsSettings>>,
): Promise<FastifyReply> {
  if (!looksLike('code', body.code) || !looksLike('client', body.client_id) || !body.redirect_uri) {
    return oauthError(reply, 400, 'invalid_request', 'The token request is not valid.');
  }
  const found = await withAiAppToken(
    sha256Hex(body.code),
    (db) =>
      db.aiAppAuthorizationCode.findFirst({
        select: { id: true, workspaceId: true, connectionId: true },
      }),
    { prisma: ctx.tenant },
  );
  if (!found) return oauthError(reply, 400, 'invalid_grant', INVALID_GRANT);

  const outcome = await withWorkspace(
    found.workspaceId,
    async (db) => {
      const now = ctx.clock.now();
      const code = await db.aiAppAuthorizationCode.findUnique({
        where: { id: found.id },
        include: { connection: { include: { client: true } } },
      });
      if (!code) return { kind: 'invalid' as const };
      if (code.connection.client.clientId !== body.client_id) return { kind: 'invalid' as const };
      if (code.consumedAt) {
        // A code presented twice: something has a copy. Kill the grant.
        await revokeConnection(db, ctx, code.connectionId, 'code.reused', null);
        await writeAuditEvent(db, code.workspaceId, {
          action: 'ai_app.connection.revoked',
          actorType: 'SYSTEM',
          resourceType: 'ai_app_connection',
          resourceId: code.connectionId,
          severity: 'WARNING',
          reason: 'An authorization code was presented twice.',
          after: { reason: 'code.reused' },
        });
        return { kind: 'invalid' as const };
      }
      const claimed = await db.aiAppAuthorizationCode.updateMany({
        where: { id: code.id, consumedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now },
      });
      if (claimed.count !== 1) return { kind: 'invalid' as const };
      if (
        code.redirectUri !== body.redirect_uri ||
        code.resource !== resource ||
        !pkceS256Matches(body.code_verifier, code.codeChallenge) ||
        code.connection.status !== 'ACTIVE' ||
        code.connection.client.disabledAt !== null
      ) {
        return { kind: 'invalid' as const };
      }
      if (await aiAppsRefusal(db, code.workspaceId, settings, ctx)) {
        return { kind: 'unavailable' as const };
      }
      const tokens = await issueTokens(db, ctx, code.connection, code.scopes, resource, ttl);
      await writeAuditEvent(db, code.workspaceId, {
        action: 'ai_app.token.issued',
        actorType: 'USER',
        actorId: code.connection.userId,
        resourceType: 'ai_app_connection',
        resourceId: code.connectionId,
        after: {
          app: code.connection.client.clientName,
          grant: 'authorization_code',
          refreshIssued: tokens.refresh !== null,
        },
      });
      return { kind: 'ok' as const, tokens };
    },
    { prisma: ctx.tenant },
  );
  return tokenResponse(reply, outcome);
}

async function refreshTokens(
  ctx: AiAppsContext,
  reply: FastifyReply,
  body: TokenBody,
  resource: string,
  ttl: { accessSeconds: number; refreshDays: number },
  settings: Awaited<ReturnType<typeof aiAppsSettings>>,
): Promise<FastifyReply> {
  if (!looksLike('refresh', body.refresh_token) || !looksLike('client', body.client_id)) {
    return oauthError(reply, 400, 'invalid_request', 'The token request is not valid.');
  }
  const found = await withAiAppToken(
    sha256Hex(body.refresh_token),
    (db) =>
      db.aiAppToken.findFirst({
        where: { kind: 'REFRESH' },
        select: { id: true, workspaceId: true },
      }),
    { prisma: ctx.tenant },
  );
  if (!found) return oauthError(reply, 400, 'invalid_grant', INVALID_GRANT);

  const outcome = await withWorkspace(
    found.workspaceId,
    async (db) => {
      const now = ctx.clock.now();
      const old = await db.aiAppToken.findUnique({
        where: { id: found.id },
        include: { connection: { include: { client: true } } },
      });
      if (!old || old.connection.client.clientId !== body.client_id) {
        return { kind: 'invalid' as const };
      }
      if (old.revokedAt !== null || old.replacedById !== null) {
        // A rotated refresh token presented again (OAuth 2.1 §4.3.1): either the
        // app or an attacker holds a stale copy. Revoke the whole connection.
        if (await revokeConnection(db, ctx, old.connectionId, 'refresh.reused', null)) {
          await writeAuditEvent(db, old.workspaceId, {
            action: 'ai_app.connection.revoked',
            actorType: 'SYSTEM',
            resourceType: 'ai_app_connection',
            resourceId: old.connectionId,
            severity: 'WARNING',
            reason: 'A refresh token was presented again after it had been replaced.',
            after: { reason: 'refresh.reused', app: old.connection.client.clientName },
          });
        }
        return { kind: 'invalid' as const };
      }
      if (
        old.expiresAt <= now ||
        old.resource !== resource ||
        old.connection.status !== 'ACTIVE' ||
        old.connection.client.disabledAt !== null
      ) {
        return { kind: 'invalid' as const };
      }
      if (await aiAppsRefusal(db, old.workspaceId, settings, ctx)) {
        return { kind: 'unavailable' as const };
      }
      const tokens = await issueTokens(db, ctx, old.connection, old.scopes, resource, ttl);
      // Rotation is a single conditional write: two concurrent refreshes with
      // the same token cannot both succeed; the loser's new tokens roll back.
      const rotated = await db.aiAppToken.updateMany({
        where: { id: old.id, revokedAt: null, replacedById: null },
        data: { revokedAt: now, replacedById: tokens.refreshId },
      });
      if (rotated.count !== 1) throw new RotationLostError();
      await writeAuditEvent(db, old.workspaceId, {
        action: 'ai_app.token.issued',
        actorType: 'USER',
        actorId: old.connection.userId,
        resourceType: 'ai_app_connection',
        resourceId: old.connectionId,
        after: { app: old.connection.client.clientName, grant: 'refresh_token' },
      });
      return { kind: 'ok' as const, tokens };
    },
    { prisma: ctx.tenant },
  ).catch((error: unknown) => {
    if (error instanceof RotationLostError) return { kind: 'invalid' as const };
    throw error;
  });
  return tokenResponse(reply, outcome);
}

class RotationLostError extends Error {}

function tokenResponse(
  reply: FastifyReply,
  outcome:
    | { readonly kind: 'invalid' }
    | { readonly kind: 'unavailable' }
    | { readonly kind: 'ok'; readonly tokens: IssuedTokens },
): FastifyReply {
  if (outcome.kind === 'invalid') return oauthError(reply, 400, 'invalid_grant', INVALID_GRANT);
  if (outcome.kind === 'unavailable') {
    return oauthError(reply, 400, 'invalid_grant', 'AI apps are turned off for this workspace.');
  }
  const { tokens } = outcome;
  return reply
    .header('cache-control', 'no-store')
    .header('pragma', 'no-cache')
    .send({
      access_token: tokens.access,
      token_type: 'Bearer',
      expires_in: tokens.expiresIn,
      scope: scopeString(tokens.scopes),
      ...(tokens.refresh ? { refresh_token: tokens.refresh } : {}),
    });
}

// ---------------------------------------------------------------------------
// RFC 7009 — revocation
// ---------------------------------------------------------------------------

function revokeRoute(app: FastifyInstance): void {
  route(
    app,
    'POST',
    '/oauth/revoke',
    { scope: 'public', rateLimit: 'ai-apps.oauth.tokenPerIpPerMinute' },
    async (req, reply) => {
      const ctx = aiAppsContext();
      const settings = await aiAppsSettings(ctx);
      if (
        !(await limitOrRefuse(
          ctx,
          req,
          reply,
          'ai-apps-token:ip',
          settings.oauth.tokenPerIpPerMinute,
          60,
        ))
      ) {
        return reply;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const token = body['token'];
      // RFC 7009 §2.2: an unknown or malformed token is still a 200.
      if (!(looksLike('access', token) || looksLike('refresh', token))) {
        return reply.code(200).header('cache-control', 'no-store').send({});
      }
      const found = await withAiAppToken(
        sha256Hex(token),
        (db) =>
          db.aiAppToken.findFirst({
            select: { id: true, workspaceId: true, connectionId: true, kind: true },
          }),
        { prisma: ctx.tenant },
      );
      if (found) {
        await withWorkspace(
          found.workspaceId,
          async (db) => {
            const connection = await db.aiAppConnection.findUnique({
              where: { id: found.connectionId },
              select: { userId: true, client: { select: { clientId: true, clientName: true } } },
            });
            if (!connection) return;
            if (
              typeof body['client_id'] === 'string' &&
              body['client_id'] !== connection.client.clientId
            ) {
              return;
            }
            // Revoking a refresh token ends the grant; an access token ends itself.
            if (found.kind === 'REFRESH') {
              if (await revokeConnection(db, ctx, found.connectionId, 'app.revoked', null)) {
                await writeAuditEvent(db, found.workspaceId, {
                  action: 'ai_app.connection.revoked',
                  actorType: 'USER',
                  actorId: connection.userId,
                  resourceType: 'ai_app_connection',
                  resourceId: found.connectionId,
                  after: { reason: 'app.revoked', app: connection.client.clientName },
                });
              }
            } else {
              await db.aiAppToken.updateMany({
                where: { id: found.id, revokedAt: null },
                data: { revokedAt: ctx.clock.now() },
              });
            }
          },
          { prisma: ctx.tenant },
        );
      }
      return reply.code(200).header('cache-control', 'no-store').send({});
    },
  );
}

/**
 * Register the endpoints. The token and revocation endpoints take
 * `application/x-www-form-urlencoded` (RFC 6749 §4.1.3), which this API parses
 * nowhere else, so they live in their own plugin with their own parser.
 */
export async function registerAiAppsOAuthRoutes(app: FastifyInstance): Promise<void> {
  metadataRoutes(app);
  registerRoute(app);
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 8_192 },
      (_req, body, done) => {
        try {
          done(null, Object.fromEntries(new URLSearchParams(String(body))));
        } catch (error) {
          done(error as Error, undefined);
        }
      },
    );
    tokenRoute(scope);
    revokeRoute(scope);
  });
}
