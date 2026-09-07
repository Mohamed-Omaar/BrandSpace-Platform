import { describe, expect, it } from 'vitest';
import {
  buildImpactPreview,
  defaultPayload,
  validateConfiguration,
  withAffectedWorkspaces,
  type ConfigContext,
} from '@brandspace/config';
import { findPlan, priceIn, readPlanCatalogue, termsFor } from '@brandspace/entitlements';

/**
 * Plan configuration: validation, the impact preview, and reading the catalogue.
 *
 * Every value in this file is a FIXTURE invented for the test. None of it is
 * the approved commercial data — that lives in configuration, entered from
 * Platform Admin, and `tests/unit/module-boundaries.test.ts` is what proves no
 * plan name or price appears in application source (AC-04.3).
 */

const SUPPORTED_CURRENCIES: ConfigContext = {
  operations: { supportedCurrencies: ['SAR', 'USD'] },
  credits: { hardStopAtZero: true },
};

function plan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: 'fixture-tier',
    name: { ar: 'مستوى', en: 'Fixture Tier' },
    description: { ar: 'وصف', en: 'Description' },
    tier: 1,
    visibility: 'public',
    status: 'active',
    prices: [
      { currency: 'SAR', monthlyMinor: 100, annualMinor: 1000 },
      { currency: 'USD', monthlyMinor: 50, annualMinor: 500 },
    ],
    taxBehavior: 'exclusive',
    trialDays: 7,
    trialRequiresCard: false,
    trialCredits: 10,
    monthlyCredits: 100,
    creditRollover: { policy: 'capped', capMultiplier: 1 },
    quotas: {
      seats: 2,
      brands: 1,
      socialAccounts: 3,
      scheduledPostsPerMonth: 100,
      storageGb: 5,
      analyticsRetentionDays: 90,
    },
    addOns: [],
    overagePolicy: { mode: 'block', pricePerCreditMinor: 0, capCredits: null },
    upgradeBehavior: { timing: 'immediate', prorate: true, creditGrant: 'prorated' },
    downgradeBehavior: {
      timing: 'period_end',
      excessResources: 'read_only',
      excessCredits: 'retain_until_expiry',
    },
    sortOrder: 1,
    ...overrides,
  };
}

function validate(plans: Record<string, unknown>[], context = SUPPORTED_CURRENCIES) {
  return validateConfiguration('plans', { plans }, context);
}

function errors(report: { issues: readonly { severity: string; message: string }[] }) {
  return report.issues.filter((i) => i.severity === 'error').map((i) => i.message);
}

describe('a well-formed plan validates', () => {
  it('accepts the fixture', () => {
    expect(validate([plan()]).valid).toBe(true);
  });

  it('an empty document is valid — nothing configured is not an error', () => {
    expect(validateConfiguration('plans', defaultPayload('plans'), {}).valid).toBe(true);
  });
});

describe('currency completeness (AC-04.10, D-08)', () => {
  it('refuses an active plan missing a supported currency', () => {
    const report = validate([
      plan({ prices: [{ currency: 'SAR', monthlyMinor: 100, annualMinor: 1000 }] }),
    ]);
    expect(report.valid).toBe(false);
    expect(errors(report).join(' ')).toMatch(/No USD price/);
  });

  it('names the reason: nothing converts a price at runtime', () => {
    const report = validate([plan({ prices: [] })]);
    expect(errors(report).join(' ')).toMatch(/no rate converts one at runtime/i);
  });

  it('does not require a full price table for a DRAFT plan', () => {
    // A draft is work in progress. Blocking it would make the editor unusable.
    expect(validate([plan({ status: 'draft', prices: [] })]).valid).toBe(true);
  });

  it('refuses a duplicated currency', () => {
    const report = validate([
      plan({
        prices: [
          { currency: 'SAR', monthlyMinor: 100, annualMinor: 1000 },
          { currency: 'SAR', monthlyMinor: 200, annualMinor: 2000 },
          { currency: 'USD', monthlyMinor: 50, annualMinor: 500 },
        ],
      }),
    ]);
    expect(errors(report).join(' ')).toMatch(/Duplicate currency/);
  });

  it('warns when the annual price costs more than twelve months', () => {
    const report = validate([
      plan({
        prices: [
          { currency: 'SAR', monthlyMinor: 100, annualMinor: 5000 },
          { currency: 'USD', monthlyMinor: 50, annualMinor: 500 },
        ],
      }),
    ]);
    expect(report.valid).toBe(true);
    expect(report.issues.some((i) => i.severity === 'warning')).toBe(true);
  });
});

