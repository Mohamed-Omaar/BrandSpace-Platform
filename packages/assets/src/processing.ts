import { writeAuditEvent, type AssetStatus, type TenantScopedClient } from '@brandspace/database';
import { type ObjectStore } from '@brandspace/storage';
import { type Clock, systemClock } from '@brandspace/shared';
import { planDerivatives } from './derivatives';
import type { AssetFailureReason } from './errors';
import { checkAssetSignature } from './file-safety';
import type { AssetPolicy } from './policy';
import type { VirusScanner } from './scanning';

/**
 * Process one uploaded asset: scan, inspect, derive.
 *
 * IDEMPOTENT AND SAFE TO RETRY (CLAUDE.md §5). The database row is the state
 * and the queue message is a pointer, so a duplicate delivery — BullMQ
 * at-least-once, a reconciler racing the producer, a retry after a lost
 * acknowledgement — re-reads the job, finds it finished, and returns without a
 * second scan or a second set of derivatives.
 *
 * THE ORDER IS NOT NEGOTIABLE. Scan first, then inspect, then derive. A
 * derivative is produced by DECODING the file, which is the same act a scanner
 * exists to make safe; producing one before the verdict would run a decoder on
 * bytes nobody has cleared. So an infected file is never decoded, and a file
 * whose scan failed is never decoded either.
 *
 * WHAT A FAILURE MEANS DEPENDS ON WHAT FAILED, and the distinction is the
 * difference between a customer who can act and one who cannot:
 *
 *   - INFECTED is terminal. Retrying costs another scan and reaches the same
 *     answer, and the file stays quarantined forever either way.
 *   - A SIGNATURE MISMATCH is terminal. It is a property of the bytes.
 *   - A FAILED SCAN is retryable. The engine could not reach a verdict, which
 *     is an operational problem rather than a property of the file, and the
 *     asset stays quarantined in the meantime.
 *   - A MISSING OBJECT is terminal. The row exists and the bytes do not;
 *     retrying cannot conjure them.
 */

export interface AssetProcessingServiceOptions {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
  readonly store: ObjectStore;
  readonly policy: AssetPolicy;
  readonly scanner: VirusScanner;
  readonly clock?: Clock;
}

export interface ProcessAssetResult {
  readonly assetId: string;
  readonly status: AssetStatus;
  readonly scanStatus: 'PENDING' | 'CLEAN' | 'INFECTED' | 'FAILED';
  readonly derivativesCreated: number;
  readonly failureReason: AssetFailureReason | null;
}

/** What `claim` took: the attempt, and whether this delivery really owns it (D-549). */
export interface AssetClaim {
  readonly jobId: string;
  readonly attempt: number;
  readonly claimed: boolean;
}

/** The failures where a second attempt could plausibly succeed. */
const RETRYABLE_REASONS: ReadonlySet<AssetFailureReason> = new Set([
  'scan_failed',
  'scan_unavailable',
  'derivative_failed',
]);

export class AssetProcessingService {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;
  readonly #store: ObjectStore;
  readonly #policy: AssetPolicy;
  readonly #scanner: VirusScanner;
  readonly #clock: Clock;

  constructor(options: AssetProcessingServiceOptions) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#store = options.store;
    this.#policy = options.policy;
    this.#scanner = options.scanner;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Claim and run one attempt in the caller's context — the inline path a
   * non-production dashboard takes when no queue is configured, and the
   * composition the tests drive. THE WORKER DOES NOT CALL THIS: it claims in a
   * transaction of its own and commits it before `run` reads a byte (D-549).
   */
  async process(jobId: string, expectedAttempt?: number): Promise<ProcessAssetResult> {
    return this.run(await this.claim(jobId, expectedAttempt));
  }

