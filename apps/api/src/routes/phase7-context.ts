import type { FastifyReply, FastifyRequest } from 'fastify';
import { CUSTOMER_REALM, CustomerAuthService } from '@brandspace/auth';
import {
  AiGateway,
  ConfigurationAiSource,
  MockProviderAdapter,
  type AiProviderAdapter,
} from '@brandspace/ai-gateway';
import { ConfigurationService } from '@brandspace/config';
import {
  CreditLedgerService,
  EntitlementService,
  TenantCatalogueSource,
} from '@brandspace/entitlements';
import {
  getPrisma,
  withWorkspace,
  writeDeniedAudit,
  type TenantScopedClient,
} from '@brandspace/database';
import type { InsightDenialSink } from '@brandspace/analytics';
import type { CopilotDenialSink } from '@brandspace/copilot';
import type { AutomationDenialSink } from '@brandspace/automation';
import { getPlatformClient } from '@brandspace/database/platform';
import {
  createLogger,
  currentEnvironment,
  internalErrorFields,
  isAppError,
} from '@brandspace/shared';

/**
 * The shared plumbing every Phase 7 route needs.
 *
 * WHY IT IS ONE FILE. Analytics, insights, strategy, the Copilot and automations
 * are five routers that all need the same four things: a resolved caller, the
 * workspace's live plan facts, a gateway built the one approved way, and a single
 * failure shape. Re-deriving any of them per router is how two surfaces end up
 * with different ideas of who the caller is — and the caller is the whole
 * authorization story in this phase.
 *
 * THE TWO IDENTITIES, AND NEITHER BORROWS THE OTHER'S REACH. Everything that
 * touches tenant data runs under `withWorkspace` on the TENANT pool, so RLS
 * constrains it. The PLATFORM identity is used for the gateway alone —
 * configuration, the ledger, the `ai_request` row — and never reads a tenant
 * table. The same seam Brand Brain chat crossed first (F-07).
 */

const log = createLogger({ context: { component: 'api.phase7' } });

let cachedGateway: AiGateway | null = null;
let cachedConfiguration: ConfigurationService | null = null;

export function configurationService(): ConfigurationService {
  cachedConfiguration ??= new ConfigurationService({ prisma: getPlatformClient() });
  return cachedConfiguration;
}

/**
 * Build the gateway once per process.
 *
 * THE MOCK ADAPTER IS THE ONLY ONE REGISTERED, for the reason D-13 gave and
 * Phase 5B-2 repeated: the provider architecture is approved and vendor
 * selection is deferred, so registering a real one here would be the decision
 * D-13 explicitly withheld. Everything else about the call is real — routing,
 * the reservation, settlement, budgets, idempotency and the ledger row.
 */
export function gateway(): AiGateway {
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
    // The mock needs no credential, and nothing here can resolve one: the Secret
    // Service decrypt path is not imported by this route at all.
    credentials: { resolve: async () => null },
    environment,
  });
  return cachedGateway;
}

