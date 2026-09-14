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

  async process(jobId: string): Promise<ProcessAssetResult> {
    const job = await this.#db.assetProcessingJob.findUnique({ where: { id: jobId } });
    // A job in another workspace is invisible to RLS and arrives as null.
    if (!job) throw new Error('Asset processing job not found.');

    const asset = await this.#db.asset.findUnique({ where: { id: job.assetId } });
    if (!asset) throw new Error('Asset not found.');

    // A DUPLICATE DELIVERY STOPS HERE. The row is the state; a finished job
    // reports what it found rather than doing the work again.
    if (job.stage === 'COMPLETED' || job.stage === 'FAILED') {
      return {
        assetId: asset.id,
        status: asset.status,
        scanStatus: asset.scanStatus,
        derivativesCreated: job.derivativesCreated,
        failureReason: (job.failureReason as AssetFailureReason | null) ?? null,
      };
    }

    const now = this.#clock.now();
    await this.#db.assetProcessingJob.update({
      where: { id: job.id },
      data: { stage: 'SCANNING', attempts: { increment: 1 }, startedAt: now },
    });

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
      data: { scanStatus: 'CLEAN', scanReason: null, scannedAt: this.#clock.now() },
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
