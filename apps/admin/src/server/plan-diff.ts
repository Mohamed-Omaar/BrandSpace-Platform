import type { PlanDetail, PlanQuotas } from '@brandspace/entitlements';

/**
 * WHAT A PLANS CHANGE DOES, IN WORDS AN OWNER CAN CHECK (D-313).
 *
 * `ConfigurationService.previewImpact` reports JSON paths and a severity; the
 * owner needs "Growth: monthly AI credits 500 → 300". This compares the ACTIVE
 * catalogue with the DRAFT one, plan by plan, and returns structured changes
 * for the screen to phrase. It adds no judgement of its own: the service's
 * impact preview (who would exceed a new limit) is still the authority, and is
 * shown beside this.
 */
export type PlanField =
  | 'name'
  | 'status'
  | 'visibility'
  | 'price'
  | 'trialDays'
  | 'trialCredits'
  | 'monthlyCredits'
  | keyof PlanQuotas;

export interface PlanFieldChange {
  readonly field: PlanField;
  /** For a price, which currency and period. */
  readonly detail?: { readonly currency: string; readonly period: 'monthly' | 'annual' };
  readonly before: string | number | null;
  readonly after: string | number | null;
}

export interface PlanChange {
  readonly key: string;
  readonly kind: 'added' | 'removed' | 'changed';
  readonly nameEn: string;
  readonly nameAr: string;
  readonly changes: readonly PlanFieldChange[];
}

const QUOTAS: readonly (keyof PlanQuotas)[] = [
  'seats',
  'brands',
  'socialAccounts',
  'scheduledPostsPerMonth',
  'storageGb',
  'analyticsRetentionDays',
];

export function describePlanChanges(
  active: readonly PlanDetail[],
  draft: readonly PlanDetail[],
): readonly PlanChange[] {
  const out: PlanChange[] = [];
  for (const next of draft) {
    const before = active.find((plan) => plan.key === next.key);
    if (!before) {
      out.push({
        key: next.key,
        kind: 'added',
        nameEn: next.nameEn,
        nameAr: next.nameAr,
        changes: [],
      });
      continue;
    }
    const changes: PlanFieldChange[] = [];
    const compare = (field: PlanField, a: string | number | null, b: string | number | null) => {
      if (a !== b) changes.push({ field, before: a, after: b });
    };
    compare('name', before.nameEn, next.nameEn);
    compare('status', before.status, next.status);
    compare('visibility', before.visibility, next.visibility);
    const currencies = [
      ...new Set([...before.prices, ...next.prices].map((p) => p.currency)),
    ].sort();
    for (const currency of currencies) {
      const a = before.prices.find((p) => p.currency === currency);
      const b = next.prices.find((p) => p.currency === currency);
      for (const period of ['monthly', 'annual'] as const) {
        const field = period === 'monthly' ? 'monthlyMinor' : 'annualMinor';
        const x = a ? a[field] : null;
        const y = b ? b[field] : null;
        if (x !== y)
          changes.push({ field: 'price', detail: { currency, period }, before: x, after: y });
      }
    }
    compare('trialDays', before.trialDays, next.trialDays);
    compare('trialCredits', before.trialCredits, next.trialCredits);
    compare('monthlyCredits', before.monthlyCredits, next.monthlyCredits);
    for (const quota of QUOTAS) compare(quota, before.quotas[quota], next.quotas[quota]);
    if (changes.length > 0) {
      out.push({
        key: next.key,
        kind: 'changed',
        nameEn: next.nameEn,
        nameAr: next.nameAr,
        changes,
      });
    }
  }
  for (const previous of active) {
    if (!draft.some((plan) => plan.key === previous.key)) {
      out.push({
        key: previous.key,
        kind: 'removed',
        nameEn: previous.nameEn,
        nameAr: previous.nameAr,
        changes: [],
      });
    }
  }
  return out;
}
