/**
 * WHO GETS A FEATURE — the Simple reading of the existing entitlement engine
 * (D-314).
 *
 * The engine's precedence is unchanged (docs/ADMIN-CONTROL-CENTER.md §5.3):
 * kill switch, workspace override, the flag's workspace / plan / cohort /
 * country / date / percentage rules, then the flag's own global on/off, then
 * the plan grant, then the default. Simple mode exposes exactly the three
 * answers those levers can give WITHOUT per-customer targeting:
 *
 *   everyone  — the flag's `globalEnabled: true`
 *   nobody    — the flag's `globalEnabled: false`
 *   plans     — no global setting, so each plan's grant decides
 *
 * and it offers them ONLY for a boolean feature whose flag carries none of the
 * advanced rules. A feature with a kill switch or custom targeting is shown as
 * such and changed in Advanced: rewriting it from a three-way switch would
 * silently discard targeting somebody set on purpose. Quota and enum features
 * are set per plan — "on for everyone" on a quota feature would read the
 * limit of whichever plan the customer has, including none, so it is not
 * offered at all.
 *
 * Customer-specific exceptions (workspace overrides) still apply on top of
 * any of the three, and the screen says how many there are.
 */

export interface FlagShape {
  readonly featureKey: string;
  readonly killSwitch: boolean;
  readonly globalEnabled: boolean | null;
  readonly enabledForPlans: readonly string[];
  readonly enabledForWorkspaces: readonly string[];
  readonly disabledForWorkspaces: readonly string[];
  readonly betaGroups: readonly string[];
  readonly countries: readonly string[];
  readonly activeFrom: string | null;
  readonly activeUntil: string | null;
  readonly percentageRollout: number | null;
}

export interface GrantShape {
  readonly planKey: string;
  readonly featureKey: string;
  readonly enabled: boolean;
  readonly limitValue: number | null;
  readonly limitPeriod: 'day' | 'month' | 'billing_cycle' | 'total' | null;
  readonly enumValue: string | null;
}

export type FeatureAccess =
  | { readonly kind: 'not_boolean' }
  | { readonly kind: 'kill_switch' }
  | { readonly kind: 'custom' }
  | { readonly kind: 'everyone' }
  | { readonly kind: 'nobody' }
  | { readonly kind: 'plans'; readonly plans: readonly string[] };

export type SimpleChoice = 'everyone' | 'plans' | 'nobody';

export function hasAdvancedTargeting(flag: FlagShape): boolean {
  return (
    flag.enabledForPlans.length > 0 ||
    flag.enabledForWorkspaces.length > 0 ||
    flag.disabledForWorkspaces.length > 0 ||
    flag.betaGroups.length > 0 ||
    flag.countries.length > 0 ||
    flag.activeFrom !== null ||
    flag.activeUntil !== null ||
    flag.percentageRollout !== null
  );
}

export function featureAccess(input: {
  readonly valueType: string;
  /** The feature's default — what a plan with no grant row resolves to. */
  readonly defaultValue: unknown;
  readonly flag: FlagShape | null;
  /** THIS feature's grant rows. */
  readonly grants: readonly GrantShape[];
  /** The plans that exist, in display order. */
  readonly planKeys: readonly string[];
}): FeatureAccess {
  if (input.valueType !== 'boolean') return { kind: 'not_boolean' };
  const flag = input.flag;
  if (flag?.killSwitch) return { kind: 'kill_switch' };
  if (flag && hasAdvancedTargeting(flag)) return { kind: 'custom' };
  if (flag?.globalEnabled === true) return { kind: 'everyone' };
  if (flag?.globalEnabled === false) return { kind: 'nobody' };
  return {
    kind: 'plans',
    plans: input.planKeys.filter((planKey) => {
      const grant = input.grants.find((row) => row.planKey === planKey);
      // No grant row: the engine falls through to the feature default.
      return grant ? grant.enabled : input.defaultValue === true;
    }),
  };
}

/** Whether Simple mode may change this feature at all. */
export function simpleEditable(access: FeatureAccess): boolean {
  return access.kind === 'everyone' || access.kind === 'nobody' || access.kind === 'plans';
}

/** The flag document with this feature's global setting replaced. */
export function withGlobal<T extends { flags: readonly FlagShape[] }>(
  document: T,
  featureKey: string,
  globalEnabled: boolean | null,
): T {
  const existing = document.flags.find((flag) => flag.featureKey === featureKey);
  if (!existing && globalEnabled === null) return document;
  const next: FlagShape = existing
    ? { ...existing, globalEnabled }
    : {
        featureKey,
        killSwitch: false,
        globalEnabled,
        enabledForPlans: [],
        enabledForWorkspaces: [],
        disabledForWorkspaces: [],
        betaGroups: [],
        countries: [],
        activeFrom: null,
        activeUntil: null,
        percentageRollout: null,
      };
  return {
    ...document,
    flags: existing
      ? document.flags.map((flag) => (flag.featureKey === featureKey ? next : flag))
      : [...document.flags, next],
  };
}

/**
 * The entitlement document with this feature granted to exactly `selected`
 * among `planKeys`. An existing grant keeps its limit, period and option; only
 * `enabled` changes. A plan with no grant row resolves to the feature's
 * default, so a row is added only when the wanted answer differs from that
 * default — adding rows nobody needs is noise in the history.
 */
export function withPlanGrants<T extends { planEntitlements: readonly GrantShape[] }>(
  document: T,
  featureKey: string,
  planKeys: readonly string[],
  selected: readonly string[],
  defaultValue: unknown,
): T {
  const rows = [...document.planEntitlements];
  for (const planKey of planKeys) {
    const enabled = selected.includes(planKey);
    const index = rows.findIndex((row) => row.planKey === planKey && row.featureKey === featureKey);
    if (index >= 0) {
      rows[index] = { ...(rows[index] as GrantShape), enabled };
    } else if (enabled !== (defaultValue === true)) {
      rows.push({
        planKey,
        featureKey,
        enabled,
        limitValue: null,
        limitPeriod: null,
        enumValue: null,
      });
    }
  }
  return { ...document, planEntitlements: rows };
}
