'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { createLogger, internalErrorFields, toPublicErrorCode } from '@brandspace/shared';
import { checksumOf } from '@brandspace/storage';
import type { AssetActor } from '@brandspace/assets';
import {
  PROCESS_ASSET,
  enqueue,
  mayProcessInline,
  type ProcessAssetPayload,
} from '@brandspace/jobs';
import { requireWorkspace, type WorkspaceSession } from '../../../server/customer-context';
import { inAssetLibrary } from '../../../server/assets-context';

const log = createLogger({ context: { component: 'dashboard.assets' } });

/**
 * Asset Library actions.
 *
 * THE WORKSPACE IS NEVER TAKEN FROM THE FORM. `requireWorkspace()` reads it
 * from the session and re-verifies membership, so a crafted POST carrying
 * another tenant's ids operates on the caller's own workspace. The brand and
 * folder ids ARE taken from the form — the customer chooses them — and RLS,
 * the composite foreign keys and the service's own brand-scope check are what
 * make a foreign one fail rather than succeed quietly.
 *
 * EACH ACTION NAMES THE PERMISSION IT NEEDS, TWICE. `requireWorkspace` refuses
 * the request, and the service refuses the call. That is not redundancy: the
 * page also hides the control, and hiding is a courtesy — a server action is a
 * public HTTP endpoint, so the check that matters is the one the service makes
 * with the actor it was handed.
 */

/**
 * The actor every Asset Library service call is made under, built in ONE place.
 *
 * Its brand scope is the whole point. Assembling the actor inline at eight call
 * sites is how one of them ends up without it, and the field is required
 * precisely so that omission is a type error rather than a silent grant (F-74).
 */
function assetActor(session: WorkspaceSession): AssetActor {
  return {
    userId: session.customer.userId,
    permissionKeys: session.workspace.permissionKeys,
    brandScope: session.workspace.brandScope,
  };
}

function pageUrl(locale: string, params: Record<string, string> = {}): string {
  const search = new URLSearchParams(params).toString();
  return `/${locale}/assets${search ? `?${search}` : ''}`;
}

function failure(
  locale: string,
  error: unknown,
  action: string,
  extra: Record<string, string> = {},
): string {
  const correlationId = randomUUID();
  // The correlation id is the ONLY thing joining this screen to the server log,
  // and the log is redacted. NO FILE NAME and no customer content is written
  // either side — a file name is routinely the most sensitive string in the
  // record (docs/SECURITY.md §5.1).
  log.warn('asset action failed', { correlationId, action, ...internalErrorFields(error) });
  return pageUrl(locale, { ...extra, error: toPublicErrorCode(error), ref: correlationId });
}

/** Read an optional id from a form, treating an empty string as absent. */
function optionalId(formData: FormData, field: string): string | null {
  const raw = String(formData.get(field) ?? '').trim();
  return raw === '' ? null : raw;
}

