import {
  writeAuditEvent,
  type Asset,
  type AssetProcessingJob,
  type AssetUploadSession,
  type TenantScopedClient,
} from '@brandspace/database';
import { QUOTA_FEATURES, QuotaExceededError, type UsageService } from '@brandspace/entitlements';
import { checksumOf, type ObjectStore } from '@brandspace/storage';
import { type Clock, systemClock } from '@brandspace/shared';
import {
  assetBrandScopeFilter,
  assertAssetBrandInScope,
  assertPermission,
  type AssetActor,
} from './actor';
import {
  assetLimitReached,
  contentTypeMismatch,
  declaredSizeMismatch,
  duplicateAsset,
  emptyFile,
  fileTooLarge,
  folderNotFound,
  storageQuotaReached,
  unsupportedFileType,
  uploadSessionExpired,
  uploadSessionNotFound,
} from './errors';
import { checkAssetSignature, normaliseFileName, signatureIsKnown } from './file-safety';
import { kindForMimeType, maxBytesForKind, type AssetPolicy } from './policy';
import { assetObjectKey, uploadStagingKey } from './storage-keys';

/**
 * Upload — initiate, then complete.
 *
 * WHY TWO STEPS RATHER THAN ONE. Every authorisation and every ceiling that can
 * be decided WITHOUT the bytes is decided before any bytes exist: permission,
 * brand scope, the folder, the declared type, the declared size, the per-brand
 * asset count and the plan storage quota. Refusing a 500 MB video after
 * receiving it costs the platform the 500 MB and the customer the wait; the
 * whole point of a session is that the refusal arrives first.
 *
 * It is also the shape a real storage vendor needs. R-09 and docs/SECURITY.md
 * §11.1 call for a PRE-SIGNED upload with a server-issued key, so that the API
 * never proxies bytes. The session IS that contract: it issues a key and a
 * window, and `complete` records what arrived. Against the filesystem store
 * the bytes pass through `complete`; against a vendor adapter they would go
 * straight to the bucket and `complete` would verify what landed. Neither the
 * session shape nor anything that depends on it changes between the two, which
 * is why the boundary is worth having before the vendor is chosen.
 *
 * WHAT COMPLETE STILL CHECKS, and why it cannot be skipped. The bytes decide
 * what the file IS — the declared type was only ever the caller's opinion — so
 * the signature is verified here, and the actual size is compared against what
 * the quota was spent on. A caller that under-declares to get past the quota
 * and then sends more is refused rather than reconciled.
 *
 * IDEMPOTENCY HAS TWO KEYS, BECAUSE THERE ARE TWO QUESTIONS.
 *   - `idempotencyKey` answers "is this the same REQUEST?" — a client retrying
 *     an initiate whose response it lost. It replays the original session.
 *   - `checksumSha256` answers "is this the same FILE?" — a customer uploading
 *     the same photo twice from two screens. It refuses as a duplicate.
 * A single key could not tell those apart, and they deserve different answers:
 * one is a network artefact, the other is a person making a mistake.
 */

export interface AssetUploadServiceOptions {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
  readonly store: ObjectStore;
  readonly policy: AssetPolicy;
  readonly usage: UsageService;
  /**
   * The plan's storage ceiling in GIGABYTES, resolved from the entitlements
   * engine. `null` means unlimited.
   *
   * PASSED IN RATHER THAN RESOLVED HERE, deliberately. The limit comes from
   * plan, override, flag and default in that precedence (D-10), and this
   * service has no business re-deriving it — that is the entitlement engine's
   * single job, and a second implementation of the precedence rules is a second
   * answer.
   */
  readonly storageLimitGb: number | null;
  readonly clock?: Clock;
}

export interface InitiateUploadInput {
  readonly brandId: string | null;
  readonly folderId: string | null;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly idempotencyKey: string;
  readonly actor: AssetActor;
}

export interface InitiatedUpload {
  readonly session: AssetUploadSession;
  /** Where the bytes go. Opaque to the caller and never a path or a URL. */
  readonly storageKey: string;
  readonly expiresAt: Date;
  /** True when an identical session already existed. A replay, not a new one. */
  readonly replayed: boolean;
}

/** A gigabyte, as the quota counts it. Binary, matching how storage is sold. */
const BYTES_PER_GB = 1024 * 1024 * 1024;

export class AssetUploadService {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;
  readonly #store: ObjectStore;
  readonly #policy: AssetPolicy;
  readonly #usage: UsageService;
  readonly #storageLimitGb: number | null;
  readonly #clock: Clock;

