'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  AppError,
  contrastIssues,
  createLogger,
  internalErrorFields,
  themeDocumentSchema,
  themeLookSchema,
  toPublicErrorCode,
  type ThemeDocument,
} from '@brandspace/shared';
import {
  getConfigService,
  requirePlatformActor,
  serviceActor,
} from '../../../../server/platform-context';
import { proposeAndActivate, refusalCode } from '../../../../server/simple-config';
import { previousThemeVersion } from '../../../../server/look';
import { currentEnvironment } from '../../../../server/platform-context';

/**
 * THE LOOK & FEEL PAGE'S CHANGES (LF). Every one goes through the ONE
 * configuration lifecycle (`proposeAndActivate`: draft → validate → impact →
 * activate, with an author, a reason, an audit event and a version), or the
 * service's own rollback for "Undo". Nothing is written around it.
 */
const log = createLogger({ context: { component: 'admin.look' } });

type Change = (active: ThemeDocument) => ThemeDocument;

const localeOf = (formData: FormData) =>
  String(formData.get('locale') ?? '') === 'ar' ? 'ar' : 'en';
const pageOf = (locale: string) => `/${locale}/console/look`;

function note(formData: FormData, base: string): string {
  const text = String(formData.get('note') ?? '')
    .trim()
    .slice(0, 300);
  return text ? `${base} — ${text}` : base;
}

async function apply(
  formData: FormData,
  ok: string,
  reason: string,
  change: Change,
): Promise<void> {
  const locale = localeOf(formData);
  const back = pageOf(locale);
  let destination: string;
  try {
    const actor = await requirePlatformActor('platform.configuration.manage');
    await requirePlatformActor('platform.configuration.activate');
    if (formData.get('confirm') !== 'yes') throw new AppError('VALIDATION_FAILED', 'NOT_CONFIRMED');
    await proposeAndActivate<ThemeDocument>({
      actor,
      domain: 'theme',
      reason,
      acknowledged: true,
      change: (active) => {
        const next = themeDocumentSchema.parse(change(themeDocumentSchema.parse(active)));
        if (contrastIssues(next.look).length > 0)
          throw new AppError('VALIDATION_FAILED', 'CONTRAST');
        return next;
      },
      unchanged: (active) => {
        const parsed = themeDocumentSchema.parse(active);
        return JSON.stringify(themeDocumentSchema.parse(change(parsed))) === JSON.stringify(parsed);
      },
    });
    destination = `${back}?ok=${ok}`;
  } catch (error: unknown) {
    destination = refused(back, error);
  }
  revalidatePath(back);
  redirect(destination);
}

function refused(back: string, error: unknown): string {
  const known = ['NOT_CONFIRMED', 'CONTRAST', 'NO_UNDO'];
  const code =
    refusalCode(error) ??
    (error instanceof AppError && known.includes(error.message) ? error.message : null);
  if (code) return `${back}?error=${code}`;
  const correlationId = randomUUID();
  log.error('look change failed', { correlationId, ...internalErrorFields(error) });
  return `${back}?error=${toPublicErrorCode(error)}&ref=${correlationId}`;
}

function postedLook(formData: FormData) {
  const raw = String(formData.get('look') ?? '{}');
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AppError('VALIDATION_FAILED', 'The look could not be read.');
  }
  return themeLookSchema.parse(parsed);
}

const PRESETS = new Set(['original', 'calm', 'modern', 'premium', 'light', 'custom', 'saved']);

/** Activate the look on the page. */
export async function activateLookAction(formData: FormData): Promise<void> {
  const raw = String(formData.get('preset') ?? 'custom');
  const preset = (PRESETS.has(raw) ? raw : 'custom') as ThemeDocument['preset'];
  let look: ReturnType<typeof postedLook>;
  try {
    look = postedLook(formData);
  } catch (error: unknown) {
    redirect(refused(pageOf(localeOf(formData)), error));
  }
  await apply(formData, 'SAVED', note(formData, 'Look & feel: a new look'), (active) => ({
    ...active,
    preset,
    look,
  }));
}

