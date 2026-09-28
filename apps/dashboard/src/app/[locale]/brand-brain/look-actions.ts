'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import {
  AppError,
  assertBrandInScope,
  createLogger,
  internalErrorFields,
} from '@brandspace/shared';
import { requireWorkspaceAction, type WorkspaceSession } from '../../../server/customer-context';
import { actionErrorCode } from '../../../server/denial';
import { inAssetLibrary } from '../../../server/assets-context';
import {
  dispatchProcessing,
  uploadIntoLibrary,
  uploadWithin,
  type CompletedUpload,
} from '../../../server/asset-upload';
import { saveBrandProfile } from '../../../server/brand-profile-save';
import { assetActorOf, brandFontServiceFrom } from '../../../server/brand-fonts';
import { paletteFromForm, typographySlotsFromForm } from '../../../server/brand-look';

/**
 * PHASE 2C-2 (item 3) — BRAND BRAIN → LOOK & VOICE: colours, logo and fonts.
 *
 * EVERY ACTION REQUIRES `brand.manage` (the approved E3 deviation) and the
 * member's BrandScope before anything is read. Brand writes go through the one
 * profile save (`saveBrandProfile`: the `brand.profile.updated` audit event, the
 * logo rule, the v2 typography writer). Files go through the one upload path,
 * whose own `assets.upload` / `assets.archive` checks still apply — `brand.manage`
 * never stands in for them.
 */

const log = createLogger({ context: { component: 'dashboard.brand-look' } });

function lookUrl(locale: string, brandId: string, params: Record<string, string>): string {
  const search = new URLSearchParams({ brand: brandId, tab: 'look', ...params });
  return `/${locale}/brand-brain?${search.toString()}`;
}

function failure(locale: string, brandId: string, error: unknown, action: string): string {
  const correlationId = randomUUID();
  log.warn('look & voice action failed', { correlationId, action, ...internalErrorFields(error) });
  return lookUrl(locale, brandId, { error: actionErrorCode(error), ref: correlationId });
}

async function begin(formData: FormData): Promise<{
  readonly locale: string;
  readonly brandId: string;
  readonly session: WorkspaceSession;
}> {
  const locale = String(formData.get('locale') ?? 'en');
  const brandId = String(formData.get('brandId') ?? '');
  const session = await requireWorkspaceAction(locale, 'brand.manage');
  // BEFORE the read, not after (docs/SECURITY.md §4.2).
  assertBrandInScope(session.workspace.brandScope, brandId);
  return { locale, brandId, session };
}

function fileOf(formData: FormData, field = 'file'): File {
  const file = formData.get(field);
  if (!(file instanceof File) || file.size === 0) {
    throw new AppError('VALIDATION_FAILED', 'Choose a file.');
  }
  return file;
}

async function saveProfile(
  session: WorkspaceSession,
  brandId: string,
  patch: Parameters<typeof saveBrandProfile>[1]['patch'],
): Promise<void> {
  const outcome = await inAssetLibrary(session.workspace.workspaceId, ({ db }) =>
    saveBrandProfile(db, {
      workspaceId: session.workspace.workspaceId,
      actorUserId: session.customer.userId,
      brandId,
      patch,
    }),
  );
  if (outcome === 'not_found') throw new AppError('NOT_FOUND', 'Brand not found.');
}

/** Colour swatches: the existing brand palette, the existing save. */
export async function saveBrandColoursAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const brandId = String(formData.get('brandId') ?? '');
  let destination: string;
  try {
    const { session } = await begin(formData);
    await saveProfile(session, brandId, { colorPalette: paletteFromForm(formData) });
    destination = lookUrl(locale, brandId, { ok: 'BRAND_COLOURS_SAVED' });
  } catch (error: unknown) {
    destination = failure(locale, brandId, error, 'save-colours');
  }
  revalidatePath(`/${locale}/brand-brain`);
  redirect(destination);
}

