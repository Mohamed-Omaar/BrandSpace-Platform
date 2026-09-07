'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { AppError, createLogger, internalErrorFields, toPublicErrorCode } from '@brandspace/shared';
import { withSpan } from '@brandspace/observability';
import {
  getConfigService,
  requirePlatformActor,
  serviceActor,
} from '../../../../server/platform-context';
import { removeCollectionItem, upsertCollectionItem } from '../../../../server/config-draft';

const log = createLogger({ context: { component: 'admin.plans' } });

/**
 * The operator's change reason, or a stated fallback.
 *
 * `??` is not enough: an untouched text input posts an EMPTY STRING, not
 * undefined, and the Configuration Service requires at least eight characters
 * for the audit trail. Passing "" through produced an opaque "that change was
 * rejected" for the ordinary case of leaving an optional-looking field blank.
 *
 * The fallback is a real sentence rather than a placeholder, because it is what
 * the audit event will say.
 */
function reasonFrom(form: FormData, fallback: string): string {
  const typed = String(form.get('reason') ?? '').trim();
  return typed.length >= 8 ? typed : fallback;
}

/**
 * Plan editor server actions.
 *
 * Every one re-checks authorisation server-side. A server action is a public
 * HTTP endpoint: being reachable only from an authorised page is not a control.
 *
 * Nothing here validates commercial rules. The Configuration Service's semantic
 * validation does that on `validate` and again on `activate`, so a plan cannot
 * be activated with a missing currency, an Agency name, postpaid overage under
 * a hard stop, or a downgrade that deletes a resource — whatever this form
 * allowed to be typed.
 */

function backTo(locale: string, params: Record<string, string>): string {
  const search = new URLSearchParams(params);
  return `/${locale}/console/plans?${search.toString()}`;
}

/** Any failure becomes a redirect carrying a CODE, never a message. */
function failure(locale: string, error: unknown): string {
  const correlationId = randomUUID();
  log.error('plan action failed', { correlationId, ...internalErrorFields(error) });
  return backTo(locale, { error: toPublicErrorCode(error), ref: correlationId });
}

/** Read an integer field, or throw. Empty means "not stated" where allowed. */
function readNullableInt(form: FormData, name: string): number | null {
  const raw = String(form.get(name) ?? '').trim();
  if (raw === '') return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new AppError('VALIDATION_FAILED', 'Expected a whole number of zero or more.');
  }
  return parsed;
}

function readInt(form: FormData, name: string, fallback = 0): number {
  return readNullableInt(form, name) ?? fallback;
}

/**
 * Save one plan into the open draft, creating the draft if there is none.
 *
 * The form carries the currencies it rendered, so the price table is rebuilt
 * from exactly the rows the operator saw — rather than merged into whatever was
 * there before, which would leave a stale price for a currency that had been
 * removed from the supported list.
 */
export async function savePlanAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.configuration.manage');
    const key = String(formData.get('key') ?? '').trim();
    if (!key) throw new AppError('VALIDATION_FAILED', 'A plan needs a key.');

    const currencies = String(formData.get('currencies') ?? '')
      .split(',')
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean);

    const prices = currencies.map((currency) => ({
      currency,
      monthlyMinor: readInt(formData, `price.${currency}.monthly`),
      annualMinor: readInt(formData, `price.${currency}.annual`),
    }));

    const item: Record<string, unknown> = {
      key,
      name: {
        ar: String(formData.get('name.ar') ?? '').trim(),
        en: String(formData.get('name.en') ?? '').trim(),
      },
      description: {
        ar: String(formData.get('description.ar') ?? '').trim(),
        en: String(formData.get('description.en') ?? '').trim(),
      },
      tier: readInt(formData, 'tier'),
      visibility: String(formData.get('visibility') ?? 'private'),
      status: String(formData.get('status') ?? 'draft'),
      prices,
      trialDays: readInt(formData, 'trialDays'),
      trialRequiresCard: formData.get('trialRequiresCard') === 'yes',
      trialCredits: readInt(formData, 'trialCredits'),
      monthlyCredits: readInt(formData, 'monthlyCredits'),
      creditRollover: {
        policy: String(formData.get('rollover.policy') ?? 'none'),
        capMultiplier: Number(formData.get('rollover.capMultiplier') ?? 0),
      },
      quotas: {
        // Empty means "not stated", which resolves as unlimited — the
        // Enterprise "negotiated" case. It is NOT zero.
        seats: readNullableInt(formData, 'quota.seats'),
        brands: readNullableInt(formData, 'quota.brands'),
        socialAccounts: readNullableInt(formData, 'quota.socialAccounts'),
        scheduledPostsPerMonth: readNullableInt(formData, 'quota.scheduledPostsPerMonth'),
        storageGb: readNullableInt(formData, 'quota.storageGb'),
        analyticsRetentionDays: readNullableInt(formData, 'quota.analyticsRetentionDays'),
      },
      sortOrder: readInt(formData, 'sortOrder'),
    };

    const lockRaw = String(formData.get('lockVersion') ?? '');
    await withSpan('admin.plan.save', { 'plan.key': key }, async () =>
      upsertCollectionItem(actor, 'plans', {
        field: 'plans',
        keyField: 'key',
        key,
        item,
        reason: reasonFrom(formData, 'Plan edited from the Control Center.'),
        expectedLockVersion: lockRaw === '' ? null : Number(lockRaw),
      }),
    );
    destination = backTo(locale, { ok: 'DRAFT_SAVED', plan: key });
  } catch (error: unknown) {
    destination = failure(locale, error);
  }
  revalidatePath(`/${locale}/console/plans`);
  redirect(destination);
}

