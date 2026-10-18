import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { resolveLiveAuthorization } from '@brandspace/copilot';
import { withAiAppToken, withWorkspace } from '@brandspace/database';
import { createLogger, internalErrorFields } from '@brandspace/shared';
import { route } from '../route-contract';
import { aiAppsContext, aiAppsRefusal, aiAppsSettings, type AiAppsContext } from './context';
import { bearerChallenge, looksLike, resourceUrl, sha256Hex } from './oauth-core';
import { buildMcpServer, type McpCaller } from './tools';

const log = createLogger({ context: { component: 'api.ai-apps.mcp' } });

/**
 * D-566 — THE REMOTE MCP ENDPOINT: `POST {api}/mcp`.
 *
 * MCP Streamable HTTP, 2025-11-25, STATELESS with JSON responses: every POST is
 * answered by a server object built for it and thrown away after, so there is
 * no session to steal and nothing to clean up. GET and DELETE answer 405, which
 * the transport spec allows a server without a stream to do.
 *
 * Before a single JSON-RPC message is read, in this order:
 *
 *   1. an `Origin` header, when present, must be on `ai-apps.allowedOrigins`
 *      (transport spec: "MUST validate … respond with HTTP 403");
 *   2. a bearer access token THIS server issued, for THIS resource (RFC 8707),
 *      not expired, not revoked, on an ACTIVE connection — otherwise 401 with
 *      `WWW-Authenticate` naming the metadata (RFC 9728);
 *   3. the person behind the connection still an ACTIVE member — their role
 *      and permissions read fresh, never from the token;
 *   4. a `tools/call` counts against the connection's window
 *      (`ai-apps.rateLimit`) — over it, 429 with `Retry-After`.
 *
 * The token is read from the Authorization header ONLY (never the query
 * string), is never forwarded anywhere, and never appears in a log.
 */

type Refused = {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body: unknown;
};

