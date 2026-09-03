import { describe, expect, it } from 'vitest';
import {
  resolveEntitlement,
  rolloutBucket,
  validateOverride,
  type EntitlementCatalogue,
  type WorkspaceEntitlementContext,
} from '@brandspace/entitlements';

/**
 * The entitlement precedence engine — docs/ADMIN-CONTROL-CENTER.md §5.3.
 *
 * Pure, so every rule is testable without a database or a calendar. The order
 * matters more than any individual rule: a kill switch that an override can
 * outrank is not a kill switch, and a rollout that is not stable makes a
 * feature flicker between page loads.
 */

const NOW = new Date('2026-06-15T12:00:00.000Z');
const WORKSPACE = '11111111-2222-4333-8444-555555555555';

function catalogue(overrides: Partial<EntitlementCatalogue> = {}): EntitlementCatalogue {
  return {
    features: [
      { key: 'ai.generation', valueType: 'boolean', defaultValue: false, dependsOn: [] },
      {
        key: 'ai.image_generation',
        valueType: 'boolean',
        defaultValue: false,
        dependsOn: ['ai.generation'],
      },
      { key: 'seats', valueType: 'quota', defaultValue: 1, dependsOn: [] },
      ...(overrides.features ?? []),
    ],
    planEntitlements: overrides.planEntitlements ?? [],
    flags: overrides.flags ?? [],
  };
}

function context(
  overrides: Partial<WorkspaceEntitlementContext> = {},
): WorkspaceEntitlementContext {
  return {
    workspaceId: WORKSPACE,
    planKey: null,
    country: 'SA',
    betaGroups: [],
    overrides: [],
    ...overrides,
  };
}

describe('an unknown feature fails closed', () => {
  it('is disabled, with the reason named', () => {
    const result = resolveEntitlement(catalogue(), context(), 'nope.typo', NOW);
    expect(result.enabled).toBe(false);
    expect(result.source).toBe('unknown_feature');
  });
});

describe('1. the kill switch outranks everything', () => {
  it('beats a workspace override that says enabled', () => {
    const result = resolveEntitlement(
      catalogue({ flags: [flag('ai.generation', { killSwitch: true })] }),
      context({
        overrides: [
          {
            featureKey: 'ai.generation',
            enabled: true,
            limitValue: null,
            reason: 'customer paid for it',
            effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
            effectiveUntil: null,
          },
        ],
      }),
      'ai.generation',
      NOW,
    );
    // Containment during an incident must not depend on nobody having granted
    // an exception (docs/SECURITY.md §14.4).
    expect(result.enabled).toBe(false);
    expect(result.source).toBe('kill_switch');
  });

  it('beats a plan that grants it', () => {
    const result = resolveEntitlement(
      catalogue({
        flags: [flag('ai.generation', { killSwitch: true })],
        planEntitlements: [entitlement('growth', 'ai.generation', true)],
      }),
      context({ planKey: 'growth' }),
      'ai.generation',
      NOW,
    );
    expect(result.enabled).toBe(false);
    expect(result.source).toBe('kill_switch');
  });

  it('beats an explicit allow list', () => {
    const result = resolveEntitlement(
      catalogue({
        flags: [flag('ai.generation', { killSwitch: true, enabledForWorkspaces: [WORKSPACE] })],
      }),
      context(),
      'ai.generation',
      NOW,
    );
    expect(result.source).toBe('kill_switch');
  });
});

describe('2. a workspace override outranks a plan', () => {
  it('enables a feature the plan withholds', () => {
    const result = resolveEntitlement(
      catalogue({ planEntitlements: [entitlement('starter', 'ai.generation', false)] }),
      context({
        planKey: 'starter',
        overrides: [
          {
            featureKey: 'ai.generation',
            enabled: true,
            limitValue: 50,
            reason: 'goodwill after an incident',
            effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
            effectiveUntil: null,
          },
        ],
      }),
      'ai.generation',
      NOW,
    );
    expect(result.enabled).toBe(true);
    expect(result.limitValue).toBe(50);
    expect(result.source).toBe('workspace_override');
  });

  it('disables a feature the plan grants', () => {
    const result = resolveEntitlement(
      catalogue({ planEntitlements: [entitlement('growth', 'ai.generation', true)] }),
      context({
        planKey: 'growth',
        overrides: [
          {
            featureKey: 'ai.generation',
            enabled: false,
            limitValue: null,
            reason: 'abuse investigation',
            effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
            effectiveUntil: null,
          },
        ],
      }),
      'ai.generation',
      NOW,
    );
    expect(result.enabled).toBe(false);
    expect(result.source).toBe('workspace_override');
  });

  it('an EXPIRED override does not apply', () => {
    const result = resolveEntitlement(
      catalogue({ planEntitlements: [entitlement('starter', 'ai.generation', false)] }),
      context({
        planKey: 'starter',
        overrides: [
          {
            featureKey: 'ai.generation',
            enabled: true,
            limitValue: null,
            reason: 'a trial that has ended',
            effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
            effectiveUntil: new Date('2026-02-01T00:00:00.000Z'),
          },
        ],
      }),
      'ai.generation',
      NOW,
    );
    expect(result.enabled).toBe(false);
    expect(result.source).toBe('plan_entitlement');
  });

  it('a FUTURE override does not apply yet', () => {
    const result = resolveEntitlement(
      catalogue(),
      context({
        overrides: [
          {
            featureKey: 'ai.generation',
            enabled: true,
            limitValue: null,
            reason: 'starts next month',
            effectiveFrom: new Date('2026-12-01T00:00:00.000Z'),
            effectiveUntil: null,
          },
        ],
      }),
      'ai.generation',
      NOW,
    );
    expect(result.source).toBe('feature_default');
  });
});

