'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { isConfigDomain } from '@brandspace/config';
import { withSpan } from '@brandspace/observability';
import {
  currentEnvironment,
  getConfigService,
  requirePlatformActor,
} from '../../../../server/platform-context';

/**
 * Configuration server actions.
 *
 * Every one re-checks authorisation server-side. A server action is a public
 * HTTP endpoint — being reachable only from an authorised page is not a control.
 */

function backTo(locale: string, domain: string, params: Record<string, string>): string {
  const search = new URLSearchParams({ domain, ...params });
  return `/${locale}/console/configuration?${search.toString()}`;
}

/** Errors are surfaced to the operator, never a raw stack. */
function safeMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'AppError') return error.message;
  return error instanceof Error ? error.message : 'Unexpected error';
}

export async function createDraftAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const domain = String(formData.get('domain') ?? '');
  const reason = String(formData.get('reason') ?? '');
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.workspace.read');
    if (!isConfigDomain(domain)) throw new Error(`Unknown domain: ${domain}`);

    await withSpan(
      'config.draft.create',
      { 'config.domain': domain, 'config.environment': currentEnvironment() },
      async () =>
        getConfigService().createDraft(
          {
            platformUserId: actor.platformUserId,
            roleKey: actor.roleKey,
            mfaVerified: actor.mfaVerified,
          },
          domain,
          currentEnvironment(),
          reason,
        ),
    );
    destination = backTo(locale, domain, { ok: encodeURIComponent('Draft created') });
  } catch (error: unknown) {
    destination = backTo(locale, domain, { error: encodeURIComponent(safeMessage(error)) });
  }
  revalidatePath(`/${locale}/console/configuration`);
  redirect(destination);
}

/**
 * Save an edited draft payload.
 *
 * The `lockVersion` the operator's page was rendered with travels back with the
 * form. If someone else saved in the meantime the service refuses this write
 * rather than silently discarding their edit — see docs/ADMIN-CONTROL-CENTER.md.
 */
export async function updateDraftAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const domain = String(formData.get('domain') ?? '');
  const versionId = String(formData.get('versionId') ?? '');
  const lockVersion = Number(formData.get('lockVersion') ?? Number.NaN);
  const raw = String(formData.get('payload') ?? '');
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.workspace.read');
    if (!Number.isInteger(lockVersion)) {
      throw new Error(
        'The form was submitted without a version to compare against. Reload the page.',
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      // The parser's own message can echo a fragment of the input, and this
      // input is operator-supplied configuration.
      throw new Error('The payload is not valid JSON.');
    }

    await withSpan(
      'config.draft.update',
      { 'config.domain': domain, 'config.version_id': versionId },
      async () =>
        getConfigService().updateDraft(
          {
            platformUserId: actor.platformUserId,
            roleKey: actor.roleKey,
            mfaVerified: actor.mfaVerified,
          },
          versionId,
          payload,
          lockVersion,
        ),
    );
    destination = backTo(locale, domain, {
      ok: encodeURIComponent('Draft saved. Validate it again before activating.'),
    });
  } catch (error: unknown) {
    destination = backTo(locale, domain, { error: encodeURIComponent(safeMessage(error)) });
  }
  revalidatePath(`/${locale}/console/configuration`);
  redirect(destination);
}

export async function validateAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const domain = String(formData.get('domain') ?? '');
  const versionId = String(formData.get('versionId') ?? '');
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.workspace.read');
    const config = getConfigService();
    const report = await withSpan(
      'config.validate',
      { 'config.domain': domain, 'config.version_id': versionId },
      async () =>
        config.validateDraft(
          {
            platformUserId: actor.platformUserId,
            roleKey: actor.roleKey,
            mfaVerified: actor.mfaVerified,
          },
          versionId,
        ),
    );
    // Impact preview is computed alongside validation, so the operator sees
    // both before deciding.
    const preview = await config.previewImpact(versionId);
    destination = backTo(locale, domain, {
      ok: encodeURIComponent(
        report.valid
          ? `Valid. ${preview.changes.length} change(s), ${preview.highImpactCount} high impact.`
          : `${report.issues.filter((i) => i.severity === 'error').length} validation error(s).`,
      ),
    });
  } catch (error: unknown) {
    destination = backTo(locale, domain, { error: encodeURIComponent(safeMessage(error)) });
  }
  revalidatePath(`/${locale}/console/configuration`);
  redirect(destination);
}

export async function activateAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const domain = String(formData.get('domain') ?? '');
  const versionId = String(formData.get('versionId') ?? '');
  const acknowledge = formData.get('acknowledge') === 'yes';
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.workspace.read');
    await withSpan(
      'config.activate',
      {
        'config.domain': domain,
        'config.version_id': versionId,
        'config.acknowledged': acknowledge,
      },
      async () =>
        getConfigService().activate(
          {
            platformUserId: actor.platformUserId,
            roleKey: actor.roleKey,
            mfaVerified: actor.mfaVerified,
          },
          versionId,
          { acknowledgeHighImpact: acknowledge },
        ),
    );
    destination = backTo(locale, domain, { ok: encodeURIComponent('Configuration activated') });
  } catch (error: unknown) {
    destination = backTo(locale, domain, { error: encodeURIComponent(safeMessage(error)) });
  }
  revalidatePath(`/${locale}/console/configuration`);
  redirect(destination);
}

export async function rollbackAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const domain = String(formData.get('domain') ?? '');
  const versionId = String(formData.get('versionId') ?? '');
  const reason = String(formData.get('reason') ?? '');
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.workspace.read');
    await withSpan(
      'config.rollback',
      { 'config.domain': domain, 'config.target_version_id': versionId },
      async () =>
        getConfigService().rollback(
          {
            platformUserId: actor.platformUserId,
            roleKey: actor.roleKey,
            mfaVerified: actor.mfaVerified,
          },
          versionId,
          reason,
        ),
    );
    destination = backTo(locale, domain, { ok: encodeURIComponent('Rolled back') });
  } catch (error: unknown) {
    destination = backTo(locale, domain, { error: encodeURIComponent(safeMessage(error)) });
  }
  revalidatePath(`/${locale}/console/configuration`);
  redirect(destination);
}