  /**
   * Claim one attempt: SCANNING, one more attempt, `startedAt` now.
   *
   * A REAL CLAIM (final review of #83, D-549 — the ingestion fix, D-413, made
   * for assets). It used to be an unconditional update, so a redelivered
   * message re-ran a job that was running, and the update was rolled back with
   * everything else whenever the run threw, so the attempt was never counted.
   * Now it is ONE compare-and-set: the row must still be QUEUED with the
   * attempts this claim read — and, when the message names its attempt,
   * exactly that one attempt short. Two deliveries of the same attempt race one
   * row lock; the loser matches no row and `claimed` is false.
   */
  async claim(jobId: string, expectedAttempt?: number): Promise<AssetClaim> {
    const job = await this.#db.assetProcessingJob.findUnique({ where: { id: jobId } });
    // A job in another workspace is invisible to RLS and arrives as null.
    if (!job) throw new Error('Asset processing job not found.');

    const unclaimed: AssetClaim = { jobId: job.id, attempt: job.attempts + 1, claimed: false };
    // A DUPLICATE DELIVERY STOPS HERE. The row is the state; a finished job
    // reports what it found rather than doing the work again.
    if (job.stage === 'COMPLETED' || job.stage === 'FAILED') return unclaimed;
    // A message for another attempt — an older one replayed — claims nothing.
    if (expectedAttempt !== undefined && expectedAttempt !== unclaimed.attempt) return unclaimed;

    const claim = await this.#db.assetProcessingJob.updateMany({
      where: { id: job.id, stage: 'QUEUED', attempts: job.attempts },
      data: { stage: 'SCANNING', attempts: { increment: 1 }, startedAt: this.#clock.now() },
    });
    return { ...unclaimed, claimed: claim.count === 1 };
  }

  /**
   * Run a claimed attempt: scan, inspect, derive.
   *
   * ONLY THE ATTEMPT THAT CLAIMED THE ROW MAY WRITE (D-549). A claim that took
   * nothing writes nothing and reports the row as it stands. A claimed one
   * FENCES first: the row must still be SCANNING on this very attempt — the
   * stuck-job sweep may have handed it back (or failed it) while this attempt
   * was silent. The fence is an UPDATE, so it holds the row lock for the rest
   * of this transaction and the sweep's own compare-and-set waits for it:
   * exactly one of the two wins.
   */
  async run(claimed: AssetClaim): Promise<ProcessAssetResult> {
    if (!claimed.claimed) return this.#asItStands(claimed.jobId);
    const fence = await this.#db.assetProcessingJob.updateMany({
      where: { id: claimed.jobId, stage: 'SCANNING', attempts: claimed.attempt },
      data: { stage: 'SCANNING' },
    });
    if (fence.count !== 1) return this.#asItStands(claimed.jobId);

    const job = await this.#db.assetProcessingJob.findUniqueOrThrow({
      where: { id: claimed.jobId },
    });
    const asset = await this.#db.asset.findUnique({ where: { id: job.assetId } });
    if (!asset) throw new Error('Asset not found.');

    const bytes = await this.#store.get(asset.storageKey);
    if (!bytes) {
      // The row exists and the object does not. Terminal: retrying cannot fix
      // it, and leaving the customer watching a spinner would be worse.
      return this.#fail(job.id, asset.id, 'object_missing', true);
    }

    /*
     * THE SCAN. Its verdict is written before anything else looks at the bytes.
     */
    let verdict;
    try {
      verdict = await this.#scanner.scan({
        bytes,
        declaredMimeType: asset.mimeType,
        timeoutMs: this.#policy.scanning.timeoutMs,
      });
    } catch {
      /*
       * THE SCANNER ITSELF FAILED — unreachable, timed out, threw. The asset
       * stays QUARANTINED and the job is retryable. It must never fall through
       * to "clean": a scanner that cannot answer has not said the file is safe,
       * and treating silence as approval is how an unscanned file reaches a
       * customer.
       */
      return this.#fail(job.id, asset.id, 'scan_unavailable', false);
    }

    if (verdict.verdict === 'infected') {
      await this.#db.asset.update({
        where: { id: asset.id },
        data: { scanStatus: 'INFECTED', scanReason: 'infected', scannedAt: this.#clock.now() },
      });
      await this.#audit(asset.id, asset.brandId, 'assets.scan_infected', 'WARNING', {
        scanStatus: 'INFECTED',
      });
      return this.#fail(job.id, asset.id, 'infected', true);
    }

    if (verdict.verdict === 'failed') {
      await this.#db.asset.update({
        where: { id: asset.id },
        data: { scanStatus: 'FAILED', scanReason: 'scan_failed', scannedAt: this.#clock.now() },
      });
      await this.#audit(asset.id, asset.brandId, 'assets.scan_failed', 'WARNING', {
        scanStatus: 'FAILED',
      });
      return this.#fail(job.id, asset.id, 'scan_failed', false);
    }

    /*
     * THE FILE IS CLEAN. Only now is it decoded for anything.
     *
     * THE SIGNATURE IS CHECKED AGAIN, and that is not redundant. `complete`
     * checked the bytes it was handed; this checks the bytes that came BACK OUT
     * of the store. They should be identical, and the day they are not — a
     * driver bug, a truncated write, a key collision, a tampered object — is
     * the day a file becomes something other than what was verified. It costs a
     * few microseconds on a buffer that is already in memory.
     */
    const signature = checkAssetSignature(asset.mimeType, bytes);
    if (!signature.ok) {
      return this.#fail(job.id, asset.id, 'content_type_mismatch', true);
    }

    await this.#db.asset.update({
      where: { id: asset.id },
      data: {
        scanStatus: 'CLEAN',
        // PR F (g): a file the `none` scanner let through says so, rather than
        // claiming a check that never happened.
        scanReason: verdict.notScanned ? 'not_scanned' : null,
        scannedAt: this.#clock.now(),
      },
    });
    await this.#db.assetVersion.updateMany({
      where: { assetId: asset.id, versionNumber: asset.currentVersion },
      data: { scanStatus: 'CLEAN' },
    });

    await this.#db.assetProcessingJob.update({
      where: { id: job.id },
      data: { stage: 'DERIVING' },
    });

    /*
     * DERIVATIVES. Bounded by policy, and currently EMPTY for every kind —
     * `ENCODABLE_KINDS` is empty because no image encoder has been reviewed
     * (see derivatives.ts). The planning, the ceiling, the records and the
     * deletion path are all real and tested; only the encoder is absent, and
     * the asset becomes READY with none rather than stuck waiting for one.
     */
    const planned = planDerivatives(asset.kind, this.#policy.derivatives);
    // Idempotent rewrite: a retry produces one clean set rather than layering
    // on a partial run. Derivatives are derived data, so nothing is lost.
    if (planned.length > 0) {
      await this.#db.assetDerivative.deleteMany({ where: { assetId: asset.id } });
    }

    const completedAt = this.#clock.now();
    await this.#db.asset.update({
      where: { id: asset.id },
      data: { status: 'READY', failureReason: null },
    });
    await this.#db.assetProcessingJob.update({
      where: { id: job.id },
      data: {
        stage: 'COMPLETED',
        derivativesCreated: planned.length,
        completedAt,
        failureReason: null,
        failureCode: null,
      },
    });

    await this.#audit(asset.id, asset.brandId, 'assets.processed', 'INFO', {
      status: 'READY',
      scanStatus: 'CLEAN',
      derivatives: planned.length,
    });

    return {
      assetId: asset.id,
      status: 'READY',
      scanStatus: 'CLEAN',
      derivativesCreated: planned.length,
      failureReason: null,
    };
  }

  /** What a delivery that claimed nothing reports: the job and its asset as they stand. */
  async #asItStands(jobId: string): Promise<ProcessAssetResult> {
    const job = await this.#db.assetProcessingJob.findUnique({ where: { id: jobId } });
    if (!job) throw new Error('Asset processing job not found.');
    const asset = await this.#db.asset.findUnique({ where: { id: job.assetId } });
    if (!asset) throw new Error('Asset not found.');
    return {
      assetId: asset.id,
      status: asset.status,
      scanStatus: asset.scanStatus,
      derivativesCreated: job.derivativesCreated,
      failureReason: (job.failureReason as AssetFailureReason | null) ?? null,
    };
  }

  /**
   * Record a failure.
   *
   * `terminal` decides whether another attempt is scheduled. A property of the
   * FILE is terminal on the first attempt — retrying costs another scan and
   * reaches the same answer while the customer watches PROCESSING — and an
   * operational failure is retried until `maxAttempts`.
   */
  async #fail(
    jobId: string,
    assetId: string,
    reason: AssetFailureReason,
    terminal: boolean,
  ): Promise<ProcessAssetResult> {
    const job = await this.#db.assetProcessingJob.findUnique({ where: { id: jobId } });
    const attempts = job?.attempts ?? 1;
    const maxAttempts = job?.maxAttempts ?? this.#policy.processing.maxAttempts;
    const retryable = !terminal && RETRYABLE_REASONS.has(reason) && attempts < maxAttempts;

    const now = this.#clock.now();
    await this.#db.assetProcessingJob.update({
      where: { id: jobId },
      data: retryable
        ? {
            stage: 'QUEUED',
            failureReason: reason,
            failureCode: reason,
            nextAttemptAt: new Date(
              now.getTime() + this.#policy.processing.retryBackoffSeconds * 1_000,
            ),
          }
        : {
            stage: 'FAILED',
            failureReason: reason,
            failureCode: reason,
            completedAt: now,
            nextAttemptAt: null,
          },
    });

    /*
     * QUARANTINED, NOT PROCESSING_FAILED, WHEN THE SCAN IS THE PROBLEM.
     *
     * The two statuses say different things to a customer and to every consumer
     * of `isSelectable`. An infected or unscanned file is QUARANTINED — it may
     * exist and must never be used. A file that failed for any other reason is
     * PROCESSING_FAILED, which the screen can offer to retry or delete.
     */
    const status: AssetStatus =
      reason === 'infected' || reason === 'scan_failed' || reason === 'scan_unavailable'
        ? 'QUARANTINED'
        : retryable
          ? 'PROCESSING'
          : 'PROCESSING_FAILED';

    const asset = await this.#db.asset.update({
      where: { id: assetId },
      data: { status, failureReason: reason },
    });

    return {
      assetId,
      status,
      scanStatus: asset.scanStatus,
      derivativesCreated: 0,
      failureReason: reason,
    };
  }

  async #audit(
    assetId: string,
    brandId: string | null,
    action: string,
    severity: 'INFO' | 'NOTICE' | 'WARNING',
    after: Record<string, string | number | boolean>,
  ): Promise<void> {
    await writeAuditEvent(this.#db, this.#workspaceId, {
      action,
      // SYSTEM, not the uploader. The scan verdict is the platform's finding
      // rather than an act by the person who uploaded the file, and attributing
      // it to them would read as an accusation in their activity log.
      actorType: 'SYSTEM',
      resourceType: 'Asset',
      resourceId: assetId,
      brandId: brandId ?? undefined,
      severity,
      after,
    });
  }
}

