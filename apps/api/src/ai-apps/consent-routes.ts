import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CustomerAuthService } from '@brandspace/auth';
import {
  withoutTenantContext,
  withWorkspace,
  writeAuditEvent,
  type TenantScopedClient,
} from '@brandspace/database';
import {
  EntitlementService,
  TenantCatalogueSource,
  readAccessibleBrands,
} from '@brandspace/entitlements';
import { requestContext } from '@brandspace/shared';
import { route } from '../route-contract';
import { resolveCaller, sessionTokenFrom } from '../routes/phase7-context';
import { aiAppsContext, aiAppsRefusal, aiAppsSettings, type AiAppsContext } from './context';
import {
  authorizationRedirect,
  grantedScopes,
  isS256Challenge,
  looksLike,
  newSecret,
  redirectUriRegistered,
  resourceUrl,
  sha256Hex,
  type Scope,
} from './oauth-core';
import { revokeConnection } from './oauth-routes';

/**
 * D-566 — THE CONSENT SCREEN'S AND THE SETTINGS PAGE'S API.
 *
 * The authorization endpoint and the consent screen are dashboard pages
 * (`/oauth/authorize`, `/{locale}/oauth/authorize`), because the customer's
 * sign-in cookie lives on that origin. The dashboard cannot read configuration
 * (F-07), so every decision is made HERE, with the customer's own session
 * forwarded as a bearer, exactly as `/v1/ai/availability` does:
 *
 *   POST /v1/ai-apps/authorize/check   is this request valid; who is asking; where may it go
 *   POST /v1/ai-apps/authorize/decide  Allow (writes the grant and a one-time code) or Cancel
 *   GET  /v1/ai-apps/connections       Settings → Connected AI apps
 *   POST /v1/ai-apps/connections/:id/revoke
 *
 * OAuth's own rule decides what may be sent back to the app: an unknown app or
 * an unregistered redirect address is shown as an error in Brandspace and
 * NEVER redirected (RFC 6749 §4.1.2.1); anything else wrong goes back to the
 * app as `error=…` with its `state`.
 */

const authorizeParams = z.object({
  response_type: z.string().max(40).optional(),
  client_id: z.string().max(120),
  redirect_uri: z.string().max(500),
  code_challenge: z.string().max(200).optional(),
  code_challenge_method: z.string().max(20).optional(),
  scope: z.string().max(500).optional(),
  state: z.string().max(1000).optional(),
  resource: z.string().max(500).optional(),
});
type AuthorizeParams = z.infer<typeof authorizeParams>;

type Checked =
  | { readonly kind: 'error'; readonly code: 'INVALID_CLIENT' | 'INVALID_REDIRECT' | 'UNAVAILABLE' }
  | { readonly kind: 'redirect'; readonly redirectTo: string }
  | {
      readonly kind: 'ok';
      readonly client: {
        readonly id: string;
        readonly name: string;
        readonly redirectHost: string;
      };
      readonly scopes: readonly Scope[];
      readonly resource: string;
    };

/** Validate an authorization request (OAuth 2.1 §4.1.1, MCP spec, RFC 8707). */
async function checkRequest(ctx: AiAppsContext, params: AuthorizeParams): Promise<Checked> {
  const addresses = ctx.addresses();
  if (!addresses) return { kind: 'error', code: 'UNAVAILABLE' };
  if (!looksLike('client', params.client_id)) return { kind: 'error', code: 'INVALID_CLIENT' };
  const client = await withoutTenantContext(
    (db) => db.aiAppClient.findUnique({ where: { clientId: params.client_id } }),
    { prisma: ctx.tenant },
  );
  if (!client || client.disabledAt) return { kind: 'error', code: 'INVALID_CLIENT' };
  if (!redirectUriRegistered(params.redirect_uri, client.redirectUris)) {
    return { kind: 'error', code: 'INVALID_REDIRECT' };
  }
  const back = (error: string, description: string): Checked => ({
    kind: 'redirect',
    redirectTo: authorizationRedirect(params.redirect_uri, {
      error,
      error_description: description,
      state: params.state,
      iss: addresses.api,
    }),
  });
  if (params.response_type !== 'code') {
    return back('unsupported_response_type', 'Only the authorization code flow is supported.');
  }
  if (params.code_challenge_method !== 'S256' || !isS256Challenge(params.code_challenge)) {
    return back('invalid_request', 'PKCE with S256 is required.');
  }
  const resource = resourceUrl(addresses);
  if (params.resource !== undefined && params.resource !== resource) {
    return back('invalid_target', 'This server only issues access to the Brandspace MCP server.');
  }
  return {
    kind: 'ok',
    client: {
      id: client.id,
      name: client.clientName,
      redirectHost: new URL(params.redirect_uri).host,
    },
    scopes: grantedScopes(params.scope),
    resource,
  };
}

