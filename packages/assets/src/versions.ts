import { randomUUID } from 'node:crypto';
import {
  writeAuditEvent,
  type Asset,
  type AssetProcessingJob,
  type AssetVersion,
  type PrismaClient,
  type TenantScopedClient,
} from '@brandspace/database';
import { QUOTA_FEATURES, QuotaExceededError, type UsageService } from '@brandspace/entitlements';
import { checksumOf, type ObjectStore } from '@brandspace/storage';
import { AppError, type Clock, createLogger, systemClock } from '@brandspace/shared';
import { assetBrandScopeFilter, assertPermission, type AssetActor } from './actor';
import {
  assetChangedDuringVersionUpload,
  assetNotFound,
  contentTypeMismatch,
  emptyFile,
  fileTooLarge,
  storageQuotaReached,
  versionLimitReached,
  versionNotFound,
} from './errors';
import { checkAssetSignature } from './file-safety';
import { maxBytesForKind, type AssetPolicy } from './policy';
import { assetVersionAttemptKey } from './storage-keys';

/**
 * Versions — replacing the bytes behind an asset, and going back.
 *
 * A NEW VERSION IS A NEW OBJECT, NEVER AN OVERWRITE. Version 1 keeps pointing
 * at exactly the bytes that were uploaded as version 1 for as long as the row
 * exists. An overwrite would make the whole history point at whatever was
 * written last, which turns "restore version 2" into a promise the platform
 * cannot keep — and `asset_version` is append-only in three layers precisely
 * so that promise is real.
 *
 * REPLACING BYTES IS ITS OWN PERMISSION (`assets.version`), separate from
 * `assets.edit`. Editing metadata changes what an asset is CALLED; adding a
 * version changes what every piece of content already referencing it will
 * PUBLISH. Those are different amounts of trust.
 *
 * THE NEW VERSION IS QUARANTINED LIKE ANY UPLOAD. It goes through the same
 * scan, and the asset returns to PROCESSING until the verdict arrives — so an
 * asset that was clean yesterday cannot be turned into a delivery mechanism by
 * a version nobody scanned.
 *
 * A NEW VERSION IS STORAGE, AND IS CHARGED LIKE ANY UPLOAD (B-1). Its exact
 * bytes are reserved against the same `limit.storage_gb` byte meter as an
 * ordinary upload before the object is written, and stay charged until the
 * asset is purged — which refunds each distinct object once. A restore stores
 * nothing new and is charged nothing.
 */

/** What an operator needs to find and reconcile a failed version attempt. */
export interface VersionCompensationFailure {
  readonly workspaceId: string;
  readonly assetId: string;
  readonly attemptId: string;
  readonly versionNumber: number;
  readonly bytes: number;
  /** Which compensating steps did not complete. */
  readonly failed: ReadonlyArray<'object_delete' | 'storage_refund'>;
}

export interface AssetVersionServiceOptions {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
  readonly store: ObjectStore;
  readonly policy: AssetPolicy;
  /**
   * B-1 — REQUIRED. The byte meter every new version is charged to. There is
   * deliberately no default: a version service that could run without it is
   * the unmetered path this fix closes.
   */
  readonly usage: UsageService;
  /**
   * The plan's storage ceiling in GIGABYTES (`limit.storage_gb`), from the
   * entitlements engine. `null` is unlimited — but it must be SAID; the key is
   * required, like `AssetUploadService`'s.
   */
  readonly storageLimitGb: number | null;
  /**
   * Where a compensation that did not complete is RECORDED beyond the log.
   *
   * It cannot be this service's own transaction: the failure is about to be
   * rethrown, and the caller's transaction rolls back with it — taking any
   * audit row written here along. So, like `DenialSink` for approvals, the
   * caller supplies a writer on a SEPARATE connection. Absent (tests), the
   * failure is still logged.
   */
  readonly onCompensationFailure?: (failure: VersionCompensationFailure) => Promise<void>;
  readonly clock?: Clock;
}

const log = createLogger({ context: { component: 'assets.versions' } });