describe('D-62: this is not an agency operating system', () => {
  it('refuses a plan keyed "agency"', () => {
    const report = validate([plan({ key: 'agency' })]);
    expect(report.valid).toBe(false);
    expect(errors(report).join(' ')).toMatch(/D-62/);
  });

  it('refuses a plan NAMED Agency however it is keyed', () => {
    const report = validate([plan({ key: 'tier-four', name: { ar: 'مستوى', en: 'Agency Pro' } })]);
    expect(errors(report).join(' ')).toMatch(/D-62/);
  });

  it('refuses the Arabic word too', () => {
    const report = validate([
      plan({ key: 'tier-four', name: { ar: 'خطة وكالة', en: 'Tier Four' } }),
    ]);
    expect(errors(report).join(' ')).toMatch(/D-62/);
  });

  it('points at the plan that IS approved for larger businesses', () => {
    expect(errors(validate([plan({ key: 'agency' })])).join(' ')).toMatch(/"scale"/);
  });

  it('refuses a client_viewer plan feature', () => {
    // AC-04.9. The RBAC key is untouched; what is refused is SELLING it.
    const report = validateConfiguration(
      'entitlements',
      {
        features: [
          {
            key: 'client_viewer',
            name: { ar: 'ع', en: 'v' },
            valueType: 'boolean',
            defaultValue: false,
            dependsOn: [],
          },
        ],
        planEntitlements: [{ planKey: 'fixture-tier', featureKey: 'client_viewer', enabled: true }],
      },
      {},
    );
    expect(report.valid).toBe(false);
    expect(errors(report).join(' ')).toMatch(/D-62/);
  });
});

describe('D-11 and D-12 are enforced where plans are written', () => {
  it('refuses postpaid overage while the platform hard-stops', () => {
    const report = validate([
      plan({ overagePolicy: { mode: 'charge', pricePerCreditMinor: 5, capCredits: null } }),
    ]);
    expect(report.valid).toBe(false);
    expect(errors(report).join(' ')).toMatch(/D-11/);
  });

  it('refuses a downgrade that archives a customer resource', () => {
    const report = validate([
      plan({
        downgradeBehavior: {
          timing: 'period_end',
          excessResources: 'archive',
          excessCredits: 'retain_until_expiry',
        },
      }),
    ]);
    expect(report.valid).toBe(false);
    expect(errors(report).join(' ')).toMatch(/D-12/);
  });

  it('refuses a capped rollover with no cap', () => {
    const report = validate([plan({ creditRollover: { policy: 'capped', capMultiplier: 0 } })]);
    expect(errors(report).join(' ')).toMatch(/cap above zero/);
  });

  it('refuses switching the hard stop off while nothing implements overage', () => {
    const report = validateConfiguration('credits', { hardStopAtZero: false }, {});
    expect(report.valid).toBe(false);
    expect(errors(report).join(' ')).toMatch(/D-11/);
  });

  it('warns about a trial that grants no credits', () => {
    const report = validate([plan({ trialDays: 14, trialCredits: 0 })]);
    expect(report.valid).toBe(true);
    expect(report.issues.some((i) => i.message.includes('no credits'))).toBe(true);
  });
});

describe('duplicate keys', () => {
  it('refuses two plans with the same key', () => {
    const report = validate([plan(), plan()]);
    expect(errors(report).join(' ')).toMatch(/Duplicate plan key/);
  });
});