interface Session {
  readonly token: string;
  readonly userId: string;
}

async function sessionOf(
  req: FastifyRequest,
  reply: FastifyReply,
  ctx: AiAppsContext,
): Promise<Session | null> {
  const token = sessionTokenFrom(req);
  const customer = token
    ? await new CustomerAuthService({ prisma: ctx.tenant }).resolve(token).catch(() => null)
    : null;
  if (!token || !customer) {
    await reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
    return null;
  }
  return { token, userId: customer.userId };
}

function gateFor(db: TenantScopedClient, ctx: AiAppsContext) {
  return new EntitlementService({
    prisma: db as never,
    catalogueSource: new TenantCatalogueSource(db as never, ctx.environment),
    environment: ctx.environment,
  });
}

/** The member's workspaces, each with whether AI apps may be used there and the brands they may see. */
async function workspacesFor(ctx: AiAppsContext, session: Session) {
  const settings = await aiAppsSettings(ctx);
  const workspaces = await new CustomerAuthService({ prisma: ctx.tenant }).listWorkspaces(
    session.token,
  );
  const out = [];
  for (const workspace of workspaces) {
    const facts = await withWorkspace(
      workspace.workspaceId,
      async (db) => ({
        refusal: await aiAppsRefusal(db, workspace.workspaceId, settings, ctx),
        brands: await readAccessibleBrands(
          db as never,
          gateFor(db, ctx),
          workspace.workspaceId,
          workspace.brandScope,
        ),
      }),
      { prisma: ctx.tenant },
    );
    out.push({
      id: workspace.workspaceId,
      name: workspace.workspaceName,
      available: facts.refusal === null,
      reason: facts.refusal,
      brands: facts.brands.map((brand) => ({ id: brand.id, name: brand.name })),
    });
  }
  return out;
}

const decision = authorizeParams.extend({
  decision: z.enum(['allow', 'cancel']),
  workspaceId: z.string().uuid().optional(),
  brandMode: z.enum(['all', 'some']).optional(),
  brandIds: z.array(z.string().uuid()).max(100).optional(),
});

