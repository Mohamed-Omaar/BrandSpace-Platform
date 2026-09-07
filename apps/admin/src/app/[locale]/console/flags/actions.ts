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

const log = createLogger({ context: { component: 'admin.flags' } });

/**
 * Feature flag targeting — §5.2.
 *
 * All eight dimensions are editable here, in the precedence order the engine
 * evaluates them. None is dropped and none is invented: kill switch, explicit
 * allow/deny, beta cohort, country, date range, percentage rollout, plan, and
 * the flag's own global setting.
 *
 * The KILL SWITCH is the one control that must work under pressure, so it gets
 * its own action rather than being a checkbox inside a long form an operator
 * has to complete correctly during an incident.
 */

function backTo(locale: string, params: Record<string, string>): string {
  return `/${locale}/console/flags?${new URLSearchParams(params).toString()}`;
}

function failure(locale: string, error: unknown): string {
  const correlationId = randomUUID();
  log.error('flag action failed', { correlationId, ...internalErrorFields(error) });
  return backTo(locale, { error: toPublicErrorCode(error), ref: correlationId });
}

function csv(form: FormData, name: string): string[] {
  return String(form.get(name) ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export async function saveFlagAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.configuration.manage');
    const featureKey = String(formData.get('featureKey') ?? '').trim();
    if (!featureKey) throw new AppError('VALIDATION_FAILED', 'A flag names a feature.');

    const rollout = String(formData.get('percentageRollout') ?? '').trim();
    const globalEnabled = String(formData.get('globalEnabled') ?? '');
    const activeFrom = String(formData.get('activeFrom') ?? '').trim();
    const activeUntil = String(formData.get('activeUntil') ?? '').trim();

    const item: Record<string, unknown> = {
      featureKey,
      killSwitch: formData.get('killSwitch') === 'yes',
      // Three states, not two: on, off, and "this flag has no opinion" — which
      // is what lets the plan entitlement below it decide.
      globalEnabled: globalEnabled === '' ? null : globalEnabled === 'true',
      enabledForPlans: csv(formData, 'enabledForPlans'),
      enabledForWorkspaces: csv(formData, 'enabledForWorkspaces'),
      disabledForWorkspaces: csv(formData, 'disabledForWorkspaces'),
      betaGroups: csv(formData, 'betaGroups'),
      countries: csv(formData, 'countries').map((c) => c.toUpperCase()),
      // A date input gives `YYYY-MM-DD`; the schema wants a full timestamp.
      activeFrom: activeFrom === '' ? null : new Date(`${activeFrom}T00:00:00.000Z`).toISOString(),
      activeUntil:
        activeUntil === '' ? null : new Date(`${activeUntil}T00:00:00.000Z`).toISOString(),
      percentageRollout: rollout === '' ? null : Number(rollout),
    };

    await withSpan('admin.flag.save', { 'feature.key': featureKey }, async () =>
      upsertCollectionItem(actor, 'feature-flags', {
        field: 'flags',
        keyField: 'featureKey',
        key: featureKey,
        item,
        reason: String(formData.get('reason') ?? 'Flag edited from the Control Center.'),
      }),
    );
    destination = backTo(locale, { ok: 'FLAG_SAVED' });
  } catch (error: unknown) {
    destination = failure(locale, error);
  }
  revalidatePath(`/${locale}/console/flags`);
  redirect(destination);
}

/**
 * Engage or release a kill switch, and activate in the same action.
 *
 * Deliberately NOT a draft the operator must remember to activate. §5.5 puts
 * containment "within the cache TTL (seconds)", and a switch that needs a
 * second, separate step during an incident is a switch that does not work. It
 * still writes a version, so it is auditable and reversible like everything
 * else — it just does not wait.
 */
export async function toggleKillSwitchAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  let destination: string;

  try {
    // Activation permission, because that is what this does.
    const actor = await requirePlatformActor('platform.configuration.activate');
    const featureKey = String(formData.get('featureKey') ?? '').trim();
    const engage = formData.get('engage') === 'yes';
    if (!featureKey) throw new AppError('VALIDATION_FAILED', 'A flag names a feature.');

    await withSpan(
      'admin.flag.kill_switch',
      { 'feature.key': featureKey, 'flag.engaged': engage },
      async () => {
        await upsertCollectionItem(actor, 'feature-flags', {
          field: 'flags',
          keyField: 'featureKey',
          key: featureKey,
          item: { featureKey, killSwitch: engage },
          reason: engage
            ? `Kill switch engaged for "${featureKey}".`
            : `Kill switch released for "${featureKey}".`,
        });

        const config = getConfigService();
        const { loadDomainEditor } = await import('../../../../server/config-draft');
        const state = await loadDomainEditor(actor, 'feature-flags');
        if (!state.draft) {
          throw new AppError('CONFLICT', 'The kill-switch draft could not be prepared.');
        }
        const report = await config.validateDraft(serviceActor(actor), state.draft.id);
        if (!report.valid) {
          throw new AppError(
            'VALIDATION_FAILED',
            'The flag configuration is not valid, so the kill switch was not activated.',
          );
        }
        // A kill switch is high-impact BY DESIGN, so the acknowledgement is
        // implicit in having pressed this specific button.
        await config.activate(serviceActor(actor), state.draft.id, {
          acknowledgeHighImpact: true,
        });
      },
    );
    destination = backTo(locale, { ok: 'ACTIVATED' });
  } catch (error: unknown) {
    destination = failure(locale, error);
  }
  revalidatePath(`/${locale}/console/flags`);
  redirect(destination);
}

export async function removeFlagAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.configuration.manage');
    await removeCollectionItem(actor, 'feature-flags', {
      field: 'flags',
      keyField: 'featureKey',
      key: String(formData.get('featureKey') ?? '').trim(),
      reason: 'Flag removed from the draft.',
    });
    destination = backTo(locale, { ok: 'DRAFT_SAVED' });
  } catch (error: unknown) {
    destination = failure(locale, error);
  }
  revalidatePath(`/${locale}/console/flags`);
  redirect(destination);
}

export async function validateFlagsAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const versionId = String(formData.get('versionId') ?? '');
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.configuration.manage');
    const report = await getConfigService().validateDraft(serviceActor(actor), versionId);
    destination = report.valid
      ? backTo(locale, { ok: 'VALIDATION_PASSED', changes: '0', high: '0' })
      : backTo(locale, {
          ok: 'VALIDATION_FAILED',
          errors: String(report.issues.filter((i) => i.severity === 'error').length),
        });
  } catch (error: unknown) {
    destination = failure(locale, error);
  }
  revalidatePath(`/${locale}/console/flags`);
  redirect(destination);
}

export async function activateFlagsAction(formData: FormData): Promise<void> {
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
  revalidatePath(`/${locale}/console/flags`);
  redirect(destination);
}

export async function rollbackFlagsAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const versionId = String(formData.get('versionId') ?? '');
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.configuration.activate');
    await getConfigService().rollback(
      serviceActor(actor),
      versionId,
      String(formData.get('reason') ?? 'Rolled back from the Control Center.'),
    );
    destination = backTo(locale, { ok: 'ROLLED_BACK' });
  } catch (error: unknown) {
    destination = failure(locale, error);
  }
  revalidatePath(`/${locale}/console/flags`);
  redirect(destination);
}
