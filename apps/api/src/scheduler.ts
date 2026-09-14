import { findUnclaimedIngestionJobs, purgeExpiredChatContent } from '@brandspace/brand-brain';
import { ConfigurationAiSource, purgeExpiredOutputs } from '@brandspace/ai-gateway';
import { ConfigurationService, type Environment } from '@brandspace/config';
import { getPrisma, withWorkspace } from '@brandspace/database';
import { getPlatformClient } from '@brandspace/database/platform';
import {
  INGEST_SOURCE_DOCUMENT,
  enqueue,
  type IngestSourceDocumentPayload,
} from '@brandspace/jobs';
import { createLogger, internalErrorFields, systemClock, type Clock } from '@brandspace/shared';

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

export interface MaintenanceResult {
  readonly ingestionDispatched: number;
  readonly chatContentPurged: number;
  readonly gatewayOutputsPurged: number;
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

  /** One full pass of everything. Exposed so a test can run it deterministically. */
  async runOnce(): Promise<MaintenanceResult> {
    const cadence = await this.#cadence();
    const ingestionDispatched = await this.reconcileIngestion(cadence.ingestionReconcileBatch);
    const purged = await this.purgeRetention(cadence.retentionPurgeBatch);
    return {
      ingestionDispatched,
      chatContentPurged: purged.chat,
      gatewayOutputsPurged: purged.gateway,
    };
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
