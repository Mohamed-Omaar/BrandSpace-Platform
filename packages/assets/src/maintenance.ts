import type { TenantScopedClient } from '@brandspace/database';
import { QUOTA_FEATURES, type UsageService } from '@brandspace/entitlements';
import type { ObjectStore } from '@brandspace/storage';
import { type Clock, systemClock } from '@brandspace/shared';
import type { AssetPolicy } from './policy';

/**
 * The sweeps that keep the library honest when something did not finish.
 *
 * ALL THREE RUN INSIDE ONE TENANT'S OWN RLS CONTEXT. The cross-tenant question
 * — "which workspaces have work waiting" — is asked on the designated platform
 * surface and dispatched per workspace (D-96), exactly as the Brand Brain
 * maintenance does. Nothing here holds the platform identity, so nothing here
 * can reach another tenant even if a workspace id were forged.
 *
 * EVERY SWEEP IS BOUNDED AND IDEMPOTENT. Bounded because an unbounded sweep on
 * a large workspace is an outage; idempotent because these run on a timer and
 * will overlap with themselves the first time one is slow.
 *
 * THE CLOCK IS INJECTED so a retention window can be tested in BOTH directions
 * — that it purges past the window AND that it purges nothing before it. A test
 * that can only wait cannot assert the second, which is the half that catches a
 * sweep deleting a customer's files early.
 */

export interface AssetMaintenanceOptions {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
  readonly store: ObjectStore;
  readonly policy: AssetPolicy;
  readonly usage: UsageService;
  readonly clock?: Clock;
}

/** How many rows one sweep touches. A bound, not a target. */
const SWEEP_BATCH = 100;

export class AssetMaintenanceService {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;
  readonly #store: ObjectStore;
  readonly #policy: AssetPolicy;
  readonly #usage: UsageService;
  readonly #clock: Clock;