export function registerAiAppsConsentRoutes(app: FastifyInstance): void {
  route(
    app,
    'POST',
    '/v1/ai-apps/authorize/check',
    // Any signed-in member: what they may grant is checked per workspace below.
    { scope: 'workspace', permission: 'workspace.read' },
    async (req, reply) => {
      const ctx = aiAppsContext();
      const session = await sessionOf(req, reply, ctx);
      if (!session) return reply;
      const params = authorizeParams.safeParse(req.body);
      if (!params.success) return reply.code(200).send({ status: 'error', code: 'INVALID_CLIENT' });
      const checked = await checkRequest(ctx, params.data);
      if (checked.kind === 'error') return reply.send({ status: 'error', code: checked.code });
      if (checked.kind === 'redirect')
        return reply.send({ status: 'redirect', redirectTo: checked.redirectTo });
      return reply.send({
        status: 'ok',
        client: { name: checked.client.name, redirectHost: checked.client.redirectHost },
        scopes: checked.scopes,
        workspaces: await workspacesFor(ctx, session),
      });
    },
  );

  route(
    app,
    'POST',
    '/v1/ai-apps/authorize/decide',
    {
      scope: 'workspace',
      permission: 'workspace.read',
      // The consent screen IS the confirmation, shown in Brandspace (CLAUDE.md §2.5).
      confirmation: 'required',
      confirmedBy: 'explicit_decision',
    },
    async (req, reply) => {
      const ctx = aiAppsContext();
      const session = await sessionOf(req, reply, ctx);
      if (!session) return reply;
      const parsed = decision.safeParse(req.body);
      if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });
      const body = parsed.data;
      const checked = await checkRequest(ctx, body);
      if (checked.kind === 'error') return reply.send({ status: 'error', code: checked.code });
      if (checked.kind === 'redirect')
        return reply.send({ status: 'redirect', redirectTo: checked.redirectTo });
      const addresses = ctx.addresses()!;
      if (body.decision === 'cancel') {
        return reply.send({
          status: 'redirect',
          redirectTo: authorizationRedirect(body.redirect_uri, {
            error: 'access_denied',
            error_description: 'The person cancelled the connection.',
            state: body.state,
            iss: addresses.api,
          }),
        });
      }

      const workspaces = await new CustomerAuthService({ prisma: ctx.tenant }).listWorkspaces(
        session.token,
      );
      const workspace = workspaces.find((w) => w.workspaceId === body.workspaceId);
      if (!workspace) return reply.send({ status: 'error', code: 'WORKSPACE' });
      const settings = await aiAppsSettings(ctx);
      const source = requestContext({ headers: req.headers, socketAddress: req.ip });

      const result = await withWorkspace(
        workspace.workspaceId,
        async (db) => {
          if (await aiAppsRefusal(db, workspace.workspaceId, settings, ctx)) {
            return { kind: 'error' as const, code: 'UNAVAILABLE' };
          }
          const visible = await readAccessibleBrands(
            db as never,
            gateFor(db, ctx),
            workspace.workspaceId,
            workspace.brandScope,
          );
          const all = body.brandMode !== 'some';
          const chosen = all ? [] : [...new Set(body.brandIds ?? [])];
          // Only brands this person may see; "some" must name at least one.
          if (
            !all &&
            (chosen.length === 0 || !chosen.every((id) => visible.some((b) => b.id === id)))
          ) {
            return { kind: 'error' as const, code: 'BRANDS' };
          }
          const now = ctx.clock.now();
          const connection = await db.aiAppConnection.create({
            data: {
              workspaceId: workspace.workspaceId,
              userId: session.userId,
              clientId: checked.client.id,
              brandIds: chosen,
              scopes: [...checked.scopes],
            },
            select: { id: true },
          });
          const code = newSecret('code');
          await db.aiAppAuthorizationCode.create({
            data: {
              workspaceId: workspace.workspaceId,
              connectionId: connection.id,
              codeHash: sha256Hex(code),
              codeChallenge: body.code_challenge!,
              redirectUri: body.redirect_uri,
              resource: checked.resource,
              scopes: [...checked.scopes],
              createdAt: now,
              expiresAt: new Date(
                now.getTime() + settings.oauth.authorizationCodeTtlSeconds * 1000,
              ),
            },
          });
          await writeAuditEvent(db, workspace.workspaceId, {
            action: 'ai_app.connection.granted',
            actorType: 'USER',
            actorId: session.userId,
            resourceType: 'ai_app_connection',
            resourceId: connection.id,
            severity: 'NOTICE',
            after: {
              app: checked.client.name,
              redirectHost: checked.client.redirectHost,
              brands: all ? 'all' : chosen.length,
              scopes: checked.scopes,
            },
            ip: source.ip,
            userAgent: source.userAgent,
          });
          return { kind: 'ok' as const, code };
        },
        { prisma: ctx.tenant },
      );
      if (result.kind === 'error') return reply.send({ status: 'error', code: result.code });
      return reply.send({
        status: 'redirect',
        redirectTo: authorizationRedirect(body.redirect_uri, {
          code: result.code,
          state: body.state,
          iss: addresses.api,
        }),
      });
    },
  );

  route(
    app,
    'GET',
    '/v1/ai-apps/connections',
    { scope: 'workspace', permission: 'workspace.read' },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, 'workspace.read');
      if (!caller) return reply;
      const ctx = aiAppsContext();
      const manageAll = caller.permissionKeys.includes('integrations.manage');
      const settings = await aiAppsSettings(ctx);
      const view = await withWorkspace(
        caller.workspaceId,
        async (db) => {
          const rows = await db.aiAppConnection.findMany({
            where: { status: 'ACTIVE', ...(manageAll ? {} : { userId: caller.userId }) },
            orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
            take: 200,
            select: {
              id: true,
              userId: true,
              brandIds: true,
              scopes: true,
              createdAt: true,
              lastUsedAt: true,
              client: { select: { clientName: true, logoUri: true } },
            },
          });
          // People are read on their own: under RLS a former member is not
          // visible in this workspace, and a required join would fail the page.
          const people = await db.user.findMany({
            where: { id: { in: [...new Set(rows.map((row) => row.userId))] } },
            select: { id: true, name: true, email: true },
          });
          const personOf = new Map(people.map((p) => [p.id, p.name ?? p.email]));
          const brandIds = [...new Set(rows.flatMap((row) => row.brandIds))];
          const brands = brandIds.length
            ? await db.brand.findMany({
                where: { id: { in: brandIds } },
                select: { id: true, name: true },
              })
            : [];
          const names = new Map(brands.map((brand) => [brand.id, brand.name]));
          return {
            refusal: await aiAppsRefusal(db, caller.workspaceId, settings, ctx),
            rows: rows.map((row) => ({
              id: row.id,
              app: row.client.clientName,
              // The https logo the app registered (RFC 7591 `logo_uri`), or null.
              logoUri: row.client.logoUri,
              person: personOf.get(row.userId) ?? null,
              mine: row.userId === caller.userId,
              brands:
                row.brandIds.length === 0
                  ? 'all'
                  : row.brandIds.map((id) => names.get(id) ?? null).filter(Boolean),
              canWrite: row.scopes.includes('brandspace.write'),
              createdAt: row.createdAt.toISOString(),
              lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
            })),
          };
        },
        { prisma: ctx.tenant },
      );
      const addresses = ctx.addresses();
      return reply.send({
        available: view.refusal === null,
        reason: view.refusal,
        manageAll,
        // The address a person types into Claude or ChatGPT (the Connect page).
        mcpUrl: addresses ? resourceUrl(addresses) : null,
        connections: view.rows,
      });
    },
  );

  route(
    app,
    'POST',
    '/v1/ai-apps/connections/:id/revoke',
    {
      scope: 'workspace',
      permission: 'workspace.read',
      confirmation: 'required',
      confirmedBy: 'confirm_field',
    },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, 'workspace.read');
      if (!caller) return reply;
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      const body = z.object({ confirm: z.literal(true) }).safeParse(req.body);
      if (!params.success) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
      if (!body.success) return reply.code(422).send({ error: { code: 'CONFIRMATION_REQUIRED' } });
      const ctx = aiAppsContext();
      const manageAll = caller.permissionKeys.includes('integrations.manage');
      const source = requestContext({ headers: req.headers, socketAddress: req.ip });
      const done = await withWorkspace(
        caller.workspaceId,
        async (db) => {
          const connection = await db.aiAppConnection.findFirst({
            where: {
              id: params.data.id,
              status: 'ACTIVE',
              ...(manageAll ? {} : { userId: caller.userId }),
            },
            select: { id: true, userId: true, client: { select: { clientName: true } } },
          });
          // Somebody else's connection, without the right to manage it, is a miss.
          if (!connection) return false;
          await revokeConnection(db, ctx, connection.id, 'user.revoked', caller.userId);
          await writeAuditEvent(db, caller.workspaceId, {
            action: 'ai_app.connection.revoked',
            actorType: 'USER',
            actorId: caller.userId,
            resourceType: 'ai_app_connection',
            resourceId: connection.id,
            severity: 'NOTICE',
            after: {
              reason: 'user.revoked',
              app: connection.client.clientName,
              ownConnection: connection.userId === caller.userId,
            },
            ip: source.ip,
            userAgent: source.userAgent,
          });
          return true;
        },
        { prisma: ctx.tenant },
      );
      if (!done) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
      return reply.send({ ok: true });
    },
  );
}