export async function uploadAssetAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  let destination: string;
  try {
    const session = await requireWorkspace(locale, 'assets.upload');
    const file = formData.get('file');
    if (!(file instanceof File) || file.size === 0) throw new Error('no file');

    const bytes = new Uint8Array(await file.arrayBuffer());
    const brandId = optionalId(formData, 'brandId');
    const folderId = optionalId(formData, 'folderId');

    /*
     * THE IDEMPOTENCY KEY IS THE CONTENT, not the file's name and size.
     *
     * `<name>-<size>` answers a different question than the one it is asked:
     * two DIFFERENT photographs saved as `hero.png` at the same byte count
     * collide and the second is silently discarded as a replay, while the same
     * photograph renamed produces a second upload rather than replaying. A
     * checksum over the bytes, scoped to the workspace, the brand and the
     * folder, answers "is this the same request?" correctly — the same file to
     * the same place is a replay, and anything else is a new upload. The same
     * lesson the Brand Brain upload key learned.
     */
    const checksum = await checksumOf(bytes);
    const idempotencyKey = `ui:${session.workspace.workspaceId}:${brandId ?? 'ws'}:${
      folderId ?? 'root'
    }:${checksum}`;

    const job = await inAssetLibrary(session.workspace.workspaceId, async ({ upload }) => {
      const service = await upload();
      const session_ = await service.initiate({
        brandId,
        folderId,
        fileName: file.name,
        /*
         * THE BROWSER'S TYPE, and it is trusted for exactly one thing: whether
         * this workspace may upload this KIND of file. It decides no parser and
         * no pipeline — the file's own SIGNATURE has to agree before anything
         * is stored (docs/SECURITY.md §11.2).
         */
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: bytes.byteLength,
        idempotencyKey,
        actor: assetActor(session),
      });
      const completed = await service.complete({
        sessionId: session_.session.id,
        bytes,
        actor: assetActor(session),
      });
      return completed.job;
    });

    if (job) {
      const dispatch = await enqueue('media-processing', PROCESS_ASSET, {
        kind: PROCESS_ASSET,
        workspaceId: session.workspace.workspaceId,
        requestedByUserId: session.customer.userId,
        // The job row's id IS the natural key for this work. A second dispatch
        // of the same row is refused by BullMQ rather than scanned twice.
        idempotencyKey: `asset-${job.id}`,
        processingJobId: job.id,
      } satisfies ProcessAssetPayload);

      if (!dispatch.dispatched) {
        if (!mayProcessInline()) {
          /*
           * PRODUCTION DOES NOT PROCESS INLINE. The row is already durable, so
           * the reconciliation sweep will pick it up: the upload succeeded, the
           * file reads PROCESSING, and the outage is the operator's to fix
           * rather than the customer's to notice as a hung page. It also means
           * an unscanned file stays quarantined rather than being rushed
           * through on a request thread.
           */
          log.error('could not dispatch asset processing; leaving it for the sweep', {
            workspaceId: session.workspace.workspaceId,
            jobId: job.id,
          });
        } else {
          log.warn('no queue configured; processing this upload inline (non-production only)', {
            jobId: job.id,
          });
          await inAssetLibrary(session.workspace.workspaceId, async ({ processing }) => {
            const service = await processing();
            await service.process(job.id);
          });
        }
      }
    }

    destination = pageUrl(locale, { ok: 'ASSET_UPLOADED' });
  } catch (error: unknown) {
    destination = failure(locale, error, 'upload-asset');
  }
  revalidatePath(`/${locale}/assets`);
  redirect(destination);
}

export async function createAssetFolderAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  let destination: string;
  try {
    const session = await requireWorkspace(locale, 'assets.manage_taxonomy');
    const name = String(formData.get('name') ?? '').trim();
    if (name.length === 0 || name.length > 120) throw new Error('invalid folder name');

    await inAssetLibrary(session.workspace.workspaceId, async ({ library }) => {
      const service = await library();
      await service.createFolder({
        actor: assetActor(session),
        name,
        brandId: optionalId(formData, 'brandId'),
        parentFolderId: optionalId(formData, 'parentFolderId'),
      });
    });
    destination = pageUrl(locale, { ok: 'ASSET_FOLDER_CREATED' });
  } catch (error: unknown) {
    destination = failure(locale, error, 'create-folder');
  }
  revalidatePath(`/${locale}/assets`);
  redirect(destination);
}

export async function updateAssetAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const assetId = String(formData.get('assetId') ?? '');
  let destination: string;
  try {
    const session = await requireWorkspace(locale, 'assets.edit');
    const rawTags = String(formData.get('tags') ?? '');
    const name = String(formData.get('name') ?? '').trim();

    await inAssetLibrary(session.workspace.workspaceId, async ({ library }) => {
      const service = await library();
      await service.updateMetadata({
        assetId,
        actor: assetActor(session),
        ...(name.length > 0 ? { name } : {}),
        // Split on commas so a single text field can carry a tag list. The
        // SERVICE normalises, de-duplicates and enforces the ceiling; this only
        // has to turn one string into many.
        tags: rawTags
          .split(',')
          .map((tag) => tag.trim())
          .filter((tag) => tag.length > 0),
      });
    });
    destination = pageUrl(locale, { ok: 'ASSET_UPDATED', asset: assetId });
  } catch (error: unknown) {
    destination = failure(locale, error, 'update-asset', { asset: assetId });
  }
  revalidatePath(`/${locale}/assets`);
  redirect(destination);
}