describe('3-7. flag targeting, in order', () => {
  it('a deny list beats an allow list when a workspace is on both', () => {
    // A contradiction resolves to the RESTRICTIVE reading.
    const result = resolveEntitlement(
      catalogue({
        flags: [
          flag('ai.generation', {
            enabledForWorkspaces: [WORKSPACE],
            disabledForWorkspaces: [WORKSPACE],
          }),
        ],
      }),
      context(),
      'ai.generation',
      NOW,
    );
    expect(result.enabled).toBe(false);
  });

  it('a beta group grants it', () => {
    const result = resolveEntitlement(
      catalogue({ flags: [flag('ai.generation', { betaGroups: ['image-v2'] })] }),
      context({ betaGroups: ['image-v2'] }),
      'ai.generation',
      NOW,
    );
    expect(result.enabled).toBe(true);
    expect(result.source).toBe('flag_beta_group');
  });

  it('a country rule matches and, separately, does not', () => {
    const enabled = resolveEntitlement(
      catalogue({ flags: [flag('ai.generation', { countries: ['SA', 'AE'] })] }),
      context({ country: 'SA' }),
      'ai.generation',
      NOW,
    );
    expect(enabled.enabled).toBe(true);

    const disabled = resolveEntitlement(
      catalogue({ flags: [flag('ai.generation', { countries: ['SA', 'AE'] })] }),
      context({ country: 'EG' }),
      'ai.generation',
      NOW,
    );
    expect(disabled.enabled).toBe(false);
    expect(disabled.source).toBe('flag_country');
  });

  it('a date range opens and closes', () => {
    const inside = resolveEntitlement(
      catalogue({
        flags: [
          flag('ai.generation', {
            activeFrom: '2026-01-01T00:00:00.000Z',
            activeUntil: '2026-12-31T00:00:00.000Z',
          }),
        ],
      }),
      context(),
      'ai.generation',
      NOW,
    );
    expect(inside.enabled).toBe(true);

    const outside = resolveEntitlement(
      catalogue({
        flags: [flag('ai.generation', { activeUntil: '2026-02-01T00:00:00.000Z' })],
      }),
      context(),
      'ai.generation',
      NOW,
    );
    expect(outside.enabled).toBe(false);
  });

  it('a percentage rollout is STABLE for the same workspace', () => {
    // The property docs/ADMIN-CONTROL-CENTER.md §5.2 calls out: a workspace
    // must not flip between page loads.
    const first = rolloutBucket('ai.generation', WORKSPACE);
    for (let i = 0; i < 20; i += 1) {
      expect(rolloutBucket('ai.generation', WORKSPACE)).toBe(first);
    }
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(100);
  });

  it('two features at the same percentage do not select the same cohort', () => {
    // Hashing the feature key as well means a 50% rollout of B is not exactly
    // the same half of the customer base as a 50% rollout of A.
    const differing = Array.from({ length: 50 }, (_, i) => {
      const ws = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      return rolloutBucket('feature.a', ws) !== rolloutBucket('feature.b', ws);
    });
    expect(differing.filter(Boolean).length).toBeGreaterThan(20);
  });

  it('0% includes nobody and 100% includes everybody', () => {
    const none = resolveEntitlement(
      catalogue({ flags: [flag('ai.generation', { percentageRollout: 0 })] }),
      context(),
      'ai.generation',
      NOW,
    );
    expect(none.enabled).toBe(false);

    const all = resolveEntitlement(
      catalogue({ flags: [flag('ai.generation', { percentageRollout: 100 })] }),
      context(),
      'ai.generation',
      NOW,
    );
    expect(all.enabled).toBe(true);
  });
});