/**
 * Logo replace-by-upload. The file becomes an ordinary brand image asset; it is
 * made the logo ONLY once it is READY and CLEAN (`saveBrandProfile` checks), so
 * a file still being scanned is uploaded but not yet the logo.
 */
export async function uploadBrandLogoAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const brandId = String(formData.get('brandId') ?? '');
  let destination: string;
  try {
    const { session } = await begin(formData);
    const file = fileOf(formData);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const uploaded = await uploadIntoLibrary({
      workspaceId: session.workspace.workspaceId,
      actor: assetActorOf(session),
      file,
      bytes,
      brandId,
      folderId: null,
    });
    const ready = await inAssetLibrary(session.workspace.workspaceId, async ({ db }) => {
      const asset = await db.asset.findFirst({
        where: {
          id: uploaded.assetId,
          kind: 'IMAGE',
          status: 'READY',
          scanStatus: 'CLEAN',
          archivedAt: null,
          deletedAt: null,
        },
        select: { id: true },
      });
      return asset !== null;
    });
    if (ready) {
      await saveProfile(session, brandId, { primaryLogoAssetId: uploaded.assetId });
      destination = lookUrl(locale, brandId, { ok: 'BRAND_LOGO_SAVED' });
    } else {
      destination = lookUrl(locale, brandId, { ok: 'BRAND_LOGO_PROCESSING' });
    }
  } catch (error: unknown) {
    destination = failure(locale, brandId, error, 'upload-logo');
  }
  revalidatePath(`/${locale}/brand-brain`);
  redirect(destination);
}

/** Choose the logo among the brand's ready images — the decision-D check applies. */
export async function chooseBrandLogoAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const brandId = String(formData.get('brandId') ?? '');
  let destination: string;
  try {
    const { session } = await begin(formData);
    const assetId = String(formData.get('primaryLogoAssetId') ?? '').trim();
    await saveProfile(session, brandId, { primaryLogoAssetId: assetId === '' ? null : assetId });
    destination = lookUrl(locale, brandId, { ok: 'BRAND_LOGO_SAVED' });
  } catch (error: unknown) {
    destination = failure(locale, brandId, error, 'choose-logo');
  }
  revalidatePath(`/${locale}/brand-brain`);
  redirect(destination);
}

/** The four slots, through the one v2 writer. */
export async function saveBrandTypographyAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const brandId = String(formData.get('brandId') ?? '');
  let destination: string;
  try {
    const { session } = await begin(formData);
    const slots = await inAssetLibrary(session.workspace.workspaceId, async (services) =>
      typographySlotsFromForm(formData, {
        policy: await services.policy(),
        activeFonts: await services.db.brandFont.findMany({
          where: { brandId, archivedAt: null },
          select: { id: true, language: true },
        }),
      }),
    );
    await saveProfile(session, brandId, { typography: slots });
    destination = lookUrl(locale, brandId, { ok: 'BRAND_FONTS_SAVED' });
  } catch (error: unknown) {
    destination = failure(locale, brandId, error, 'save-typography');
  }
  revalidatePath(`/${locale}/brand-brain`);
  redirect(destination);
}

function languageOf(formData: FormData): 'en' | 'ar' {
  const language = String(formData.get('language') ?? '');
  if (language !== 'en' && language !== 'ar') {
    throw new AppError('VALIDATION_FAILED', 'Choose a language.');
  }
  return language;
}

/** Name from the form, or the file's own name without its extension. */
function displayNameOf(formData: FormData, file: File): string {
  const typed = String(formData.get('displayName') ?? '').trim();
  if (typed !== '') return typed;
  return file.name.replace(/\.[A-Za-z0-9]{1,8}$/, '').slice(0, 80) || 'Font';
}

