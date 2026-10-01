import { describe, expect, it } from 'vitest';
import { validateConfiguration, type ConfigContext } from '@brandspace/config';
import {
  AUTOMATION_AI_ACTIONS_FEATURE,
  applyTrialQuota,
  projectAutomationAiCap,
  readPlanCatalogue,
  resolveEntitlement,
  type EntitlementCatalogue,
  type WorkspaceEntitlementContext,
} from '@brandspace/entitlements';

/**
 * PHASE 2B-3 PR 6 — THE AI AUTOMATION CAP ON THE PLAN (D-458, D-459).
 *
 * `quotas.automationAiActionsPerMonth` and `quotas.trialAutomationAiActionsPerMonth`
 * are `{ kind: 'limited', value: 1..1000 }` or `{ kind: 'unlimited' }`, and
 * ABSENT MEANS OFF. Every value below is a fixture, never the owner's numbers.
 */

const CONTEXT: ConfigContext = {
  operations: { supportedCurrencies: ['USD'] },
  credits: { hardStopAtZero: true },
};

function plan(quotas: Record<string, unknown>, key = 'fixture-plan'): Record<string, unknown> {
  return {
    key,
    name: { ar: 'خطة', en: 'Fixture plan' },
    description: { ar: 'وصف', en: 'Description' },
    status: 'active',
    prices: [{ currency: 'USD', monthlyMinor: 100, annualMinor: 1000 }],
    trialDays: 7,
    trialCredits: 10,
    quotas,
  };
}

const errorsFor = (quotas: Record<string, unknown>) =>
  validateConfiguration('plans', { plans: [plan(quotas)] }, CONTEXT)
    .issues.filter((issue) => issue.severity === 'error')
    .map((issue) => issue.path);

describe('the plan fields validate', () => {
  it('absent, limited 1..1000 and unlimited are accepted', () => {
    expect(errorsFor({})).toEqual([]);
    expect(errorsFor({ automationAiActionsPerMonth: { kind: 'limited', value: 1 } })).toEqual([]);
    expect(errorsFor({ automationAiActionsPerMonth: { kind: 'limited', value: 1000 } })).toEqual(
      [],
    );
    expect(errorsFor({ automationAiActionsPerMonth: { kind: 'unlimited' } })).toEqual([]);
  });

  it('0, 1001, a fraction, a bare number and an unknown kind are refused', () => {
    for (const bad of [
      { kind: 'limited', value: 0 },
      { kind: 'limited', value: 1001 },
      { kind: 'limited', value: 2.5 },
      4,
      null,
      { kind: 'some' },
    ]) {
      expect(errorsFor({ automationAiActionsPerMonth: bad }).length, JSON.stringify(bad)).toBe(1);
    }
  });

  it('a trial never allows more than the plan', () => {
    const limited = (value: number) => ({ kind: 'limited', value });
    const field = 'plans.0.quotas.trialAutomationAiActionsPerMonth';
    expect(
      errorsFor({
        automationAiActionsPerMonth: limited(4),
        trialAutomationAiActionsPerMonth: limited(2),
      }),
    ).toEqual([]);
    expect(
      errorsFor({
        automationAiActionsPerMonth: limited(4),
        trialAutomationAiActionsPerMonth: limited(4),
      }),
    ).toEqual([]);
    expect(
      errorsFor({
        automationAiActionsPerMonth: { kind: 'unlimited' },
        trialAutomationAiActionsPerMonth: { kind: 'unlimited' },
      }),
    ).toEqual([]);
    expect(
      errorsFor({
        automationAiActionsPerMonth: limited(2),
        trialAutomationAiActionsPerMonth: limited(4),
      }),
    ).toEqual([field]);
    expect(
      errorsFor({
        automationAiActionsPerMonth: limited(2),
        trialAutomationAiActionsPerMonth: { kind: 'unlimited' },
      }),
    ).toEqual([field]);
    // The plan not set is off: a trial-only capability is refused.
    expect(errorsFor({ trialAutomationAiActionsPerMonth: limited(2) })).toEqual([field]);
  });
});

