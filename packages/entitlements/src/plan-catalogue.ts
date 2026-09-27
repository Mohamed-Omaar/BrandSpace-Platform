import type { PlanTerms } from './subscription';

/**
 * Reading the `plans` configuration document into typed plan details.
 *
 * Every number here came from Platform Admin. Nothing in this file names a
 * plan, a price, a limit or an allowance — it only knows the SHAPE those
 * values arrive in (AC-04.3). A repository scan for "Starter", "29" or "500"
 * finds nothing in application source, which is the point.
 */

export interface PlanPriceRow {
  readonly currency: string;
  readonly monthlyMinor: number;
  readonly annualMinor: number;
}

export interface PlanQuotas {
  readonly seats: number | null;
  readonly brands: number | null;
  readonly socialAccounts: number | null;
  readonly scheduledPostsPerMonth: number | null;
  readonly storageGb: number | null;
  readonly analyticsRetentionDays: number | null;
  /** Q1: how many workspaces an owner on this plan may own. `null` = unlimited. */
  readonly workspaces: number | null;
}

export interface PlanAddOn {
  readonly key: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly kind: string;
  readonly unitAmount: number;
  readonly prices: ReadonlyArray<{ currency: string; monthlyMinor: number }>;
}

export interface PlanDetail {
  readonly key: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly descriptionEn: string;
  readonly descriptionAr: string;
  readonly tier: number;
  readonly visibility: 'public' | 'private' | 'legacy';
  readonly status: 'draft' | 'active' | 'grandfathered' | 'retired';
  readonly prices: readonly PlanPriceRow[];
  readonly taxBehavior: 'inclusive' | 'exclusive';
  readonly trialDays: number;
  readonly trialRequiresCard: boolean;
  readonly trialCredits: number;
  readonly monthlyCredits: number;
  readonly rolloverPolicy: 'none' | 'capped' | 'full';
  readonly rolloverCapMultiplier: number;
  readonly quotas: PlanQuotas;
  readonly addOns: readonly PlanAddOn[];
  readonly overageMode: 'block' | 'charge' | 'charge_capped';
  readonly upgradeTiming: 'immediate' | 'period_end';
  readonly downgradeTiming: 'immediate' | 'period_end';
  readonly excessResources: 'read_only' | 'archive';
  readonly excessCredits: 'retain_until_expiry' | 'forfeit';
  readonly sortOrder: number;
}

/** Parse one `plans` configuration document. */
export function readPlanCatalogue(payload: Record<string, unknown>): readonly PlanDetail[] {
  const raw = (payload['plans'] ?? []) as ReadonlyArray<Record<string, unknown>>;
  return raw.map(readPlan).sort((a, b) => a.sortOrder - b.sortOrder || a.tier - b.tier);
}

export function findPlan(
  catalogue: readonly PlanDetail[],
  planKey: string | null,
): PlanDetail | null {
  if (!planKey) return null;
  return catalogue.find((p) => p.key === planKey) ?? null;
}

/**
 * The price for one currency.
 *
 * Returns null rather than converting. D-08: each currency has its own
 * explicitly set price and NOTHING converts one at runtime, so a missing row is
 * a gap the owner must fill — not one this code may paper over with a rate.
 */
export function priceIn(plan: PlanDetail, currency: string): PlanPriceRow | null {
  const wanted = currency.toUpperCase();
  return plan.prices.find((p) => p.currency.toUpperCase() === wanted) ?? null;
}

/** Materialise the terms a subscription pins, or null if that currency has no price. */
export function termsFor(
  plan: PlanDetail,
  currency: string,
  sourceVersionId: string | null,
): PlanTerms | null {
  const pricing = priceIn(plan, currency);
  if (!pricing) return null;
  return {
    planKey: plan.key,
    pricing,
    monthlyCredits: plan.monthlyCredits,
    trialDays: plan.trialDays,
    trialCredits: plan.trialCredits,
    tier: plan.tier,
    sourceVersionId,
  };
}

