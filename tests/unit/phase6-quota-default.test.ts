import { describe, expect, it } from 'vitest';
import {
  resolveEntitlement,
  type EntitlementCatalogue,
  type WorkspaceEntitlementContext,
} from '@brandspace/entitlements';

/**
 * PHASE 6 · P6-03b — A QUOTA WITH NO DECLARED CEILING IS NOT A CEILING OF ZERO.
 *
 * The staging blocker: a newly created workspace, on an environment with no
 * configured customer plans, could not create its FIRST brand. It was told
 * "This workspace has reached a limit on its plan" — a workspace with no plan,
 * no limit reached and nothing it could free.
 *
 * The chain (docs/CURRENT-EXECUTION-PHASE-6.md §4.3): onboarding leaves
 * `planKey` null when no trial plan is configured, so `limit.brands` falls past
 * the plan rung to the FEATURE DEFAULT, where the bootstrap projection declares
 * `{ valueType: 'quota', defaultValue: null }`. Step 9 then applied a BOOLEAN
 * feature's rule — `enabled = defaultValue === true` — to a QUOTA feature, and
 * `EntitlementService.limit()` turned that `enabled: false` into `0`.
 *
 * That is the exact collapse `limit()`'s own comment forbids: "`null` is
 * unlimited and `0` is none, and a caller that collapses the two locks out
 * exactly the customers who paid for no limit". The engine was doing it to
 * itself.
 *
 * WHAT THIS FILE PINS, and what it deliberately does NOT:
 *
 *   - a quota whose default is ABSENT states no ceiling, so it resolves as no
 *     ceiling — `enabled`, `limitValue: null`;
 *   - a quota whose default is a NUMBER still states that ceiling;
 *   - a quota an owner explicitly turned OFF (`defaultValue: false`) is still
 *     off, because that is a stated decision rather than an absent one;
 *   - a BOOLEAN feature is untouched: no plan still means no feature;
 *   - an UNKNOWN key still fails closed, so a typo can never grant anything.
 *
 * NO ALLOWANCE IS HARD-CODED BY ANY OF THIS. The ceiling is still whatever
 * configuration states — a plan entitlement, a workspace override, or a declared
 * feature default. What changed is only what the engine does when configuration
 * states nothing at all.
 */

const NOW = new Date('2026-06-15T12:00:00.000Z');
const WORKSPACE = '11111111-2222-4333-8444-555555555555';

/**
 * The catalogue as the bootstrap projection actually ships it.
 *
 * `limit.brands` with `defaultValue: null` is copied from
 * `QUOTA_FEATURE_DEFINITIONS` in packages/entitlements/src/service.ts, not
 * invented for the test — the point of the case is the value the product really
 * carries.
 */
function catalogue(overrides: Partial<EntitlementCatalogue> = {}): EntitlementCatalogue {
  return {
    features: [
      {
        key: 'limit.brands',
        valueType: 'quota',
        defaultValue: null,
        dependsOn: [],
        enumOptions: [],
      },
      {
        key: 'limit.seats',
        valueType: 'quota',
        defaultValue: 3,
        dependsOn: [],
        enumOptions: [],
      },
      {
        key: 'limit.storage_gb',
        valueType: 'quota',
        defaultValue: false,
        dependsOn: [],
        enumOptions: [],
      },
      {
        key: 'ai.copilot',
        valueType: 'boolean',
        defaultValue: false,
        dependsOn: [],
        enumOptions: [],
      },
      ...(overrides.features ?? []),
    ],
    planEntitlements: overrides.planEntitlements ?? [],
    flags: overrides.flags ?? [],
  };
}

/** A workspace on NO PLAN — which is the whole case. */
function noPlan(overrides: Partial<WorkspaceEntitlementContext> = {}): WorkspaceEntitlementContext {
  return {
    workspaceId: WORKSPACE,
    planKey: null,
    country: 'SA',
    betaGroups: [],
    overrides: [],
    ...overrides,
  };
}

describe('P6-03b · a quota with no declared default states no ceiling', () => {
  it('resolves limit.brands as enabled with no ceiling, not as disabled', () => {
    const result = resolveEntitlement(catalogue(), noPlan(), 'limit.brands', NOW);

    // THE REGRESSION. Before the fix this was `enabled: false`, which
    // `EntitlementService.limit()` turned into 0 — and 0 brands is a workspace
    // that can never be used.
    expect(result.enabled).toBe(true);
    expect(result.limitValue).toBeNull();
    expect(result.source).toBe('feature_default');
  });

  it('says so in the trace, so an operator reading it is not guessing', () => {
    const result = resolveEntitlement(catalogue(), noPlan(), 'limit.brands', NOW);
    const step = result.trace.find((t) => t.source === 'feature_default');
    expect(step?.detail).toMatch(/no ceiling/i);
  });

  it('still honours a numeric default as the ceiling it states', () => {
    const result = resolveEntitlement(catalogue(), noPlan(), 'limit.seats', NOW);
    expect(result.enabled).toBe(true);
    expect(result.limitValue).toBe(3);
  });

  it('still honours an explicit false — a stated "none" is not an absent default', () => {
    // The distinction the fix turns on: an owner who declared the dimension OFF
    // decided something. An absent default decided nothing.
    const result = resolveEntitlement(catalogue(), noPlan(), 'limit.storage_gb', NOW);
    expect(result.enabled).toBe(false);
  });
});