/** The stages a claimed attempt passes through. A row in one of them is being worked on. */
const RUNNING_STAGES = ['SCANNING', 'INSPECTING', 'DERIVING'] as const;

/**
 * HOW LONG A CLAIM MUST HAVE BEEN SILENT BEFORE IT IS STUCK (D-549), as
 * `stuckIngestionThresholdSeconds` is for ingestion (D-413).
 *
 * Asset processing shares the `media-processing` worker and its five-minute
 * BullMQ lock (`apps/worker/src/main.ts`), and one scan is bounded by the
 * configured `scanning.timeoutMs`. A claim younger than that bound plus the
 * lock could belong to a worker that is still alive, so the sweep never takes
 * one, whatever `processing.stuckAfterSeconds` says. The fence in `run` covers
 * the rest: an attempt that overruns even this finds itself superseded and
 * writes nothing.
 */
export const ASSET_WORKER_LOCK_SECONDS = 5 * 60;

export function stuckAssetThresholdSeconds(policy: {
  readonly processing: { readonly stuckAfterSeconds: number };
  readonly scanning: { readonly timeoutMs: number };
}): number {
  return Math.max(
    policy.processing.stuckAfterSeconds,
    Math.ceil(policy.scanning.timeoutMs / 1000) + ASSET_WORKER_LOCK_SECONDS,
  );
}

