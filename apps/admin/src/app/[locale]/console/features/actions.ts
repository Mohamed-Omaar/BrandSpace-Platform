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
import {
  currentCollection,
  removeCollectionItem,
  replaceCollection,
  upsertCollectionItem,
} from '../../../../server/config-draft';

const log = createLogger({ context: { component: 'admin.features' } });

/**
 * The feature registry and the plan grant matrix.
 *
 * Both live in the `entitlements` domain: a feature's key, type, default and
 * dependencies, and which plan grants which feature at what limit. Editing them
 * is the same draft → validate → activate lifecycle as everything else, so an
 * accidental grant can be rolled back rather than hot-fixed.
 */

function backTo(locale: string, params: Record<string, string>): string {
  return `/${locale}/console/features?${new URLSearchParams(params).toString()}`;
}

function failure(locale: string, error: unknown): string {
  const correlationId = randomUUID();
  log.error('feature action failed', { correlationId, ...internalErrorFields(error) });
  return backTo(locale, { error: toPublicErrorCode(error), ref: correlationId });
}

export async function saveFeatureAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.configuration.manage');
    const key = String(formData.get('key') ?? '').trim();
    if (!key) throw new AppError('VALIDATION_FAILED', 'A feature needs a key.');

    const valueType = String(formData.get('valueType') ?? 'boolean');
    const rawDefault = String(formData.get('defaultValue') ?? '').trim();

    // The default is typed by the feature's own value type, so a quota's
    // default is a number rather than the string "10" — which the engine would
    // then not recognise as a limit.
    const defaultValue =
      rawDefault === ''
        ? null
        : valueType === 'boolean'
          ? rawDefault === 'true'
          : valueType === 'quota'
            ? Number(rawDefault)
            : rawDefault;

    if (valueType === 'quota' && defaultValue !== null && !Number.isFinite(defaultValue)) {
      throw new AppError('VALIDATION_FAILED', 'A quota default must be a number.');
    }

    const item: Record<string, unknown> = {
      key,
      name: {
        ar: String(formData.get('name.ar') ?? '').trim(),
        en: String(formData.get('name.en') ?? '').trim(),
      },
      category: String(formData.get('category') ?? 'general').trim() || 'general',
      valueType,
      defaultValue,
      enumValues: String(formData.get('enumValues') ?? '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
      dependsOn: String(formData.get('dependsOn') ?? '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
      status: String(formData.get('status') ?? 'active'),
    };

    await withSpan('admin.feature.save', { 'feature.key': key }, async () =>
      upsertCollectionItem(actor, 'entitlements', {
        field: 'features',
        keyField: 'key',
        key,
        item,
        reason: String(formData.get('reason') ?? 'Feature edited from the Control Center.'),
      }),
    );
    destination = backTo(locale, { ok: 'FEATURE_SAVED' });
  } catch (error: unknown) {
    destination = failure(locale, error);
  }
  revalidatePath(`/${locale}/console/features`);
  redirect(destination);
}

export async function removeFeatureAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.configuration.manage');
    await removeCollectionItem(actor, 'entitlements', {
      field: 'features',
      keyField: 'key',
      key: String(formData.get('key') ?? '').trim(),
      reason: 'Feature removed from the draft.',
    });
    destination = backTo(locale, { ok: 'DRAFT_SAVED' });
  } catch (error: unknown) {
    destination = failure(locale, error);
  }
  revalidatePath(`/${locale}/console/features`);
  redirect(destination);
}

/**
 * Set one plan's grant of one feature.
 *
 * The collection is keyed on the PAIR, so the composite key is synthesised here
 * rather than the row being appended blindly — which is how a plan ends up
 * granting the same feature twice with different answers.
 */
export async function savePlanGrantAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.configuration.manage');
    const planKey = String(formData.get('planKey') ?? '').trim();
    const featureKey = String(formData.get('featureKey') ?? '').trim();
    if (!planKey || !featureKey) {
      throw new AppError('VALIDATION_FAILED', 'A grant names a plan and a feature.');
    }

    const rawLimit = String(formData.get('limitValue') ?? '').trim();
    const rawEnum = String(formData.get('enumValue') ?? '').trim();

    const grant: Record<string, unknown> = {
      planKey,
      featureKey,
      enabled: formData.get('enabled') === 'true',
      // Blank means unlimited, not zero.
      limitValue: rawLimit === '' ? null : Number(rawLimit),
      limitPeriod: String(formData.get('limitPeriod') ?? '') || null,
      enumValue: rawEnum === '' ? null : rawEnum,
    };

    // `planEntitlements` is keyed on the PAIR, so the row is replaced by
    // rebuilding the collection: an upsert by a single key would append, and a
    // plan would then grant the same feature twice with different answers —
    // which the validator refuses, but only after the operator has saved.
    const rows = (await currentCollection(actor, 'entitlements', 'planEntitlements')).filter(
      (row) => !(row['planKey'] === planKey && row['featureKey'] === featureKey),
    );
    rows.push(grant);

    await withSpan(
      'admin.plan_grant.save',
      { 'plan.key': planKey, 'feature.key': featureKey },
      async () =>
        replaceCollection(actor, 'entitlements', {
          field: 'planEntitlements',
          rows,
          reason: String(formData.get('reason') ?? 'Plan grant edited.'),
        }),
    );

    destination = backTo(locale, { ok: 'FEATURE_SAVED' });
  } catch (error: unknown) {
    destination = failure(locale, error);
  }
  revalidatePath(`/${locale}/console/features`);
  redirect(destination);
}

export async function validateFeaturesAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const versionId = String(formData.get('versionId') ?? '');
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.configuration.manage');
    const config = getConfigService();
    const report = await config.validateDraft(serviceActor(actor), versionId);
    await config.previewImpact(serviceActor(actor), versionId);
    destination = report.valid
      ? backTo(locale, { ok: 'VALIDATION_PASSED', changes: '0', high: '0' })
      : backTo(locale, {
          ok: 'VALIDATION_FAILED',
          errors: String(report.issues.filter((i) => i.severity === 'error').length),
        });
  } catch (error: unknown) {
    destination = failure(locale, error);
  }
  revalidatePath(`/${locale}/console/features`);
  redirect(destination);
}

export async function activateFeaturesAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const versionId = String(formData.get('versionId') ?? '');
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.configuration.activate');
    await getConfigService().activate(serviceActor(actor), versionId, {
      acknowledgeHighImpact: formData.get('acknowledge') === 'yes',
    });
    destination = backTo(locale, { ok: 'ACTIVATED' });
  } catch (error: unknown) {
    destination = failure(locale, error);
  }
  revalidatePath(`/${locale}/console/features`);
  redirect(destination);
}