  constructor(options: AssetUploadServiceOptions) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#store = options.store;
    this.#policy = options.policy;
    this.#usage = options.usage;
    this.#storageLimitGb = options.storageLimitGb;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Open an upload session, having decided everything that can be decided
   * without the bytes.
   */
  async initiate(input: InitiateUploadInput): Promise<InitiatedUpload> {
    // BEFORE ANYTHING ELSE. An actor without the permission, or aimed at a
    // brand outside their scope, is refused before a single row is read — so
    // nothing is counted, reserved or disclosed on the way to the refusal.
    assertPermission(input.actor, 'assets.upload');
    assertAssetBrandInScope(input.actor, input.brandId);

    if (input.sizeBytes <= 0) throw emptyFile();

    /*
     * THE DECLARED TYPE DECIDES ONE THING ONLY: whether this workspace may
     * upload this KIND of file. It does not decide a parser, a store or a
     * pipeline — the bytes do that at `complete`.
     */
    const kind = kindForMimeType(this.#policy.upload, input.mimeType);
    if (kind === null) throw unsupportedFileType();
    /*
     * AN OPERATOR CAN ADMIT A TYPE NOBODY CAN VERIFY. The allow-list is
     * configuration, so a type can be added to it that has no signature
     * expectation. Storing a file whose contents were never checked against its
     * claim is precisely the guarantee docs/SECURITY.md §11.2 makes, so the
     * upload is refused at the door instead.
     */
    if (!signatureIsKnown(input.mimeType)) throw unsupportedFileType();
    if (input.sizeBytes > maxBytesForKind(this.#policy.upload, kind)) throw fileTooLarge();

    // Refused or normalised BEFORE it reaches a row. See file-safety.ts: a
    // traversing name is refused rather than repaired.
    const fileName = normaliseFileName(input.fileName, this.#policy.upload.maxFileNameLength);

    // REQUEST idempotency: a retry of an initiate whose response was lost.
    const replay = await this.#db.assetUploadSession.findFirst({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (replay) {
      /*
       * A REPLAY IS RETURNED EVEN IF IT HAS EXPIRED, and the caller is told so
       * by the expiry it carries. Silently minting a fresh session under a used
       * key would spend the quota twice for one logical upload, which is the
       * exact failure the key exists to prevent.
       */
      return {
        session: replay,
        storageKey: replay.storageKey,
        expiresAt: replay.expiresAt,
        replayed: true,
      };
    }

    if (input.folderId !== null) await this.#assertFolderUsable(input.folderId, input.brandId);

    /*
     * THE PER-BRAND CEILING. Counted over LIVE rows only: a customer who
     * deleted a hundred assets has a hundred slots back, which is what a
     * customer expects a delete to mean.
     */
    const liveCount = await this.#db.asset.count({
      where: { brandId: input.brandId, deletedAt: null },
    });
    if (liveCount >= this.#policy.upload.maxAssetsPerBrand) throw assetLimitReached();

    const now = this.#clock.now();
    const expiresAt = new Date(now.getTime() + this.#policy.upload.sessionTtlSeconds * 1_000);

    /*
     * THE QUOTA IS SPENT BEFORE THE BYTES ARRIVE, against the DECLARED size.
     *
     * Counting after the upload would let a workspace at its ceiling upload
     * anything it liked and be told afterwards — the bytes are already stored
     * and the cost already paid. `UsageService.consume` does the check and the
     * increment in one statement, so two concurrent uploads cannot both pass a
     * check that only one of them should.
     *
     * The consequence is that an abandoned session holds quota until it is
     * swept. That is the correct trade: a held slot is recoverable and an
     * overspent plan is not, and `expireStaleSessions` gives the slot back.
     */
    await this.#consumeStorage(input.sizeBytes, `asset-upload:${input.idempotencyKey}`);

    const session = await this.#db.assetUploadSession.create({
      data: {
        workspaceId: this.#workspaceId,
        brandId: input.brandId,
        folderId: input.folderId,
        declaredFileName: fileName.name,
        declaredMimeType: input.mimeType,
        declaredSizeBytes: input.sizeBytes,
        // Replaced immediately below; the row has to exist first so the key can
        // carry its id, which is what keeps one staging object per session.
        storageKey: 'pending',
        status: 'PENDING',
        idempotencyKey: input.idempotencyKey,
        createdByUserId: input.actor.userId,
        expiresAt,
      },
    });

    const storageKey = uploadStagingKey({
      workspaceId: this.#workspaceId,
      sessionId: session.id,
    });
    const stored = await this.#db.assetUploadSession.update({
      where: { id: session.id },
      data: { storageKey },
    });

