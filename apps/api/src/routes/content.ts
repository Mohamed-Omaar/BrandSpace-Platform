import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ContentStudioService,
  contentGenerateRequestSchema,
  contentQuoteRequestSchema,
  contentToolRequestSchema,
  readRetentionFacts,
  resolveContentPolicy,
  type WorkspaceRetentionFacts,
} from '@brandspace/content';
import { AiGateway, MockProviderAdapter, type AiProviderAdapter } from '@brandspace/ai-gateway';
import { ConfigurationAiSource } from '@brandspace/ai-gateway';
import { ConfigurationService } from '@brandspace/config';
import { CreditLedgerService } from '@brandspace/entitlements';
import { CUSTOMER_REALM, CustomerAuthService } from '@brandspace/auth';
import { getPrisma, withWorkspace } from '@brandspace/database';
import { getPlatformClient } from '@brandspace/database/platform';
import {
  brandInScope,
  createLogger,
  currentEnvironment,
  internalErrorFields,
  isAppError,
} from '@brandspace/shared';
import { route } from '../route-contract';

/**
 * AI Content Studio — the customer-initiated generation surface.
 *
 * WHY THIS LIVES IN apps/api AND NOT IN THE DASHBOARD: the same seam the Brand
 * Brain chat crossed first. The gateway reads platform-owned `ai.*`
 * configuration and settles credits in its own transactions, so it needs the
 * PLATFORM database identity, and F-07 forbids the customer dashboard from
 * holding that identity. `apps/api` is the designated platform surface
 * (eslint.config.mjs, PLATFORM_SURFACE_APPS).
 *
 * THE TWO IDENTITIES ARE USED FOR TWO DIFFERENT THINGS, AND NEITHER BORROWS THE
 * OTHER'S REACH:
 *
 *   - TENANT identity (`withWorkspace`) for everything in the Content Studio —
 *     retrieval, drafts, variants, audit. RLS applies to every statement, so the
 *     result is constrained by the database and not by this handler.
 *   - PLATFORM identity for the gateway alone: configuration, the credit
 *     ledger, the AI request row. It never reads a content table.
 *
 * The workspace is resolved from the SESSION, never from a request body — none
 * of the three bodies has a field to name one.
 */

const log = createLogger({ context: { component: 'api.content' } });

const READ_PERMISSION = 'content.read';
const CREATE_PERMISSION = 'content.create';
const EDIT_PERMISSION = 'content.edit';

let cachedGateway: AiGateway | null = null;
let cachedConfiguration: ConfigurationService | null = null;

function configurationService(): ConfigurationService {
  cachedConfiguration ??= new ConfigurationService({ prisma: getPlatformClient() });
  return cachedConfiguration;
}

/**
 * Build the gateway once per process.
 *
 * The MOCK adapter is the only one registered, for the reason D-13 gave: the
 * provider architecture is approved and vendor selection is deferred, so
 * registering a real one here would be the decision D-13 explicitly withheld.
 * Everything else about the call is real — routing, reservation, settlement,
 * budgets, idempotency and the ledger row.
 */
function gateway(): AiGateway {
  if (cachedGateway) return cachedGateway;

  const platform = getPlatformClient();
  const environment = currentEnvironment();
  const adapters = new Map<string, AiProviderAdapter>([
    /*
     * PHASE 10 §11 — NO ADAPTER AT ALL IN PRODUCTION, rather than a mock with
     * its context-answering turned off.
     *
     * With no adapter registered, routing still resolves and the pipeline still
     * reserves, but the chain finds nothing to call and the request fails with
     * MODEL_UNAVAILABLE — which releases the reservation, charges nothing, and
     * shows the customer "this is temporarily unavailable". That is the honest
     * outcome when no AI provider has been configured. Serving invented text
     * that looks like a model wrote it is the outcome this replaces.
     *
     * `MockProviderAdapter` also refuses to be constructed in production, so
     * this is the second of two locks rather than the only one.
     */
    ...(environment === 'PRODUCTION'
      ? []
      : ([['mock', new MockProviderAdapter({ answerFromContext: true })]] as const)),
  ]);

  cachedGateway = new AiGateway({
    prisma: platform,
    ledger: new CreditLedgerService({ prisma: platform }),
    adapters,
    configuration: new ConfigurationAiSource(configurationService(), environment),
    // The mock needs no credential, and nothing here can resolve one: the
    // Secret Service decrypt path is not imported by this route at all.
    credentials: { resolve: async () => null },
    environment,
  });
  return cachedGateway;
}

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