describe('feature dependencies per plan (AC-05.4)', () => {
  const features = [
    {
      key: 'ai.generation',
      name: { ar: 'أ', en: 'a' },
      valueType: 'boolean',
      defaultValue: false,
      dependsOn: [],
    },
    {
      key: 'ai.video',
      name: { ar: 'ب', en: 'b' },
      valueType: 'boolean',
      defaultValue: false,
      dependsOn: ['ai.generation'],
    },
  ];

  it('refuses a plan that enables a feature whose dependency it leaves off', () => {
    const report = validateConfiguration(
      'entitlements',
      {
        features,
        planEntitlements: [{ planKey: 'p', featureKey: 'ai.video', enabled: true }],
      },
      {},
    );
    expect(report.valid).toBe(false);
    expect(errors(report).join(' ')).toMatch(/depends on "ai\.generation"/);
  });

  it('accepts it when the same plan also enables the dependency', () => {
    const report = validateConfiguration(
      'entitlements',
      {
        features,
        planEntitlements: [
          { planKey: 'p', featureKey: 'ai.generation', enabled: true },
          { planKey: 'p', featureKey: 'ai.video', enabled: true },
        ],
      },
      {},
    );
    expect(report.valid).toBe(true);
  });

  it('refuses the same feature granted twice on one plan', () => {
    const report = validateConfiguration(
      'entitlements',
      {
        features,
        planEntitlements: [
          { planKey: 'p', featureKey: 'ai.generation', enabled: true },
          { planKey: 'p', featureKey: 'ai.generation', enabled: false },
        ],
      },
      {},
    );
    expect(errors(report).join(' ')).toMatch(/twice/);
  });

  it('refuses a limit on a boolean feature', () => {
    const report = validateConfiguration(
      'entitlements',
      {
        features,
        planEntitlements: [
          { planKey: 'p', featureKey: 'ai.generation', enabled: true, limitValue: 5 },
        ],
      },
      {},
    );
    expect(errors(report).join(' ')).toMatch(/takes no limit/);
  });

  it('requires an enum feature to say which value the plan grants', () => {
    const report = validateConfiguration(
      'entitlements',
      {
        features: [
          {
            key: 'analytics.smart',
            name: { ar: 'ت', en: 'c' },
            valueType: 'enum',
            defaultValue: null,
            enumValues: ['basic', 'full', 'advanced'],
            dependsOn: [],
          },
        ],
        planEntitlements: [{ planKey: 'p', featureKey: 'analytics.smart', enabled: true }],
      },
      {},
    );
    expect(errors(report).join(' ')).toMatch(/must say which value/);
  });

  it('refuses an enum value the feature does not define', () => {
    const report = validateConfiguration(
      'entitlements',
      {
        features: [
          {
            key: 'analytics.smart',
            name: { ar: 'ت', en: 'c' },
            valueType: 'enum',
            defaultValue: null,
            enumValues: ['basic', 'full'],
            dependsOn: [],
          },
        ],
        planEntitlements: [
          { planKey: 'p', featureKey: 'analytics.smart', enabled: true, enumValue: 'platinum' },
        ],
      },
      {},
    );
    expect(errors(report).join(' ')).toMatch(/not one of the values/);
  });
});

