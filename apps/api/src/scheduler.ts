import {
  AssetMaintenanceService,
  TenantAssetPolicySource,
  findUnclaimedAssetJobs,
} from '@brandspace/assets';
import { findUnclaimedIngestionJobs, purgeExpiredChatContent } from '@brandspace/brand-brain';
import { ConfigurationAiSource, purgeExpiredOutputs } from '@brandspace/ai-gateway';
import {
  createAnalyticsRegistry,
  createMetricWindowPort,
  ensureIngestionCursors,
  pruneAnalytics,
  resolveAnalyticsPolicy,
} from '@brandspace/analytics';
import { pruneCopilot, resolveCopilotPolicy } from '@brandspace/copilot';
import { ConfigurationService, type Environment } from '@brandspace/config';
import {
  getPrisma,
  recordRuleAutomationEvent,
  withWorkspace,
  type PrismaClient,
  type TenantScopedClient,
} from '@brandspace/database';
import { getPlatformClient } from '@brandspace/database/platform';
import {
  evaluateThresholdRule,
  localMomentFor,
  nextTimedEvaluationAt,
  timedRuleIsDue,
} from '@brandspace/automation';
import {
  BACKFILL_ANALYTICS,
  EVALUATE_AUTOMATION,
  INGEST_ANALYTICS,
  INGEST_SOURCE_DOCUMENT,
  PROCESS_ASSET,
  PUBLISH_SOCIAL_POST,
  VERIFY_SOCIAL_POST,
  enqueue,
  type BackfillAnalyticsPayload,
  type EvaluateAutomationPayload,
  type IngestAnalyticsPayload,
  type IngestSourceDocumentPayload,
  type ProcessAssetPayload,
  type PublishSocialPostPayload,
  type VerifySocialPostPayload,
} from '@brandspace/jobs';
import {
  createConnectorRegistry,
  PublishPipelineService,
  resolvePublishingPolicy,
  SocialTokenVault,
} from '@brandspace/social-connectors';
import { ContentApprovalService, TenantContentPolicySource } from '@brandspace/content';
import {
  CreditLedgerService,
  SubscriptionService,
  UsageService,
  creditPolicyFrom,
  findPlan,
  readPlanCatalogue,
  termsFor,
  type CreditPolicy,
  type PlanDetail,
} from '@brandspace/entitlements';
import {
  FinancialReconciler,
  ROTATION_START,
  SubscriptionLifecycleService,
  commercePolicyFrom,
  foldRotation,
  type CommercePolicy,
  type RotationState,
} from '@brandspace/billing';
import { createObjectStore } from '@brandspace/storage';
import { WorkspaceDeletionService } from '@brandspace/onboarding';
import {
  AppError,
  createLogger,
  internalErrorFields,
  systemClock,
  type Clock,
} from '@brandspace/shared';

/**
 * Background maintenance.
 *
 * WHY IT IS HERE AND NOT IN THE WORKER. Both of these sweeps begin with a
 * CROSS-TENANT question — which tenants have work waiting, which have content
 * past its window — and F-07 and docs/ARCHITECTURE.md keep the platform
 * identity out of "ordinary workers". `apps/api` is the designated platform
 * surface, so the enumeration happens here and the per-tenant work is either
 * dispatched to the worker or performed inside that tenant's own RLS context.
 * Only the enumeration is cross-tenant; nothing that WRITES tenant data does so
 * with a wider reach than the tenant itself has.
 *
 * WHY A SWEEP EXISTS AT ALL. docs/ARCHITECTURE.md §9: "delayed jobs are an
 * optimization; a reconciliation sweeper every minute finds [work] that is due
 * and unclaimed, so a lost Redis state degrades punctuality, not correctness."
 * The upload writes a durable row and dispatches; if the dispatch is lost —
 * Redis restarted, the producer died between the two — this finds the row and
 * dispatches it again. Without it, "the queue was briefly down" means "these
 * documents are never processed", with nothing anywhere saying so.
 *
 * EVERY PASS IS IDEMPOTENT AND BOUNDED. A re-dispatch of a job already done is
 * a no-op in the processor; a purge that runs twice clears nothing the second
 * time. Both take a batch ceiling from configuration, so one pass cannot
 * monopolise the database, and both return counts so a pass that is doing
 * nothing is visible rather than merely quiet.
 */

const log = createLogger({ context: { component: 'api.scheduler' } });

/**
 * How long a dispatched-but-undelivered automation event waits before it is sent
 * again.
 *
 * NOT CONFIGURATION, and the distinction matters (CLAUDE.md §2.2): this is not a
 * product behaviour an owner tunes, it is the width of the window in which a
 * queue message is still plausibly in flight. Too short and every slow worker
 * gets a duplicate; too long and a lost message sits unnoticed. Two minutes is
 * comfortably longer than any delivery and comfortably shorter than a customer
 * noticing, and a duplicate delivery is free — the engine's run key collides and
 * the second one does nothing.
 */
const AUTOMATION_REDISPATCH_SECONDS = 120;

/**
 * The furthest ahead a rule-derived automation rule may be parked (R4-2).
 *
 * NOT CONFIGURATION EITHER, and for the same reason: it is not a product
 * behaviour an owner tunes, it is the width of the window in which everything
 * this scheduler read about a rule is still assumed true. `nextTimedEvaluationAt`
 * computes the real next occurrence — often a day or a week away — from a local
 * moment measured once, and a workspace that moves zone, or a daylight-saving
 * shift, changes that answer underneath a rule that is already asleep. The cap
 * bounds how long a wrong park can last.
 *
 * ONE HOUR IS THE OCCURRENCE WINDOW ITSELF, so no timed rule is ever invisible
 * for longer than the thing it is waiting for. It also sets the honest capacity
 * statement for the sweep: with a minutely cadence, `batch` rules per pass
 * evaluates `batch × 60` rules an hour, and every timed rule needs one visit in
 * that hour. At the default batch of 200 that is 12,000 timed rules — past which
 * the batch, not the ordering, is what needs raising.
 */
const AUTOMATION_RULE_PARK_MAX_SECONDS = 3_600;

/**
 * How long one billing-cycle boundary may hold its transaction.
 *
 * The boundary is now the subscription's period transition AND the credit
 * reset that belongs to it, together. Twenty seconds is far longer than either
 * needs and far shorter than the sweep's own cadence, so a genuinely stuck
 * boundary fails and is retried rather than holding a connection.
 */
const CYCLE_BOUNDARY_TIMEOUT_MS = 20_000;

export interface MaintenanceResult {
  readonly ingestionDispatched: number;
  readonly chatContentPurged: number;
  readonly gatewayOutputsPurged: number;
  /** Phase 5B-1 — the Asset Library sweeps. */
  readonly assetJobsDispatched: number;
  readonly uploadSessionsExpired: number;
  readonly deletedAssetsPurged: number;
  /** Phase 6 — the publishing sweep. */
  readonly publishJobsCreated: number;
  readonly publishJobsDispatched: number;
  /** Jobs whose worker died mid-flight, handed to verification (D-143). */
  readonly publishJobsRecovered: number;
  /** Phase 7 — the analytics sweeps. */
  readonly analyticsCursorsDispatched: number;
  readonly analyticsBackfillsDispatched: number;
  readonly analyticsRowsPruned: number;
  /** Phase 7 remediation — the automation outbox (A1). */
  readonly automationEventsProduced: number;
  readonly automationEventsDispatched: number;
  readonly automationProposalsExpired: number;
  /**
   * Current execution Phase 3 — the financial sweeps.
   *
   * Every one of these numbers was previously unreachable in a running
   * deployment: the operations behind them existed, were tested, and had no
   * caller anywhere outside a test file. A monthly allowance nothing grants is
   * not a monthly allowance.
   */
  readonly creditReservationsSwept: number;
  readonly creditExpiryWorkspaces: number;
  readonly billingCyclesAdvanced: number;
  readonly cycleAllowancesGranted: number;
  readonly dunningSuspensions: number;
  readonly financialDriftsFound: number;
  /** Prototype v94 Phase 2B-1, A8 (D-328) — deletions whose waiting period ended. */
  readonly workspacesDeleted: number;
}

export interface SchedulerOptions {
  readonly environment: Environment;
  /** Injected so a test can drive the clock rather than wait for one. */
  readonly clock?: Clock;
}

export class MaintenanceScheduler {
  readonly #environment: Environment;
  readonly #clock: Clock;
  readonly #timers: NodeJS.Timeout[] = [];
  #running = false;

  constructor(options: SchedulerOptions) {
    this.#environment = options.environment;
    this.#clock = options.clock ?? systemClock;
  }

