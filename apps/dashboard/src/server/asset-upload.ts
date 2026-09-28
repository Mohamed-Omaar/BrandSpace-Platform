import 'server-only';
import { createLogger } from '@brandspace/shared';
import { checksumOf } from '@brandspace/storage';
import { contentTypeMismatch, resolveFontType, type AssetActor } from '@brandspace/assets';
import {
  PROCESS_ASSET,
  enqueue,
  mayProcessInline,
  type ProcessAssetPayload,
} from '@brandspace/jobs';
import { inAssetLibrary, type AssetServices } from './assets-context';

const log = createLogger({ context: { component: 'dashboard.asset-upload' } });

/**
 * PUTTING A FILE INTO THE ONE ASSET LIBRARY — ONE IMPLEMENTATION (AC-27.1).
 *
 * WHY IT MOVED HERE. The Asset Library screen owned this, and Phase 8 gave the
 * Content Studio a reason to do the same thing: an author attaching a picture
 * to a post they are in the middle of writing should not have to leave, upload
 * it somewhere else and come back. Two screens, one library — and therefore one
 * upload path, because a second copy is how a rule (the signature check, the
 * checksum key, the quarantine, the dispatch) ends up enforced on one screen
 * and not the other.
 *
 * NOTHING ABOUT IT IS RELAXED FOR THE COMPOSER. The same `assets.upload`
 * permission, the same actor with the caller's BrandScope, the same initiate →
 * bytes → complete sequence with its signature and quota checks, the same
 * PENDING scan status, and the same background dispatch. The composer just gets
 * the asset id back so it can tick the box it would otherwise have made the
 * author go and find.
 */

/**
 * THE IDEMPOTENCY KEY IS THE CONTENT, not the file's name and size.
 *
 * `<name>-<size>` answers a different question than the one it is asked: two
 * DIFFERENT photographs saved as `hero.png` at the same byte count collide and
 * the second is silently discarded as a replay, while the same photograph
 * renamed produces a second upload rather than replaying. A checksum over the
 * bytes, scoped to the workspace, the brand and the folder, answers "is this
 * the same request?" correctly.
 */
export async function uploadIdempotencyKey(input: {
  readonly workspaceId: string;
  readonly brandId: string | null;
  readonly folderId: string | null;
  readonly bytes: Uint8Array;
}): Promise<string> {
  const checksum = await checksumOf(input.bytes);
  return `ui:${input.workspaceId}:${input.brandId ?? 'ws'}:${input.folderId ?? 'root'}:${checksum}`;
}

export interface UploadedAsset {
  readonly assetId: string;
  readonly processingJobId: string | null;
}

export interface UploadInput {
  readonly workspaceId: string;
  readonly actor: AssetActor;
  readonly file: File;
  readonly bytes: Uint8Array;
  readonly brandId: string | null;
  readonly folderId: string | null;
}

/** The job `complete` created, for `dispatchProcessing` after the commit. */
export interface CompletedUpload {
  readonly assetId: string;
  readonly job: { readonly id: string } | null;
}

/**
 * INITIATE AND COMPLETE INSIDE A TRANSACTION THE CALLER ALREADY HOLDS.
 *
 * `uploadIntoLibrary` is this plus its own transaction plus the dispatch. A
 * caller that must do more in the SAME transaction — Look & voice adds a font
 * only after a limit check under a lock on the brand row (Phase 2C-2) — calls
 * this with its own services and dispatches after its transaction commits.
 * Nothing about the upload itself differs: the same service, the same checks.
 */
export async function uploadWithin(
  services: Pick<AssetServices, 'upload'>,
  input: UploadInput,
): Promise<CompletedUpload> {
  /*
   * A FONT'S TYPE COMES FROM ITS BYTES (Phase 2C-2). Browsers send nothing, a
   * generic type or a legacy alias for fonts; the signature decides the type,
   * the extension must agree, and a header naming another type is refused. The
   * same check runs again at `complete` and in the worker on the stored bytes.
   */
  const font = resolveFontType({
    fileName: input.file.name,
    declaredMimeType: input.file.type,
    bytes: input.bytes,
  });
  if (font.font && !font.ok) throw contentTypeMismatch();
  const declaredMimeType =
    font.font && font.ok ? font.mimeType : input.file.type || 'application/octet-stream';

  const idempotencyKey = await uploadIdempotencyKey({
    workspaceId: input.workspaceId,
    brandId: input.brandId,
    folderId: input.folderId,
    bytes: input.bytes,
  });

  const service = await services.upload();
  const started = await service.initiate({
    brandId: input.brandId,
    folderId: input.folderId,
    fileName: input.file.name,
    /*
     * THE BROWSER'S TYPE, and it is trusted for exactly one thing: whether
     * this workspace may upload this KIND of file. It decides no parser and
     * no pipeline — the file's own SIGNATURE has to agree before anything is
     * stored (docs/SECURITY.md §11.2).
     */
    mimeType: declaredMimeType,
    sizeBytes: input.bytes.byteLength,
    idempotencyKey,
    actor: input.actor,
  });
  const completed = await service.complete({
    sessionId: started.session.id,
    bytes: input.bytes,
    actor: input.actor,
  });
  return { assetId: completed.asset.id, job: completed.job ? { id: completed.job.id } : null };
}

/** Hand a completed upload to the worker — after the transaction that made it commits. */
export async function dispatchProcessing(input: {
  readonly workspaceId: string;
  readonly actor: AssetActor;
  readonly job: { readonly id: string } | null;
}): Promise<void> {
  const job = input.job;
  if (!job) return;
  const dispatch = await enqueue('media-processing', PROCESS_ASSET, {
    kind: PROCESS_ASSET,
    workspaceId: input.workspaceId,
    requestedByUserId: input.actor.userId,
    // The job row's id IS the natural key for this work. A second dispatch of
    // the same row is refused by BullMQ rather than scanned twice.
    idempotencyKey: `asset-${job.id}`,
    processingJobId: job.id,
  } satisfies ProcessAssetPayload);

  if (!dispatch.dispatched) {
    if (!mayProcessInline()) {
      /*
       * PRODUCTION DOES NOT PROCESS INLINE. The row is already durable, so
       * the reconciliation sweep will pick it up: the upload succeeded, the
       * file reads PROCESSING, and the outage is the operator's to fix rather
       * than the customer's to notice as a hung page. It also means an
       * unscanned file stays quarantined rather than being rushed through on
       * a request thread.
       */
      log.error('could not dispatch asset processing; leaving it for the sweep', {
        workspaceId: input.workspaceId,
        jobId: job.id,
      });
    } else {
      log.warn('no queue configured; processing this upload inline (non-production only)', {
        jobId: job.id,
      });
      await inAssetLibrary(input.workspaceId, async ({ processing }) => {
        const service = await processing();
        await service.process(job.id);
      });
    }
  }
}

export async function uploadIntoLibrary(input: UploadInput): Promise<UploadedAsset> {
  const completed = await inAssetLibrary(input.workspaceId, (services) =>
    uploadWithin(services, input),
  );
  await dispatchProcessing({
    workspaceId: input.workspaceId,
    actor: input.actor,
    job: completed.job,
  });
  return { assetId: completed.assetId, processingJobId: completed.job?.id ?? null };
}