interface Caller {
  readonly userId: string;
  readonly workspaceId: string;
  readonly brandScope: readonly string[];
}

/**
 * Resolve the caller's session and active workspace, or the reply that refuses.
 *
 * A missing session is a 401. Everything else — no active workspace, a
 * membership since removed, a member without the permission — is a 404 shaped
 * exactly like a genuine miss, because telling someone which endpoints exist but
 * are closed to them is itself information (CLAUDE.md §2.1).
 */
async function resolveCaller(
  req: FastifyRequest,
  reply: FastifyReply,
  permission: string,
): Promise<Caller | null> {
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

  const workspaces = await auth.listWorkspaces(token).catch(() => null);
  const workspace = workspaces?.find((w) => w.workspaceId === customer.activeWorkspaceId);
  if (!workspace || !workspace.permissionKeys.includes(permission)) {
    await reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    return null;
  }

  return {
    userId: customer.userId,
    workspaceId: workspace.workspaceId,
    brandScope: workspace.brandScope,
  };
}

/**
 * The workspace's plan key, its subscription state and its D-117 retention
 * control — read fresh, on the TENANT pool, inside its own workspace context.
 *
 * Read from the WORKSPACE ROW rather than from the session, which is a snapshot
 * taken at sign-in: a plan change or a cancellation since then has to take
 * effect now, not at the member's next sign-in.
 */
/**
 * ONE READER FOR THE RETENTION FACTS.
 *
 * This used to transcribe the "which subscription states still retain content"
 * rule inline. Manual authoring in the dashboard needs the same answer, and a
 * second transcription is a second answer — one that nobody would notice
 * diverging until somebody's drafts were purged early. `readRetentionFacts`
 * in `@brandspace/content` is now the only copy; D-116's reasoning lives with it.
 */
async function workspaceFacts(workspaceId: string): Promise<WorkspaceRetentionFacts> {
  return withWorkspace(workspaceId, async (db) => readRetentionFacts(db, workspaceId), {
    prisma: getPrisma(),
  });
}

/** A brand outside the caller's scope, or absent, or archived: the same 404. */
async function requireBrand(caller: Caller, brandId: string): Promise<boolean> {
  // BEFORE the query. A scoped-out brand must be indistinguishable from one
  // that does not exist, and a read that happens first is a read that happened
  // (docs/SECURITY.md §4.2, F-74).
  if (!brandInScope(caller.brandScope, brandId)) return false;
  const brand = await withWorkspace(
    caller.workspaceId,
    async (db) =>
      db.brand.findFirst({ where: { id: brandId, deletedAt: null }, select: { id: true } }),
    { prisma: getPrisma() },
  );
  return brand !== null;
}

/**
 * One failure shape for all three routes.
 *
 * An AppError carries a stable code the client can act on. It is still LOGGED
 * when it maps to a 5xx, because those are ours, not the caller's: a routing
 * error for an unconfigured task is an operator problem that would otherwise be
 * invisible. A 4xx is the caller's and stays quiet.
 */
function fail(reply: FastifyReply, action: string, error: unknown) {
  if (isAppError(error)) {
    if (error.httpStatus >= 500) {
      log.error(`content ${action} failed`, { code: error.code, ...internalErrorFields(error) });
    }
    return reply.code(error.httpStatus).send({ error: { code: error.code } });
  }
  log.error(`content ${action} failed`, internalErrorFields(error));
  return reply.code(500).send({ error: { code: 'INTERNAL' } });
}

async function studioFor(caller: Caller, db: Parameters<Parameters<typeof withWorkspace>[1]>[0]) {
  return new ContentStudioService({
    db,
    workspaceId: caller.workspaceId,
    gateway: gateway(),
    policy: await resolveContentPolicy(configurationService(), currentEnvironment()),
  });
}