function readPlan(p: Record<string, unknown>): PlanDetail {
  const name = (p['name'] ?? {}) as Record<string, string>;
  const description = (p['description'] ?? {}) as Record<string, string>;
  const quotas = (p['quotas'] ?? {}) as Record<string, unknown>;
  const rollover = (p['creditRollover'] ?? {}) as Record<string, unknown>;
  const overage = (p['overagePolicy'] ?? {}) as Record<string, unknown>;
  const upgrade = (p['upgradeBehavior'] ?? {}) as Record<string, unknown>;
  const downgrade = (p['downgradeBehavior'] ?? {}) as Record<string, unknown>;
  const key = String(p['key'] ?? '');

  return {
    key,
    nameEn: name['en'] ?? key,
    nameAr: name['ar'] ?? key,
    descriptionEn: description['en'] ?? '',
    descriptionAr: description['ar'] ?? '',
    tier: Number(p['tier'] ?? 0),
    visibility: (String(p['visibility'] ?? 'private') as PlanDetail['visibility']) ?? 'private',
    status: (String(p['status'] ?? 'draft') as PlanDetail['status']) ?? 'draft',
    prices: ((p['prices'] ?? []) as ReadonlyArray<Record<string, unknown>>).map((price) => ({
      currency: String(price['currency'] ?? '').toUpperCase(),
      monthlyMinor: Number(price['monthlyMinor'] ?? 0),
      annualMinor: Number(price['annualMinor'] ?? 0),
    })),
    taxBehavior: String(p['taxBehavior'] ?? 'exclusive') as PlanDetail['taxBehavior'],
    trialDays: Number(p['trialDays'] ?? 0),
    trialRequiresCard: p['trialRequiresCard'] === true,
    trialCredits: Number(p['trialCredits'] ?? 0),
    monthlyCredits: Number(p['monthlyCredits'] ?? 0),
    rolloverPolicy: String(rollover['policy'] ?? 'none') as PlanDetail['rolloverPolicy'],
    rolloverCapMultiplier: Number(rollover['capMultiplier'] ?? 0),
    quotas: {
      seats: nullableNumber(quotas['seats']),
      brands: nullableNumber(quotas['brands']),
      socialAccounts: nullableNumber(quotas['socialAccounts']),
      scheduledPostsPerMonth: nullableNumber(quotas['scheduledPostsPerMonth']),
      storageGb: nullableNumber(quotas['storageGb']),
      analyticsRetentionDays: nullableNumber(quotas['analyticsRetentionDays']),
      workspaces: nullableNumber(quotas['workspaces']),
    },
    addOns: ((p['addOns'] ?? []) as ReadonlyArray<Record<string, unknown>>).map((addOn) => {
      const addOnName = (addOn['name'] ?? {}) as Record<string, string>;
      const addOnKey = String(addOn['key'] ?? '');
      return {
        key: addOnKey,
        nameEn: addOnName['en'] ?? addOnKey,
        nameAr: addOnName['ar'] ?? addOnKey,
        kind: String(addOn['kind'] ?? ''),
        unitAmount: Number(addOn['unitAmount'] ?? 0),
        prices: ((addOn['prices'] ?? []) as ReadonlyArray<Record<string, unknown>>).map((pr) => ({
          currency: String(pr['currency'] ?? '').toUpperCase(),
          monthlyMinor: Number(pr['monthlyMinor'] ?? 0),
        })),
      };
    }),
    overageMode: String(overage['mode'] ?? 'block') as PlanDetail['overageMode'],
    upgradeTiming: String(upgrade['timing'] ?? 'immediate') as PlanDetail['upgradeTiming'],
    downgradeTiming: String(downgrade['timing'] ?? 'period_end') as PlanDetail['downgradeTiming'],
    excessResources: String(
      downgrade['excessResources'] ?? 'read_only',
    ) as PlanDetail['excessResources'],
    excessCredits: String(
      downgrade['excessCredits'] ?? 'retain_until_expiry',
    ) as PlanDetail['excessCredits'],
    sortOrder: Number(p['sortOrder'] ?? 0),
  };
}

/**
 * `null` survives; anything unparseable becomes `null` too.
 *
 * Both mean "no limit stated". Coercing a bad value to 0 would silently lock a
 * customer out of a dimension the owner never restricted.
 */
function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
