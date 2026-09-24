/**
 * USAGE AGAINST WHAT THE PLAN STATES (P6-13) — never against an invented number.
 *
 * The Plan screen showed usage with no ceiling beside it, and brands and social
 * accounts not at all, although both are enforced quotas. This reads the
 * ceiling from the SAME resolved entitlement decision the quota consults, so
 * the screen and the refusal cannot disagree:
 *
 *   - a numeric `limitValue` on an enabled decision is the ceiling;
 *   - an enabled decision with no `limitValue` states NO ceiling (D-259) — shown
 *     as such, never as a made-up allowance;
 *   - a disabled decision is a ceiling of zero, which is exactly what
 *     `EntitlementService.limit()` enforces.
 *
 * PURE — the unit suite imports it.
 */
export interface EntitlementDecisionView {
  readonly featureKey: string;
  readonly enabled: boolean;
  readonly limitValue: number | null;
}

export type UsageCeiling =
  { readonly kind: 'limited'; readonly limit: number } | { readonly kind: 'unstated' };

export function ceilingFor(
  decisions: readonly EntitlementDecisionView[],
  featureKey: string,
): UsageCeiling {
  const decision = decisions.find((entry) => entry.featureKey === featureKey);
  if (!decision) return { kind: 'unstated' };
  if (!decision.enabled) return { kind: 'limited', limit: 0 };
  return decision.limitValue === null
    ? { kind: 'unstated' }
    : { kind: 'limited', limit: decision.limitValue };
}

/** A catalogue plan's name in the reader's language — or its key if the catalogue lacks it. */
export function planDisplayName(
  planKey: string | null,
  plans: readonly { readonly key: string; readonly nameEn: string; readonly nameAr: string }[],
  locale: string,
): string | null {
  if (!planKey) return null;
  const plan = plans.find((entry) => entry.key === planKey);
  if (!plan) return planKey;
  return locale === 'ar' ? plan.nameAr : plan.nameEn;
}