export async function removePlanAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.configuration.manage');
    const key = String(formData.get('key') ?? '').trim();
    if (!key) throw new AppError('VALIDATION_FAILED', 'A plan needs a key.');

    await withSpan('admin.plan.remove', { 'plan.key': key }, async () =>
      removeCollectionItem(actor, 'plans', {
        field: 'plans',
        keyField: 'key',
        key,
        reason: reasonFrom(formData, 'Plan removed from the draft.'),
      }),
    );
    destination = backTo(locale, { ok: 'DRAFT_SAVED' });
  } catch (error: unknown) {
    destination = failure(locale, error);
  }
  revalidatePath(`/${locale}/console/plans`);
  redirect(destination);
}

/** Validate the draft and compute the impact preview in one step. */
export async function validatePlansAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const versionId = String(formData.get('versionId') ?? '');
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.configuration.manage');
    const config = getConfigService();
    const report = await withSpan('admin.plan.validate', {}, async () =>
      config.validateDraft(serviceActor(actor), versionId),
    );
    // The impact preview is computed alongside validation so the operator sees
    // both before deciding — including who would be pushed over a new limit.
    const preview = await config.previewImpact(serviceActor(actor), versionId);

    destination = report.valid
      ? backTo(locale, {
          ok: 'VALIDATION_PASSED',
          changes: String(preview.changes.length),
          high: String(preview.highImpactCount),
          over: String(preview.affected?.overLimit.length ?? 0),
        })
      : backTo(locale, {
          ok: 'VALIDATION_FAILED',
          errors: String(report.issues.filter((i) => i.severity === 'error').length),
        });
  } catch (error: unknown) {
    destination = failure(locale, error);
  }
  revalidatePath(`/${locale}/console/plans`);
  redirect(destination);
}

export async function activatePlansAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const versionId = String(formData.get('versionId') ?? '');
  const acknowledge = formData.get('acknowledge') === 'yes';
  let destination: string;

  try {
    // Activation is a SEPARATE permission from drafting, and the service also
    // enforces dual control on `plans`: the person who drafted a price change
    // may not be the one who activates it.
    const actor = await requirePlatformActor('platform.configuration.activate');
    await withSpan('admin.plan.activate', { 'config.acknowledged': acknowledge }, async () =>
      getConfigService().activate(serviceActor(actor), versionId, {
        acknowledgeHighImpact: acknowledge,
      }),
    );
    destination = backTo(locale, { ok: 'ACTIVATED' });
  } catch (error: unknown) {
    destination = failure(locale, error);
  }
  revalidatePath(`/${locale}/console/plans`);
  redirect(destination);
}

export async function rollbackPlansAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const versionId = String(formData.get('versionId') ?? '');
  const reason = String(formData.get('reason') ?? '');
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.configuration.activate');
    await withSpan('admin.plan.rollback', {}, async () =>
      getConfigService().rollback(serviceActor(actor), versionId, reason),
    );
    destination = backTo(locale, { ok: 'ROLLED_BACK' });
  } catch (error: unknown) {
    destination = failure(locale, error);
  }
  revalidatePath(`/${locale}/console/plans`);
  redirect(destination);
}

export async function discardPlanDraftAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const versionId = String(formData.get('versionId') ?? '');
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.configuration.manage');
    await getConfigService().discardDraft(
      serviceActor(actor),
      versionId,
      reasonFrom(formData, 'Draft discarded from the Control Center.'),
    );
    destination = backTo(locale, { ok: 'DRAFT_DISCARDED' });
  } catch (error: unknown) {
    destination = failure(locale, error);
  }
  revalidatePath(`/${locale}/console/plans`);
  redirect(destination);
}