  constructor(options: AssetMaintenanceOptions) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#store = options.store;
    this.#policy = options.policy;
    this.#usage = options.usage;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Expire upload sessions that were opened and never completed.
   *
   * THE QUOTA IS GIVEN BACK, and that is the reason this sweep matters rather
   * than merely tidying. `initiate` spends storage against the DECLARED size
   * before any bytes arrive, so a customer whose browser was closed mid-upload
   * is paying for a file that does not exist. Without this sweep, a flaky
   * connection quietly consumes a plan.
   *
   * The staged bytes go too. They were never verified, never scanned and never
   * became an asset; keeping them is cost with no possible use.
   */
  async expireStaleSessions(): Promise<{ expired: number; bytesReclaimed: number }> {
    const now = this.#clock.now();
    const stale = await this.#db.assetUploadSession.findMany({
      where: { status: 'PENDING', expiresAt: { lte: now } },
      orderBy: { expiresAt: 'asc' },
      take: SWEEP_BATCH,
    });

    let bytesReclaimed = 0;
    for (const session of stale) {
      /*
       * THE ROW MOVES FIRST, AND CONDITIONALLY.
       *
       * `updateMany` with `status: 'PENDING'` in the WHERE is a compare-and-set:
       * if a completion landed between the SELECT above and this write, it
       * matches zero rows and the sweep leaves it alone. Deleting the object
       * first would race the other way — a completion in flight would find its
       * bytes gone.
       */
      const claimed = await this.#db.assetUploadSession.updateMany({
        where: { id: session.id, status: 'PENDING' },
        data: { status: 'EXPIRED', failureReason: 'stuck_timeout' },
      });
      if (claimed.count === 0) continue;

      await this.#store.delete(session.storageKey);
      await this.#refundStorage(session.declaredSizeBytes, `asset-expired:${session.id}`);
      bytesReclaimed += session.declaredSizeBytes;
    }

    return { expired: stale.length, bytesReclaimed };
  }

  /**
   * Purge the objects behind assets deleted longer ago than the grace period.
   *
   * THE ROW STAYS AND THE BYTES GO. The asset row carries the accounting and
   * the audit trail — who uploaded it, when it was deleted, what it was called
   * — and destroying that would make the activity log lie about what happened.
   * What is removed is the storage: every version's object, every derivative,
   * and the quota they occupied.
   *
   * `storageKey` is cleared as the record that the bytes are gone, so nothing
   * can later hand out a grant for an object that no longer exists.
   */
  async purgeDeletedAssets(): Promise<{ purged: number }> {
    const cutoff = new Date(
      this.#clock.now().getTime() -
        this.#policy.retention.purgeDeletedAfterDays * 24 * 60 * 60 * 1_000,
    );

    const expired = await this.#db.asset.findMany({
      where: { deletedAt: { lte: cutoff }, storageKey: { not: '' } },
      orderBy: { deletedAt: 'asc' },
      take: SWEEP_BATCH,
    });

    let purged = 0;
    for (const asset of expired) {
      const [versions, derivatives] = await Promise.all([
        this.#db.assetVersion.findMany({
          where: { assetId: asset.id },
          select: { storageKey: true, sizeBytes: true },
        }),
        this.#db.assetDerivative.findMany({
          where: { assetId: asset.id },
          select: { storageKey: true },
        }),
      ]);

      /*
       * DE-DUPLICATED BEFORE DELETING. A restored version points at the SAME
       * object as the version it restored (see versions.ts), so a naive loop
       * would delete one object twice. The store's delete is idempotent, so the
       * second call is harmless — but the byte total below would double-count
       * and refund quota the workspace never used.
       */
      const objectKeys = new Set<string>(derivatives.map((d) => d.storageKey));
      let bytes = 0;
      const countedKeys = new Set<string>();
      for (const version of versions) {
        objectKeys.add(version.storageKey);
        if (!countedKeys.has(version.storageKey)) {
          countedKeys.add(version.storageKey);
          bytes += version.sizeBytes;
        }
      }

      for (const key of objectKeys) await this.#store.delete(key);
      // The derivative ROWS go with their objects; the version rows stay,
      // because `asset_version` is append-only and cannot be deleted at all.
      await this.#db.assetDerivative.deleteMany({ where: { assetId: asset.id } });
      await this.#db.asset.update({
        where: { id: asset.id },
        data: { storageKey: '' },
      });
      if (bytes > 0) await this.#refundStorage(bytes, `asset-purged:${asset.id}`);
      purged += 1;
    }

    return { purged };
  }

  /**
   * Find processing jobs that were dispatched and never came back.
   *
   * A LOST QUEUE MESSAGE COSTS PUNCTUALITY, NOT CORRECTNESS (R-08). Redis is an
   * accelerator and the database is the source of truth, so a job whose message
   * evaporated — an evicted key, a worker killed mid-flight, a deploy — is
   * found here and re-queued rather than leaving a customer watching a spinner
   * that never resolves.
   *
   * IT RETURNS IDS RATHER THAN DISPATCHING. This package cannot import
   * `@brandspace/jobs` and should not: a domain service that dispatches is a
   * service that needs Redis to be tested. The caller — the maintenance
   * scheduler — enqueues what it is handed.
   */
  async reclaimStuckJobs(): Promise<readonly string[]> {
    const cutoff = new Date(
      this.#clock.now().getTime() - this.#policy.processing.stuckAfterSeconds * 1_000,
    );

    const stuck = await this.#db.assetProcessingJob.findMany({
      where: {
        stage: { in: ['QUEUED', 'SCANNING', 'INSPECTING', 'DERIVING'] },
        queuedAt: { lte: cutoff },
        attempts: { lt: this.#policy.processing.maxAttempts },
      },
      // DETERMINISTIC: oldest first, then by id. Two sweeps running against the
      // same data must select the same rows in the same order, or the batch
      // bound stops meaning anything.
      orderBy: [{ queuedAt: 'asc' }, { id: 'asc' }],
      take: SWEEP_BATCH,
      select: { id: true },
    });

    return stuck.map((job) => job.id);
  }

  async #refundStorage(bytes: number, idempotencyKey: string): Promise<void> {
    // Exact bytes (B-1): the counter re-derives its gigabytes from the total.
    await this.#usage.refundBytes({
      workspaceId: this.#workspaceId,
      featureKey: QUOTA_FEATURES.storageGb,
      bytes,
      idempotencyKey,
    });
  }
}

/**
 * Asset processing jobs nothing has claimed, across whatever the caller can see.
 *
 * IT TAKES A CLIENT RATHER THAN OPENING ONE, and the caller's identity decides
 * the reach. A tenant-scoped client returns that workspace's jobs; the platform
 * identity returns every tenant's, which is what the sweep in the designated
 * platform surface needs and what "ordinary workers" must not have (F-07). This
 * function grants nothing — it asks a question with whatever reach the caller
 * already had.
 *
 * "UNCLAIMED" IS `QUEUED` WITH ITS NEXT ATTEMPT DUE, which is the same condition
 * the producer's dispatch races. A job already SCANNING is left alone: the
 * worker holds a lock on it, and re-dispatching would only queue a message the
 * processor discards.
 */
export async function findUnclaimedAssetJobs(
  db: {
    assetProcessingJob: {
      findMany(args: unknown): Promise<Array<{ id: string; workspaceId: string }>>;
    };
  },
  now: Date,
  limit: number,
): Promise<Array<{ id: string; workspaceId: string }>> {
  return db.assetProcessingJob.findMany({
    where: {
      stage: 'QUEUED',
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    select: { id: true, workspaceId: true },
    // Oldest first with an id tie-break: deterministic, and the asset that has
    // been waiting longest goes first.
    orderBy: [{ queuedAt: 'asc' }, { id: 'asc' }],
    take: limit,
  });
}