/** "Save as my preset": the look on the page, kept to start from later. */
export async function savePresetAction(formData: FormData): Promise<void> {
  const name = String(formData.get('name') ?? '')
    .trim()
    .slice(0, 60);
  let look: ReturnType<typeof postedLook>;
  try {
    if (!name) throw new AppError('VALIDATION_FAILED', 'NOT_CONFIRMED');
    look = postedLook(formData);
  } catch (error: unknown) {
    redirect(refused(pageOf(localeOf(formData)), error));
  }
  const id = `p-${randomUUID().slice(0, 8)}`;
  await apply(formData, 'PRESET', `Look & feel: saved the preset "${name}"`, (active) => ({
    ...active,
    savedPresets: [...active.savedPresets, { id, name, look }].slice(-12),
  }));
}

export async function removePresetAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '');
  await apply(formData, 'PRESET_REMOVED', 'Look & feel: removed a saved preset', (active) => ({
    ...active,
    savedPresets: active.savedPresets.filter((p) => p.id !== id),
  }));
}

/** Safe mode's switch: keep the Control Center on the original look. */
export async function controlCenterLookAction(formData: FormData): Promise<void> {
  const keep = formData.get('keep') === 'yes';
  await apply(
    formData,
    'CC',
    keep
      ? 'Look & feel: the Control Center keeps the original look'
      : 'Look & feel: the Control Center takes the active look',
    (active) => ({ ...active, controlCenterOriginal: keep }),
  );
}

/** Reset to the original look (the saved presets and the safe-mode switch stay). */
export async function resetLookAction(formData: FormData): Promise<void> {
  await apply(
    formData,
    'RESET',
    note(formData, 'Look & feel: reset to the original look'),
    (active) => ({
      ...active,
      preset: 'original',
      look: themeLookSchema.parse({}),
    }),
  );
}

/** Undo: roll back to the version that was active before this one. */
export async function undoLookAction(formData: FormData): Promise<void> {
  const locale = localeOf(formData);
  const back = pageOf(locale);
  let destination: string;
  try {
    const actor = await requirePlatformActor('platform.configuration.activate');
    if (formData.get('confirm') !== 'yes') throw new AppError('VALIDATION_FAILED', 'NOT_CONFIRMED');
    const previous = await previousThemeVersion(actor);
    if (!previous) throw new AppError('CONFLICT', 'NO_UNDO');
    await getConfigService().rollback(
      serviceActor(actor),
      previous,
      note(formData, 'Look & feel: undo the last change'),
    );
    destination = `${back}?ok=UNDONE`;
  } catch (error: unknown) {
    destination = refused(back, error);
  }
  revalidatePath(back);
  redirect(destination);
}

/**
 * SAFE MODE: the fixed recovery link (LF). The platform owner, signed in with
 * the second step, puts the original look back at once — and the Control
 * Center back on it. An unfinished theme draft would otherwise refuse the
 * change, so it is discarded first: recovering beats a half-written edit.
 */
export async function recoverLookAction(formData: FormData): Promise<void> {
  const locale = localeOf(formData);
  const back = `${pageOf(locale)}/recover`;
  let destination: string;
  try {
    const actor = await requirePlatformActor('platform.configuration.activate');
    if (actor.roleKey !== 'platform_owner' || !actor.mfaVerified) {
      throw new AppError('FORBIDDEN', 'NOT_OWNER');
    }
    const config = getConfigService();
    const service = serviceActor(actor);
    for (const version of await config.listVersions(service, 'theme', currentEnvironment())) {
      if (version.status === 'DRAFT' || version.status === 'VALIDATED') {
        await config.discardDraft(
          service,
          version.id,
          'Discarded by the Look & feel recovery link.',
        );
      }
    }
    await proposeAndActivate<ThemeDocument>({
      actor,
      domain: 'theme',
      reason: 'Look & feel: the recovery link restored the original look',
      acknowledged: true,
      change: (active) => ({
        ...themeDocumentSchema.parse(active),
        preset: 'original',
        look: themeLookSchema.parse({}),
        controlCenterOriginal: true,
      }),
      unchanged: (active) => {
        const parsed = themeDocumentSchema.parse(active);
        return (
          parsed.controlCenterOriginal &&
          JSON.stringify(parsed.look) === JSON.stringify(themeLookSchema.parse({}))
        );
      },
    });
    destination = `${back}?ok=RECOVERED`;
  } catch (error: unknown) {
    if (refusalCode(error) === 'UNCHANGED') destination = `${back}?ok=RECOVERED`;
    else if (error instanceof AppError && error.message === 'NOT_OWNER')
      destination = `${back}?error=NOT_OWNER`;
    else destination = refused(back, error);
  }
  revalidatePath(pageOf(locale));
  redirect(destination);
}
