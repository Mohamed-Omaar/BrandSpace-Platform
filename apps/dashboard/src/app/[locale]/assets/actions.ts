'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { AppError, createLogger, internalErrorFields, toPublicErrorCode } from '@brandspace/shared';
import type { AssetActor } from '@brandspace/assets';
import {
  PROCESS_ASSET,
  enqueue,
  mayProcessInline,
  type ProcessAssetPayload,
} from '@brandspace/jobs';
import { requireWorkspace, type WorkspaceSession } from '../../../server/customer-context';
import { inAssetLibrary } from '../../../server/assets-context';
import { uploadIntoLibrary } from '../../../server/asset-upload';

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
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;
  try {
    const session = await requireWorkspace(locale, 'assets.upload');
    const file = formData.get('file');
    if (!(file instanceof File) || file.size === 0) throw new Error('no file');

    /*
     * THE UPLOAD ITSELF LIVES IN `server/asset-upload.ts` (AC-27.1).
     *
     * It moved there when the Content Studio gained a reason to do the same
     * thing: an author attaching a picture mid-draft should not have to leave.
     * Two screens, one library, and therefore ONE upload path — a second copy
     * is how the signature check, the checksum key, the quarantine or the
     * dispatch ends up enforced on one screen and not the other.
     */
    await uploadIntoLibrary({
      workspaceId: session.workspace.workspaceId,
      actor: assetActor(session),
      file,
      bytes: new Uint8Array(await file.arrayBuffer()),
      brandId: optionalId(formData, 'brandId'),
      folderId: optionalId(formData, 'folderId'),
    });

    destination = pageUrl(locale, { ok: 'ASSET_UPLOADED' });
  } catch (error: unknown) {
    destination = failure(locale, error, 'upload-asset');
  }
  revalidatePath(`/${locale}/assets`);
  redirect(destination);
}

export async function createAssetFolderAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
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
  const locale = String(formData.get('locale') ?? 'en');
  const assetId = String(formData.get('assetId') ?? '');
  let destination: string;
  try {
    const session = await requireWorkspace(locale, 'assets.edit');
    const rawTags = String(formData.get('tags') ?? '');
    const name = String(formData.get('name') ?? '').trim();
    /*
     * PHASE 6 FINAL (D-286/D-287) — LICENCE, RIGHTS AND FOLDER. Each is changed
     * only when its field was on the form; an empty value clears it. The rights
     * date is the last day the licence covers, so it ends at the close of that
     * day (UTC) — the publishability predicate refuses the file after it.
     */
    const rawLicense = formData.get('license');
    const license =
      rawLicense === null ? undefined : String(rawLicense).trim().slice(0, 500) || null;
    const rawRights = formData.get('rightsExpiryAt');
    const rightsExpiryAt =
      rawRights === null
        ? undefined
        : /^\d{4}-\d{2}-\d{2}$/.test(String(rawRights))
          ? new Date(`${String(rawRights)}T23:59:59.999Z`)
          : null;
    const rawFolder = formData.get('folderId');
    const folderId = rawFolder === null ? undefined : String(rawFolder) || null;

    await inAssetLibrary(session.workspace.workspaceId, async ({ library }) => {
      const service = await library();
      await service.updateMetadata({
        assetId,
        actor: assetActor(session),
        ...(name.length > 0 ? { name } : {}),
        ...(license === undefined ? {} : { license }),
        ...(rightsExpiryAt === undefined ? {} : { rightsExpiryAt }),
        ...(folderId === undefined ? {} : { folderId }),
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

/**
 * PHASE 6 FINAL (D-287) — BULK: archive, tag or move several files at once.
 *
 * NOT A NEW SERVICE PATH. Each file goes through the same `archive` /
 * `updateMetadata` call the single-file controls use, with the same permission,
 * BrandScope, folder rules and audit event per file. A file the member may not
 * change is skipped and counted, never a reason to stop the rest.
 */
export async function bulkAssetAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;
  try {
    const operation = String(formData.get('operation') ?? '');
    const permission = operation === 'archive' ? 'assets.archive' : 'assets.edit';
    const session = await requireWorkspace(locale, permission);
    const ids = [...new Set(formData.getAll('assetIds').map(String))].slice(0, 100);
    if (ids.length === 0 || !['archive', 'tag', 'move'].includes(operation)) {
      throw new AppError('VALIDATION_FAILED', 'Nothing to do.');
    }
    const tag = String(formData.get('tag') ?? '').trim();
    const folder = String(formData.get('folderId') ?? '');
    let changed = 0;
    let skipped = 0;
    await inAssetLibrary(session.workspace.workspaceId, async ({ library }) => {
      const service = await library();
      const actor = assetActor(session);
      for (const assetId of ids) {
        try {
          if (operation === 'archive') {
            await service.archive(assetId, actor);
          } else if (operation === 'tag') {
            if (tag === '') throw new AppError('VALIDATION_FAILED', 'A tag is required.');
            const current = await service.get(assetId, actor);
            await service.updateMetadata({ assetId, actor, tags: [...current.tags, tag] });
          } else {
            await service.updateMetadata({ assetId, actor, folderId: folder || null });
          }
          changed += 1;
        } catch (error: unknown) {
          if (error instanceof AppError && error.code === 'VALIDATION_FAILED' && tag === '') {
            throw error;
          }
          skipped += 1;
        }
      }
    });
    destination = pageUrl(locale, {
      ok: skipped > 0 || changed === 0 ? 'ASSETS_BULK_PARTIAL' : 'ASSETS_BULK_DONE',
    });
  } catch (error: unknown) {
    destination = failure(locale, error, 'bulk-assets');
  }
  revalidatePath(`/${locale}/assets`);
  redirect(destination);
}

export async function archiveAssetAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
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
  const locale = String(formData.get('locale') ?? 'en');
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
  const locale = String(formData.get('locale') ?? 'en');
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
  const locale = String(formData.get('locale') ?? 'en');
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
  const locale = String(formData.get('locale') ?? 'en');
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