export interface StuckAssetJob {
  readonly id: string;
  readonly workspaceId: string;
  readonly brandId: string | null;
  readonly assetId: string;
  readonly attempts: number;
  readonly maxAttempts: number;
}

/**
 * The claims that went silent: a running stage, claimed before `stuckBefore`.
 * Takes a client rather than opening one, as `findUnclaimedAssetJobs` does:
 * the platform identity sees every tenant's (the scheduler), a tenant client
 * its own workspace's.
 */
export async function findStuckAssetJobs(
  db: { assetProcessingJob: { findMany(args: unknown): Promise<StuckAssetJob[]> } },
  stuckBefore: Date,
  limit: number,
): Promise<StuckAssetJob[]> {
  return db.assetProcessingJob.findMany({
    where: { stage: { in: [...RUNNING_STAGES] }, startedAt: { lt: stuckBefore } },
    select: {
      id: true,
      workspaceId: true,
      brandId: true,
      assetId: true,
      attempts: true,
      maxAttempts: true,
    },
    orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
    take: limit,
  });
}

/**
 * Hand one stuck claim back, or fail it for good (D-549).
 *
 * ONE COMPARE-AND-SET: the row must still be in a running stage, on the very
 * attempt that was found, claimed before `stuckBefore`. A worker that finished
 * in between, a second attempt that claimed it, or another replica's sweep all
 * make it match nothing, and nothing is written. Below the attempt limit it
 * goes back to QUEUED with its backoff and the reconciler dispatches the NEXT
 * attempt under a new id; the asset keeps the status it had (PROCESSING, or
 * QUARANTINED while a scan is owed) — neither is usable. At the limit the job
 * is FAILED `stuck_timeout`, and a PROCESSING asset becomes PROCESSING_FAILED,
 * which the library offers to retry or delete: an upload never reads
 * "processing" for ever. A QUARANTINED one stays quarantined. Either way it is
 * audited.
 */