export function registerContentRoutes(app: FastifyInstance): void {
  /*
   * AC-11.1 — the price BEFORE it is spent.
   *
   * A READ, and registered as one: `content.read`, no idempotency key, no
   * confirmation. It reserves nothing, writes no `ai_request` and moves no
   * credit. Requiring `content.create` here would mean a member who may only
   * read could not be shown what a generation would cost.
   */
  route(
    app,
    'POST',
    '/v1/content/quote',
    {
      scope: 'workspace',
      permission: READ_PERMISSION,
      rateLimit: 'ai.quote',
      confirmation: 'not_required',
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const caller = await resolveCaller(req, reply, READ_PERMISSION);
      if (!caller) return reply;

      const parsed = contentQuoteRequestSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });
      if (!(await requireBrand(caller, parsed.data.brandId))) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
      }

      const facts = await workspaceFacts(caller.workspaceId);
      try {
        const quote = await withWorkspace(
          caller.workspaceId,
          async (db) =>
            (await studioFor(caller, db)).quote({
              brandId: parsed.data.brandId,
              brief: parsed.data.brief,
              platformKeys: parsed.data.platformKeys,
              planKey: facts.planKey,
              actorBrandScope: caller.brandScope,
            }),
          { prisma: getPrisma() },
        );
        // The ESTIMATE and the task, and nothing about how it was routed: no
        // provider, no model key, no prompt (AC-11.6).
        return reply.send({ estimateMilli: quote.estimateMilli.toString() });
      } catch (error: unknown) {
        return fail(reply, 'quote', error);
      }
    },
  );

  /* AC-11.2 to AC-11.9 — one generation, end to end. */
  route(
    app,
    'POST',
    '/v1/content/generate',
    {
      scope: 'workspace',
      permission: CREATE_PERMISSION,
      // A generation spends credits, so a retry must never bill twice. The
      // client key is required by the schema, not optional here.
      idempotent: true,
      rateLimit: 'ai.generate',
      confirmation: 'not_required',
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const caller = await resolveCaller(req, reply, CREATE_PERMISSION);
      if (!caller) return reply;

      const parsed = contentGenerateRequestSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });
      if (!(await requireBrand(caller, parsed.data.brandId))) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
      }

      const facts = await workspaceFacts(caller.workspaceId);
      try {
        const result = await withWorkspace(
          caller.workspaceId,
          async (db) =>
            (await studioFor(caller, db)).generate({
              brandId: parsed.data.brandId,
              brief: parsed.data.brief,
              ...(parsed.data.contentType ? { contentType: parsed.data.contentType } : {}),
              locale: parsed.data.locale,
              platformKeys: parsed.data.platformKeys,
              idempotencyKey: parsed.data.idempotencyKey,
              actorUserId: caller.userId,
              planKey: facts.planKey,
              actorBrandScope: caller.brandScope,
              retention: facts,
            }),
          { prisma: getPrisma() },
        );

        return reply.send({
          itemId: result.item.id,
          title: result.item.title,
          // AC-11.4 — the citations RETRIEVAL produced, never the model's.
          citations: result.citations,
          insufficientKnowledge: result.insufficientKnowledge,
          replayed: result.replayed,
          creditsChargedMilli: result.creditsChargedMilli.toString(),
          variants: result.variants.map((variant) => ({
            id: variant.id,
            platformKey: variant.platformKey,
            locale: variant.locale,
            body: variant.body,
            hashtags: variant.hashtags,
            characterCount: variant.characterCount,
            validationState: variant.validationState,
          })),
        });
      } catch (error: unknown) {
        return fail(reply, 'generate', error);
      }
    },
  );

  /* Rewrite / shorten / expand / retone / translate one variant. */
  route(
    app,
    'POST',
    '/v1/content/tool',
    {
      scope: 'workspace',
      permission: EDIT_PERMISSION,
      idempotent: true,
      rateLimit: 'ai.generate',
      confirmation: 'not_required',
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const caller = await resolveCaller(req, reply, EDIT_PERMISSION);
      if (!caller) return reply;

      const parsed = contentToolRequestSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });

      const facts = await workspaceFacts(caller.workspaceId);
      try {
        const result = await withWorkspace(
          caller.workspaceId,
          async (db) =>
            (await studioFor(caller, db)).applyTool({
              variantId: parsed.data.variantId,
              tool: parsed.data.tool,
              argument: parsed.data.argument,
              targetLocale: parsed.data.targetLocale,
              idempotencyKey: parsed.data.idempotencyKey,
              actorUserId: caller.userId,
              planKey: facts.planKey,
              actorBrandScope: caller.brandScope,
            }),
          { prisma: getPrisma() },
        );

        return reply.send({
          variant: {
            id: result.variant.id,
            platformKey: result.variant.platformKey,
            locale: result.variant.locale,
            body: result.variant.body,
            hashtags: result.variant.hashtags,
            characterCount: result.variant.characterCount,
            validationState: result.variant.validationState,
          },
          creditsChargedMilli: result.creditsChargedMilli.toString(),
        });
      } catch (error: unknown) {
        return fail(reply, 'tool', error);
      }
    },
  );
}
