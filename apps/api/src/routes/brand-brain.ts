import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  BrandBrainChatService,
  chatMessageSchema,
  resolveBrandBrainPolicy,
} from '@brandspace/brand-brain';
import { AiGateway, MockProviderAdapter, type AiProviderAdapter } from '@brandspace/ai-gateway';
import { ConfigurationService } from '@brandspace/config';
import { CreditLedgerService } from '@brandspace/entitlements';
import { ConfigurationAiSource } from '@brandspace/ai-gateway';
import { CUSTOMER_REALM, CustomerAuthService } from '@brandspace/auth';
import { getPrisma, withWorkspace } from '@brandspace/database';
import { getPlatformClient } from '@brandspace/database/platform';
import { brandInScope, createLogger, internalErrorFields, isAppError } from '@brandspace/shared';
import { route } from '../route-contract';

/**
 * Brand Brain chat — the customer-initiated AI surface.
 *
 * WHY THIS LIVES IN apps/api AND NOT IN THE DASHBOARD.
 *
 * Phase 5 is the first time a CUSTOMER action triggers an AI request, and that
 * exposed a seam Phase 4 never had to cross: the gateway reads platform-owned
 * `ai.*` configuration and settles credits in its own transactions, so it needs
 * the PLATFORM database identity. F-07 forbids the customer dashboard from ever
 * holding that identity — a rule worth keeping, because the dashboard is the
 * surface closest to a browser bundle.
 *
 * Until now the gateway's only callers were tests, which run on the platform
 * pool, so nothing forced the question. The answer is this route: `apps/api` is
 * the designated platform surface (eslint.config.mjs, PLATFORM_SURFACE_APPS),
 * and it is where a customer-initiated AI action belongs.
 *
 * THE TWO IDENTITIES ARE USED FOR TWO DIFFERENT THINGS, AND NEITHER BORROWS THE
 * OTHER'S REACH:
 *
 *   - TENANT identity (`withWorkspace`) for everything in Brand Brain —
 *     retrieval, conversations, messages. RLS applies to every statement, so
 *     the answer is constrained by the database and not by this handler.
 *   - PLATFORM identity for the gateway alone: configuration, the credit
 *     ledger, the AI request row. It never reads a Brand Brain table.
 *
 * The workspace is resolved from the SESSION, never from the request body, so a
 * crafted payload naming another tenant operates on the caller's own workspace.
 */

const log = createLogger({ context: { component: 'api.brand-brain' } });

const CHAT_PERMISSION = 'brand_brain.chat';

interface GatewayDeps {
  readonly gateway: AiGateway;
}

let cachedGateway: GatewayDeps | null = null;
let cachedConfiguration: ConfigurationService | null = null;

/**
 * The configuration service, on the PLATFORM identity.
 *
 * `configuration_version` is platform-owned; the tenant role cannot read it and
 * must not. `apps/api` is the designated platform surface
 * (eslint.config.mjs, PLATFORM_SURFACE_APPS), so this is where the read belongs
 * and where the customer-safe projection below is produced.
 */
function configurationService(): ConfigurationService {
  cachedConfiguration ??= new ConfigurationService({ prisma: getPlatformClient() });
  return cachedConfiguration;
}

/**
 * Build the gateway once per process.
 *
 * The MOCK adapter is the only one registered: D-13 approved the provider
 * architecture and deferred vendor selection, so registering a real one here
 * would be the decision D-13 explicitly withheld. Everything else about the
 * call is real — routing, reservation, settlement, budgets, idempotency and the
 * ledger row.
 *
 * OUTSIDE PRODUCTION the mock answers from the retrieved material rather than
 * from its placeholder vocabulary. Without it, a developer or an end-to-end run
 * sees "[mock:mock-fast] placeholder sample draft" on the chat panel, which
 * proves nothing about whether retrieval, grounding, citation and the refusal
 * path work, and puts a model key on a customer-shaped screen. The flag SELECTS
 * from the workspace's own approved knowledge; it invents nothing, and it is
 * off in production, where a mock answer should look unmistakably like one.
 */