export function sessionTokenFrom(req: FastifyRequest): string | null {
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

export interface Caller {
  readonly userId: string;
  readonly workspaceId: string;
  readonly brandScope: readonly string[];
  readonly permissionKeys: readonly string[];
  readonly roleKey: string;
}

/**
 * Resolve the caller's session and active workspace, or the reply that refuses.
 *
 * A missing session is a 401. Everything else — no active workspace, a
 * membership since removed, a member without the permission — is a 404 shaped
 * exactly like a genuine miss, because telling somebody which endpoints exist
 * but are closed to them is itself information (CLAUDE.md §2.1).
 *
 * THE WORKSPACE COMES FROM THE SESSION, never from a request body. None of the
 * Phase 7 bodies has a field to name one.
 */
export async function resolveCaller(
  req: FastifyRequest,
  reply: FastifyReply,
  permission: string | readonly string[],
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
  // Q18 — a credit-spending route passes its feature key AND `copilot.use`;
  // every key must be held, and a miss is the same 404 as any other.
  const required = typeof permission === 'string' ? [permission] : permission;
  if (!workspace || !required.every((key) => workspace.permissionKeys.includes(key))) {
    await reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    return null;
  }
  return {
    userId: customer.userId,
    workspaceId: workspace.workspaceId,
    brandScope: workspace.brandScope,
    permissionKeys: workspace.permissionKeys,
    roleKey: workspace.roleKey,
  };
}

export interface WorkspaceFacts {
  readonly planKey: string | null;
  readonly subscriptionActive: boolean;
  readonly cancelledAt: Date | null;
  readonly workspaceRetentionDays: number | null;
  readonly timezone: string;
}

/**
 * The workspace's plan, subscription state, D-117 control and zone — read
 * FRESH, on the TENANT pool, inside its own workspace context.
 *
 * From the WORKSPACE ROW rather than from the session, which is a snapshot taken
 * at sign-in: a plan change or a cancellation since then has to take effect now,
 * not at the member's next sign-in.
 */
export async function workspaceFacts(workspaceId: string): Promise<WorkspaceFacts> {
  const row = await withWorkspace(
    workspaceId,
    async (db) =>
      db.workspace.findUnique({
        where: { id: workspaceId },
        select: {
          planKey: true,
          timezone: true,
          aiContentRetentionDays: true,
          subscription: { select: { status: true, cancelledAt: true } },
        },
      }),
    { prisma: getPrisma() },
  );

  const subscription = row?.subscription ?? null;
  // D-116: TRIALING and PAST_DUE count as active — a trial is a workspace the
  // platform is currently serving, and a failed card is a billing problem rather
  // than consent to start deleting the customer's work.
  const ACTIVE: readonly string[] = ['ACTIVE', 'TRIALING', 'PAST_DUE'];
  return {
    planKey: row?.planKey ?? null,
    subscriptionActive: subscription !== null && ACTIVE.includes(subscription.status),
    cancelledAt: subscription?.cancelledAt ?? null,
    workspaceRetentionDays: row?.aiContentRetentionDays ?? null,
    timezone: row?.timezone ?? 'UTC',
  };
}

/**
 * The entitlement gate the Copilot and the automation engine consult.
 *
 * READS THE TENANT-SIDE CATALOGUE PROJECTION, not `configuration_version`: the
 * dashboard resolves entitlements the same way, and two sources for one answer is
 * how a feature appears enabled on one surface and disabled on another.
 */
export function entitlementGate(
  db: TenantScopedClient,
  workspaceId: string,
): { allows(featureKey: string): Promise<boolean> } {
  const service = new EntitlementService({
    // A scoped client is a PrismaClient minus the connection-lifecycle and
    // transaction methods, which is exactly the surface this service uses.
    prisma: db as never,
    catalogueSource: new TenantCatalogueSource(db as never, currentEnvironment()),
    environment: currentEnvironment(),
  });
  return {
    async allows(featureKey: string): Promise<boolean> {
      return service.can(workspaceId, featureKey);
    },
  };
}

/**
 * One failure shape for every Phase 7 route.
 *
 * An `AppError` carries a stable code the client can act on. It is still LOGGED
 * when it maps to a 5xx, because those are ours rather than the caller's: a
 * routing error for an unconfigured task is an operator problem that would
 * otherwise be invisible. A 4xx is the caller's and stays quiet.
 */
export function fail(reply: FastifyReply, action: string, error: unknown) {
  if (isAppError(error)) {
    if (error.httpStatus >= 500) {
      log.error(`${action} failed`, { code: error.code, ...internalErrorFields(error) });
    }
    /*
     * A 429 CARRIES THE WAIT — Phase 4, docs/SECURITY.md §10.
     *
     * Set here rather than at each throw site, because this is the one exit
     * every route error already passes through: a header added beside a throw
     * is a header the next surface to refuse forgets. The value comes from the
     * limiter's own window rather than a constant, so a client that honours it
     * waits exactly as long as the ceiling actually lasts.
     */
    if (error.code === 'RATE_LIMITED') {
      const seconds = (error.publicDetails as { retryAfterSeconds?: unknown } | undefined)
        ?.retryAfterSeconds;
      if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
        void reply.header('Retry-After', String(Math.ceil(seconds)));
      }
    }
    return reply
      .code(error.httpStatus)
      .send({ error: { code: error.code, details: error.publicDetails } });
  }
  log.error(`${action} failed`, internalErrorFields(error));
  return reply.code(500).send({ error: { code: 'INTERNAL' } });
}