describe('the catalogue reads them, and absent stays null (off)', () => {
  it('reads limited, unlimited and absent', () => {
    const [read] = readPlanCatalogue({
      plans: [
        plan({
          automationAiActionsPerMonth: { kind: 'limited', value: 4 },
          trialAutomationAiActionsPerMonth: { kind: 'unlimited' },
        }),
      ],
    });
    expect(read?.quotas.automationAiActionsPerMonth).toEqual({ kind: 'limited', value: 4 });
    expect(read?.quotas.trialAutomationAiActionsPerMonth).toEqual({ kind: 'unlimited' });
    const [bare] = readPlanCatalogue({ plans: [plan({ seats: 2 })] });
    expect(bare?.quotas.automationAiActionsPerMonth).toBeNull();
    expect(bare?.quotas.trialAutomationAiActionsPerMonth).toBeNull();
  });
});

const FEATURE = {
  key: AUTOMATION_AI_ACTIONS_FEATURE,
  valueType: 'quota' as const,
  defaultValue: false,
  dependsOn: [],
  enumOptions: [],
};

function catalogueFor(plans: Record<string, unknown>[]): EntitlementCatalogue {
  return {
    features: [FEATURE],
    planEntitlements: projectAutomationAiCap(plans, 'automationAiActionsPerMonth'),
    flags: [],
    trialPlanEntitlements: projectAutomationAiCap(plans, 'trialAutomationAiActionsPerMonth'),
  };
}

function context(
  overrides: Partial<WorkspaceEntitlementContext> = {},
): WorkspaceEntitlementContext {
  return {
    workspaceId: '00000000-0000-4000-8000-000000000001',
    planKey: 'fixture-plan',
    country: 'SA',
    betaGroups: [],
    overrides: [],
    ...overrides,
  };
}

const NOW = new Date('2026-10-15T09:00:00.000Z');

function decide(plans: Record<string, unknown>[], ctx: WorkspaceEntitlementContext) {
  const catalogue = catalogueFor(plans);
  return applyTrialQuota(
    resolveEntitlement(catalogue, ctx, AUTOMATION_AI_ACTIONS_FEATURE, NOW),
    catalogue.trialPlanEntitlements ?? [],
    ctx,
  );
}

describe('resolution: absent is off, the trial value applies while TRIALING', () => {
  const both = plan({
    automationAiActionsPerMonth: { kind: 'limited', value: 4 },
    trialAutomationAiActionsPerMonth: { kind: 'limited', value: 2 },
  });

  it('a plan that does not set it is off, and so is no plan and an ended plan', () => {
    expect(decide([plan({})], context()).enabled).toBe(false);
    expect(decide([plan({})], context({ planKey: null })).enabled).toBe(false);
    expect(decide([both], context({ planKey: null, planEnded: true })).enabled).toBe(false);
  });

  it('limited is the number, unlimited is null', () => {
    expect(decide([both], context())).toMatchObject({ enabled: true, limitValue: 4 });
    expect(
      decide([plan({ automationAiActionsPerMonth: { kind: 'unlimited' } })], context()),
    ).toMatchObject({ enabled: true, limitValue: null });
  });

  it('while TRIALING the trial value replaces the plan value', () => {
    expect(decide([both], context({ trialing: true }))).toMatchObject({
      enabled: true,
      limitValue: 2,
    });
  });

  it('while TRIALING with no trial value it is off', () => {
    expect(
      decide(
        [plan({ automationAiActionsPerMonth: { kind: 'limited', value: 4 } })],
        context({ trialing: true }),
      ).enabled,
    ).toBe(false);
  });

  it('a workspace override still wins during a trial', () => {
    const decision = decide(
      [both],
      context({
        trialing: true,
        overrides: [
          {
            featureKey: AUTOMATION_AI_ACTIONS_FEATURE,
            enabled: true,
            limitValue: 9,
            enumValue: null,
            reason: 'fixture override',
            effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
            effectiveUntil: null,
          },
        ],
      }),
    );
    expect(decision).toMatchObject({ enabled: true, limitValue: 9, source: 'workspace_override' });
  });
});