    return { session: stored, storageKey, expiresAt, replayed: false };
  }

  /**
   * Complete a session with the bytes that arrived.
   *
   * IDEMPOTENT. A second completion of a session that already produced an asset
   * returns that asset rather than creating a second one — a duplicate submit,
   * a retried request and a doubled webhook all converge on one row.
   */
  async complete(input: {
    readonly sessionId: string;
    readonly bytes: Uint8Array;
    readonly actor: AssetActor;
  }): Promise<{ asset: Asset; job: AssetProcessingJob | null; replayed: boolean }> {
    assertPermission(input.actor, 'assets.upload');

    // A session in another workspace is invisible to RLS and arrives here as
    // null — the same answer a session that never existed gives. D-132 puts the
    // BRAND scope in the same place rather than checking it after the read.
    const session = await this.#db.assetUploadSession.findFirst({
      where: { id: input.sessionId, ...assetBrandScopeFilter(input.actor) },
    });
    if (!session) throw uploadSessionNotFound();

    // REPLAY. The session already produced an asset; return it untouched.
    if (session.status === 'COMPLETED' && session.assetId !== null) {
      const existing = await this.#db.asset.findUnique({ where: { id: session.assetId } });
      if (existing) return { asset: existing, job: null, replayed: true };
    }
    if (session.status === 'ABORTED' || session.status === 'EXPIRED') {
      throw uploadSessionExpired();
    }
    if (session.expiresAt.getTime() <= this.#clock.now().getTime()) {
      await this.#abort(session.id, 'stuck_timeout');
      throw uploadSessionExpired();
    }

    if (input.bytes.byteLength === 0) {
      await this.#abort(session.id, 'file_empty');
      throw emptyFile();
    }

    /*
     * THE BYTES DECIDE WHAT THE FILE IS, NOT THE CALLER.
     *
     * `declaredMimeType` came from the browser, which derives it from the file
     * EXTENSION, or from a scripted upload, which can simply assert it. It was
     * the right basis for "may this workspace upload this kind of thing" and it
     * is the wrong basis for anything else. A signature mismatch is refused
     * before the object is written — nothing unverified is ever stored.
     */
    const signature = checkAssetSignature(session.declaredMimeType, input.bytes);
    if (!signature.ok) {
      await this.#abort(session.id, 'content_type_mismatch');
      throw contentTypeMismatch();
    }

    /*
     * THE SIZE THE QUOTA WAS SPENT ON IS THE SIZE ALLOWED.
     *
     * A completion larger than the declaration has spent storage the workspace
     * was not granted. Reconciling it would mean a caller can always
     * under-declare and then send whatever it likes, which makes the quota
     * advisory. A SMALLER file is fine and common — a client that estimated —
     * and the difference is returned to the counter below.
     */
    if (input.bytes.byteLength > session.declaredSizeBytes) {
      await this.#abort(session.id, 'size_mismatch');
      throw declaredSizeMismatch();
    }

    const kind = kindForMimeType(this.#policy.upload, session.declaredMimeType);
    if (kind === null) {
      await this.#abort(session.id, 'unsupported_type');
      throw unsupportedFileType();
    }

    const checksum = await checksumOf(input.bytes);

    /*
     * FILE IDENTITY. The same bytes already live in this workspace.
     *
     * Checked here rather than at initiate because the checksum is a property
     * of the BYTES, and at initiate there are none. The partial unique index
     * over live rows is the backstop for two requests that race past this.
     */
    const duplicate = await this.#db.asset.findFirst({
      where: { checksumSha256: checksum, deletedAt: null },
    });
    if (duplicate) {
      await this.#abort(session.id, 'checksum_mismatch');
      /*
       * THE QUOTA IS GIVEN BACK. The upload is refused, so the workspace must
       * not go on paying for it. Keyed off the session so a retried completion
       * refunds once.
       */
      await this.#refundStorage(session.declaredSizeBytes, `asset-duplicate:${session.id}`);
      throw duplicateAsset();
    }

    const now = this.#clock.now();

    const asset = await this.#db.asset.create({
      data: {
        workspaceId: this.#workspaceId,
        brandId: session.brandId,
        folderId: session.folderId,
        name: session.declaredFileName,
        kind,
        mimeType: session.declaredMimeType,
        sizeBytes: input.bytes.byteLength,
        storageKey: 'pending',
        checksumSha256: checksum,
        source: 'UPLOAD',
        // QUARANTINED UNTIL PROVEN OTHERWISE. Both fields have to move before
        // anything can select or download this, and only the scanner moves the
        // first (docs/SECURITY.md §11.3).
        scanStatus: 'PENDING',
        status: 'PROCESSING',
        currentVersion: 1,
        uploadedByUserId: input.actor.userId,
      },
    });

    const storageKey = assetObjectKey({
      workspaceId: this.#workspaceId,
      brandId: session.brandId,
      assetId: asset.id,
      versionNumber: 1,
    });
    await this.#store.put(storageKey, input.bytes, session.declaredMimeType);
    const stored = await this.#db.asset.update({
      where: { id: asset.id },
      data: { storageKey },
    });

    // The append-only history starts at the same bytes the asset row describes.
    await this.#db.assetVersion.create({
      data: {
        workspaceId: this.#workspaceId,
        brandId: session.brandId,
        assetId: asset.id,
        versionNumber: 1,
        storageKey,
        checksumSha256: checksum,
        mimeType: session.declaredMimeType,
        sizeBytes: input.bytes.byteLength,
        scanStatus: 'PENDING',
        createdByUserId: input.actor.userId,
      },
    });

    const job = await this.#db.assetProcessingJob.create({
      data: {
        workspaceId: this.#workspaceId,
        brandId: session.brandId,
        assetId: asset.id,
        stage: 'QUEUED',
        maxAttempts: this.#policy.processing.maxAttempts,
        queuedAt: now,
      },
    });

    await this.#db.assetUploadSession.update({
      where: { id: session.id },
      data: { status: 'COMPLETED', assetId: asset.id, completedAt: now },
    });

    // The declaration was an upper bound; give back what was not used.
    const unused = session.declaredSizeBytes - input.bytes.byteLength;
    if (unused > 0) await this.#refundStorage(unused, `asset-unused:${session.id}`);

    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'assets.uploaded',
      actorType: 'USER',
      actorId: input.actor.userId,
      resourceType: 'Asset',
      resourceId: asset.id,
      brandId: session.brandId ?? undefined,
      // The file NAME is metadata the customer chose; the CONTENT never enters
      // an audit event, and neither does the storage key.
      after: {
        fileName: session.declaredFileName,
        mimeType: session.declaredMimeType,
        sizeBytes: input.bytes.byteLength,
        kind,
      },
    });

    return { asset: stored, job, replayed: false };
  }

  /** Give up on a session, recording a customer-safe reason. */
  async #abort(sessionId: string, reason: string): Promise<void> {
    await this.#db.assetUploadSession.updateMany({
      where: { id: sessionId, status: 'PENDING' },
      data: { status: 'ABORTED', failureReason: reason },
    });
  }

  async #assertFolderUsable(folderId: string, brandId: string | null): Promise<void> {
    const folder = await this.#db.assetFolder.findUnique({ where: { id: folderId } });
    // Another workspace's folder is invisible to RLS and arrives as null.
    if (!folder || folder.deletedAt !== null) throw folderNotFound();
    /*
     * A BRAND-SCOPED FOLDER TAKES ONLY THAT BRAND'S ASSETS.
     *
     * Without this an asset for brand A could be filed in brand B's folder, and
     * every member who can see B's folder would then see A's asset in it — a
     * cross-brand disclosure built out of two things that were each in scope.
     * A workspace-level folder (null brand) takes anything, which is what makes
     * it the shared one.
     */
    if (folder.brandId !== null && folder.brandId !== brandId) throw folderNotFound();
  }

  async #consumeStorage(bytes: number, idempotencyKey: string): Promise<void> {
    /*
     * THE QUOTA IS COUNTED IN GIGABYTES because that is how the plan states it
     * (D-10: 5 / 50 / 250 GB), and a counter must be in the unit the limit is
     * in or the comparison is meaningless. Rounding is UP: a workspace at
     * 4.6 GB of a 5 GB plan has used 5, not 4, and rounding down would let the
     * last fraction of every gigabyte be free.
     */
    const gigabytes = Math.max(1, Math.ceil(bytes / BYTES_PER_GB));
    try {
      await this.#usage.consume({
        workspaceId: this.#workspaceId,
        featureKey: QUOTA_FEATURES.storageGb,
        limitValue: this.#storageLimitGb,
        period: 'total',
        amount: gigabytes,
        idempotencyKey,
      });
    } catch (error) {
      // The engine's own refusal, re-shaped into the library's customer-facing
      // message. The engine's message names a feature key, which is internal.
      if (error instanceof QuotaExceededError) throw storageQuotaReached();
      throw error;
    }
  }

  async #refundStorage(bytes: number, idempotencyKey: string): Promise<void> {
    const gigabytes = Math.max(1, Math.ceil(bytes / BYTES_PER_GB));
    await this.#usage.refund({
      workspaceId: this.#workspaceId,
      featureKey: QUOTA_FEATURES.storageGb,
      period: 'total',
      amount: gigabytes,
      idempotencyKey,
    });
  }
}