/** A period from a day count, anchored at the caller's request time. */
export function periodFromDays(days: number, now: Date): { start: Date; end: Date } {
  return { start: new Date(now.getTime() - days * 86_400_000), end: now };
}

/** The immediately preceding window of the same length. */
export function previousPeriod(period: { start: Date; end: Date }): { start: Date; end: Date } {
  const length = period.end.getTime() - period.start.getTime();
  return { start: new Date(period.start.getTime() - length), end: period.start };
}

/**
 * WHERE A REFUSAL GETS RECORDED — and why it cannot be the refusing transaction.
 *
 * Every domain service on these routes is reached inside `withWorkspace`, which
 * is ONE transaction. A refusal throws; the transaction rolls back; an audit row
 * written immediately before the throw rolls back with it. So a refused
 * confirmation — the exact shape an attempted replay takes — would leave no
 * trace at all, which is the opposite of what docs/SECURITY.md §7 asks for.
 *
 * These two sinks write on a SEPARATE connection, which commits whatever happens
 * to the one that refused. The precedent is `apps/dashboard`'s approval denial
 * sink and `packages/auth`'s workspace-access denial; the reasoning is identical
 * and is repeated here rather than referenced, because the day somebody inlines
 * one of these back into the service is the day the signal disappears silently.
 */
export function copilotDenialSink(workspaceId: string): CopilotDenialSink {
  return async (event) => {
    await withWorkspace(workspaceId, async (db) =>
      writeDeniedAudit(db, workspaceId, {
        action: event.action,
        actorType: 'USER',
        actorId: event.userId,
        resourceType: 'CopilotActionPlan',
        resourceId: event.planId,
        ...(event.brandId ? { brandId: event.brandId } : {}),
        reason: event.reason,
      }),
    );
  };
}

/**
 * The same sink for an UNGROUNDED GENERATION.
 *
 * `analytics.explain` and `StrategyService` both audit a rejection and then
 * throw, which rolled the record back — so the one event the grounding gate
 * exists to catch was being written and immediately discarded.
 */
export function insightDenialSink(workspaceId: string): InsightDenialSink {
  return async (event) => {
    await withWorkspace(workspaceId, async (db) =>
      writeDeniedAudit(db, workspaceId, {
        action: event.action,
        actorType: 'SYSTEM',
        actorId: event.userId,
        resourceType: 'Insight',
        brandId: event.brandId,
        reason: event.reason,
        after: event.detail,
      }),
    );
  };
}

export function automationDenialSink(workspaceId: string): AutomationDenialSink {
  return async (event) => {
    await withWorkspace(workspaceId, async (db) =>
      writeDeniedAudit(db, workspaceId, {
        action: 'automation.confirmation_refused',
        actorType: 'USER',
        actorId: event.actorUserId,
        resourceType: 'AutomationRun',
        resourceId: event.runId,
        brandId: event.brandId,
        reason: event.reason,
      }),
    );
  };
}

/**
 * Re-exported from `@brandspace/shared` so every caller in this app keeps its
 * existing import. The DEFINITION moved: it used to live here, and in eleven
 * other files, each a private copy of the same four lines (Phase 10 §18).
 */
export { currentEnvironment };