/**
 * Run `fn` as ONE nested transaction — a SAVEPOINT — on the caller's
 * tenant-scoped transaction.
 *
 * WHY A SAVEPOINT AND NOT A NEW TRANSACTION. Every caller reaches this service
 * inside `withWorkspace`, whose transaction carries `app.workspace_id`, the
 * setting every RLS policy reads. A fresh transaction from another client
 * would run WITHOUT it. Prisma runs a nested `$transaction` on an interactive
 * transaction client as a savepoint on the same connection, so the writes are
 * atomic among themselves, stay under the caller's RLS context, and a failure
 * rolls back only these writes — leaving the outer transaction usable for the
 * compensation that follows. `TenantScopedClient` hides `$transaction` so
 * ordinary code cannot open a second, unscoped transaction by accident; this
 * is the one place that deliberately nests one, and it proves the context
 * first rather than assuming it.
 */
async function inTenantSavepoint<T>(
  db: TenantScopedClient,
  workspaceId: string,
  fn: (tx: TenantScopedClient) => Promise<T>,
): Promise<T> {
  return (db as unknown as PrismaClient).$transaction(async (tx) => {
    const [context] = await tx.$queryRaw<{ workspace: string | null }[]>`
      SELECT current_setting('app.workspace_id', true) AS "workspace"`;
    if (context?.workspace !== workspaceId) {
      throw new AppError('TENANT_CONTEXT_MISSING', 'Version persistence lost its tenant context.');
    }
    return fn(tx as unknown as TenantScopedClient);
  });
}

/** A unique violation, recognised structurally (Prisma P2002). */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}

export class AssetVersionService {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;
  readonly #store: ObjectStore;
  readonly #policy: AssetPolicy;
  readonly #usage: UsageService;
  readonly #storageLimitGb: number | null;
  readonly #onCompensationFailure: AssetVersionServiceOptions['onCompensationFailure'];
  readonly #clock: Clock;

