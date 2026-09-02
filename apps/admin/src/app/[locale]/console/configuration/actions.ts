'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { isConfigDomain } from '@brandspace/config';
import {
  AppError,
  PublicError,
  createLogger,
  internalErrorFields,
  toPublicErrorCode,
} from '@brandspace/shared';
import { withSpan } from '@brandspace/observability';
import {
  currentEnvironment,
  getConfigService,
  requirePlatformActor,
  serviceActor,
} from '../../../../server/platform-context';

const log = createLogger({ context: { component: 'admin.configuration' } });

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

/**
 * Turn any failure into a redirect that carries a CODE, never a message.
 *
 * The previous `safeMessage()` returned `error.message` and put it in the query
 * string, so a Prisma constraint, a connection string or a stack trace would
 * have ended up in the address bar, browser history and access logs. The real
 * error is logged once, redacted, against a correlation id the operator can
 * quote.
 */
function failure(locale: string, domain: string, error: unknown): string {
  const correlationId = randomUUID();
  log.error('configuration action failed', {
    correlationId,
    domain,
    ...internalErrorFields(error),
  });
  return backTo(locale, domain, { error: toPublicErrorCode(error), ref: correlationId });
}

export async function createDraftAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const domain = String(formData.get('domain') ?? '');
  const reason = String(formData.get('reason') ?? '');
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.configuration.manage');
    if (!isConfigDomain(domain)) {
      // The submitted domain is attacker-controllable; it never goes into a URL.
      throw new AppError('VALIDATION_FAILED', 'Unknown configuration domain.');
    }

    await withSpan(
      'config.draft.create',
      { 'config.domain': domain, 'config.environment': currentEnvironment() },
      async () =>
        getConfigService().createDraft(serviceActor(actor), domain, currentEnvironment(), reason),
    );
    destination = backTo(locale, domain, { ok: 'DRAFT_CREATED' });
  } catch (error: unknown) {
    destination = failure(locale, domain, error);
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
    const actor = await requirePlatformActor('platform.configuration.manage');
    if (!Number.isInteger(lockVersion)) {
      throw new Error(
        'The form was submitted without a version to compare against. Reload the page.',
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      // The parser's own message echoes a fragment of the input, and this input
      // is operator-supplied configuration. A chosen code, not a message.
      throw new PublicError('INVALID_JSON');
    }

    await withSpan(
      'config.draft.update',
      { 'config.domain': domain, 'config.version_id': versionId },
      async () =>
        getConfigService().updateDraft(serviceActor(actor), versionId, payload, lockVersion),
    );
    destination = backTo(locale, domain, { ok: 'DRAFT_SAVED' });
  } catch (error: unknown) {
    destination = failure(locale, domain, error);
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
    const actor = await requirePlatformActor('platform.configuration.manage');
    const config = getConfigService();
    const report = await withSpan(
      'config.validate',
      { 'config.domain': domain, 'config.version_id': versionId },
      async () => config.validateDraft(serviceActor(actor), versionId),
    );
    // Impact preview is computed alongside validation, so the operator sees
    // both before deciding.
    const preview = await config.previewImpact(serviceActor(actor), versionId);
    // Codes and numbers only: nothing free-form goes into the URL.
    destination = report.valid
      ? backTo(locale, domain, {
          ok: 'VALIDATION_PASSED',
          changes: String(preview.changes.length),
          high: String(preview.highImpactCount),
        })
      : backTo(locale, domain, {
          ok: 'VALIDATION_FAILED',
          errors: String(report.issues.filter((i) => i.severity === 'error').length),
        });
  } catch (error: unknown) {
    destination = failure(locale, domain, error);
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
    const actor = await requirePlatformActor('platform.configuration.activate');
    await withSpan(
      'config.activate',
      {
        'config.domain': domain,
        'config.version_id': versionId,
        'config.acknowledged': acknowledge,
      },
      async () =>
        getConfigService().activate(serviceActor(actor), versionId, {
          acknowledgeHighImpact: acknowledge,
        }),
    );
    destination = backTo(locale, domain, { ok: 'ACTIVATED' });
  } catch (error: unknown) {
    destination = failure(locale, domain, error);
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
    const actor = await requirePlatformActor('platform.configuration.activate');
    await withSpan(
      'config.rollback',
      { 'config.domain': domain, 'config.target_version_id': versionId },
      async () => getConfigService().rollback(serviceActor(actor), versionId, reason),
    );
    destination = backTo(locale, domain, { ok: 'ROLLED_BACK' });
  } catch (error: unknown) {
    destination = failure(locale, domain, error);
  }
  revalidatePath(`/${locale}/console/configuration`);
  redirect(destination);
}