/** Add an uploaded font: limit check under the brand lock, then the upload, one transaction. */
export async function addBrandFontAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const brandId = String(formData.get('brandId') ?? '');
  let destination: string;
  try {
    const { session } = await begin(formData);
    const file = fileOf(formData);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const language = languageOf(formData);
    const actor = assetActorOf(session);
    let completed: CompletedUpload | null = null;
    await inAssetLibrary(session.workspace.workspaceId, async (services) => {
      const fonts = await brandFontServiceFrom(services, session.workspace.workspaceId);
      await fonts.add({
        brandId,
        language,
        displayName: displayNameOf(formData, file),
        actor,
        upload: async () => {
          completed = await uploadWithin(services, {
            workspaceId: session.workspace.workspaceId,
            actor,
            file,
            bytes,
            brandId,
            folderId: null,
          });
          return { assetId: completed.assetId };
        },
      });
    });
    await dispatchProcessing({
      workspaceId: session.workspace.workspaceId,
      actor,
      job: (completed as CompletedUpload | null)?.job ?? null,
    });
    destination = lookUrl(locale, brandId, { ok: 'BRAND_FONT_ADDED' });
  } catch (error: unknown) {
    destination = failure(locale, brandId, error, 'add-font');
  }
  revalidatePath(`/${locale}/brand-brain`);
  redirect(destination);
}

export async function renameBrandFontAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const brandId = String(formData.get('brandId') ?? '');
  let destination: string;
  try {
    const { session } = await begin(formData);
    await inAssetLibrary(session.workspace.workspaceId, async (services) => {
      const fonts = await brandFontServiceFrom(services, session.workspace.workspaceId);
      await fonts.rename({
        brandFontId: String(formData.get('brandFontId') ?? ''),
        displayName: String(formData.get('displayName') ?? ''),
        actor: assetActorOf(session),
      });
    });
    destination = lookUrl(locale, brandId, { ok: 'BRAND_FONT_RENAMED' });
  } catch (error: unknown) {
    destination = failure(locale, brandId, error, 'rename-font');
  }
  revalidatePath(`/${locale}/brand-brain`);
  redirect(destination);
}

/** Replace a font's file: one logical font, a new asset, the old one archived if unused. */
export async function replaceBrandFontAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const brandId = String(formData.get('brandId') ?? '');
  let destination: string;
  try {
    const { session } = await begin(formData);
    const file = fileOf(formData);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const actor = assetActorOf(session);
    let completed: CompletedUpload | null = null;
    await inAssetLibrary(session.workspace.workspaceId, async (services) => {
      const fonts = await brandFontServiceFrom(services, session.workspace.workspaceId);
      await fonts.replace({
        brandFontId: String(formData.get('brandFontId') ?? ''),
        actor,
        upload: async () => {
          completed = await uploadWithin(services, {
            workspaceId: session.workspace.workspaceId,
            actor,
            file,
            bytes,
            brandId,
            folderId: null,
          });
          return { assetId: completed.assetId };
        },
      });
    });
    await dispatchProcessing({
      workspaceId: session.workspace.workspaceId,
      actor,
      job: (completed as CompletedUpload | null)?.job ?? null,
    });
    destination = lookUrl(locale, brandId, { ok: 'BRAND_FONT_REPLACED' });
  } catch (error: unknown) {
    destination = failure(locale, brandId, error, 'replace-font');
  }
  revalidatePath(`/${locale}/brand-brain`);
  redirect(destination);
}

export async function removeBrandFontAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const brandId = String(formData.get('brandId') ?? '');
  let destination: string;
  try {
    const { session } = await begin(formData);
    await inAssetLibrary(session.workspace.workspaceId, async (services) => {
      const fonts = await brandFontServiceFrom(services, session.workspace.workspaceId);
      await fonts.remove({
        brandFontId: String(formData.get('brandFontId') ?? ''),
        actor: assetActorOf(session),
      });
    });
    destination = lookUrl(locale, brandId, { ok: 'BRAND_FONT_REMOVED' });
  } catch (error: unknown) {
    destination = failure(locale, brandId, error, 'remove-font');
  }
  revalidatePath(`/${locale}/brand-brain`);
  redirect(destination);
}
