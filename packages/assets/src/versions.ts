import {
  writeAuditEvent,
  type Asset,
  type AssetProcessingJob,
  type AssetVersion,
  type TenantScopedClient,
} from '@brandspace/database';
import { checksumOf, type ObjectStore } from '@brandspace/storage';
import { type Clock, systemClock } from '@brandspace/shared';
import { assetBrandScopeFilter, assertPermission, type AssetActor } from './actor';
import {
  assetNotFound,
  contentTypeMismatch,
  emptyFile,
  fileTooLarge,
  versionLimitReached,
  versionNotFound,
} from './errors';
import { checkAssetSignature } from './file-safety';
import { maxBytesForKind, type AssetPolicy } from './policy';
import { assetObjectKey } from './storage-keys';

/**
 * Versions — replacing the bytes behind an asset, and going back.
 *
 * A NEW VERSION IS A NEW OBJECT, NEVER AN OVERWRITE. The version number is in
 * the storage key, so version 1 keeps pointing at exactly the bytes that were
 * uploaded as version 1 for as long as the row exists. An overwrite would make
 * the whole history point at whatever was written last, which turns "restore
 * version 2" into a promise the platform cannot keep — and `asset_version` is
 * append-only in three layers precisely so that promise is real.
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
 */

export interface AssetVersionServiceOptions {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
  readonly store: ObjectStore;
  readonly policy: AssetPolicy;
  readonly clock?: Clock;
}

export class AssetVersionService {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;
  readonly #store: ObjectStore;
  readonly #policy: AssetPolicy;
  readonly #clock: Clock;

  constructor(options: AssetVersionServiceOptions) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#store = options.store;
    this.#policy = options.policy;
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
   */
  async addVersion(input: {
    readonly assetId: string;
    readonly bytes: Uint8Array;
    readonly actor: AssetActor;
  }): Promise<{ asset: Asset; version: AssetVersion; job: AssetProcessingJob }> {
    assertPermission(input.actor, 'assets.version');

    // D-132: the scope is part of the WHERE, so an out-of-scope row is never
    // read. `assetBrandScopeFilter` keeps the NULL-brand (workspace-level) rule.
    const asset = await this.#db.asset.findFirst({
      where: { id: input.assetId, ...assetBrandScopeFilter(input.actor) },
    });
    if (!asset || asset.deletedAt !== null) throw assetNotFound();

    if (input.bytes.byteLength === 0) throw emptyFile();
    if (input.bytes.byteLength > maxBytesForKind(this.#policy.upload, asset.kind)) {
      throw fileTooLarge();
    }
    // The bytes decide, as always. A version whose content disagrees with the
    // asset's declared type is refused before anything is stored.
    if (!checkAssetSignature(asset.mimeType, input.bytes).ok) throw contentTypeMismatch();

    const liveVersions = await this.#db.assetVersion.count({ where: { assetId: asset.id } });
    if (liveVersions >= this.#policy.versions.maxVersionsPerAsset) throw versionLimitReached();

    const versionNumber = asset.currentVersion + 1;
    const checksum = await checksumOf(input.bytes);
    const storageKey = assetObjectKey({
      workspaceId: this.#workspaceId,
      brandId: asset.brandId,
      assetId: asset.id,
      versionNumber,
    });

    await this.#store.put(storageKey, input.bytes, asset.mimeType);

    const version = await this.#db.assetVersion.create({
      data: {
        workspaceId: this.#workspaceId,
        brandId: asset.brandId,
        assetId: asset.id,
        versionNumber,
        storageKey,
        checksumSha256: checksum,
        mimeType: asset.mimeType,
        sizeBytes: input.bytes.byteLength,
        scanStatus: 'PENDING',
        createdByUserId: input.actor.userId,
      },
    });

    /*
     * THE ASSET RETURNS TO QUARANTINE. Both fields move back: `scanStatus` to
     * PENDING because these bytes have not been scanned, and `status` to
     * PROCESSING because the job has not run. `isSelectable` requires both, so
     * for the length of the scan this asset cannot be chosen or downloaded —
     * which is the whole point.
     */
    const updated = await this.#db.asset.update({
      where: { id: asset.id },
      data: {
        currentVersion: versionNumber,
        storageKey,
        checksumSha256: checksum,
        sizeBytes: input.bytes.byteLength,
        scanStatus: 'PENDING',
        scanReason: null,
        scannedAt: null,
        status: 'PROCESSING',
        failureReason: null,
      },
    });

    const job = await this.#db.assetProcessingJob.create({
      data: {
        workspaceId: this.#workspaceId,
        brandId: asset.brandId,
        assetId: asset.id,
        stage: 'QUEUED',
        maxAttempts: this.#policy.processing.maxAttempts,
        queuedAt: this.#clock.now(),
      },
    });

    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'assets.version_created',
      actorType: 'USER',
      actorId: input.actor.userId,
      resourceType: 'Asset',
      resourceId: asset.id,
      brandId: asset.brandId ?? undefined,
      severity: 'NOTICE',
      before: { version: asset.currentVersion, sizeBytes: asset.sizeBytes },
      after: { version: versionNumber, sizeBytes: input.bytes.byteLength },
    });

    return { asset: updated, version, job };
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
    const version = await this.#db.assetVersion.create({
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

    const updated = await this.#db.asset.update({
      where: { id: asset.id },
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

    await writeAuditEvent(this.#db, this.#workspaceId, {
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

    return { asset: updated, version };
  }
}