export async function recoverStuckAssetJob(input: {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
  readonly job: StuckAssetJob;
  readonly stuckBefore: Date;
  readonly retryBackoffSeconds: number;
  readonly clock: Clock;
}): Promise<'requeued' | 'failed' | 'skipped'> {
  const { db, job } = input;
  const now = input.clock.now();
  const terminal = job.attempts >= job.maxAttempts;
  const moved = await db.assetProcessingJob.updateMany({
    where: {
      id: job.id,
      workspaceId: input.workspaceId,
      stage: { in: [...RUNNING_STAGES] },
      attempts: job.attempts,
      startedAt: { lt: input.stuckBefore },
    },
    data: terminal
      ? {
          stage: 'FAILED',
          failureReason: 'stuck_timeout',
          failureCode: 'stuck_timeout',
          completedAt: now,
          nextAttemptAt: null,
        }
      : {
          stage: 'QUEUED',
          failureReason: 'stuck_timeout',
          failureCode: 'stuck_timeout',
          nextAttemptAt: new Date(now.getTime() + input.retryBackoffSeconds * 1000),
        },
  });
  if (moved.count !== 1) return 'skipped';

  if (terminal) {
    await db.asset.updateMany({
      where: { id: job.assetId, status: 'PROCESSING' },
      data: { status: 'PROCESSING_FAILED', failureReason: 'stuck_timeout' },
    });
  }
  await writeAuditEvent(db, input.workspaceId, {
    action: terminal ? 'assets.processing_failed' : 'assets.processing_retry_scheduled',
    actorType: 'SYSTEM',
    resourceType: 'Asset',
    resourceId: job.assetId,
    brandId: job.brandId ?? undefined,
    severity: terminal ? 'WARNING' : 'INFO',
    after: { jobId: job.id, attempt: job.attempts, reason: 'stuck_timeout' },
  });
  return terminal ? 'failed' : 'requeued';
}