describe('impact preview names who is affected (AC-04.5)', () => {
  const before = { plans: [plan({ quotas: { ...(plan()['quotas'] as object), brands: 10 } })] };
  const after = { plans: [plan({ quotas: { ...(plan()['quotas'] as object), brands: 2 } })] };

  it('lists the workspaces that would exceed a tightened limit', () => {
    const preview = withAffectedWorkspaces(buildImpactPreview('plans', before, after), after, [
      {
        workspaceId: 'w1',
        slug: 'over',
        planKey: 'fixture-tier',
        usage: { brands: 7 },
      },
      {
        workspaceId: 'w2',
        slug: 'under',
        planKey: 'fixture-tier',
        usage: { brands: 1 },
      },
    ]);
    expect(preview.affected?.totalOnChangedPlans).toBe(2);
    expect(preview.affected?.overLimit).toHaveLength(1);
    expect(preview.affected?.overLimit[0]).toMatchObject({
      slug: 'over',
      dimension: 'brands',
      current: 7,
      newLimit: 2,
    });
  });

  it('ignores workspaces on plans this activation does not change', () => {
    const preview = withAffectedWorkspaces(buildImpactPreview('plans', before, after), after, [
      { workspaceId: 'w3', slug: 'other', planKey: 'a-different-plan', usage: { brands: 99 } },
    ]);
    expect(preview.affected?.totalOnChangedPlans).toBe(0);
    expect(preview.affected?.overLimit).toEqual([]);
  });

  it('nobody can be over an unlimited limit', () => {
    const unlimited = {
      plans: [plan({ quotas: { ...(plan()['quotas'] as object), brands: null } })],
    };
    const preview = withAffectedWorkspaces(
      buildImpactPreview('plans', before, unlimited),
      unlimited,
      [{ workspaceId: 'w1', slug: 'over', planKey: 'fixture-tier', usage: { brands: 500 } }],
    );
    expect(preview.affected?.overLimit).toEqual([]);
  });

  it('does not report a dimension it has no usage data for', () => {
    // Honesty: "nobody is over their brand limit" derived from a table nothing
    // writes to yet would be worse than saying nothing.
    const preview = withAffectedWorkspaces(buildImpactPreview('plans', before, after), after, [
      { workspaceId: 'w1', slug: 'unknown', planKey: 'fixture-tier', usage: {} },
    ]);
    expect(preview.affected?.overLimit).toEqual([]);
  });

  it('repricing an active plan is a high-impact change', () => {
    const repriced = {
      plans: [
        plan({
          prices: [
            { currency: 'SAR', monthlyMinor: 999, annualMinor: 9990 },
            { currency: 'USD', monthlyMinor: 50, annualMinor: 500 },
          ],
        }),
      ],
    };
    expect(buildImpactPreview('plans', before, repriced).highImpactCount).toBeGreaterThan(0);
  });
});

describe('reading the catalogue', () => {
  const catalogue = readPlanCatalogue({
    plans: [plan(), plan({ key: 'other', tier: 2, sortOrder: 2 })],
  });

  it('reads every plan', () => {
    expect(catalogue.map((p) => p.key)).toEqual(['fixture-tier', 'other']);
  });

  it('finds a plan by key, and returns null for an unknown one', () => {
    expect(findPlan(catalogue, 'fixture-tier')?.tier).toBe(1);
    expect(findPlan(catalogue, 'nope')).toBeNull();
    expect(findPlan(catalogue, null)).toBeNull();
  });

  it('returns the price for a currency', () => {
    expect(priceIn(catalogue[0]!, 'usd')?.monthlyMinor).toBe(50);
  });

  it('returns NULL for a currency with no price rather than converting', () => {
    // D-08. A missing row is a gap the owner must fill; inventing a rate here
    // would quietly sell at a price nobody approved.
    expect(priceIn(catalogue[0]!, 'EUR')).toBeNull();
    expect(termsFor(catalogue[0]!, 'EUR', null)).toBeNull();
  });

  it('materialises the terms a subscription pins', () => {
    const terms = termsFor(catalogue[0]!, 'SAR', 'version-1');
    expect(terms).toMatchObject({
      planKey: 'fixture-tier',
      monthlyCredits: 100,
      trialDays: 7,
      trialCredits: 10,
      tier: 1,
      sourceVersionId: 'version-1',
    });
  });

  it('an unstated quota reads as null, not zero', () => {
    // Coercing to 0 would lock a customer out of a dimension the owner never
    // restricted — the opposite of what "not stated" means.
    const [only] = readPlanCatalogue({ plans: [plan({ quotas: { seats: 2 } })] });
    expect(only?.quotas.seats).toBe(2);
    expect(only?.quotas.brands).toBeNull();
  });
});
