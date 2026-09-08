import { createHash } from 'node:crypto';

/**
 * The entitlement precedence engine — docs/ADMIN-CONTROL-CENTER.md §5.3.
 *
 * Pure. No database, no clock of its own, no configuration loading: it takes a
 * fully-materialised decision context and returns a decision plus the trace of
 * how it got there. That makes every rule directly testable, and makes the
 * "why is this feature on?" answer in the Control Center the SAME code path
 * that decides — not a second implementation that can drift.
 *
 * PRECEDENCE, highest wins. The first rule that produces a decision stops the
 * evaluation:
 *
 *   1. Kill switch                 -> OFF for everyone, immediately
 *   2. Workspace override          (explicit, unexpired)
 *   3. Explicit workspace allow/deny on a flag rule
 *   4. Beta group membership
 *   5. Country rule
 *   6. Date-range rule
 *   7. Percentage rollout          (stable hash of feature + workspace)
 *   8. Plan entitlement
 *   9. Feature default
 *
 * THE KILL SWITCH IS FIRST AND UNCONDITIONAL. An override cannot outrank it:
 * containment during an incident must not depend on nobody having granted an
 * exception (docs/SECURITY.md §14.4).
 */

export type EntitlementSource =
  | 'kill_switch'
  | 'workspace_override'
  | 'flag_workspace_list'
  | 'flag_plan_list'
  | 'flag_beta_group'
  | 'flag_country'
  | 'flag_date_range'
  | 'flag_percentage'
  | 'plan_entitlement'
  | 'feature_default'
  | 'dependency_unmet'
  | 'unknown_feature';

export interface FeatureDefinition {
  readonly key: string;
  readonly valueType: 'boolean' | 'quota' | 'enum';
  readonly defaultValue: boolean | number | string | null;
  readonly dependsOn: readonly string[];
  /**
   * The options an `enum` feature offers (A-4). Empty for every other type.
   *
   * Without it there is nothing to validate an override against, so a typo in
   * an option name would be written and would silently resolve.
   */
  readonly enumOptions: readonly string[];
}

export interface PlanEntitlementRule {
  readonly planKey: string;
  readonly featureKey: string;
  readonly enabled: boolean;
  readonly limitValue: number | null;
  readonly limitPeriod: string | null;
  /**
   * The chosen option for an `enum` feature — A-4.
   *
   * `valueType: 'enum'` existed and nothing could ever resolve one: the
   * decision carried `enabled` and `limitValue` only, so "which video quality
   * does this plan get" had nowhere to live and every enum feature resolved to
   * false. Null for features that are not enums.
   */
  readonly enumValue: string | null;
}