function jsonRpcError(code: number, message: string) {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

function bearerOf(req: FastifyRequest): string | null {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

function countsAsToolCall(body: unknown): number {
  const messages = Array.isArray(body) ? body : [body];
  return messages.filter(
    (message) =>
      typeof message === 'object' &&
      message !== null &&
      (message as { method?: unknown }).method === 'tools/call',
  ).length;
}

/**
 * Count `calls` tool calls in the connection's current window; true when they
 * are still within the ceiling. One statement, so concurrent calls cannot both
 * slip under it (the `auth_rate_limit` design).
 */
async function withinRateLimit(
  ctx: AiAppsContext,
  connection: { readonly id: string; readonly workspaceId: string },
  calls: number,
  limit: { readonly windowSeconds: number; readonly maxCallsPerConnection: number },
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const now = ctx.clock.now();
  const windowMs = limit.windowSeconds * 1000;
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const count = await withWorkspace(
    connection.workspaceId,
    async (db) => {
      const rows = await db.$queryRaw<{ count: number }[]>`
        INSERT INTO "ai_app_rate_window" ("workspaceId", "connectionId", "windowStart", "count")
        VALUES (${connection.workspaceId}::uuid, ${connection.id}::uuid, ${windowStart}, ${calls})
        ON CONFLICT ("connectionId", "windowStart")
        DO UPDATE SET "count" = LEAST("ai_app_rate_window"."count" + ${calls}, 1000000)
        RETURNING "count"`;
      return rows[0]?.count ?? 0;
    },
    { prisma: ctx.tenant },
  );
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((windowStart.getTime() + windowMs - now.getTime()) / 1000),
  );
  return { allowed: count <= limit.maxCallsPerConnection, retryAfterSeconds };
}

/** Resolve the bearer into the person and connection it acts for, or the refusal. */
async function authenticate(req: FastifyRequest, ctx: AiAppsContext): Promise<McpCaller | Refused> {
  const addresses = ctx.addresses();
  if (!addresses) return { status: 404, body: { error: { code: 'NOT_FOUND' } } };
  const unauthorized = (error?: string): Refused => ({
    status: 401,
    headers: { 'www-authenticate': bearerChallenge(addresses, error ? { error } : {}) },
    body: jsonRpcError(-32001, 'Brandspace needs you to connect again.'),
  });

  const token = bearerOf(req);
  if (!token) return unauthorized();
  if (!looksLike('access', token)) return unauthorized('invalid_token');

  const found = await withAiAppToken(
    sha256Hex(token),
    (db) =>
      db.aiAppToken.findFirst({
        where: { kind: 'ACCESS' },
        select: { id: true, workspaceId: true },
      }),
    { prisma: ctx.tenant },
  );
  if (!found) return unauthorized('invalid_token');

  const settings = await aiAppsSettings(ctx);
  const resolved = await withWorkspace(
    found.workspaceId,
    async (db) => {
      const now = ctx.clock.now();
      const row = await db.aiAppToken.findUnique({
        where: { id: found.id },
        select: {
          revokedAt: true,
          expiresAt: true,
          resource: true,
          scopes: true,
          connection: {
            select: {
              id: true,
              workspaceId: true,
              userId: true,
              brandIds: true,
              status: true,
              lastUsedAt: true,
              client: { select: { clientName: true, disabledAt: true } },
              workspace: { select: { name: true, timezone: true, status: true } },
            },
          },
        },
      });
      if (
        !row ||
        row.revokedAt !== null ||
        row.expiresAt <= now ||
        row.resource !== resourceUrl(addresses) ||
        row.connection.status !== 'ACTIVE' ||
        row.connection.client.disabledAt !== null
      ) {
        return null;
      }
      // Live, every call: a member removed, suspended or downgraded since they
      // connected loses that power now, not when the token expires. The person
      // is read only after the membership is known to be active — under RLS a
      // former member's row is simply not visible in this workspace.
      const live = await resolveLiveAuthorization(
        db,
        row.connection.workspaceId,
        row.connection.userId,
      );
      if (!live) return null;
      const person = await db.user.findFirst({
        where: { id: row.connection.userId, status: 'ACTIVE', deletedAt: null },
        select: { name: true, email: true, locale: true },
      });
      if (!person) return null;
      // "Last used", at most once a minute so a busy app does not write every call.
      if (
        !row.connection.lastUsedAt ||
        now.getTime() - row.connection.lastUsedAt.getTime() > 60_000
      ) {
        await db.aiAppConnection.update({
          where: { id: row.connection.id },
          data: { lastUsedAt: now },
        });
      }
      return {
        connectionId: row.connection.id,
        workspaceId: row.connection.workspaceId,
        workspaceName: row.connection.workspace.name,
        timezone: row.connection.workspace.timezone,
        userId: row.connection.userId,
        personName: person.name ?? '',
        personEmail: person.email,
        locale: person.locale === 'AR' ? ('ar' as const) : ('en' as const),
        appName: row.connection.client.clientName,
        scopes: row.scopes,
        connectionBrandIds: row.connection.brandIds,
        roleKey: live.roleKey,
        permissionKeys: live.permissionKeys,
        memberBrandScope: live.brandScope,
        refusal: await aiAppsRefusal(db, row.connection.workspaceId, settings, ctx),
      } satisfies McpCaller;
    },
    { prisma: ctx.tenant },
  );
  return resolved ?? unauthorized('invalid_token');
}

function send(reply: FastifyReply, refused: Refused): FastifyReply {
  for (const [name, value] of Object.entries(refused.headers ?? {})) reply.header(name, value);
  return reply.code(refused.status).send(refused.body);
}

export function registerAiAppsMcpRoutes(app: FastifyInstance): void {
  route(
    app,
    'POST',
    '/mcp',
    // Public at the contract level and authenticated by its own bearer check,
    // the same way the social callbacks are public (audit §7).
    { scope: 'public', rateLimit: 'ai-apps.rateLimit' },
    async (req, reply) => {
      const ctx = aiAppsContext();
      try {
        const settings = await aiAppsSettings(ctx);
        const origin = req.headers['origin'];
        if (typeof origin === 'string' && !settings.allowedOrigins.includes(origin)) {
          return reply.code(403).send(jsonRpcError(-32000, 'This origin may not call Brandspace.'));
        }
        const caller = await authenticate(req, ctx);
        if ('status' in caller) return send(reply, caller);

        const calls = countsAsToolCall(req.body);
        if (calls > 0) {
          const limit = await withinRateLimit(
            ctx,
            { id: caller.connectionId, workspaceId: caller.workspaceId },
            calls,
            settings.rateLimit,
          );
          if (!limit.allowed) {
            return reply
              .code(429)
              .header('retry-after', String(limit.retryAfterSeconds))
              .send(
                jsonRpcError(-32002, 'Too many requests from this app. Try again in a minute.'),
              );
          }
        }

        const server = buildMcpServer(caller, ctx);
        // Stateless: no session id generator at all (the SDK's documented
        // stateless form), JSON responses rather than an SSE stream.
        const transport = new WebStandardStreamableHTTPServerTransport({
          enableJsonResponse: true,
        });
        await server.connect(transport);
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') headers.set(name, value);
          else if (Array.isArray(value)) headers.set(name, value.join(', '));
        }
        const request = new Request(`${ctx.addresses()?.api ?? 'http://localhost'}/mcp`, {
          method: 'POST',
          headers,
          body: JSON.stringify(req.body ?? null),
        });
        const response = await transport.handleRequest(request, { parsedBody: req.body });
        const text = await response.text();
        await server.close();
        reply.code(response.status);
        response.headers.forEach((value, name) => {
          if (name !== 'content-length' && name !== 'transfer-encoding') reply.header(name, value);
        });
        return reply.send(text.length === 0 ? '' : text);
      } catch (error: unknown) {
        log.error('an MCP request failed', internalErrorFields(error));
        return reply
          .code(500)
          .send(jsonRpcError(-32603, 'Something went wrong in Brandspace. Try again.'));
      }
    },
  );

  const notAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(405).header('allow', 'POST').send(jsonRpcError(-32000, 'Use POST.'));
  route(app, 'GET', '/mcp', { scope: 'public' }, notAllowed);
  route(app, 'DELETE', '/mcp', { scope: 'public' }, notAllowed);
}