  constructor(options: AssetVersionServiceOptions) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#store = options.store;
    this.#policy = options.policy;
    this.#usage = options.usage;
    this.#storageLimitGb = options.storageLimitGb;
    this.#onCompensationFailure = options.onCompensationFailure;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Add a version from new bytes.
   *
   * THE MEDIA TYPE CANNOT CHANGE. A version is a new revision of the SAME
   * asset, and letting a PNG become a PDF would break every consumer that read
   * the kind once and cached it — and would route the file past the size
   * ceiling its new kind carries. Replacing a file with a different kind of
   * file is a new asset, which the customer can upload.
   *
   * THE ORDER IS THE CONTRACT (B-1). Everything that can refuse without
   * touching storage runs first; only then are the bytes reserved, then
   * written under a key only this attempt owns, then recorded in ONE
   * savepoint. A failure after the reservation deletes this attempt's object
   * and gives its bytes back; a success keeps them charged until purge.
   *
   * REPLAY IS PROVED BY STATE, NOT BY A USAGE EVENT. If the bytes are exactly
   * the CURRENT version's (same checksum, and that version is committed and
   * current), this is an immediate retry of a request that already succeeded:
   * the existing result is returned and nothing is stored or charged. That is
   * all it detects — an identical checksum that exists only in an OLDER version
   * is treated as a new upload, and a failed attempt left no version, so its
   * retry reserves storage again from scratch.
   */
  async addVersion(input: {
    readonly assetId: string;
    readonly bytes: Uint8Array;
    readonly actor: AssetActor;
  }): Promise<{
    asset: Asset;
    version: AssetVersion;
    /** Null only on a replay of a version whose job no longer exists. */
    job: AssetProcessingJob | null;
    /** True when this was an immediate retry of the current version. */
    replayed: boolean;
  }> {
    // 1. Permission.
    assertPermission(input.actor, 'assets.version');

    // 2. Lookup under brand scope. D-132: the scope is part of the WHERE, so an
    // out-of-scope row is never read. `assetBrandScopeFilter` keeps the
    // NULL-brand (workspace-level) rule.
    const asset = await this.#db.asset.findFirst({
      where: { id: input.assetId, ...assetBrandScopeFilter(input.actor) },
    });
    // 3. Deleted state.
    if (!asset || asset.deletedAt !== null) throw assetNotFound();

    // 4-6. Empty, size, and the bytes decide the type, as always.
    const size = input.bytes.byteLength;
    if (size === 0) throw emptyFile();
    if (size > maxBytesForKind(this.#policy.upload, asset.kind)) throw fileTooLarge();
    if (!checkAssetSignature(asset.mimeType, input.bytes).ok) throw contentTypeMismatch();

    // 7. Checksum.
    const checksum = await checksumOf(input.bytes);

    // 8. Immediate replay of the CURRENT, committed version.
    const current = await this.#db.assetVersion.findFirst({
      where: { assetId: asset.id, versionNumber: asset.currentVersion },
    });
    if (
      current &&
      current.checksumSha256 === checksum &&
      asset.checksumSha256 === checksum &&
      asset.storageKey === current.storageKey
    ) {
      const job = await this.#db.assetProcessingJob.findFirst({
        where: { assetId: asset.id },
        orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }],
      });
      return { asset, version: current, job, replayed: true };
    }

    // 9. The version ceiling.
    const liveVersions = await this.#db.assetVersion.count({ where: { assetId: asset.id } });
    if (liveVersions >= this.#policy.versions.maxVersionsPerAsset) throw versionLimitReached();

    // 10. Reserve the exact bytes, under a key unique to THIS attempt. A key
    // shared across attempts would let a refunded attempt's retry be taken
    // for a completed charge and store bytes for free.
    const attemptId = randomUUID();
    const versionNumber = asset.currentVersion + 1;
    const keys = {
      consume: `asset-version:${asset.id}:${attemptId}:consume`,
      refund: `asset-version:${asset.id}:${attemptId}:refund`,
    };
    try {
      await this.#usage.consumeBytes({
        workspaceId: this.#workspaceId,
        featureKey: QUOTA_FEATURES.storageGb,
        limitGb: this.#storageLimitGb,
        bytes: size,
        idempotencyKey: keys.consume,
      });
    } catch (error) {
      // The SAME refusal an ordinary upload gives, before any object exists.
      if (error instanceof QuotaExceededError) throw storageQuotaReached();
      throw error;
    }

    // 11-12. An object only this attempt can ever write.
    const storageKey = assetVersionAttemptKey({
      workspaceId: this.#workspaceId,
      brandId: asset.brandId,
      assetId: asset.id,
      versionNumber,
      attemptId,
    });
    const attempt = { attemptId, versionNumber, storageKey, bytes: size, refundKey: keys.refund };

    try {
      await this.#store.put(storageKey, input.bytes, asset.mimeType);
    } catch (error) {
      await this.#compensate(asset.id, attempt);
      throw error;
    }

    // 13. ONE savepoint: the asset claim, the version, the job, the audit.
    try {
      const persisted = await inTenantSavepoint(this.#db, this.#workspaceId, async (tx) => {
        /*
         * THE CLAIM COMES FIRST, AND IT IS CONDITIONAL. The asset moves only
         * if it is still at the version this request was built on. A
         * concurrent upload that already moved it wins, and this one gets a
         * retryable conflict instead of stacking silently on a version its
         * author never saw. The UPDATE takes the row lock, so two claims
         * cannot both succeed. Both fields go back to quarantine: these bytes
         * are unscanned and the job has not run.
         */
        const claimed = await tx.asset.updateMany({
          where: {
            id: asset.id,
            currentVersion: asset.currentVersion,
            deletedAt: null,
            ...assetBrandScopeFilter(input.actor),
          },
          data: {
            currentVersion: versionNumber,
            storageKey,
            checksumSha256: checksum,
            sizeBytes: size,
            scanStatus: 'PENDING',
            scanReason: null,
            scannedAt: null,
            status: 'PROCESSING',
            failureReason: null,
          },
        });
        if (claimed.count === 0) throw assetChangedDuringVersionUpload();

        const version = await tx.assetVersion.create({
          data: {
            workspaceId: this.#workspaceId,
            brandId: asset.brandId,
            assetId: asset.id,
            versionNumber,
            storageKey,
            checksumSha256: checksum,
            mimeType: asset.mimeType,
            sizeBytes: size,
            scanStatus: 'PENDING',
            createdByUserId: input.actor.userId,
          },
        });
        const job = await tx.assetProcessingJob.create({
          data: {
            workspaceId: this.#workspaceId,
            brandId: asset.brandId,
            assetId: asset.id,
            stage: 'QUEUED',
            maxAttempts: this.#policy.processing.maxAttempts,
            queuedAt: this.#clock.now(),
          },
        });
        await writeAuditEvent(tx, this.#workspaceId, {
          action: 'assets.version_created',
          actorType: 'USER',
          actorId: input.actor.userId,
          resourceType: 'Asset',
          resourceId: asset.id,
          brandId: asset.brandId ?? undefined,
          severity: 'NOTICE',
          before: { version: asset.currentVersion, sizeBytes: asset.sizeBytes },
          after: { version: versionNumber, sizeBytes: size },
        });
        const updated = await tx.asset.findUniqueOrThrow({ where: { id: asset.id } });
        return { asset: updated, version, job };
      });
      // 14. Committed with the caller's transaction; the bytes stay charged.
      return { ...persisted, replayed: false };
    } catch (error) {
      // Nothing of this attempt was recorded: the savepoint rolled back.
      await this.#compensate(asset.id, attempt);
      // A version number taken by another path is the same race, told the
      // same way — never a raw constraint error.
      throw isUniqueViolation(error) ? assetChangedDuringVersionUpload() : error;
    }
  }

  /**
   * Undo a failed attempt: delete ITS object and give back ITS bytes.
   *
   * SAFE BY CONSTRUCTION. The object key carries this attempt's id, so no
   * committed version, no concurrent winner and no restored row can point at
   * it — deleting it can only remove this attempt's own bytes. The refund
   * carries its own per-attempt key, so running this twice refunds once.
   *
   * BEST EFFORT, AND NEVER SILENT. The object store and the database are not
   * one transaction. If a step fails it is logged with every identifier needed
   * to reconcile it and handed to `onCompensationFailure`; the ORIGINAL error
   * still reaches the caller, and no version is ever reported as created.
   * `pnpm storage:recompute` (dry run) detects a counter left high; an orphan
   * object is an operational clean-up, never an automatic delete.
   */
  async #compensate(
    assetId: string,
    attempt: {
      readonly attemptId: string;
      readonly versionNumber: number;
      readonly storageKey: string;
      readonly bytes: number;
      readonly refundKey: string;
    },
  ): Promise<void> {
    const failed: Array<'object_delete' | 'storage_refund'> = [];
    try {
      await this.#store.delete(attempt.storageKey);
    } catch {
      failed.push('object_delete');
    }
    try {
      await this.#usage.refundBytes({
        workspaceId: this.#workspaceId,
        featureKey: QUOTA_FEATURES.storageGb,
        bytes: attempt.bytes,
        idempotencyKey: attempt.refundKey,
      });
    } catch {
      failed.push('storage_refund');
    }
    if (failed.length === 0) return;

    const failure: VersionCompensationFailure = {
      workspaceId: this.#workspaceId,
      assetId,
      attemptId: attempt.attemptId,
      versionNumber: attempt.versionNumber,
      bytes: attempt.bytes,
      failed,
    };
    log.error('asset version compensation did not complete', { ...failure });
    try {
      await this.#onCompensationFailure?.(failure);
    } catch (sinkError) {
      log.error('asset version compensation could not be recorded', {
        ...failure,
        errorName: sinkError instanceof Error ? sinkError.name : 'UnknownError',
      });
    }
  }

  /**
   * Go back to an earlier version.
   *
   * A RESTORE IS A FORWARD VERSION, never a rewind. The same shape the Brand
   * Brain knowledge rollback uses, and for the same reason: `asset_version` is
   * append-only, so there is no "undo" to perform — restoring version 2 as
   * version 5 keeps every row, keeps the audit trail honest about what happened
   * and when, and leaves 3 and 4 restorable in their turn.
   *
   * It costs no new storage: the new row points at the SAME object the old
   * version does, because the bytes are byte-identical and there is nothing to
   * gain from a second copy.
   */
  async restoreVersion(input: {
    readonly assetId: string;
    readonly versionNumber: number;
    readonly actor: AssetActor;
  }): Promise<{ asset: Asset; version: AssetVersion }> {
    assertPermission(input.actor, 'assets.version');

    // D-132: the scope is part of the WHERE, so an out-of-scope row is never
    // read. `assetBrandScopeFilter` keeps the NULL-brand (workspace-level) rule.
    const asset = await this.#db.asset.findFirst({
      where: { id: input.assetId, ...assetBrandScopeFilter(input.actor) },
    });
    if (!asset || asset.deletedAt !== null) throw assetNotFound();

    const source = await this.#db.assetVersion.findFirst({
      where: { assetId: asset.id, versionNumber: input.versionNumber },
    });
    if (!source) throw versionNotFound();

    const liveVersions = await this.#db.assetVersion.count({ where: { assetId: asset.id } });
    if (liveVersions >= this.#policy.versions.maxVersionsPerAsset) throw versionLimitReached();

    const versionNumber = asset.currentVersion + 1;
    /*
     * ZERO NEW STORAGE (B-1). The new row points at the SAME object the source
     * version does, so nothing is reserved or charged: that object is already
     * counted, and purge and recompute count each distinct object once however
     * many rows share it.
     *
     * The same claim-first savepoint as `addVersion`, so a restore racing an
     * upload is refused the same retryable way rather than colliding on the
     * version number.
     */
    return inTenantSavepoint(this.#db, this.#workspaceId, async (tx) => {
      const claimed = await tx.asset.updateMany({
        where: {
          id: asset.id,
          currentVersion: asset.currentVersion,
          deletedAt: null,
          ...assetBrandScopeFilter(input.actor),
        },
        data: {
          currentVersion: versionNumber,
          storageKey: source.storageKey,
          checksumSha256: source.checksumSha256,
          sizeBytes: source.sizeBytes,
          width: source.width,
          height: source.height,
          durationMs: source.durationMs,
          /*
           * NO RE-SCAN, AND THE CHECKSUM IS WHY. These are bytes this workspace
           * already stored and a scanner already cleared, identified by content
           * rather than by name. Re-scanning them would be honest but pointless;
           * what would NOT be honest is restoring a version whose own scan never
           * came back clean, so the source row's verdict is carried across and an
           * unscanned version restores to quarantine.
           */
          scanStatus: source.scanStatus,
          status: source.scanStatus === 'CLEAN' ? 'READY' : 'QUARANTINED',
          failureReason: null,
        },
      });
      if (claimed.count === 0) throw assetChangedDuringVersionUpload();

      const version = await tx.assetVersion.create({
        data: {
          workspaceId: this.#workspaceId,
          brandId: asset.brandId,
          assetId: asset.id,
          versionNumber,
          // THE SAME OBJECT. The bytes are identical; a copy would double the
          // storage a customer pays for to store something they already have.
          storageKey: source.storageKey,
          checksumSha256: source.checksumSha256,
          mimeType: source.mimeType,
          sizeBytes: source.sizeBytes,
          width: source.width,
          height: source.height,
          durationMs: source.durationMs,
          // Already scanned as this exact content — the checksum says so.
          scanStatus: source.scanStatus,
          createdByUserId: input.actor.userId,
        },
      });

      await writeAuditEvent(tx, this.#workspaceId, {
        action: 'assets.version_restored',
        actorType: 'USER',
        actorId: input.actor.userId,
        resourceType: 'Asset',
        resourceId: asset.id,
        brandId: asset.brandId ?? undefined,
        severity: 'NOTICE',
        before: { version: asset.currentVersion },
        after: { version: versionNumber, restoredFrom: input.versionNumber },
      });

      const updated = await tx.asset.findUniqueOrThrow({ where: { id: asset.id } });
      return { asset: updated, version };
    }).catch((error: unknown) => {
      throw isUniqueViolation(error) ? assetChangedDuringVersionUpload() : error;
    });
  }
}