export interface FlagRule {
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

export interface WorkspaceOverrideRule {
  readonly featureKey: string;
  readonly enabled: boolean;
  readonly limitValue: number | null;
  /** The chosen option for an `enum` feature (A-4). Null otherwise. */
  readonly enumValue: string | null;
  readonly reason: string;
  readonly effectiveFrom: Date;
  readonly effectiveUntil: Date | null;
}

/** Everything the engine needs about one workspace, materialised by the caller. */
export interface WorkspaceEntitlementContext {
  readonly workspaceId: string;
  readonly planKey: string | null;
  readonly country: string;
  readonly betaGroups: readonly string[];
  readonly overrides: readonly WorkspaceOverrideRule[];
}

export interface EntitlementCatalogue {
  readonly features: readonly FeatureDefinition[];
  readonly planEntitlements: readonly PlanEntitlementRule[];
  readonly flags: readonly FlagRule[];
}

/** One step the engine considered, in evaluation order. */
export interface TraceStep {
  readonly source: EntitlementSource;
  readonly decided: boolean;
  readonly detail: string;
}

export interface EntitlementDecision {
  readonly featureKey: string;
  readonly enabled: boolean;
  /** null = unlimited, or not a quota feature. */
  readonly limitValue: number | null;
  /**
   * The resolved option for an `enum` feature, or null (A-4).
   *
   * Separate from `limitValue` because they answer different questions: a
   * quota asks "how many", an enum asks "which one", and collapsing them into
   * one nullable number is what left enum features unresolvable.
   */
  readonly enumValue: string | null;
  readonly source: EntitlementSource;
  readonly trace: readonly TraceStep[];
}

/**
 * Stable percentage bucket for (feature, workspace).
 *
 * Deterministic, so a workspace does not flip between page loads — the property
 * docs/ADMIN-CONTROL-CENTER.md §5.2 calls out explicitly. Hashing both keys
 * means two features at 50% do not select the same half of the customer base.
 */
export function rolloutBucket(featureKey: string, workspaceId: string): number {
  const digest = createHash('sha256').update(`${featureKey}:${workspaceId}`).digest();
  return digest.readUInt32BE(0) % 100;
}

/**
 * Resolve one feature for one workspace.
 *
 * `now` is injected rather than read, so date-range rules are testable without
 * waiting for a calendar.
 */
export function resolveEntitlement(
  catalogue: EntitlementCatalogue,
  context: WorkspaceEntitlementContext,
  featureKey: string,
  now: Date,
): EntitlementDecision {
  return resolveWithDependencies(catalogue, context, featureKey, now, new Set());
}

/**
 * Resolve, then re-check what the feature depends on — A-4.
 *
 * DEPENDENCIES WERE ONLY EVER CHECKED WHEN AN OVERRIDE WAS WRITTEN.
 * `validateOverride` refuses to enable a feature whose dependency is off, and
 * that is the only place the graph was consulted. Configuration is not static:
 * the dependency can be turned off afterwards by a kill switch, a plan change,
 * a flag edit or an override of its own — and the dependent feature carried on
 * resolving to enabled, because nothing looked again.
 *
 * A validation-time check answers "may I write this row"; only a resolve-time
 * check answers "is this true now". So the graph is walked on every resolve,
 * and a dependent whose dependency is off is forced off whatever granted it.
 *
 * CYCLES TERMINATE. `visiting` carries the chain currently being resolved; a
 * feature that reappears in it is treated as unmet rather than followed. A
 * cyclic dependency is a configuration mistake, and failing closed is the same
 * choice the unknown-feature branch makes.
 */
function resolveWithDependencies(
  catalogue: EntitlementCatalogue,
  context: WorkspaceEntitlementContext,
  featureKey: string,
  now: Date,
  visiting: ReadonlySet<string>,
): EntitlementDecision {
  const decision = resolveOwnRules(catalogue, context, featureKey, now);
  if (!decision.enabled) return decision;

  const feature = catalogue.features.find((f) => f.key === featureKey);
  if (!feature || feature.dependsOn.length === 0) return decision;

  const chain = new Set(visiting).add(featureKey);
  for (const dependency of feature.dependsOn) {
    const unmet = chain.has(dependency)
      ? `"${featureKey}" and "${dependency}" depend on each other.`
      : resolveWithDependencies(catalogue, context, dependency, now, chain).enabled
        ? null
        : `"${dependency}" is off.`;
    if (unmet === null) continue;

    return {
      featureKey,
      enabled: false,
      limitValue: null,
      enumValue: null,
      source: 'dependency_unmet',
      trace: [
        ...decision.trace,
        {
          source: 'dependency_unmet',
          decided: true,
          // The trace keeps the grant that WOULD have applied, so an operator
          // reading it sees both what granted the feature and why it is
          // nonetheless off.
          detail: `Granted by ${decision.source}, but ${unmet}`,
        },
      ],
    };
  }

  return decision;
}

/** The precedence ladder itself, without the dependency re-check above it. */
function resolveOwnRules(
  catalogue: EntitlementCatalogue,
  context: WorkspaceEntitlementContext,
  featureKey: string,
  now: Date,
): EntitlementDecision {
  const trace: TraceStep[] = [];
  const feature = catalogue.features.find((f) => f.key === featureKey);

  if (!feature) {
    // An unknown feature is OFF. Failing closed matters more than being
    // forgiving: a typo in a feature key must not silently grant access.
    trace.push({
      source: 'unknown_feature',
      decided: true,
      detail: `Feature "${featureKey}" is not in the active entitlements configuration.`,
    });
    return {
      featureKey,
      enabled: false,
      limitValue: null,
      enumValue: null,
      source: 'unknown_feature',
      trace,
    };
  }

  const flag = catalogue.flags.find((f) => f.featureKey === featureKey);

  // 1. Kill switch — unconditional, first, and beats every grant below.
  if (flag?.killSwitch) {
    trace.push({
      source: 'kill_switch',
      decided: true,
      detail: 'Kill switch is engaged: the feature is off for everyone.',
    });
    return {
      featureKey,
      enabled: false,
      limitValue: null,
      enumValue: null,
      source: 'kill_switch',
      trace,
    };
  }
  trace.push({
    source: 'kill_switch',
    decided: false,
    detail: flag ? 'no kill switch' : 'no flag rule',
  });

  // 2. Workspace override — explicit, unexpired.
  const override = context.overrides.find(
    (o) =>
      o.featureKey === featureKey &&
      o.effectiveFrom <= now &&
      (o.effectiveUntil === null || o.effectiveUntil > now),
  );
  if (override) {
    trace.push({
      source: 'workspace_override',
      decided: true,
      detail: `Workspace override: ${override.enabled ? 'enabled' : 'disabled'} — ${override.reason}`,
    });
    return {
      featureKey,
      enabled: override.enabled,
      limitValue: override.limitValue,
      enumValue: override.enumValue,
      source: 'workspace_override',
      trace,
    };
  }
  trace.push({ source: 'workspace_override', decided: false, detail: 'none active' });

  if (flag) {
    // 3. Explicit workspace allow/deny. Deny is checked first: an address on
    //    both lists is denied, because the safer reading of a contradiction is
    //    the restrictive one.
    if (flag.disabledForWorkspaces.includes(context.workspaceId)) {
      trace.push({
        source: 'flag_workspace_list',
        decided: true,
        detail: 'Workspace is on the flag deny list.',
      });
      return {
        featureKey,
        enabled: false,
        limitValue: null,
        enumValue: null,
        source: 'flag_workspace_list',
        trace,
      };
    }
    if (flag.enabledForWorkspaces.includes(context.workspaceId)) {
      trace.push({
        source: 'flag_workspace_list',
        decided: true,
        detail: 'Workspace is on the flag allow list.',
      });
      return {
        featureKey,
        enabled: true,
        limitValue: planLimit(catalogue, context.planKey, featureKey),
        enumValue: planEnum(catalogue, context.planKey, featureKey),
        source: 'flag_workspace_list',
        trace,
      };
    }
    trace.push({ source: 'flag_workspace_list', decided: false, detail: 'not listed' });

    /*
     * 3b. PLAN TARGETING — A-4.
     *
     * `enabledForPlans` was declared on `FlagRule`, carried through the
     * configuration schema and the Control Center, and READ BY NOTHING. An
     * operator could switch a feature on for the Growth plan, see it saved,
     * and have it change no customer's experience at all — configuration that
     * looks live and is inert, which is worse than a missing field because
     * nothing signals the gap.
     *
     * An ALLOW LIST, like `enabledForWorkspaces` above and unlike `countries`
     * below: a match grants, a non-match falls through to the plan entitlement
     * rather than deciding against it. A flag naming one plan must not take
     * the feature away from every plan it does not name — that would make
     * targeting one audience an outage for the others.
     */
    if (flag.enabledForPlans.length > 0 && context.planKey !== null) {
      if (flag.enabledForPlans.includes(context.planKey)) {
        trace.push({
          source: 'flag_plan_list',
          decided: true,
          detail: `Plan "${context.planKey}" is on the flag's plan list.`,
        });
        return {
          featureKey,
          enabled: true,
          limitValue: planLimit(catalogue, context.planKey, featureKey),
          enumValue: planEnum(catalogue, context.planKey, featureKey),
          source: 'flag_plan_list',
          trace,
        };
      }
    }
    trace.push({ source: 'flag_plan_list', decided: false, detail: 'plan not listed' });

    // 4. Beta group.
    const matchedGroup = flag.betaGroups.find((g) => context.betaGroups.includes(g));
    if (matchedGroup) {
      trace.push({
        source: 'flag_beta_group',
        decided: true,
        detail: `Workspace is in beta group "${matchedGroup}".`,
      });
      return {
        featureKey,
        enabled: true,
        limitValue: planLimit(catalogue, context.planKey, featureKey),
        enumValue: planEnum(catalogue, context.planKey, featureKey),
        source: 'flag_beta_group',
        trace,
      };
    }
    trace.push({ source: 'flag_beta_group', decided: false, detail: 'no group match' });

    // 5. Country.
    if (flag.countries.length > 0) {
      const matches = flag.countries.includes(context.country.toUpperCase());
      trace.push({
        source: 'flag_country',
        decided: true,
        detail: `Country rule ${matches ? 'matched' : 'did not match'} ${context.country}.`,
      });
      return {
        featureKey,
        enabled: matches,
        limitValue: matches ? planLimit(catalogue, context.planKey, featureKey) : null,
        enumValue: matches ? planEnum(catalogue, context.planKey, featureKey) : null,
        source: 'flag_country',
        trace,
      };
    }
    trace.push({ source: 'flag_country', decided: false, detail: 'no country rule' });

    // 6. Date range.
    if (flag.activeFrom !== null || flag.activeUntil !== null) {
      const from = flag.activeFrom ? new Date(flag.activeFrom) : null;
      const until = flag.activeUntil ? new Date(flag.activeUntil) : null;
      const inWindow = (from === null || from <= now) && (until === null || until > now);
      trace.push({
        source: 'flag_date_range',
        decided: true,
        detail: `Date rule: ${inWindow ? 'inside' : 'outside'} the active window.`,
      });
      return {
        featureKey,
        enabled: inWindow,
        limitValue: inWindow ? planLimit(catalogue, context.planKey, featureKey) : null,
        enumValue: inWindow ? planEnum(catalogue, context.planKey, featureKey) : null,
        source: 'flag_date_range',
        trace,
      };
    }
    trace.push({ source: 'flag_date_range', decided: false, detail: 'no date rule' });

    // 7. Percentage rollout.
    if (flag.percentageRollout !== null) {
      const bucket = rolloutBucket(featureKey, context.workspaceId);
      const included = bucket < flag.percentageRollout;
      trace.push({
        source: 'flag_percentage',
        decided: true,
        detail: `Rollout ${flag.percentageRollout}%: bucket ${bucket} is ${included ? 'in' : 'out'}.`,
      });
      return {
        featureKey,
        enabled: included,
        limitValue: included ? planLimit(catalogue, context.planKey, featureKey) : null,
        enumValue: included ? planEnum(catalogue, context.planKey, featureKey) : null,
        source: 'flag_percentage',
        trace,
      };
    }
    trace.push({ source: 'flag_percentage', decided: false, detail: 'no rollout rule' });

    // A global on/off is the flag's own fallback, applied before the plan.
    if (flag.globalEnabled !== null) {
      trace.push({
        source: 'flag_workspace_list',
        decided: true,
        detail: `Flag global setting: ${flag.globalEnabled ? 'on' : 'off'}.`,
      });
      return {
        featureKey,
        enabled: flag.globalEnabled,
        limitValue: flag.globalEnabled ? planLimit(catalogue, context.planKey, featureKey) : null,
        enumValue: flag.globalEnabled ? planEnum(catalogue, context.planKey, featureKey) : null,
        source: 'flag_workspace_list',
        trace,
      };
    }
  }

  // 8. Plan entitlement.
  if (context.planKey) {
    const entitlement = catalogue.planEntitlements.find(
      (p) => p.planKey === context.planKey && p.featureKey === featureKey,
    );
    if (entitlement) {
      trace.push({
        source: 'plan_entitlement',
        decided: true,
        detail:
          `Plan "${context.planKey}": ${entitlement.enabled ? 'enabled' : 'disabled'}` +
          (entitlement.limitValue !== null ? `, limit ${entitlement.limitValue}` : ''),
      });
      return {
        featureKey,
        enabled: entitlement.enabled,
        limitValue: entitlement.limitValue,
        enumValue: entitlement.enumValue,
        source: 'plan_entitlement',
        trace,
      };
    }
  }
  trace.push({
    source: 'plan_entitlement',
    decided: false,
    detail: context.planKey ? `plan "${context.planKey}" does not mention it` : 'no plan assigned',
  });

  // 9. Feature default.
  const limitValue = typeof feature.defaultValue === 'number' ? feature.defaultValue : null;
  /*
   * An ENUM's default is the option it takes when nothing else decides, and a
   * feature that HAS an option is on. Reading `defaultValue === true` alone —
   * which is all this used to do — made every enum feature resolve to false
   * and its value unreachable, whatever the configuration said.
   */
  const enumValue =
    feature.valueType === 'enum' && typeof feature.defaultValue === 'string'
      ? feature.defaultValue
      : null;
  const enabled = feature.defaultValue === true;
  trace.push({
    source: 'feature_default',
    decided: true,
    detail: `Feature default: ${JSON.stringify(feature.defaultValue)}`,
  });
  return {
    featureKey,
    enabled: enabled || limitValue !== null || enumValue !== null,
    limitValue,
    enumValue,
    source: 'feature_default',
    trace,
  };
}

/** The enum option a plan grants for a feature, or null. */
function planEnum(
  catalogue: EntitlementCatalogue,
  planKey: string | null,
  featureKey: string,
): string | null {
  if (!planKey) return null;
  const entitlement = catalogue.planEntitlements.find(
    (p) => p.planKey === planKey && p.featureKey === featureKey,
  );
  return entitlement?.enumValue ?? null;
}

function planLimit(
  catalogue: EntitlementCatalogue,
  planKey: string | null,
  featureKey: string,
): number | null {
  if (!planKey) return null;
  const entitlement = catalogue.planEntitlements.find(
    (p) => p.planKey === planKey && p.featureKey === featureKey,
  );
  return entitlement?.limitValue ?? null;
}

/**
 * Validate a proposed override before it is written.
 *
 * Returns the reason it is invalid, or null. Two rules from
 * docs/ADMIN-CONTROL-CENTER.md §5.4:
 *
 *   - a feature that does not exist cannot be overridden;
 *   - enabling a feature whose dependency is off is rejected at validation
 *     time, not discovered at runtime.
 */
export function validateOverride(
  catalogue: EntitlementCatalogue,
  context: WorkspaceEntitlementContext,
  featureKey: string,
  enabled: boolean,
  limitValue: number | null,
  now: Date,
  enumValue: string | null = null,
): string | null {
  const feature = catalogue.features.find((f) => f.key === featureKey);
  if (!feature) return `Unknown feature "${featureKey}".`;

  if (feature.valueType === 'quota' && limitValue !== null && limitValue < 0) {
    return 'A quota limit cannot be negative.';
  }
  if (feature.valueType === 'boolean' && limitValue !== null) {
    return `"${featureKey}" is a boolean feature and takes no limit.`;
  }

  /*
   * ENUM VALIDATION — A-4. An enum override that names no option resolves to
   * nothing useful, and one that names an option the feature does not offer is
   * a typo that would silently take effect.
   */
  if (feature.valueType === 'enum') {
    if (enabled && (enumValue === null || enumValue.trim() === '')) {
      return `"${featureKey}" is an enum feature and needs a chosen option.`;
    }
    if (enumValue !== null && !feature.enumOptions.includes(enumValue)) {
      return `"${enumValue}" is not one of the options "${featureKey}" offers.`;
    }
  } else if (enumValue !== null) {
    return `"${featureKey}" is not an enum feature and takes no option.`;
  }

  if (enabled) {
    for (const dependency of feature.dependsOn) {
      const resolved = resolveEntitlement(catalogue, context, dependency, now);
      if (!resolved.enabled) {
        return `"${featureKey}" depends on "${dependency}", which is currently off.`;
      }
    }
    // A kill switch cannot be overridden. Saying so at validation time is
    // clearer than silently writing a row that the engine will ignore.
    const flag = catalogue.flags.find((f) => f.featureKey === featureKey);
    if (flag?.killSwitch) {
      return `"${featureKey}" is disabled by a global kill switch; an override cannot re-enable it.`;
    }
  }

  return null;
}