function gatewayDeps(): GatewayDeps {
  if (cachedGateway) return cachedGateway;

  const platform = getPlatformClient();
  const environment = currentEnvironment();
  const adapters = new Map<string, AiProviderAdapter>([
    ['mock', new MockProviderAdapter({ answerFromContext: environment !== 'PRODUCTION' })],
  ]);

  cachedGateway = {
    gateway: new AiGateway({
      prisma: platform,
      ledger: new CreditLedgerService({ prisma: platform }),
      adapters,
      configuration: new ConfigurationAiSource(configurationService(), environment),
      // The mock needs no credential, and nothing here can resolve one: the
      // Secret Service decrypt path is not imported by this route at all.
      credentials: { resolve: async () => null },
      environment,
    }),
  };
  return cachedGateway;
}

function currentEnvironment(): 'DEVELOPMENT' | 'STAGING' | 'PRODUCTION' {
  const appEnv = process.env['APP_ENV'] ?? 'development';
  if (appEnv === 'production') return 'PRODUCTION';
  if (appEnv === 'staging') return 'STAGING';
  return 'DEVELOPMENT';
}

/** The session token, from the cookie the dashboard sets or an explicit header. */
function sessionTokenFrom(req: FastifyRequest): string | null {
  const header = req.headers['authorization'];
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7);
  const cookie = req.headers['cookie'];
  if (typeof cookie !== 'string') return null;
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === CUSTOMER_REALM.cookieName) return rest.join('=');
  }
  return null;
}

/**
 * Resolve the caller's session and active workspace, or the reply that refuses.
 *
 * A missing session is a 401. Everything else — no active workspace, a
 * membership that has since been removed, a member without the permission — is
 * a 404 shaped exactly like a genuine miss, because telling someone which
 * endpoints exist but are closed to them is itself information (CLAUDE.md §2.1).
 */
async function resolveCaller(
  req: FastifyRequest,
  reply: FastifyReply,
  permission: string,
): Promise<{ userId: string; workspaceId: string; brandScope: readonly string[] } | null> {
  const token = sessionTokenFrom(req);
  if (!token) {
    await reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
    return null;
  }

  const auth = new CustomerAuthService({ prisma: getPrisma() });
  const customer = await auth.resolve(token).catch(() => null);
  if (!customer) {
    await reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
    return null;
  }

  // The workspace comes from the SESSION. A body naming another tenant is
  // simply ignored — there is no field to name one.
  const workspaces = await auth.listWorkspaces(token).catch(() => null);
  const workspace = workspaces?.find((w) => w.workspaceId === customer.activeWorkspaceId);
  if (!workspace || !workspace.permissionKeys.includes(permission)) {
    await reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    return null;
  }

  // The brand scope travels with the caller, so the handler cannot forget to
  // pass it — the service's `actorBrandScope` is required (F-74).
  return {
    userId: customer.userId,
    workspaceId: workspace.workspaceId,
    brandScope: workspace.brandScope,
  };
}