describe('P6-03b · the rungs above the default are untouched', () => {
  it('a plan stating brands = 0 still refuses', () => {
    const result = resolveEntitlement(
      catalogue({
        planEntitlements: [
          {
            planKey: 'starter',
            featureKey: 'limit.brands',
            enabled: true,
            limitValue: 0,
            limitPeriod: 'total',
            enumValue: null,
          },
        ],
      }),
      noPlan({ planKey: 'starter' }),
      'limit.brands',
      NOW,
    );
    expect(result.source).toBe('plan_entitlement');
    expect(result.limitValue).toBe(0);
  });

  it('a plan stating brands = 1 grants exactly one', () => {
    const result = resolveEntitlement(
      catalogue({
        planEntitlements: [
          {
            planKey: 'starter',
            featureKey: 'limit.brands',
            enabled: true,
            limitValue: 1,
            limitPeriod: 'total',
            enumValue: null,
          },
        ],
      }),
      noPlan({ planKey: 'starter' }),
      'limit.brands',
      NOW,
    );
    expect(result.source).toBe('plan_entitlement');
    expect(result.limitValue).toBe(1);
  });

  it('a workspace override still outranks the default', () => {
    const result = resolveEntitlement(
      catalogue(),
      noPlan({
        overrides: [
          {
            featureKey: 'limit.brands',
            enabled: true,
            limitValue: 5,
            enumValue: null,
            reason: 'negotiated',
            effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
            effectiveUntil: null,
          },
        ],
      }),
      'limit.brands',
      NOW,
    );
    expect(result.source).toBe('workspace_override');
    expect(result.limitValue).toBe(5);
  });

  it('a kill switch still beats the default', () => {
    const result = resolveEntitlement(
      catalogue({
        flags: [
          {
            featureKey: 'limit.brands',
            killSwitch: true,
            globalEnabled: null,
            enabledForWorkspaces: [],
            disabledForWorkspaces: [],
            enabledForPlans: [],
            betaGroups: [],
            countries: [],
            activeFrom: null,
            activeUntil: null,
            percentageRollout: null,
          },
        ],
      }),
      noPlan(),
      'limit.brands',
      NOW,
    );
    expect(result.enabled).toBe(false);
    expect(result.source).toBe('kill_switch');
  });
});

describe('P6-03b · only a workspace that NEVER had a plan reaches the new reading', () => {
  it('a workspace whose subscription ENDED still gets none, not unlimited', () => {
    // `contextFor` stops resolving the plan for a CANCELLED or EXPIRED
    // subscription precisely so its quota dimensions become none. Handing that
    // workspace an unstated-and-therefore-absent ceiling would make cancelling
    // a subscription an UPGRADE, which is the one outcome this rung must never
    // produce.
    const result = resolveEntitlement(
      catalogue(),
      noPlan({ planEnded: true }),
      'limit.brands',
      NOW,
    );
    expect(result.enabled).toBe(false);
    expect(result.source).toBe('feature_default');
  });

  it('a workspace ON a plan that does not mention the dimension still gets none', () => {
    // The distinction that makes a plan writing `limitValue: null` mean
    // "negotiated, unlimited" rather than "not mentioned". A plan is a
    // statement; a dimension it omits was not granted.
    const result = resolveEntitlement(
      catalogue({
        planEntitlements: [
          {
            planKey: 'starter',
            featureKey: 'limit.seats',
            enabled: true,
            limitValue: 2,
            limitPeriod: 'total',
            enumValue: null,
          },
        ],
      }),
      noPlan({ planKey: 'starter' }),
      'limit.brands',
      NOW,
    );
    expect(result.enabled).toBe(false);
    expect(result.source).toBe('feature_default');
  });
});

describe('P6-03b · nothing else is loosened', () => {
  it('an unknown feature key still fails closed', () => {
    // The typo guard. It is a DIFFERENT rung from the feature default, and the
    // fix must not have reached it: a key that is in no configuration at all
    // grants nothing, however permissive the default rung became.
    const result = resolveEntitlement(catalogue(), noPlan(), 'limit.not_a_real_quota', NOW);
    expect(result.enabled).toBe(false);
    expect(result.limitValue).toBeNull();
    expect(result.source).toBe('unknown_feature');
  });

  it('a boolean feature on no plan is still off', () => {
    // "A workspace on no plan gets nothing" remains true of CAPABILITIES. What
    // changed is only what an unstated CEILING means.
    const result = resolveEntitlement(catalogue(), noPlan(), 'ai.copilot', NOW);
    expect(result.enabled).toBe(false);
  });
});