describe('8-9. plan entitlement, then the feature default', () => {
  it('uses the plan when nothing above it decided', () => {
    const result = resolveEntitlement(
      catalogue({ planEntitlements: [entitlement('growth', 'seats', true, 25)] }),
      context({ planKey: 'growth' }),
      'seats',
      NOW,
    );
    expect(result.enabled).toBe(true);
    expect(result.limitValue).toBe(25);
    expect(result.source).toBe('plan_entitlement');
  });

  it('falls back to the feature default with no plan', () => {
    const result = resolveEntitlement(catalogue(), context(), 'seats', NOW);
    expect(result.limitValue).toBe(1);
    expect(result.source).toBe('feature_default');
  });

  it('a workspace with NO plan gets nothing it was not defaulted', () => {
    // The correct behaviour before any plan is approved: nothing is silently
    // on because nobody configured it.
    const result = resolveEntitlement(catalogue(), context(), 'ai.generation', NOW);
    expect(result.enabled).toBe(false);
  });
});

describe('the trace explains the decision', () => {
  it('records every rule considered, in order', () => {
    const result = resolveEntitlement(
      catalogue({ planEntitlements: [entitlement('growth', 'ai.generation', true)] }),
      context({ planKey: 'growth' }),
      'ai.generation',
      NOW,
    );
    const sources = result.trace.map((s) => s.source);
    expect(sources[0]).toBe('kill_switch');
    expect(sources).toContain('workspace_override');
    expect(sources.at(-1)).toBe('plan_entitlement');
    expect(result.trace.filter((s) => s.decided)).toHaveLength(1);
  });

  it('names the override reason, so support can answer "why"', () => {
    const result = resolveEntitlement(
      catalogue(),
      context({
        overrides: [
          {
            featureKey: 'ai.generation',
            enabled: true,
            limitValue: null,
            reason: 'agreed during onboarding',
            effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
            effectiveUntil: null,
          },
        ],
      }),
      'ai.generation',
      NOW,
    );
    expect(result.trace.find((s) => s.decided)?.detail).toContain('agreed during onboarding');
  });
});

describe('override validation refuses what the engine would ignore', () => {
  it('refuses an unknown feature', () => {
    expect(validateOverride(catalogue(), context(), 'nope', true, null, NOW)).toMatch(/Unknown/);
  });

  it('refuses a limit on a boolean feature', () => {
    expect(validateOverride(catalogue(), context(), 'ai.generation', true, 5, NOW)).toMatch(
      /boolean/,
    );
  });

  it('refuses a negative quota', () => {
    expect(validateOverride(catalogue(), context(), 'seats', true, -1, NOW)).toMatch(/negative/);
  });

  it('refuses enabling a feature whose dependency is off', () => {
    // Discovered at validation time, not at runtime.
    expect(
      validateOverride(catalogue(), context(), 'ai.image_generation', true, null, NOW),
    ).toMatch(/depends on "ai.generation"/);
  });

  it('allows it once the dependency is on', () => {
    const withDependency = context({
      overrides: [
        {
          featureKey: 'ai.generation',
          enabled: true,
          limitValue: null,
          reason: 'enabled first',
          effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
          effectiveUntil: null,
        },
      ],
    });
    expect(
      validateOverride(catalogue(), withDependency, 'ai.image_generation', true, null, NOW),
    ).toBeNull();
  });

  it('refuses an override that tries to defeat a kill switch', () => {
    expect(
      validateOverride(
        catalogue({ flags: [flag('ai.generation', { killSwitch: true })] }),
        context(),
        'ai.generation',
        true,
        null,
        NOW,
      ),
    ).toMatch(/kill switch/);
  });

  it('ALLOWS an override that disables something, even under a kill switch', () => {
    // Turning a feature further off is never the dangerous direction.
    expect(
      validateOverride(
        catalogue({ flags: [flag('ai.generation', { killSwitch: true })] }),
        context(),
        'ai.generation',
        false,
        null,
        NOW,
      ),
    ).toBeNull();
  });
});

function flag(
  featureKey: string,
  overrides: Partial<{
    killSwitch: boolean;
    globalEnabled: boolean | null;
    enabledForPlans: string[];
    enabledForWorkspaces: string[];
    disabledForWorkspaces: string[];
    betaGroups: string[];
    countries: string[];
    activeFrom: string | null;
    activeUntil: string | null;
    percentageRollout: number | null;
  }> = {},
) {
  return {
    featureKey,
    killSwitch: false,
    globalEnabled: null,
    enabledForPlans: [],
    enabledForWorkspaces: [],
    disabledForWorkspaces: [],
    betaGroups: [],
    countries: [],
    activeFrom: null,
    activeUntil: null,
    percentageRollout: null,
    ...overrides,
  };
}

function entitlement(
  planKey: string,
  featureKey: string,
  enabled: boolean,
  limitValue: number | null = null,
) {
  return { planKey, featureKey, enabled, limitValue, limitPeriod: null };
}
