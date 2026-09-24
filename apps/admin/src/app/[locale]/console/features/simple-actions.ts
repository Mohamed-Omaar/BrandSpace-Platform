'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { readPlanCatalogue } from '@brandspace/entitlements';
import { AppError, createLogger, internalErrorFields, toPublicErrorCode } from '@brandspace/shared';
import { withSpan } from '@brandspace/observability';
import {
  featureAccess,
  simpleEditable,
  withGlobal,
  withPlanGrants,
  type FlagShape,
  type GrantShape,
  type SimpleChoice,
} from '../../../../server/feature-access';
import {
  currentEnvironment,
  getConfigService,
  requirePlatformActor,
} from '../../../../server/platform-context';
import { proposeAndActivate, refusalCode } from '../../../../server/simple-config';

const log = createLogger({ context: { component: 'admin.features.simple' } });

type FlagsDocument = { flags: FlagShape[] } & Record<string, unknown>;
type EntitlementsDocument = {
  features: { key: string; valueType: string; defaultValue: unknown }[];
  planEntitlements: GrantShape[];
} & Record<string, unknown>;

/**
 * WHO GETS A FEATURE — Simple mode's one write for features (D-314).
 *
 * Everyone / Nobody sets the flag's `globalEnabled`; Selected plans sets each
 * plan's grant in `entitlements` and clears the flag's global setting so the
 * grants decide. Each is ONE `proposeAndActivate` — draft, validate (feature
 * dependencies included), preview, activate — with the owner's reason and
 * explicit confirmation.
 *
 * EVERYTHING THE FORM CLAIMS IS RE-CHECKED HERE against the active documents:
 * that the feature exists, is boolean, has no kill switch and no advanced
 * targeting, and that every ticked plan exists. A crafted POST cannot use this
 * door to overwrite targeting that Simple mode does not show.
 *
 * NOT ATOMIC ACROSS THE TWO DOMAINS, and said so: "Selected plans" on a
 * feature that currently has a global setting is two activations, grants
 * first. If the second is refused, the grants are updated but the global
 * setting still decides — which the screen then shows truthfully.
 */
export async function setFeatureAccessAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? '') === 'ar' ? 'ar' : 'en';
  const featureKey = String(formData.get('featureKey') ?? '');
  const rawChoice = String(formData.get('access') ?? '');
  const choice: SimpleChoice | null =
    rawChoice === 'everyone' || rawChoice === 'plans' || rawChoice === 'nobody' ? rawChoice : null;
  const selected = formData.getAll('plans').map(String);
  const reason = String(formData.get('reason') ?? '');
  const acknowledged = formData.get('confirm') === 'yes';
  const back = `/${locale}/console/features`;
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.configuration.manage');
    await requirePlatformActor('platform.configuration.activate');
    if (!choice) throw new AppError('VALIDATION_FAILED', 'Choose who should get the feature.');

    const environment = currentEnvironment();
    const config = getConfigService();
    const [entitlements, flags, plansPayload] = await Promise.all([
      config.get('entitlements', environment) as unknown as Promise<EntitlementsDocument>,
      config.get('feature-flags', environment) as unknown as Promise<FlagsDocument>,
      config.get('plans', environment),
    ]);
    const planKeys = readPlanCatalogue(plansPayload as unknown as Record<string, unknown>).map(
      (plan) => plan.key,
    );
    const feature = entitlements.features.find((candidate) => candidate.key === featureKey);
    if (!feature) throw new AppError('NOT_FOUND', 'Unknown feature.');
    const access = featureAccess({
      valueType: feature.valueType,
      defaultValue: feature.defaultValue,
      flag: flags.flags.find((flag) => flag.featureKey === featureKey) ?? null,
      grants: entitlements.planEntitlements.filter((grant) => grant.featureKey === featureKey),
      planKeys,
    });
    if (!simpleEditable(access)) throw new AppError('CONFLICT', 'NOT_SIMPLE');
    if (choice === 'plans' && selected.some((planKey) => !planKeys.includes(planKey))) {
      throw new AppError('VALIDATION_FAILED', 'Unknown plan.');
    }

    await withSpan(
      'admin.feature.access',
      { 'feature.key': featureKey, 'feature.access': choice },
      async () => {
        if (choice === 'everyone' || choice === 'nobody') {
          const value = choice === 'everyone';
          await proposeAndActivate<FlagsDocument>({
            actor,
            domain: 'feature-flags',
            reason,
            acknowledged,
            unchanged: (active) =>
              active.flags.find((flag) => flag.featureKey === featureKey)?.globalEnabled === value,
            change: (active) => withGlobal(active, featureKey, value),
          });
          return;
        }
        // Selected plans: the grants first, then hand the decision to them.
        const wanted = planKeys.filter((planKey) => selected.includes(planKey));
        const grantsChange = (active: EntitlementsDocument) =>
          withPlanGrants(active, featureKey, planKeys, wanted, feature.defaultValue);
        let changedSomething = false;
        try {
          await proposeAndActivate<EntitlementsDocument>({
            actor,
            domain: 'entitlements',
            reason,
            acknowledged,
            unchanged: (active) => JSON.stringify(grantsChange(active)) === JSON.stringify(active),
            change: grantsChange,
          });
          changedSomething = true;
        } catch (error: unknown) {
          if (refusalCode(error) !== 'UNCHANGED') throw error;
        }
        const flag = flags.flags.find((candidate) => candidate.featureKey === featureKey);
        if (flag && flag.globalEnabled !== null) {
          await proposeAndActivate<FlagsDocument>({
            actor,
            domain: 'feature-flags',
            reason,
            acknowledged,
            unchanged: () => false,
            change: (active) => withGlobal(active, featureKey, null),
          });
          changedSomething = true;
        }
        if (!changedSomething) throw new AppError('CONFLICT', 'UNCHANGED');
      },
    );
    destination = `${back}?ok=ACCESS_CHANGED`;
  } catch (error: unknown) {
    const code =
      refusalCode(error) ??
      (error instanceof AppError && error.message === 'NOT_SIMPLE' ? 'NOT_SIMPLE' : null);
    if (code) {
      destination = `${back}?error=${code}`;
    } else {
      const correlationId = randomUUID();
      log.error('feature access change failed', { correlationId, ...internalErrorFields(error) });
      destination = `${back}?error=${toPublicErrorCode(error)}&ref=${correlationId}`;
    }
  }
  revalidatePath(back);
  redirect(destination);
}