  async #cadence(): Promise<{
    ingestionReconcileSeconds: number;
    retentionPurgeSeconds: number;
    retentionPurgeBatch: number;
    ingestionReconcileBatch: number;
  }> {
    const configuration = new ConfigurationService({ prisma: getPlatformClient() });
    return (await configuration.get('operations', this.#environment)).maintenance;
  }

  /**
   * Re-dispatch ingestion jobs nothing has claimed.
   *
   * "Unclaimed" is QUEUED with its next attempt due — the same condition the
   * producer's dispatch races. A job already RUNNING is left alone: the worker
   * holds a lock on it, and re-dispatching would only queue a message the
   * processor will discard.
   */
  async reconcileIngestion(limit: number): Promise<number> {
    const waiting = await findUnclaimedIngestionJobs(getPlatformClient(), this.#clock.now(), limit);

    let dispatched = 0;
    for (const job of waiting) {
      const result = await enqueue('media-processing', INGEST_SOURCE_DOCUMENT, {
        kind: INGEST_SOURCE_DOCUMENT,
        workspaceId: job.workspaceId,
        // THE SAME KEY THE PRODUCER USES. BullMQ refuses a duplicate job id, so
        // a sweep racing a successful dispatch adds nothing rather than queuing
        // a second parse of the same document.
        idempotencyKey: `ingest-${job.id}`,
        ingestionJobId: job.id,
      } satisfies IngestSourceDocumentPayload);
      if (result.dispatched) dispatched += 1;
    }
    return dispatched;
  }

  /**
   * Clear content past its retention window — D-78, and F-72 closed.
   *
   * CONTENT ONLY. Both purges null the body and keep the row: the accounting
   * links are what the platform must retain for billing and audit, and deleting
   * the row would take them with it. That is a property of the two services
   * called here rather than a rule this file follows, so it cannot be lost by
   * editing the scheduler.
   */
  async purgeRetention(batch: number): Promise<{ chat: number; gateway: number }> {
    const platform = getPlatformClient();
    const now = this.#clock.now();

    /*
     * WHICH TENANTS, then each tenant's own context.
     *
     * `distinct` rather than a cross-tenant delete: the enumeration needs the
     * platform identity, the deletion does not, and doing the write inside
     * `withWorkspace` keeps it subject to the same RLS as every other write to
     * that table. A maintenance job is not a reason to widen a boundary.
     */
    const affected = await platform.brandBrainMessage.findMany({
      where: { expiresAt: { lt: now }, bodyPurgedAt: null, body: { not: null } },
      select: { workspaceId: true },
      distinct: ['workspaceId'],
      take: batch,
    });

    let chat = 0;
    const tenantPrisma = getPrisma();
    for (const { workspaceId } of affected) {
      chat += await withWorkspace(
        workspaceId,
        // The PURGE, not the chat service. This pass has a database handle and
        // a clock and can do nothing else — it cannot retrieve, cannot call a
        // provider and cannot spend a credit, because it was never handed the
        // collaborators that would let it.
        async (db) => purgeExpiredChatContent({ db, clock: this.#clock, limit: batch }),
        { prisma: tenantPrisma },
      );
    }

    // The gateway's own retained outputs, on the platform identity: `ai_request`
    // is a platform-owned table and has no tenant context to enter.
    const gateway = await this.#purgeGatewayOutputs(batch);

    return { chat, gateway };
  }

  async #purgeGatewayOutputs(batch: number): Promise<number> {
    const platform = getPlatformClient();
    // `ai_request` is PLATFORM-OWNED and has no tenant context to enter, so
    // this half runs on the platform identity. It reads the routing rules to
    // learn each task's window and nulls payloads past it — no ledger, no
    // adapter, no credential anywhere in reach.
    return purgeExpiredOutputs({
      prisma: platform,
      configuration: new ConfigurationAiSource(
        new ConfigurationService({ prisma: platform }),
        this.#environment,
      ),
      clock: this.#clock,
      limit: batch,
    });
  }

  /**
   * Re-dispatch asset processing jobs nothing has claimed.
   *
   * The same shape, the same condition and the same idempotency key discipline
   * as `reconcileIngestion` above: an asset waiting to be scanned is a customer
   * watching a spinner, and a lost queue message must cost punctuality rather
   * than correctness (R-08).
   */
  async reconcileAssetProcessing(limit: number): Promise<number> {
    const waiting = await findUnclaimedAssetJobs(getPlatformClient(), this.#clock.now(), limit);

    let dispatched = 0;
    for (const job of waiting) {
      const result = await enqueue('media-processing', PROCESS_ASSET, {
        kind: PROCESS_ASSET,
        workspaceId: job.workspaceId,
        // THE SAME KEY THE PRODUCER USES. BullMQ refuses a duplicate job id, so
        // a sweep racing a successful dispatch adds nothing rather than queuing
        // a second scan of the same asset.
        idempotencyKey: `asset-${job.id}`,
        processingJobId: job.id,
      } satisfies ProcessAssetPayload);
      if (result.dispatched) dispatched += 1;
    }
    return dispatched;
  }

  /**
   * Expire abandoned upload sessions and purge assets past their grace period.
   *
   * THE ENUMERATION IS CROSS-TENANT; THE WORK IS NOT. The platform identity
   * answers "which workspaces have something to sweep", and each sweep then
   * runs inside that workspace own RLS context — so a maintenance job never
   * widens a boundary for its own convenience (D-96).
   *
   * WHY AN EXPIRED SESSION MATTERS ENOUGH TO SWEEP. `initiate` spends storage
   * quota against the DECLARED size before any bytes arrive, so a customer
   * whose browser closed mid-upload is paying for a file that does not exist.
   * Without this, a flaky connection quietly consumes a plan.
   */
  async sweepAssets(batch: number): Promise<{ sessions: number; purged: number }> {
    const platform = getPlatformClient();
    const now = this.#clock.now();

    const sessionWorkspaces = await platform.assetUploadSession.findMany({
      where: { status: 'PENDING', expiresAt: { lte: now } },
      select: { workspaceId: true },
      distinct: ['workspaceId'],
      take: batch,
    });
    const purgeCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1_000);
    const purgeWorkspaces = await platform.asset.findMany({
      where: { deletedAt: { lte: purgeCutoff }, storageKey: { not: '' } },
      select: { workspaceId: true },
      distinct: ['workspaceId'],
      take: batch,
    });

    const workspaceIds = new Set<string>([
      ...sessionWorkspaces.map((row) => row.workspaceId),
      ...purgeWorkspaces.map((row) => row.workspaceId),
    ]);

    const tenantPrisma = getPrisma();
    const store = createObjectStore({ appEnv: process.env['APP_ENV'] ?? 'development' });
    let sessions = 0;
    let purged = 0;

    for (const workspaceId of workspaceIds) {
      const result = await withWorkspace(
        workspaceId,
        async (db) => {
          // The SAME configuration the dashboard and the worker read, through
          // the same tenant-side projection. A sweep with its own retention
          // window would be a second setting an operator cannot see.
          const policy = await new TenantAssetPolicySource(db, this.#environment).load();
          const maintenance = new AssetMaintenanceService({
            db,
            workspaceId,
            store,
            policy,
            /*
             * The SCOPED client, cast the way every other caller casts it. A
             * scoped client is a PrismaClient minus the connection-lifecycle
             * and transaction methods, which is exactly the surface UsageService
             * uses; it detects the absence of `$transaction` and runs inline,
             * so the refund commits with the sweep rather than beside it.
             */
            usage: new UsageService({ prisma: db as unknown as PrismaClient }),
            clock: this.#clock,
          });
          const expired = await maintenance.expireStaleSessions();
          const deleted = await maintenance.purgeDeletedAssets();
          return { expired: expired.expired, purged: deleted.purged };
        },
        { prisma: tenantPrisma },
      );
      sessions += result.expired;
      purged += result.purged;
    }

    return { sessions, purged };
  }

  /**
   * Phase 6 — turn due calendar slots into publish jobs, and dispatch them.
   *
   * WHY A SWEEP AND NOT ONLY A DELAYED JOB. docs/SOCIAL-INTEGRATIONS.md §8:
   * "the delayed job is an optimization; a reconciliation sweeper runs every
   * minute for slots that are due and unclaimed, so a Redis failure costs
   * punctuality, not correctness." Without it, "Redis restarted on Tuesday"
   * means "these customers' posts never went out", with nothing anywhere saying
   * so.
   *
   * THE ENUMERATION IS CROSS-TENANT AND THE WORK IS NOT. Which workspaces have
   * something due needs the platform identity; everything that reads or writes
   * a tenant row happens inside that tenant's own `withWorkspace` context, so a
   * maintenance pass has no wider reach than the tenant itself
   * (F-07, docs/SECURITY.md §2.1 layer 8).
   *
   * BOTH HALVES ARE IDEMPOTENT. Materialising a slot twice finds the same
   * derived idempotency keys and creates nothing; dispatching a job twice is a
   * BullMQ job id collision. A pass that runs while the previous one is still
   * finishing is therefore safe rather than merely unlikely.
   */
  async sweepPublishing(
    batch: number,
  ): Promise<{ created: number; dispatched: number; recovered: number }> {
    const platform = getPlatformClient();
    const now = this.#clock.now();

    /*
     * DUE SLOTS FIRST. A slot is due when it is SCHEDULED and its instant has
     * passed. PUBLISHING slots are already materialised; their jobs are found
     * by the second query below.
     */
    const dueSlots = await platform.calendarSlot.findMany({
      where: {
        status: 'SCHEDULED',
        scheduledAtUtc: { lte: now },
        // A8 (D-328): nothing publishes from a workspace pending deletion.
        workspace: { deletionScheduledFor: null },
      },
      select: { id: true, workspaceId: true },
      orderBy: { scheduledAtUtc: 'asc' },
      take: batch,
    });

    const tenantPrisma = getPrisma();
    const environment = this.#environment;
    let created = 0;

    const byWorkspace = new Map<string, string[]>();
    for (const slot of dueSlots) {
      byWorkspace.set(slot.workspaceId, [...(byWorkspace.get(slot.workspaceId) ?? []), slot.id]);
    }

    for (const [workspaceId, slotIds] of byWorkspace) {
      created += await withWorkspace(
        workspaceId,
        async (db) => {
          const policy = await resolvePublishingPolicy(
            new ConfigurationService({ prisma: platform }),
            environment,
          );
          const contentPolicy = await new TenantContentPolicySource(db, environment).load();
          const pipeline = new PublishPipelineService({
            db,
            workspaceId,
            policy,
            registry: createConnectorRegistry({ policy, environment }),
            vault: new SocialTokenVault(),
            // THE APPROVAL GATE, consulted before a job exists at all. The
            // second consultation happens in the worker, immediately before the
            // external call (docs/SOCIAL-INTEGRATIONS.md §6.2).
            approvals: new ContentApprovalService({
              db,
              workspaceId,
              policy: contentPolicy,
            }),
            clock: this.#clock,
          });
          let made = 0;
          for (const slotId of slotIds) {
            const result = await pipeline.materialiseSlot(slotId);
            made += result.created;
          }
          return made;
        },
        { prisma: tenantPrisma },
      );
    }

    /*
     * THEN DISPATCH WHATEVER IS WAITING — including jobs a previous pass
     * created, jobs whose backoff has elapsed, and jobs whose queue message was
     * lost. `nextAttemptAt` is the single condition, so the retry schedule the
     * pipeline wrote is the schedule this honours.
     */
    const waiting = await platform.publishJob.findMany({
      where: {
        status: 'QUEUED',
        nextAttemptAt: { lte: now },
        workspace: { deletionScheduledFor: null },
      },
      select: { id: true, workspaceId: true, idempotencyKey: true, nextAttemptAt: true },
      orderBy: { nextAttemptAt: 'asc' },
      take: batch,
    });

    let dispatched = 0;
    for (const job of waiting) {
      const result = await enqueue('publish-jobs', PUBLISH_SOCIAL_POST, {
        kind: PUBLISH_SOCIAL_POST,
        workspaceId: job.workspaceId,
        /*
         * THE JOB'S OWN DERIVED KEY, PER SCHEDULED ATTEMPT. BullMQ refuses a
         * duplicate job id, so a sweep racing a successful dispatch of the SAME
         * attempt adds nothing. The attempt's time is part of the id because
         * BullMQ also keeps finished jobs: a job sent back to QUEUED for a later
         * look — a retry, or a post waiting for its account to be reconnected
         * (Q9, D-332) — would otherwise be refused as a duplicate of its own
         * first run and never looked at again. A second delivery of anything is
         * still harmless: `execute()` claims QUEUED once.
         */
        idempotencyKey: `${job.idempotencyKey}-${job.nextAttemptAt?.getTime() ?? 0}`,
        publishJobId: job.id,
      } satisfies PublishSocialPostPayload);
      if (result.dispatched) dispatched += 1;
    }

    /*
     * AND THEN THE JOBS NOBODY WAS LOOKING AT (D-143).
     *
     * `execute()` moves a job to PUBLISHING before the external call — the
     * right order, because a process that dies in between leaves a row already
     * saying "we may have sent this". But the sweep above only ever considered
     * QUEUED, so such a row sat at PUBLISHING for ever: the post possibly live,
     * the customer shown "Publishing", and nothing in the system due to look at
     * it again. A worker crash was an unbounded stall, silently.
     *
     * PAST ITS LEASE, A CLAIM IS TREATED AS ABANDONED — and as nothing more
     * than that. The message dispatched here is `social.verify-post`, a
     * DIFFERENT kind reaching a different processor that can only ASK the
     * provider what happened. A timer never authorises a send.
     */
    const lease = await this.#publishingPolicy();
    const staleBefore = new Date(now.getTime() - lease.claimLeaseSeconds * 1_000);
    const stale = await platform.publishJob.findMany({
      where: { status: 'PUBLISHING', claimedAt: { lt: staleBefore } },
      select: { id: true, workspaceId: true, idempotencyKey: true },
      orderBy: { claimedAt: 'asc' },
      take: lease.staleClaimBatchSize,
    });

    let recovered = 0;
    for (const job of stale) {
      const result = await enqueue('publish-jobs', VERIFY_SOCIAL_POST, {
        kind: VERIFY_SOCIAL_POST,
        workspaceId: job.workspaceId,
        // A DISTINCT QUEUE ID FROM THE PUBLISH MESSAGE for the same job, so a
        // verification is never de-duplicated against the publish that stalled.
        idempotencyKey: `verify:${job.idempotencyKey}`,
        publishJobId: job.id,
      } satisfies VerifySocialPostPayload);
      if (result.dispatched) recovered += 1;
    }

    return { created, dispatched, recovered };
  }

  /**
   * Phase 7 — dispatch the analytics cursors that are due, and the backfills.
   *
   * THE ENUMERATION IS CROSS-TENANT AND THE WORK IS NOT, exactly as the
   * publishing sweep is. Which cursors are due needs the platform identity;
   * everything that reads or writes a tenant row happens on the WORKER, inside
   * that tenant's own `withWorkspace` context. This pass only decides who gets a
   * message.
   *
   * IT DOES NOT CLAIM. The claim is the worker's conditional UPDATE, which is
   * what makes two schedulers safe; a sweep that claimed here and dispatched
   * afterwards would hold a claim across a queue hop and stall every cursor whose
   * message was lost.
   *
   * BOTH HALVES ARE IDEMPOTENT. The cursor id is the BullMQ job id, so a sweep
   * racing a successful dispatch adds nothing; and a duplicate delivery collides
   * on the ingestion run's derived key rather than fetching twice.
   */
  async sweepAnalytics(batch: number): Promise<{ dispatched: number; backfills: number }> {
    const platform = getPlatformClient();
    const now = this.#clock.now();

    /*
     * ENSURE THE CURSORS BEFORE LOOKING FOR DUE ONES — the wiring that did not
     * exist, and then the half of it that did not self-heal.
     *
     * `ensureIngestionCursors` was written, correct and unreachable: nothing in
     * the product called it, so no `analytics_ingestion_cursor` row was ever
     * created, so the enumeration below found an empty set on every tick and
     * analytics ingestion never ran. The module was complete down to its retry
     * backoff and had no way in.
     *
     * THE SWEEP IS THE RIGHT ENTRY POINT rather than the moment a connection is
     * activated. `@brandspace/social-connectors` cannot call analytics — the
     * dependency runs the other way, and reversing it is a cycle — and a
     * connect-time hook would also be a one-shot: a provider that gains a
     * capability, a connection reactivated after a disconnect, and every
     * account connected before this existed would all be left without cursors
     * for ever. A housekeeping pass is self-healing by construction.
     *
     * THE FIRST ENUMERATION WAS NOT (D-229). It asked for ACTIVE connections
     * with `analyticsCursors: { none: {} }` — no cursor AT ALL — which repairs
     * "never provisioned" and nothing else. A connection holding a PARTIAL set
     * stopped matching and was skipped for ever: an adapter that later declares
     * `supportsPostMetrics`, a `supportedGranularities` that grows a value, one
     * insert that failed, a row an operator removed. `ensureIngestionCursors`
     * always inserted the COMPLETE required set; only the question was too
     * narrow.
     *
     * SO THE SWEEP ROTATES OVER EVERY ACTIVE CONNECTION instead, ordered by
     * `analyticsCursorsEnsuredAt ASC NULLS FIRST` and bounded by the same
     * `batch` as the rest of this sweep. Never-ensured first, then
     * least-recently-ensured — the ordering R4-2 established two queries below,
     * and the durable cursor D-182 requires: dropping the filter without one
     * would return the same head of the queue on every tick and starve the tail
     * past `batch`.
     *
     * THE PARK IS WRITTEN INSIDE THE TENANT'S OWN TRANSACTION, with the ensure
     * it records, so the two commit together (D-186's shape). A workspace whose
     * ensure throws is NOT parked, so it comes back at the front of the queue
     * rather than being marked done.
     *
     * NOTHING HERE RESETS INGESTION STATE. The insert is ON CONFLICT DO NOTHING,
     * so a cursor that already exists keeps its progress, its backoff and its
     * freshness untouched; this pass can only ADD the rows that are missing.
     *
     * THE ENUMERATION IS CROSS-TENANT AND THE WORK IS NOT, exactly as the rest
     * of this sweep. The platform identity answers WHICH connections are due a
     * pass; the cursors and the park are written inside that tenant's own
     * `withWorkspace` context, on the tenant client, under RLS.
     */
    const dueForEnsure = await platform.socialConnection.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, workspaceId: true },
      orderBy: [{ analyticsCursorsEnsuredAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      take: batch,
    });
    if (dueForEnsure.length > 0) {
      const registry = createAnalyticsRegistry({ environment: this.#environment });
      // One pass per WORKSPACE, because `ensureIngestionCursors` covers a whole
      // workspace in one statement; the ids are what gets parked afterwards.
      const byWorkspace = new Map<string, string[]>();
      for (const row of dueForEnsure) {
        const seen = byWorkspace.get(row.workspaceId);
        if (seen) seen.push(row.id);
        else byWorkspace.set(row.workspaceId, [row.id]);
      }
      for (const [workspaceId, connectionIds] of byWorkspace) {
        try {
          await withWorkspace(
            workspaceId,
            async (db) => {
              await ensureIngestionCursors({ db, workspaceId, registry });
              await db.socialConnection.updateMany({
                where: { id: { in: connectionIds } },
                data: { analyticsCursorsEnsuredAt: now },
              });
            },
            { prisma: getPrisma() },
          );
        } catch (error: unknown) {
          // ONE WORKSPACE'S FAILURE IS NOT THE SWEEP'S. Its connections keep a
          // null or older stamp, so the next tick reaches them first, and the
          // workspaces after this one still get their cursors.
          log.warn('could not ensure analytics cursors', {
            workspaceId,
            ...internalErrorFields(error),
          });
        }
      }
    }

    const due = await platform.analyticsIngestionCursor.findMany({
      where: {
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        // A cursor a worker is actively holding is left alone. The lease is
        // re-checked by the worker's own claim; this only avoids a pointless
        // message.
        connection: { status: 'ACTIVE' },
      },
      select: { id: true, workspaceId: true, backfillCompletedAt: true, lastSucceededAt: true },
      /*
       * NULLS FIRST, EXPLICITLY (R4-2, adjacent audit).
       *
       * `ORDER BY … ASC` puts NULLs LAST in PostgreSQL, and `nextAttemptAt` is
       * null for a cursor that has NEVER been attempted — a connection somebody
       * has just authorised. So plain ascending order sent exactly the cursors
       * with the most waiting to happen to the back of the queue, and on a
       * platform with more than `batch` due cursors a brand new connection
       * could have waited behind them indefinitely. Same starvation shape as
       * the automation producers, reached through a nullable column instead of
       * a missing one; the id breaks ties so the order is total.
       */
      orderBy: [{ nextAttemptAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      take: batch,
    });

    let dispatched = 0;
    let backfills = 0;
    for (const cursor of due) {
      const result = await enqueue('analytics-ingest', INGEST_ANALYTICS, {
        kind: INGEST_ANALYTICS,
        workspaceId: cursor.workspaceId,
        // THE CURSOR ID IS THE KEY. BullMQ refuses a duplicate job id, so a sweep
        // racing a successful dispatch adds nothing rather than queuing a second
        // pull of the same window.
        idempotencyKey: `analytics-${cursor.id}`,
        cursorId: cursor.id,
      } satisfies IngestAnalyticsPayload);
      if (result.dispatched) dispatched += 1;

      /*
       * A BACKFILL IS ONLY OFFERED TO A CURSOR THAT HAS ALREADY SUCCEEDED ONCE.
       * Walking ninety days backwards for an account we have never managed to
       * read is spending a rate limit to confirm we still cannot read it.
       */
      if (cursor.backfillCompletedAt === null && cursor.lastSucceededAt !== null) {
        const backfill = await enqueue('analytics-ingest', BACKFILL_ANALYTICS, {
          kind: BACKFILL_ANALYTICS,
          workspaceId: cursor.workspaceId,
          // A DISTINCT QUEUE ID from the scheduled pull for the same cursor, so a
          // backfill is never de-duplicated against it.
          idempotencyKey: `analytics-backfill-${cursor.id}`,
          cursorId: cursor.id,
        } satisfies BackfillAnalyticsPayload);
        if (backfill.dispatched) backfills += 1;
      }
    }

    return { dispatched, backfills };
  }

  /**
   * Phase 7 — prune analytics past its retention window (D-116/D-117).
   *
   * ON THE PLATFORM IDENTITY, because "which rows are past their window" is not a
   * question any single tenant can ask — and because the tenant role has no
   * DELETE on `analytics_ingestion_run` at all, by design.
   *
   * IT NEVER TOUCHES A LEDGER OR THE AUDIT LOG. `pruneAnalytics` deletes
   * observations, run records and expired insights and nothing else, and
   * `pruneCopilot` only nulls message bodies and expires plans that never ran; a
   * retention control able to erase a financial or a security record would be a
   * control that erases evidence.
   */
  async pruneAnalyticsRetention(batch: number): Promise<number> {
    const platform = getPlatformClient();
    const policy = await resolveAnalyticsPolicy(
      new ConfigurationService({ prisma: platform }),
      this.#environment,
    );
    const pruned = await pruneAnalytics({
      prisma: platform,
      policy,
      clock: this.#clock,
      limit: batch,
    });

    /*
     * THE COPILOT'S OWN ARTEFACTS, PRUNED BY THEIR OWN OWNER in the same pass.
     * Two functions rather than one because the treatments differ — an analytics
     * row is deleted, a Copilot message body is NULLED and stamped so the row
     * survives for the audit trail that points at it — and a single function
     * doing both would hide that difference behind one name.
     */
    const copilotPolicy = await resolveCopilotPolicy(
      new ConfigurationService({ prisma: platform }),
      this.#environment,
    );
    const copilot = await pruneCopilot({
      prisma: platform,
      policy: copilotPolicy,
      clock: this.#clock,
      limit: batch,
    });

    return (
      pruned.observations +
      pruned.runs +
      pruned.insights +
      copilot.messageBodiesPurged +
      copilot.plansExpired +
      copilot.sessionsArchived
    );
  }

  /** The dispatch half of the publishing policy, read once per pass. */
  async #publishingPolicy(): Promise<{ claimLeaseSeconds: number; staleClaimBatchSize: number }> {
    const policy = await resolvePublishingPolicy(
      new ConfigurationService({ prisma: getPlatformClient() }),
      this.#environment,
    );
    return {
      claimLeaseSeconds: policy.dispatch.claimLeaseSeconds,
      staleClaimBatchSize: policy.dispatch.staleClaimBatchSize,
    };
  }

  /**
   * Phase 7 remediation — PRODUCE the rule-derived automation events, then
   * DISPATCH everything the outbox is holding (A1).
   *
   * THIS METHOD IS THE ANSWER TO "WHO FIRES AN AUTOMATION?", and until it existed
   * the answer was nobody. The worker held a complete `automation.evaluate`
   * consumer, the engine knew how to de-duplicate a delivery, the dashboard let a
   * customer author a rule — and no code path in the platform ever enqueued one.
   *
   * IT HAS TWO HALVES, AND THEY ARE DIFFERENT KINDS OF WORK.
   *
   *   PRODUCING is only for the two triggers whose identity is read off a RULE
   *   rather than off a row: a schedule and a threshold. Nothing happens in the
   *   product when nine o'clock arrives, so somebody has to look at the clock;
   *   nothing happens when a number crosses a line, so somebody has to compare
   *   it. The four domain triggers need none of this — their producers are in
   *   the domain services, writing a row inside the transaction that caused it.
   *
   *   DISPATCHING is for every event, whoever wrote it, and it is the
   *   reconciliation docs/ARCHITECTURE.md §9 describes: the durable row is the
   *   truth, the queue message is an optimisation, and a message that is never
   *   delivered is re-sent on the next pass. A lost Redis therefore costs
   *   punctuality and not correctness — which is the property the whole outbox
   *   exists to buy.
   *
   * THE ENUMERATION IS CROSS-TENANT AND THE WORK IS NOT, exactly as the
   * publishing and analytics sweeps are (F-07). Which rules are due needs the
   * platform identity; every row this method READS OR WRITES inside a workspace
   * is written through `withWorkspace`, under that tenant's own RLS context.
   *
   * ON BRANDSCOPE. There is no caller here, and no member's scope to carry: the
   * sweep is the clock, and a rule's brand is fixed on the rule. That is not the
   * "empty scope as a convenient bypass" this platform refuses — nothing here
   * ACTS. Producing an event authorizes nothing; the engine re-resolves the
   * rule creator's live permissions and BrandScope before any action runs, and
   * an external one still stops for a human.
   */
  async sweepAutomations(batch: number): Promise<{
    produced: number;
    dispatched: number;
    expired: number;
  }> {
    const produced =
      (await this.#produceTimedEvents(batch)) + (await this.#produceThresholdEvents(batch));
    const dispatched = await this.#dispatchAutomationEvents(batch);
    const expired = await this.#expireAutomationProposals(batch);
    return { produced, dispatched, expired };
  }

  /**
   * Close the proposals nobody confirmed (R3-4).
   *
   * WITHOUT THIS THE SCREEN LIES. An external action stops at
   * `AWAITING_CONFIRMATION` with a window on it; when the window closes the run
   * stays in that status for ever, and a Confirm control keeps offering to
   * authorise something that can no longer be authorised — and, worse, something
   * whose content is by then days stale. `EXPIRED` is the ending, and it is
   * distinct from `CANCELLED` because cancelled is a decision somebody made.
   *
   * THE DIGEST IS CLEARED WITH IT, so a credential minted moments before the
   * window closed cannot be spent afterwards.
   *
   * IT IS THE TENANT'S OWN WRITE. Only the enumeration is cross-tenant (F-07).
   */
  async #expireAutomationProposals(batch: number): Promise<number> {
    const platform = getPlatformClient();
    const now = this.#clock.now();

    const stale = await platform.automationRun.findMany({
      where: {
        status: 'AWAITING_CONFIRMATION',
        confirmedAt: null,
        confirmationExpiresAt: { lt: now },
      },
      select: { id: true, workspaceId: true },
      orderBy: { startedAt: 'asc' },
      take: batch,
    });

    let expired = 0;
    for (const run of stale) {
      const closed = await withWorkspace(
        run.workspaceId,
        (db) =>
          db.automationRun.updateMany({
            // CONDITIONAL, so a confirmation landing in the same instant wins
            // rather than being erased by the sweep.
            where: {
              id: run.id,
              workspaceId: run.workspaceId,
              status: 'AWAITING_CONFIRMATION',
              confirmedAt: null,
              confirmationExpiresAt: { lt: now },
            },
            data: {
              status: 'EXPIRED',
              failureCode: 'confirmation_window_closed',
              confirmationTokenHash: null,
              finishedAt: now,
            },
          }),
        { prisma: getPrisma() },
      );
      if (closed.count > 0) expired += 1;
    }
    return expired;
  }

  /**
   * Write one event per timed rule that is due in its workspace's own hour.
   *
   * THE ZONE IS THE WORKSPACE'S, ALWAYS. A rule that says 09:00 means 09:00
   * where the customer is, and `localMomentFor` asks `Intl` rather than doing
   * offset arithmetic — which is wrong twice a year in every zone that observes
   * daylight saving, on exactly the mornings a customer would notice.
   *
   * THE OCCURRENCE KEY IS WHAT MAKES A MINUTELY SWEEP SAFE. Sixty passes inside
   * the nine-o'clock hour derive the same `2026-09-17T09`, and
   * `@@unique([workspaceId, dedupeKey])` turns fifty-nine of them into nothing.
   */
  async #produceTimedEvents(batch: number): Promise<number> {
    const platform = getPlatformClient();
    const now = this.#clock.now();

    /*
     * THE OLDEST-DUE RULES, NOT AN ARBITRARY `batch` OF THEM (R4-2).
     *
     * This query used to have no ordering and no cursor. An outbox row retires
     * — `deliveredAt` takes it out of its own query — but AN EVALUATED RULE DOES
     * NOT: it is enabled before the sweep and enabled after it, so the identical
     * query next minute was free to return the identical subset, and past
     * `batch` rules the ones outside it were never evaluated at all. For this
     * trigger that is not lateness. The whole meaning of the trigger is "in the
     * customer's own hour", and an hour nobody looked at is an occurrence missed
     * permanently and silently.
     *
     * `nextEvaluationAt` makes it a QUEUE. A rule reaches the front by waiting
     * and leaves it by being visited, so every enabled rule is evaluated within
     * ceil(rules / batch) passes and no rule can hold the front. A rule nowhere
     * near due is parked out of the way, so it is not competing for the batch
     * with the ones that are.
     */
    const rules = await platform.automationRule.findMany({
      where: {
        triggerType: 'SCHEDULED_TIME',
        enabled: true,
        deletedAt: null,
        nextEvaluationAt: { lte: now },
      },
      select: { id: true, workspaceId: true, brandId: true, nextEvaluationAt: true },
      // The id breaks ties, so the order is TOTAL. Two rules parked in the same
      // pass share a timestamp, and "whichever the planner felt like" is the
      // property this cursor exists to remove.
      orderBy: [{ nextEvaluationAt: 'asc' }, { id: 'asc' }],
      take: batch,
    });
    if (rules.length === 0) return 0;

    const zones = await this.#timezonesFor(
      platform,
      rules.map((rule) => rule.workspaceId),
    );

    let produced = 0;
    for (const rule of rules) {
      const zone = zones.get(rule.workspaceId) ?? 'UTC';
      const written = await withWorkspace(
        rule.workspaceId,
        async (db) => {
          /*
           * RE-READ INSIDE THE TENANT'S OWN TRANSACTION, and take the
           * CONFIGURATION from here rather than from the enumeration.
           *
           * The platform enumeration is a snapshot. Between it and this
           * transaction the rule may have been disabled, soft-deleted or
           * edited, and producing an event for a rule somebody has just
           * switched off is exactly the kind of "it fired after I stopped it"
           * a person cannot argue with. Enumeration is the only cross-tenant
           * half (F-07); the decision is made here, under RLS.
           */
          const live = await db.automationRule.findFirst({
            where: {
              id: rule.id,
              workspaceId: rule.workspaceId,
              enabled: true,
              deletedAt: null,
            },
            select: { brandId: true, triggerConfig: true },
          });
          if (!live) return false;

          const moment = localMomentFor(now, zone);
          const due = timedRuleIsDue({ config: live.triggerConfig, moment });
          const wrote = due.due
            ? await recordRuleAutomationEvent(db, rule.workspaceId, {
                triggerType: 'SCHEDULED_TIME',
                brandId: live.brandId,
                ruleId: rule.id,
                occurrence: due.occurrence,
              })
            : false;

          /*
           * THE EVENT AND THE PARK COMMIT TOGETHER, in this one transaction.
           * Parking first would lose the occurrence if the process died between
           * the two; producing first and parking in a separate write would
           * leave the rule at the front of the queue on a crash. One
           * transaction has neither failure: it either happened or it did not,
           * and a rule that did not is simply still due.
           *
           * `lte: now` RATHER THAN AN EXACT COMPARE-AND-SWAP. A second
           * scheduler that has already parked this rule into the future must
           * not have its park undone, and a timestamp read back through
           * millisecond-precision `Date` cannot be compared for equality
           * against a microsecond column with any confidence.
           */
          await db.automationRule.updateMany({
            where: {
              id: rule.id,
              workspaceId: rule.workspaceId,
              nextEvaluationAt: { lte: now },
            },
            data: {
              nextEvaluationAt: nextTimedEvaluationAt({
                config: live.triggerConfig,
                moment,
                now,
                maxAheadSeconds: AUTOMATION_RULE_PARK_MAX_SECONDS,
              }),
              lastEvaluatedAt: now,
            },
          });
          return wrote;
        },
        { prisma: getPrisma() },
      );
      if (written) produced += 1;
    }
    return produced;
  }

  /**
   * Write one event per threshold rule whose metric has just CROSSED its line.
   *
   * CROSSED, NOT "IS PAST". The window that ends now must be on the far side and
   * the window that ended one period earlier must not have been. A rule that
   * fired while the number merely STAYED above would fire on every pass, for as
   * long as the number stayed there, which for a growing brand is for ever — and
   * a rule that notifies you every minute is a rule you switch off.
   *
   * THE WINDOW VALUE COMES FROM `AnalyticsQueryService`, and that is deliberate
   * rather than convenient: it is the one place that knows a level metric's
   * window value is its LATEST reading per subject and an additive one's is a
   * sum (P7-R7). Computing it again here would be a second answer to a question
   * that already has one, and the two would drift.
   */
  async #produceThresholdEvents(batch: number): Promise<number> {
    const platform = getPlatformClient();
    const now = this.#clock.now();

    /*
     * THE SAME FAIR-WORK CURSOR THE TIMED PRODUCER USES (R4-2), for the same
     * reason: a threshold rule does not retire either, so an unordered `take`
     * could return the same subset for ever and the memory of every rule
     * outside it would never advance — a crossing nobody was watching for.
     *
     * A THRESHOLD RULE IS PARKED TO `now`, NOT INTO THE FUTURE. There is no due
     * time to compute: the question "has the number moved across the line" is
     * worth asking on every pass. Parking it to the current instant keeps it
     * eligible while sending it to the BACK of the queue, which is exactly what
     * round-robin over more rules than one batch requires.
     */
    const rules = await platform.automationRule.findMany({
      where: {
        triggerType: 'METRIC_THRESHOLD_CROSSED',
        enabled: true,
        deletedAt: null,
        nextEvaluationAt: { lte: now },
      },
      select: { id: true, workspaceId: true },
      orderBy: [{ nextEvaluationAt: 'asc' }, { id: 'asc' }],
      take: batch,
    });
    if (rules.length === 0) return 0;

    let produced = 0;
    for (const rule of rules) {
      /*
       * THE SEMANTICS ARE THE PACKAGE'S, THE ENUMERATION IS THIS FILE'S.
       *
       * What a crossing MEANS — the remembered side, the arming cycle, the
       * compare-and-swap — lives in `@brandspace/automation`, where a test can
       * drive the real code instead of a copy of it written in the test. All
       * this loop decides is which rules to look at, which is the cross-tenant
       * question F-07 keeps here.
       */
      const outcome = await withWorkspace(
        rule.workspaceId,
        async (db) => {
          /*
           * RE-READ UNDER RLS, AND TAKE THE RULE'S STATE FROM HERE. A rule
           * disabled or deleted between the enumeration and this transaction
           * must not produce anything, and its remembered side must be the one
           * this transaction will compare-and-swap against rather than a
           * snapshot taken on another connection.
           */
          const live = await db.automationRule.findFirst({
            where: {
              id: rule.id,
              workspaceId: rule.workspaceId,
              enabled: true,
              deletedAt: null,
            },
            select: {
              id: true,
              workspaceId: true,
              brandId: true,
              triggerConfig: true,
              thresholdBreached: true,
              thresholdCycle: true,
            },
          });
          if (!live) return 'no_observation' as const;

          const result = await evaluateThresholdRule({
            db,
            workspaceId: rule.workspaceId,
            rule: live,
            metrics: createMetricWindowPort({
              db,
              workspaceId: rule.workspaceId,
              environment: this.#environment,
              clock: this.#clock,
            }),
            now,
          });

          // The event, the threshold memory and the park commit together.
          await db.automationRule.updateMany({
            where: {
              id: rule.id,
              workspaceId: rule.workspaceId,
              nextEvaluationAt: { lte: now },
            },
            data: { nextEvaluationAt: now, lastEvaluatedAt: now },
          });
          return result;
        },
        { prisma: getPrisma() },
      );
      if (outcome === 'fired') produced += 1;
    }
    return produced;
  }

  /**
   * Hand every undelivered event to the worker.
   *
   * `deliveredAt` IS THE ONLY FIELD THAT RETIRES A ROW, and `dispatchedAt` is
   * advisory. A dispatch that was accepted and then lost — Redis restarted, the
   * worker died between the two — leaves a row that LOOKS dispatched and was
   * never delivered, so a row whose dispatch is older than the re-dispatch floor
   * is sent again. A duplicate delivery is free: the engine's run key collides
   * and the second delivery does nothing (P7-R5).
   *
   * THE EVENT ID IS THE QUEUE JOB ID, so a sweep racing a successful dispatch
   * adds nothing rather than queuing the same event twice inside one minute.
   */
  async #dispatchAutomationEvents(batch: number): Promise<number> {
    const platform = getPlatformClient();
    const now = this.#clock.now();
    const redispatchFloor = new Date(now.getTime() - AUTOMATION_REDISPATCH_SECONDS * 1_000);

    const waiting = await platform.automationEvent.findMany({
      where: {
        deliveredAt: null,
        OR: [{ dispatchedAt: null }, { dispatchedAt: { lt: redispatchFloor } }],
      },
      orderBy: { createdAt: 'asc' },
      take: batch,
    });

    let dispatched = 0;
    for (const event of waiting) {
      const result = await enqueue('analytics-ingest', EVALUATE_AUTOMATION, {
        kind: EVALUATE_AUTOMATION,
        workspaceId: event.workspaceId,
        idempotencyKey: `automation-event-${event.id}`,
        eventId: event.id,
        // THE IDENTITY THE PRODUCER CHOSE, carried so the engine's run key is
        // built from the same notion of "the same event" the outbox is (R6).
        eventKey: event.dedupeKey,
        brandId: event.brandId,
        triggerType: event.triggerType,
        refType: event.refType,
        refId: event.refId,
        ruleId: event.ruleId,
        occurrence: event.occurrence,
      } satisfies EvaluateAutomationPayload);
      if (!result.dispatched) continue;
      /*
       * THE BOOKKEEPING IS WRITTEN IN THE TENANT'S OWN CONTEXT, not on the
       * platform connection that just enumerated the row.
       *
       * ONLY THE ENUMERATION IS CROSS-TENANT — that is the whole of F-07 and it
       * is what every other sweep in this file does. Writing back through the
       * platform client would have made this the one place in the scheduler that
       * MUTATES a tenant row with RLS bypassed, and the exception would have been
       * for stamping a timestamp, which is the least defensible reason to make
       * one.
       */
      await withWorkspace(
        event.workspaceId,
        (db) =>
          db.automationEvent.updateMany({
            where: { id: event.id, workspaceId: event.workspaceId },
            data: { dispatchedAt: now, attempts: { increment: 1 } },
          }),
        { prisma: getPrisma() },
      );
      dispatched += 1;
    }
    return dispatched;
  }

  // ---------------------------------------------------------------------------
  // Current execution Phase 3 — Billing & Entitlements Operations.
  //
  // WHAT WAS ACTUALLY MISSING. The credit ledger, the subscription lifecycle
  // and the dunning ladder were all implemented and all tested, and between
  // them they had ZERO callers outside `tests/`. `SubscriptionService.dueForCycle`
  // — a method whose whole purpose is to be the input to a sweep — had no caller
  // at all. So in a running deployment: lapsed credits never expired, an
  // abandoned reservation held a customer's balance for ever, the monthly
  // allowance was granted once at plan assignment and never again, a scheduled
  // downgrade never took effect, `cancelAtPeriodEnd` never ended anything, and a
  // past-due subscription never escalated. None of that is visible from reading
  // the services, which are correct; it is visible only by asking who calls them.
  //
  // WHY THE PLATFORM CLIENT. The credit tables are tenant-owned, and the ledger's
  // WRITE identity everywhere in the product is already the platform client —
  // `apps/api/src/routes/content.ts`, `phase7-context.ts` and `phase9-context.ts`
  // all construct it that way, because reserve/settle/release run on behalf of a
  // request the tenant cannot be inside (and `#lockWallet` is raw SQL the tenant
  // role is not granted). This sweep uses the same identity as the code path it
  // maintains rather than inventing a second one. Dunning is the exception and
  // runs under `withWorkspace`: `advanceDunning` takes a `TenantScopedClient` and
  // writes the tenant's own audit event, exactly as the commerce routes call it.
  //
  // EVERY PASS IS BOUNDED, STABLY ORDERED AND SAFE TO REPEAT. One workspace's
  // failure is logged and the loop continues — a single bad row must not stop
  // every other customer's billing — and every operation underneath is keyed so
  // that a duplicated tick, or two API instances sweeping at once, changes
  // nothing the first one already did.
  // ---------------------------------------------------------------------------

  /**
   * Where the reconciliation pass got to.
   *
   * DELIBERATELY IN MEMORY, unlike the analytics cursor D-182 makes durable. The
   * difference is what is lost by forgetting: an analytics cursor that resets
   * re-reads a provider window and can MISS data it already passed, while a
   * reconciliation that starts again from the beginning merely re-checks
   * workspaces it has already checked. Re-checking is the safe direction, and it
   * buys the rotation without a migration for a table that would hold one row.
   */
  #rotation: RotationState = ROTATION_START;

  /**
   * The commercial configuration one financial pass needs.
   *
   * READ PER PASS, not cached: an owner activating a new credits policy or plan
   * catalogue must take effect on the next sweep, and a cache with no
   * invalidation is how a customer keeps being granted last month's allowance.
   */
  async #commercial(): Promise<{
    readonly policy: CreditPolicy;
    readonly plans: readonly PlanDetail[];
    readonly planVersionId: string | null;
    readonly commerce: CommercePolicy;
  }> {
    const configuration = new ConfigurationService({ prisma: getPlatformClient() });
    const [credits, plans, planVersionId, commerce] = await Promise.all([
      configuration.get('credits', this.#environment),
      configuration.get('plans', this.#environment),
      configuration.activeVersionId('plans', this.#environment),
      configuration.get('commerce', this.#environment),
    ]);
    return {
      policy: creditPolicyFrom(credits as Record<string, unknown>),
      plans: readPlanCatalogue(plans as Record<string, unknown>),
      planVersionId,
      commerce: commercePolicyFrom(commerce as Record<string, unknown>),
    };
  }

  /**
   * Release reservations whose request never came back.
   *
   * A reservation holds spendable balance. A process that dies between `reserve`
   * and `settle` leaves the hold in place for ever, and the customer's balance
   * silently shrinks with no transaction anywhere explaining it. The sweep is the
   * only thing that returns it, and `failed` is a correctness alert about the
   * ledger rather than a reason to stop: the rest of the batch is still released.
   */
  async sweepCreditReservations(limit: number): Promise<number> {
    const ledger = new CreditLedgerService({ prisma: getPlatformClient(), clock: this.#clock });
    const result = await ledger.sweepAbandonedReservations(limit);
    if (result.failed.length > 0) {
      log.error('abandoned credit reservations could not be released', {
        sweep: 'credit-reservations',
        failed: result.failed.length,
        attempted: result.attempted,
      });
    }
    if (!result.exhausted) {
      // Not an error: the bound did its job. Said out loud so "the leak metric
      // is zero" is never confused with "the sweep stopped early".
      log.info('abandoned-reservation sweep stopped at its bound', {
        sweep: 'credit-reservations',
        swept: result.swept,
      });
    }
    return result.swept;
  }

  /**
   * Write off credits that have passed their expiry — §11's "daily sweep".
   *
   * THE CANDIDATE SET EXCLUDES BUCKETS THAT CANNOT MOVE. A lapsed bucket whose
   * whole remainder is reserved against a request in flight is deliberately not
   * written off by `expireLapsedGrants`, so it would stay at the head of an
   * ordered scan for ever and could keep later workspaces out of a bounded
   * batch. Comparing the two columns removes it from the candidates until the
   * reservation settles or is swept, which is the pass above.
   */
  async expireCredits(limit: number): Promise<number> {
    const platform = getPlatformClient();
    const lapsed = await platform.creditGrant.findMany({
      where: {
        expiresAt: { lt: this.#clock.now() },
        remainingMilliCredits: { gt: platform.creditGrant.fields.reservedMilliCredits },
      },
      select: { workspaceId: true },
      distinct: ['workspaceId'],
      orderBy: { workspaceId: 'asc' },
      take: limit,
    });
    if (lapsed.length === 0) return 0;

    const { policy } = await this.#commercial();
    const ledger = new CreditLedgerService({
      prisma: platform,
      clock: this.#clock,
      policy,
    });

    let touched = 0;
    for (const { workspaceId } of lapsed) {
      try {
        const expired = await ledger.expireLapsedGrants(workspaceId);
        if (expired > 0n) touched += 1;
      } catch (error: unknown) {
        // ONE WORKSPACE, NOT THE PLATFORM. A row that cannot be expired is a
        // problem for that customer; stopping here would make it everyone's.
        log.error('credit expiry failed for one workspace', {
          sweep: 'credit-expiry',
          workspaceId,
          ...internalErrorFields(error),
        });
      }
    }
    return touched;
  }

  /**
   * Cross the billing-cycle boundary and grant the new period's allowance.
   *
   * TWO OPERATIONS, ONE ORDER, AND BOTH IDEMPOTENT. `advanceCycle` moves the
   * period conditionally on the period end it read, so two instances crossing
   * the same boundary move it once. `runCycleReset` is keyed on the period it is
   * granting for, so the loser of that race — and any retry of this pass —
   * reads back `alreadyApplied` instead of granting a second allowance.
   *
   * THE ALLOWANCE IS THE PINNED ONE (AC-04.7). `pinnedMonthlyCredits` is what the
   * customer agreed to; a later catalogue edit changes what new customers are
   * offered and nothing here. The ROLLOVER policy is read from the live plan,
   * because it is a policy rather than a price.
   *
   * A TERMINAL BOUNDARY GRANTS NOTHING. A trial that ended, or a subscription the
   * customer cancelled, has no next period — granting it credits would be the
   * product paying for itself.
   */
  async advanceBillingCycles(limit: number): Promise<{ advanced: number; granted: number }> {
    const platform = getPlatformClient();
    const subscriptions = new SubscriptionService({ prisma: platform, clock: this.#clock });
    const due = await subscriptions.dueForCycle(limit);
    if (due.length === 0) return { advanced: 0, granted: 0 };

    const { policy, plans, planVersionId } = await this.#commercial();
    const ledger = new CreditLedgerService({ prisma: platform, clock: this.#clock, policy });

    let advanced = 0;
    let granted = 0;

    for (const row of due) {
      try {
        const before = await subscriptions.get(row.workspaceId);
        if (!before) continue;

        // A scheduled downgrade needs the terms of the plan it is moving TO,
        // priced in the currency this subscription is already billed in. No
        // price in that currency means nothing to pin (D-08), so the downgrade
        // waits rather than being applied at a converted number.
        const pending = findPlan(plans, before.pendingPlanKey);
        const nextTerms = pending ? termsFor(pending, before.currency, planVersionId) : null;
        if (before.pendingPlanKey !== null && nextTerms === null) {
          /*
           * SAID PLAINLY BEFORE THE REFUSAL, because the two causes need
           * different remedies and the exception cannot tell them apart: the
           * plan is gone from the catalogue, or it is there and has no price in
           * the currency this customer is billed in (D-08 forbids converting
           * one at runtime). `advanceCycleWithin` refuses either way, so the
           * period stays where it is and the workspace stays due.
           */
          log.error('a scheduled plan change cannot be resolved at its boundary', {
            sweep: 'billing-cycle',
            workspaceId: row.workspaceId,
            reason: pending ? 'no price in the subscription currency' : 'plan not in the catalogue',
          });
        }

        /*
         * THE PERIOD AND THE ALLOWANCE THAT BELONGS TO IT, IN ONE TRANSACTION.
         *
         * These were two committed operations, and the gap between them was a
         * hole a month of credits fell through. `advanceCycle` committed the
         * new period; if the grant then failed — an unresolvable plan, a lost
         * connection, a cycle key already used — the workspace was no longer
         * DUE, because `dueForCycle` selects on the period end. Nothing ever
         * retried it, and nothing anywhere recorded that an allowance had been
         * missed. "The period advanced, the grant failed" is not a degraded
         * outcome; it is a silently wrong one.
         *
         * So a NON-TERMINAL boundary is atomic: either the customer has the new
         * period AND its credits, or the period never moved and the next sweep
         * tries again. A TERMINAL boundary is different by nature — there is no
         * next period and therefore no allowance to pair with it — so it
         * commits the ending and grants zero.
         */
        const outcome = await platform.$transaction(
          async (tx) => {
            const after = await subscriptions.advanceCycleWithin(tx, row.workspaceId, nextTerms);
            const moved =
              after.currentPeriodStart.getTime() !== before.currentPeriodStart.getTime() ||
              after.status !== before.status;

            if (after.status === 'CANCELLED' || after.status === 'EXPIRED') {
              return { moved, granted: false, unforfeitable: 0n };
            }

            const plan = findPlan(plans, after.planKey);
            if (!plan) {
              /*
               * A subscription on a plan the catalogue no longer defines.
               * Granting an invented allowance would be worse than granting
               * none — and so would keeping a period the customer was never
               * given credits for. THROWING ROLLS THE BOUNDARY BACK, so the
               * workspace stays due and an operator who fixes the catalogue
               * gets the missed cycle applied by the next sweep.
               */
              log.error('billing cycle reached a plan the catalogue does not define', {
                sweep: 'billing-cycle',
                workspaceId: row.workspaceId,
              });
              throw new AppError(
                'NOT_FOUND',
                'The subscription names a plan the active catalogue does not define.',
              );
            }

            const reset = await ledger.runCycleResetWithin(tx, {
              workspaceId: row.workspaceId,
              monthlyCredits: after.pinnedMonthlyCredits,
              rolloverPolicy: plan.rolloverPolicy,
              rolloverCapMultiplier: plan.rolloverCapMultiplier,
              // THE PERIOD IT IS GRANTING FOR, and the workspace it belongs to.
              // `runCycleReset` refuses a cycle key that was used for a
              // different workspace, so the id is not decoration.
              cycleKey: `${row.workspaceId}:${after.currentPeriodStart.toISOString()}`,
              nextResetAt: after.currentPeriodEnd,
            });
            return {
              moved,
              granted: !reset.alreadyApplied,
              unforfeitable: reset.unforfeitable,
            };
          },
          // The boundary does the subscription transition, an expiry pass, a
          // wallet lock, a FIFO forfeiture and a grant. Prisma's 5s interactive
          // default is the wrong budget for that under contention.
          { timeout: CYCLE_BOUNDARY_TIMEOUT_MS },
        );

        if (outcome.moved) advanced += 1;
        if (outcome.granted) granted += 1;
        if (outcome.unforfeitable > 0n) {
          log.info('rollover cap could not be fully applied', {
            sweep: 'billing-cycle',
            workspaceId: row.workspaceId,
          });
        }
      } catch (error: unknown) {
        log.error('billing cycle failed for one workspace', {
          sweep: 'billing-cycle',
          workspaceId: row.workspaceId,
          ...internalErrorFields(error),
        });
      }
    }
    return { advanced, granted };
  }

  /**
   * Advance the dunning ladder for past-due subscriptions.
   *
   * MEASURED FROM THE FIRST FAILURE (§22), which is what makes a sweep that runs
   * late, or twice, unable to lengthen or shorten anybody's grace period. The
   * escalation ends at SUSPENDED and nothing is ever deleted.
   *
   * ORDERED BY HOW LONG THEY HAVE BEEN PAST DUE. The customer closest to the end
   * of their grace period is the one a bounded batch must not miss, and reaching
   * `suspend` moves the row out of the candidate set, so the queue drains.
   */
  async advanceDunning(limit: number): Promise<number> {
    const platform = getPlatformClient();
    const due = await platform.workspaceSubscription.findMany({
      where: { status: 'PAST_DUE', pastDueSince: { not: null } },
      select: { workspaceId: true },
      orderBy: [{ pastDueSince: 'asc' }, { workspaceId: 'asc' }],
      take: limit,
    });
    if (due.length === 0) return 0;

    const { commerce } = await this.#commercial();
    const lifecycle = new SubscriptionLifecycleService({ clock: this.#clock });
    const tenantPrisma = getPrisma();

    let suspensions = 0;
    for (const { workspaceId } of due) {
      try {
        const step = await withWorkspace(
          workspaceId,
          async (db) => lifecycle.advanceDunning(db, { workspaceId, policy: commerce }),
          { prisma: tenantPrisma },
        );
        if (step === 'suspend') suspensions += 1;
      } catch (error: unknown) {
        log.error('dunning failed for one workspace', {
          sweep: 'dunning',
          workspaceId,
          ...internalErrorFields(error),
        });
      }
    }
    return suspensions;
  }

  /**
   * Ask the rows whether the financial invariants still hold.
   *
   * IT REPAIRS NOTHING. A drift means an invariant that is supposed to hold by
   * construction did not, and rewriting the materialised value to match would
   * destroy the evidence and leave the cause in place.
   *
   * WHAT IT WRITES. A CRITICAL `AuditEvent` when it finds drift, and a NOTICE one
   * when a full rotation of the platform completes clean — so the record shows
   * both "something is wrong" and "everything was checked and was right",
   * without a row every fifteen minutes for ever. THIS IS AN AUDIT RECORD, NOT AN
   * EXTERNAL ALERT: nothing pages anybody, and docs/BILLING-AND-CREDITS.md says
   * so in the same words.
   */
  async reconcileFinancials(limit: number): Promise<number> {
    const platform = getPlatformClient();
    const result = await new FinancialReconciler({ prisma: platform }).run({
      limit,
      after: this.#rotation.cursor,
    });
    /*
     * THE ROTATION DECIDES WHAT IS RECORDED, NOT THE PAGE.
     *
     * `foldRotation` carries "did any page of this rotation find drift" across
     * the pages and wraps the cursor at the end, so a clean record is only ever
     * written by a COMPLETED rotation that found none. Its state is in memory,
     * like the cursor it belongs to: a restart begins the rotation again from
     * the top and re-checks, which is the safe direction, and it cannot lose a
     * finding because a page with drift always records its own.
     */
    const { next, record } = foldRotation(this.#rotation, {
      drifts: result.drifts.length,
      exhausted: result.exhausted,
      cursor: result.cursor,
    });
    this.#rotation = next;

    if (record === 'drift') {
      await platform.auditEvent.create({
        data: {
          workspaceId: null,
          actorType: 'SYSTEM',
          action: 'platform.billing.reconciliation.drift',
          resourceType: 'credit_wallet',
          severity: 'CRITICAL',
          outcome: 'ERROR',
          reason: 'A materialised financial value disagrees with the record it derives from.',
          // The kinds and the workspaces, and no amounts a customer could be
          // identified by beyond their own id. This row is platform-scoped: the
          // tenant role has no policy that returns it.
          after: {
            walletsChecked: result.walletsChecked,
            purchasesChecked: result.purchasesChecked,
            drifts: result.drifts.map((drift) => ({
              workspaceId: drift.workspaceId,
              kind: drift.kind,
              subjectId: drift.subjectId,
            })),
          },
        },
      });
      log.error('financial reconciliation found drift', {
        sweep: 'financial-reconciliation',
        drifts: result.drifts.length,
      });
    } else if (record === 'rotation_clean') {
      await platform.auditEvent.create({
        data: {
          workspaceId: null,
          actorType: 'SYSTEM',
          action: 'platform.billing.reconciliation.clean',
          resourceType: 'credit_wallet',
          severity: 'INFO',
          outcome: 'SUCCESS',
          reason: 'Every financial invariant held across a complete rotation.',
          after: {
            walletsChecked: result.walletsChecked,
            purchasesChecked: result.purchasesChecked,
          },
        },
      });
    }
    return result.drifts.length;
  }

  /** Every financial pass, in the order their dependencies run. */
  async sweepFinance(batch: number): Promise<{
    reservationsSwept: number;
    expiryWorkspaces: number;
    cyclesAdvanced: number;
    allowancesGranted: number;
    dunningSuspensions: number;
    driftsFound: number;
  }> {
    /*
     * THE ORDER IS NOT ARBITRARY. Releasing abandoned reservations first frees
     * the buckets that expiry and the rollover cap would otherwise have to leave
     * alone, so a boundary crossed in the same pass applies the cap to the real
     * spendable balance rather than to one an dead request was still holding.
     * Reconciliation runs LAST, so it judges the state this pass produced.
     */
    const reservationsSwept = await this.sweepCreditReservations(batch);
    const expiryWorkspaces = await this.expireCredits(batch);
    const cycle = await this.advanceBillingCycles(batch);
    const dunningSuspensions = await this.advanceDunning(batch);
    const driftsFound = await this.reconcileFinancials(batch);
    return {
      reservationsSwept,
      expiryWorkspaces,
      cyclesAdvanced: cycle.advanced,
      allowancesGranted: cycle.granted,
      dunningSuspensions,
      driftsFound,
    };
  }

  /** Every workspace's zone, in one query rather than one per rule. */
  async #timezonesFor(
    platform: PrismaClient,
    workspaceIds: readonly string[],
  ): Promise<Map<string, string>> {
    const rows = await platform.workspace.findMany({
      where: { id: { in: [...new Set(workspaceIds)] } },
      select: { id: true, timezone: true },
    });
    return new Map(rows.map((row) => [row.id, row.timezone ?? 'UTC']));
  }

  /** One full pass of everything. Exposed so a test can run it deterministically. */
  async runOnce(): Promise<MaintenanceResult> {
    const cadence = await this.#cadence();
    const ingestionDispatched = await this.reconcileIngestion(cadence.ingestionReconcileBatch);
    const assetJobsDispatched = await this.reconcileAssetProcessing(
      cadence.ingestionReconcileBatch,
    );
    const purged = await this.purgeRetention(cadence.retentionPurgeBatch);
    const assets = await this.sweepAssets(cadence.retentionPurgeBatch);
    const publishing = await this.sweepPublishing(cadence.ingestionReconcileBatch);
    const analytics = await this.sweepAnalytics(cadence.ingestionReconcileBatch);
    const analyticsRowsPruned = await this.pruneAnalyticsRetention(cadence.retentionPurgeBatch);
    const automations = await this.sweepAutomations(cadence.ingestionReconcileBatch);
    const finance = await this.sweepFinance(cadence.retentionPurgeBatch);
    const workspacesDeleted = await this.finishWorkspaceDeletions(cadence.retentionPurgeBatch);
    return {
      ingestionDispatched,
      chatContentPurged: purged.chat,
      gatewayOutputsPurged: purged.gateway,
      assetJobsDispatched,
      uploadSessionsExpired: assets.sessions,
      deletedAssetsPurged: assets.purged,
      publishJobsCreated: publishing.created,
      publishJobsDispatched: publishing.dispatched,
      publishJobsRecovered: publishing.recovered,
      analyticsCursorsDispatched: analytics.dispatched,
      analyticsBackfillsDispatched: analytics.backfills,
      analyticsRowsPruned,
      automationEventsProduced: automations.produced,
      automationEventsDispatched: automations.dispatched,
      automationProposalsExpired: automations.expired,
      creditReservationsSwept: finance.reservationsSwept,
      creditExpiryWorkspaces: finance.expiryWorkspaces,
      billingCyclesAdvanced: finance.cyclesAdvanced,
      cycleAllowancesGranted: finance.allowancesGranted,
      dunningSuspensions: finance.dunningSuspensions,
      financialDriftsFound: finance.driftsFound,
      workspacesDeleted,
    };
  }

  /**
   * FINISH THE DELETIONS WHOSE WAITING PERIOD ENDED (A8, D-328).
   *
   * On the PLATFORM connection, because it acts on every workspace that is
   * due. Each one is marked DELETED by a conditional update — a cancel that
   * landed first wins, and a rerun finishes nothing twice — its sessions are
   * revoked and `workspace.deleted` is audited. Physical purge is the
   * data-deletion lifecycle of docs/SECURITY.md §15, not this sweep.
   */
  async finishWorkspaceDeletions(batch: number): Promise<number> {
    const platform = getPlatformClient();
    const finished = await new WorkspaceDeletionService({ clock: this.#clock }).finishDue(
      platform as unknown as TenantScopedClient,
      batch,
    );
    return finished.length;
  }

  /**
   * Start the timers.
   *
   * The two sweeps run on their own cadences because they answer to different
   * pressures: a document waiting to be read is a customer watching a spinner,
   * and content past its window is a commitment measured in days.
   */
  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;

    const cadence = await this.#cadence();

    const every = (seconds: number, name: string, run: () => Promise<number>): void => {
      const timer = setInterval(() => {
        void run()
          .then((count) => {
            // Logged only when it did something, so a quiet platform does not
            // produce a log line every thirty seconds forever — but a pass that
            // acted is always visible.
            if (count > 0) log.info('maintenance pass', { sweep: name, count });
          })
          .catch((error: unknown) => {
            // A failing sweep must not stop the timer: the next pass reconciles
            // whatever this one could not (F-65's lesson).
            log.error('maintenance pass failed', { sweep: name, ...internalErrorFields(error) });
          });
      }, seconds * 1_000);
      // The process should not be held open by a maintenance timer.
      timer.unref();
      this.#timers.push(timer);
    };

    every(cadence.ingestionReconcileSeconds, 'ingestion-reconcile', () =>
      this.reconcileIngestion(cadence.ingestionReconcileBatch),
    );
    every(cadence.retentionPurgeSeconds, 'retention-purge', async () => {
      const purged = await this.purgeRetention(cadence.retentionPurgeBatch);
      return purged.chat + purged.gateway;
    });

    // Phase 5B-1. The asset sweeps ride the cadences their Brand Brain
    // counterparts already use rather than introducing two more operator
    // settings for the same two pressures.
    every(cadence.ingestionReconcileSeconds, 'asset-reconcile', () =>
      this.reconcileAssetProcessing(cadence.ingestionReconcileBatch),
    );
    every(cadence.retentionPurgeSeconds, 'asset-sweep', async () => {
      const swept = await this.sweepAssets(cadence.retentionPurgeBatch);
      return swept.sessions + swept.purged;
    });

    /*
     * PHASE 6 AND 7 — THE SWEEPS THAT WERE ONLY EVER REACHABLE FROM `runOnce`.
     *
     * `sweepPublishing` existed from Phase 6 and was called by `runOnce` but was
     * never given a timer, so in a running deployment a lost queue message
     * degraded correctness rather than punctuality — precisely the opposite of
     * what docs/ARCHITECTURE.md §9 promises a reconciliation sweep is for. Both
     * it and the two analytics sweeps are scheduled here.
     *
     * They ride the cadences their nearest counterparts already use rather than
     * introducing four more operator settings for the same two pressures: work
     * waiting to be dispatched is the reconcile cadence, and content past its
     * window is the purge cadence.
     */
    every(cadence.ingestionReconcileSeconds, 'publishing-sweep', async () => {
      const swept = await this.sweepPublishing(cadence.ingestionReconcileBatch);
      return swept.created + swept.dispatched + swept.recovered;
    });
    every(cadence.ingestionReconcileSeconds, 'analytics-sweep', async () => {
      const swept = await this.sweepAnalytics(cadence.ingestionReconcileBatch);
      return swept.dispatched + swept.backfills;
    });
    every(cadence.retentionPurgeSeconds, 'analytics-retention', () =>
      this.pruneAnalyticsRetention(cadence.retentionPurgeBatch),
    );
    /*
     * THE AUTOMATION SWEEP (A1) — the timer the whole feature was missing.
     *
     * IT RIDES THE RECONCILE CADENCE, which is a MINUTE, and that is what makes
     * an hourly schedule land on its hour: a rule set for 09:00 is noticed at
     * some point inside the 09:00 hour, and the occurrence key makes every
     * further look inside that hour a no-op rather than a second run.
     */
    every(cadence.ingestionReconcileSeconds, 'automation-sweep', async () => {
      const swept = await this.sweepAutomations(cadence.ingestionReconcileBatch);
      return swept.produced + swept.dispatched + swept.expired;
    });

    /*
     * THE FINANCIAL SWEEPS (current execution Phase 3).
     *
     * THEY RIDE THE PURGE CADENCE, which is the same judgement every sweep
     * before them made: work waiting to be dispatched answers to the reconcile
     * cadence, and things that come due over time answer to the purge one. A
     * billing boundary, an expiry date and a grace period are all measured in
     * days, so noticing them within the purge interval is punctual, and adding a
     * seventh operator setting for the same pressure is not.
     *
     * THEY RUN AS ONE TIMER, in the order `sweepFinance` fixes, because they are
     * not independent: a released reservation changes what expiry and the
     * rollover cap can take, and the reconciliation must judge the state the
     * others left.
     */
    // A8 (D-328): a deadline measured in days answers to the purge cadence.
    every(cadence.retentionPurgeSeconds, 'workspace-deletion', () =>
      this.finishWorkspaceDeletions(cadence.retentionPurgeBatch),
    );
    every(cadence.retentionPurgeSeconds, 'finance-sweep', async () => {
      const finance = await this.sweepFinance(cadence.retentionPurgeBatch);
      return (
        finance.reservationsSwept +
        finance.expiryWorkspaces +
        finance.cyclesAdvanced +
        finance.allowancesGranted +
        finance.dunningSuspensions +
        finance.driftsFound
      );
    });

    log.info('maintenance scheduler started', {
      ingestionReconcileSeconds: cadence.ingestionReconcileSeconds,
      retentionPurgeSeconds: cadence.retentionPurgeSeconds,
    });
  }

  stop(): void {
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers.length = 0;
    this.#running = false;
  }
}