export async function archiveAssetAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const assetId = String(formData.get('assetId') ?? '');
  let destination: string;
  try {
    const session = await requireWorkspace(locale, 'assets.archive');
    await inAssetLibrary(session.workspace.workspaceId, async ({ library }) => {
      const service = await library();
      await service.archive(assetId, assetActor(session));
    });
    destination = pageUrl(locale, { ok: 'ASSET_ARCHIVED' });
  } catch (error: unknown) {
    destination = failure(locale, error, 'archive-asset');
  }
  revalidatePath(`/${locale}/assets`);
  redirect(destination);
}

export async function restoreAssetAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const assetId = String(formData.get('assetId') ?? '');
  let destination: string;
  try {
    const session = await requireWorkspace(locale, 'assets.restore');
    await inAssetLibrary(session.workspace.workspaceId, async ({ library }) => {
      const service = await library();
      await service.restore(assetId, assetActor(session));
    });
    destination = pageUrl(locale, { ok: 'ASSET_RESTORED', asset: assetId });
  } catch (error: unknown) {
    destination = failure(locale, error, 'restore-asset', { asset: assetId });
  }
  revalidatePath(`/${locale}/assets`);
  redirect(destination);
}

export async function deleteAssetAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  let destination: string;
  try {
    const session = await requireWorkspace(locale, 'assets.delete');
    const assetId = String(formData.get('assetId') ?? '');
    await inAssetLibrary(session.workspace.workspaceId, async ({ library }) => {
      const service = await library();
      await service.delete(assetId, assetActor(session));
    });
    destination = pageUrl(locale, { ok: 'ASSET_DELETED' });
  } catch (error: unknown) {
    destination = failure(locale, error, 'delete-asset');
  }
  revalidatePath(`/${locale}/assets`);
  redirect(destination);
}

export async function addAssetVersionAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const assetId = String(formData.get('assetId') ?? '');
  let destination: string;
  try {
    const session = await requireWorkspace(locale, 'assets.version');
    const file = formData.get('file');
    if (!(file instanceof File) || file.size === 0) throw new Error('no file');
    const bytes = new Uint8Array(await file.arrayBuffer());

    const job = await inAssetLibrary(session.workspace.workspaceId, async ({ versions }) => {
      const service = await versions();
      const added = await service.addVersion({ assetId, bytes, actor: assetActor(session) });
      return added.job;
    });

    // The new bytes are unscanned, so the same dispatch discipline applies.
    const dispatch = await enqueue('media-processing', PROCESS_ASSET, {
      kind: PROCESS_ASSET,
      workspaceId: session.workspace.workspaceId,
      requestedByUserId: session.customer.userId,
      idempotencyKey: `asset-${job.id}`,
      processingJobId: job.id,
    } satisfies ProcessAssetPayload);

    if (!dispatch.dispatched && mayProcessInline()) {
      await inAssetLibrary(session.workspace.workspaceId, async ({ processing }) => {
        const service = await processing();
        await service.process(job.id);
      });
    }

    destination = pageUrl(locale, { ok: 'ASSET_VERSION_CREATED', asset: assetId });
  } catch (error: unknown) {
    destination = failure(locale, error, 'add-version', { asset: assetId });
  }
  revalidatePath(`/${locale}/assets`);
  redirect(destination);
}

export async function restoreAssetVersionAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const assetId = String(formData.get('assetId') ?? '');
  let destination: string;
  try {
    const session = await requireWorkspace(locale, 'assets.version');
    const versionNumber = Number(formData.get('versionNumber') ?? 0);
    if (!Number.isInteger(versionNumber) || versionNumber < 1) throw new Error('invalid version');

    await inAssetLibrary(session.workspace.workspaceId, async ({ versions }) => {
      const service = await versions();
      await service.restoreVersion({ assetId, versionNumber, actor: assetActor(session) });
    });
    destination = pageUrl(locale, { ok: 'ASSET_VERSION_RESTORED', asset: assetId });
  } catch (error: unknown) {
    destination = failure(locale, error, 'restore-version', { asset: assetId });
  }
  revalidatePath(`/${locale}/assets`);
  redirect(destination);
}