export function registerBrandBrainRoutes(app: FastifyInstance): void {
  route(
    app,
    'POST',
    '/v1/brand-brain/chat',
    {
      scope: 'workspace',
      permission: CHAT_PERMISSION,
      // A chat turn spends credits, so a retry must never bill twice. The
      // client key is required by the schema, not optional here.
      idempotent: true,
      rateLimit: 'ai.chat',
      confirmation: 'not_required',
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const environment = currentEnvironment();
      const caller = await resolveCaller(req, reply, CHAT_PERMISSION);
      if (!caller) return reply;

      const parsed = chatMessageSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });
      }

      /*
       * THE BRAND IS CHECKED BEFORE ANY WORK, AND A MISS IS A 404.
       *
       * `brandId` is the one identifier the caller supplies, and it has to be:
       * the customer chooses which brand to ask about. RLS and the composite
       * foreign key both already refuse a brand from another workspace, so
       * nothing leaks without this check — but the failure surfaces as a
       * foreign-key violation, which the customer reads as "that request could
       * not be completed" for what is really a plain not-found.
       *
       * Resolving it here makes the contract honest. A brand in another
       * workspace, a brand that never existed and a soft-deleted one all
       * produce the SAME 404, so the answer discloses nothing either
       * (CLAUDE.md §2.1).
       */
      const tenantPrisma = getPrisma();
      // A brand outside the member's scope is refused HERE, with the same 404
      // as one that does not exist — before the pre-check reveals that it does
      // (docs/SECURITY.md §4.2).
      if (!brandInScope(caller.brandScope, parsed.data.brandId)) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
      }

      const brand = await withWorkspace(
        caller.workspaceId,
        async (db) =>
          db.brand.findFirst({
            where: { id: parsed.data.brandId, deletedAt: null },
            select: { id: true },
          }),
        { prisma: tenantPrisma },
      );
      if (!brand) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });

      /*
       * Read OUTSIDE the transaction below.
       *
       * `withWorkspace` opens a transaction, so resolving this inside the
       * callback would open a SECOND one while the first is still held. The
       * value is a long-committed column, so a separate read is correct — and
       * it is read from the workspace row rather than the session, which is a
       * snapshot taken at sign-in: a plan change since then has to take effect
       * now.
       */
      const planKey = await planKeyFor(caller.workspaceId);

      /*
       * THE POLICY IS READ, NOT WRITTEN DOWN HERE.
       *
       * This used to be a local function returning 90 / 12 / 8 / 12000 under a
       * comment saying it "mirrors the config schema". A mirrored setting is a
       * second setting: an owner who shortened the retention window in Platform
       * Admin would have changed nothing, and the screen would have gone on
       * promising ninety days (CLAUDE.md §2.2).
       */
      const policy = await resolveBrandBrainPolicy(configurationService(), environment);

      try {
        const { gateway } = gatewayDeps();
        const turn = await withWorkspace(
          caller.workspaceId,
          async (db) =>
            new BrandBrainChatService({
              db,
              workspaceId: caller.workspaceId,
              gateway,
              policy: policy.chat,
            }).send({
              brandId: parsed.data.brandId,
              conversationId: parsed.data.conversationId,
              area: parsed.data.area as never,
              message: parsed.data.message,
              idempotencyKey: parsed.data.idempotencyKey,
              actorUserId: caller.userId,
              actorBrandScope: caller.brandScope,
              planKey,
            }),
          { prisma: tenantPrisma },
        );

        return reply.send({
          conversationId: turn.conversationId,
          // The BODY of the assistant message, and nothing about how it was
          // produced: no model key, no provider, no prompt, no request id.
          answer: turn.assistantMessage.body,
          citations: turn.citations,
          insufficientKnowledge: turn.insufficientKnowledge,
          replayed: turn.replayed,
        });
      } catch (error: unknown) {
        /*
         * An AppError carries a stable code the client can act on. It is still
         * LOGGED when it maps to a 5xx, because those are ours, not the
         * caller's: a `RoutingError` for an unconfigured task is an operator
         * problem that would otherwise be invisible — the customer sees a
         * generic failure and nothing anywhere says the platform has no active
         * routing rule. A 4xx is the caller's and stays quiet.
         */
        if (isAppError(error)) {
          if (error.httpStatus >= 500) {
            log.error('brand brain chat failed', {
              code: error.code,
              ...internalErrorFields(error),
            });
          }
          return reply.code(error.httpStatus).send({ error: { code: error.code } });
        }
        log.error('brand brain chat failed', internalErrorFields(error));
        return reply.code(500).send({ error: { code: 'INTERNAL' } });
      }
    },
  );
}

/**
 * The workspace plan key, read fresh.
 *
 * On the TENANT pool inside its own workspace context, so the lookup is subject
 * to the same RLS as everything else this handler touches.
 */
async function planKeyFor(workspaceId: string): Promise<string | null> {
  const row = await withWorkspace(
    workspaceId,
    async (db) =>
      db.workspace.findUnique({ where: { id: workspaceId }, select: { planKey: true } }),
    { prisma: getPrisma() },
  );
  return row?.planKey ?? null;
}
