import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BetaCohortService,
  EntitlementService,
  SubscriptionService,
  readPlanCatalogue,
  termsFor,
  type CatalogueSource,
} from '@brandspace/entitlements';

/**
 * Entitlement resolution against a real database.
 *
 * The pure precedence engine is covered by `tests/unit/precedence.test.ts`.
 * What needs a database is everything the engine reads AROUND itself: the plan
 * quota projection, workspace overrides, beta-cohort membership, the catalogue
 * cache and its invalidation, and the pinned price that makes AC-04.7 hold.
 *
 * Every plan and feature below is a FIXTURE. The approved commercial values are
 * configuration entered from Platform Admin, and no test asserts them.
 */

let platform: PrismaClient;
let entitlements: EntitlementService;
let cohorts: BetaCohortService;
let subscriptions: SubscriptionService;

/** A catalogue the test controls directly, standing in for activated config. */
class StubCatalogue implements CatalogueSource {
  #documents: Record<string, Record<string, unknown>> = {
    entitlements: {},
    plans: {},
    'feature-flags': {},
  };

  set(domain: string, document: Record<string, unknown>): void {
    this.#documents[domain] = document;
  }

  async load(domain: string): Promise<Record<string, unknown>> {
    return this.#documents[domain] ?? {};
  }
}

let catalogue: StubCatalogue;

const FEATURES = [
  {
    key: 'ai.copilot',
    name: { ar: 'م', en: 'Copilot' },
    valueType: 'boolean',
    defaultValue: false,
    dependsOn: [],
  },
  {
    key: 'approvals.workflow',
    name: { ar: 'م', en: 'Approvals' },
    valueType: 'boolean',
    defaultValue: false,
    dependsOn: [],
  },
];

const PLANS = [
  {
    key: 'fixture-small',
    name: { ar: 'ص', en: 'Small' },
    description: { ar: 'و', en: 'd' },
    tier: 1,
    status: 'active',
    visibility: 'public',
    prices: [{ currency: 'SAR', monthlyMinor: 100, annualMinor: 1000 }],
    monthlyCredits: 100,
    trialDays: 14,
    trialCredits: 20,
    quotas: { seats: 2, brands: 1 },
    creditRollover: { policy: 'capped', capMultiplier: 1 },
    downgradeBehavior: {
      timing: 'period_end',
      excessResources: 'read_only',
      excessCredits: 'retain_until_expiry',
    },
    sortOrder: 1,
  },
  {
    key: 'fixture-large',
    name: { ar: 'ك', en: 'Large' },
    description: { ar: 'و', en: 'd' },
    tier: 2,
    status: 'active',
    visibility: 'public',
    prices: [{ currency: 'SAR', monthlyMinor: 500, annualMinor: 5000 }],
    monthlyCredits: 1000,
    trialDays: 14,
    trialCredits: 20,
    quotas: { seats: 20, brands: null },
    creditRollover: { policy: 'capped', capMultiplier: 1 },
    downgradeBehavior: {
      timing: 'period_end',
      excessResources: 'read_only',
      excessCredits: 'retain_until_expiry',
    },
    sortOrder: 2,
  },
];

async function freshWorkspace(planKey: string | null): Promise<string> {
  const run = crypto.randomUUID();
  const user = await platform.user.create({
    data: { email: `ent-${run}@example.local`, name: 'Entitlement Fixture', status: 'ACTIVE' },
  });
  const workspace = await platform.workspace.create({
    data: {
      id: run,
      workspaceId: run,
      slug: `ent-${run.slice(0, 12)}`,
      name: 'Entitlement Fixture Workspace',
      ownerUserId: user.id,
      status: 'ACTIVE',
      country: 'SA',
      planKey,
    },
  });
  return workspace.id;
}

beforeAll(async () => {
  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) throw new Error('DATABASE_PLATFORM_URL is required.');
  platform = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  catalogue = new StubCatalogue();
  catalogue.set('entitlements', {
    features: FEATURES,
    planEntitlements: [
      { planKey: 'fixture-small', featureKey: 'ai.copilot', enabled: true, limitValue: null },
      {
        planKey: 'fixture-small',
        featureKey: 'approvals.workflow',
        enabled: false,
        limitValue: null,
      },
      { planKey: 'fixture-large', featureKey: 'ai.copilot', enabled: true, limitValue: null },
      {
        planKey: 'fixture-large',
        featureKey: 'approvals.workflow',
        enabled: true,
        limitValue: null,
      },
    ],
  });
  catalogue.set('plans', { plans: PLANS });
  catalogue.set('feature-flags', { flags: [] });

  entitlements = new EntitlementService({
    prisma: platform,
    catalogueSource: catalogue,
    environment: 'DEVELOPMENT',
    // Zero TTL, so a test that changes the catalogue sees it without sleeping.
    cacheTtlMs: 0,
  });
  cohorts = new BetaCohortService({ prisma: platform });
  subscriptions = new SubscriptionService({ prisma: platform });
}, 60_000);

afterAll(async () => {
  await platform?.$disconnect();
});

describe('can() and limit()', () => {
  it('a plan grant enables a feature', async () => {
    const workspaceId = await freshWorkspace('fixture-small');
    expect(await entitlements.can(workspaceId, 'ai.copilot')).toBe(true);
  });

  it('a plan that does not grant it says no', async () => {
    const workspaceId = await freshWorkspace('fixture-small');
    expect(await entitlements.can(workspaceId, 'approvals.workflow')).toBe(false);
  });

  it('a workspace on no plan gets nothing', async () => {
    const workspaceId = await freshWorkspace(null);
    expect(await entitlements.can(workspaceId, 'ai.copilot')).toBe(false);
  });

  it('an unknown feature is off — a typo never grants access', async () => {
    const workspaceId = await freshWorkspace('fixture-large');
    expect(await entitlements.can(workspaceId, 'ai.not_a_real_feature')).toBe(false);
  });

  it('limit() returns 0 for a disabled feature, not unlimited', async () => {
    // The distinction that matters: a caller treating "no limit stated" as zero
    // locks out exactly the customers who paid for no limit.
    const workspaceId = await freshWorkspace('fixture-small');
    expect(await entitlements.limit(workspaceId, 'approvals.workflow')).toBe(0);
  });
});

describe('plan quotas are projected into the catalogue', () => {
  it('a quota written on the plan resolves as a limit', async () => {
    const workspaceId = await freshWorkspace('fixture-small');
    expect(await entitlements.limit(workspaceId, 'limit.seats')).toBe(2);
    expect(await entitlements.limit(workspaceId, 'limit.brands')).toBe(1);
  });

  it('a null quota is unlimited, and is ENABLED rather than absent', async () => {
    // Omitting the row instead would fall through to the feature default and
    // disable the dimension entirely — the opposite of "negotiated".
    const workspaceId = await freshWorkspace('fixture-large');
    expect(await entitlements.can(workspaceId, 'limit.brands')).toBe(true);
    expect(await entitlements.limit(workspaceId, 'limit.brands')).toBeNull();
  });

  it('a dimension the plan does not mention resolves to nothing', async () => {
    const workspaceId = await freshWorkspace('fixture-small');
    expect(await entitlements.can(workspaceId, 'limit.storage_gb')).toBe(false);
  });

  it('the trace names the rule that decided', async () => {
    const workspaceId = await freshWorkspace('fixture-small');
    const decision = await entitlements.explain(workspaceId, 'limit.seats');
    expect(decision.source).toBe('plan_entitlement');
    expect(decision.trace.some((step) => step.decided)).toBe(true);
  });
});

describe('changing a plan changes what the workspace can do, immediately', () => {
  it('assigning a higher plan enables the feature at once', async () => {
    const workspaceId = await freshWorkspace('fixture-small');
    expect(await entitlements.can(workspaceId, 'approvals.workflow')).toBe(false);

    await platform.workspace.update({
      where: { id: workspaceId },
      data: { planKey: 'fixture-large' },
    });

    expect(await entitlements.can(workspaceId, 'approvals.workflow')).toBe(true);
  });
});

describe('a kill switch beats every grant (AC-05.8)', () => {
  it('turns the feature off for everyone the moment the catalogue changes', async () => {
    const workspaceId = await freshWorkspace('fixture-large');
    expect(await entitlements.can(workspaceId, 'ai.copilot')).toBe(true);

    catalogue.set('feature-flags', {
      flags: [
        {
          featureKey: 'ai.copilot',
          killSwitch: true,
          globalEnabled: null,
          enabledForPlans: [],
          enabledForWorkspaces: [],
          disabledForWorkspaces: [],
          betaGroups: [],
          countries: [],
          activeFrom: null,
          activeUntil: null,
          percentageRollout: null,
        },
      ],
    });
    entitlements.invalidate();

    expect(await entitlements.can(workspaceId, 'ai.copilot')).toBe(false);
    const decision = await entitlements.explain(workspaceId, 'ai.copilot');
    expect(decision.source).toBe('kill_switch');

    catalogue.set('feature-flags', { flags: [] });
    entitlements.invalidate();
  });

  it('an explicit workspace override cannot re-enable it', async () => {
    // Containment during an incident must not depend on nobody having granted
    // an exception (docs/SECURITY.md §14.4).
    const workspaceId = await freshWorkspace('fixture-large');
    await platform.workspaceOverride.create({
      data: {
        workspaceId,
        featureKey: 'ai.copilot',
        enabled: true,
        reason: 'an exception granted before the incident',
        grantedByPlatformUserId: (
          await platform.platformUser.findFirstOrThrow({ select: { id: true } })
        ).id,
      },
    });
    expect(await entitlements.can(workspaceId, 'ai.copilot')).toBe(true);

    catalogue.set('feature-flags', {
      flags: [
        {
          featureKey: 'ai.copilot',
          killSwitch: true,
          globalEnabled: null,
          enabledForPlans: [],
          enabledForWorkspaces: [],
          disabledForWorkspaces: [],
          betaGroups: [],
          countries: [],
          activeFrom: null,
          activeUntil: null,
          percentageRollout: null,
        },
      ],
    });
    entitlements.invalidate();

    expect(await entitlements.can(workspaceId, 'ai.copilot')).toBe(false);

    catalogue.set('feature-flags', { flags: [] });
    entitlements.invalidate();
  });
});

describe('beta cohorts are real membership now', () => {
  it('a flag targeted at a cohort matches only its members', async () => {
    const member = await freshWorkspace('fixture-small');
    const nonMember = await freshWorkspace('fixture-small');
    const platformUser = await platform.platformUser.findFirstOrThrow({ select: { id: true } });

    await platform.betaCohortMembership.create({
      data: {
        workspaceId: member,
        cohortKey: 'early-access',
        addedByPlatformUserId: platformUser.id,
        reason: 'fixture enrolment for the cohort test',
      },
    });

    catalogue.set('feature-flags', {
      flags: [
        {
          featureKey: 'approvals.workflow',
          killSwitch: false,
          globalEnabled: null,
          enabledForPlans: [],
          enabledForWorkspaces: [],
          disabledForWorkspaces: [],
          betaGroups: ['early-access'],
          countries: [],
          activeFrom: null,
          activeUntil: null,
          percentageRollout: null,
        },
      ],
    });
    entitlements.invalidate();

    expect(await entitlements.can(member, 'approvals.workflow')).toBe(true);
    expect(await entitlements.can(nonMember, 'approvals.workflow')).toBe(false);

    const decision = await entitlements.explain(member, 'approvals.workflow');
    expect(decision.source).toBe('flag_beta_group');

    catalogue.set('feature-flags', { flags: [] });
    entitlements.invalidate();
  });

  it('adding to a cohort requires a reason and a known cohort', async () => {
    const workspaceId = await freshWorkspace('fixture-small');
    const platformUser = await platform.platformUser.findFirstOrThrow({ select: { id: true } });
    const actor = {
      platformUserId: platformUser.id,
      roleKey: 'platform_owner',
      mfaVerified: true,
      permissionKeys: ['platform.entitlement.override'],
    };

    await expect(
      cohorts.add(actor, workspaceId, 'early-access', 'short', ['early-access']),
    ).rejects.toThrow(/written reason/);

    await expect(
      cohorts.add(actor, workspaceId, 'not-a-cohort', 'a perfectly good reason', ['early-access']),
    ).rejects.toThrow(/Unknown beta cohort/);
  });

  it('refuses an actor without MFA or the permission', async () => {
    const workspaceId = await freshWorkspace('fixture-small');
    const platformUser = await platform.platformUser.findFirstOrThrow({ select: { id: true } });

    await expect(
      cohorts.add(
        {
          platformUserId: platformUser.id,
          roleKey: 'platform_owner',
          mfaVerified: false,
          permissionKeys: ['platform.entitlement.override'],
        },
        workspaceId,
        'early-access',
        'a perfectly good reason',
        ['early-access'],
      ),
    ).rejects.toThrow(/MFA/);

    await expect(
      cohorts.add(
        {
          platformUserId: platformUser.id,
          roleKey: 'support',
          mfaVerified: true,
          permissionKeys: [],
        },
        workspaceId,
        'early-access',
        'a perfectly good reason',
        ['early-access'],
      ),
    ).rejects.toThrow(/requires platform\.entitlement\.override/);
  });
});

describe('the pinned price (AC-04.7)', () => {
  const catalogueDetail = readPlanCatalogue({ plans: PLANS });

  it('a later plan reprice does not change an existing subscription', async () => {
    const workspaceId = await freshWorkspace('fixture-small');
    // `pinnedFromVersionId` is a uuid column, so the fixture uses a real one.
    const terms = termsFor(catalogueDetail[0]!, 'SAR', crypto.randomUUID());
    await subscriptions.changePlan({
      workspaceId,
      terms: terms!,
      currentTier: 0,
      downgradeTiming: 'period_end',
    });

    const before = await subscriptions.get(workspaceId);
    expect(before?.pinnedMonthlyMinor).toBe(100);

    // The catalogue is repriced. The subscription must not follow.
    const repriced = readPlanCatalogue({
      plans: [
        { ...PLANS[0], prices: [{ currency: 'SAR', monthlyMinor: 9999, annualMinor: 99_990 }] },
      ],
    });
    expect(repriced[0]?.prices[0]?.monthlyMinor).toBe(9999);

    const after = await subscriptions.get(workspaceId);
    expect(after?.pinnedMonthlyMinor).toBe(100);
  });

  it('records which configuration version the price came from', async () => {
    const workspaceId = await freshWorkspace('fixture-small');
    await subscriptions.changePlan({
      workspaceId,
      terms: termsFor(catalogueDetail[0]!, 'SAR', crypto.randomUUID())!,
      currentTier: 0,
      downgradeTiming: 'period_end',
    });
    const row = await platform.workspaceSubscription.findUnique({ where: { workspaceId } });
    expect(row?.pinnedFromVersionId).not.toBeNull();
  });
});

describe('trials (AC-04.11, D-09)', () => {
  const catalogueDetail = readPlanCatalogue({ plans: PLANS });

  it('starts a trial with the configured length and credits', async () => {
    const workspaceId = await freshWorkspace('fixture-small');
    const { subscription, trialCredits } = await subscriptions.startTrial(
      workspaceId,
      termsFor(catalogueDetail[0]!, 'SAR', null)!,
    );
    expect(subscription.status).toBe('TRIALING');
    expect(trialCredits).toBe(20);
    expect(subscription.trialEndsAt).not.toBeNull();
  });

  it('a workspace cannot start a SECOND trial', async () => {
    const workspaceId = await freshWorkspace('fixture-small');
    const terms = termsFor(catalogueDetail[0]!, 'SAR', null)!;
    await subscriptions.startTrial(workspaceId, terms);

    await expect(subscriptions.startTrial(workspaceId, terms)).rejects.toThrow(
      /already used its trial/,
    );
  });

  it('the trial history survives the plan changing', async () => {
    const workspaceId = await freshWorkspace('fixture-small');
    await subscriptions.startTrial(workspaceId, termsFor(catalogueDetail[0]!, 'SAR', null)!);
    await subscriptions.changePlan({
      workspaceId,
      terms: termsFor(catalogueDetail[1]!, 'SAR', null)!,
      currentTier: 1,
      downgradeTiming: 'period_end',
    });

    expect(await subscriptions.hasEverTrialed(workspaceId)).toBe(true);
  });
});

describe('upgrade and downgrade timing', () => {
  const catalogueDetail = readPlanCatalogue({ plans: PLANS });

  it('an upgrade applies immediately', async () => {
    const workspaceId = await freshWorkspace('fixture-small');
    await subscriptions.changePlan({
      workspaceId,
      terms: termsFor(catalogueDetail[0]!, 'SAR', null)!,
      currentTier: 0,
      downgradeTiming: 'period_end',
    });
    const after = await subscriptions.changePlan({
      workspaceId,
      terms: termsFor(catalogueDetail[1]!, 'SAR', null)!,
      currentTier: 1,
      downgradeTiming: 'period_end',
    });

    expect(after.planKey).toBe('fixture-large');
    expect(after.pendingPlanKey).toBeNull();
  });

  it('a downgrade is SCHEDULED, not applied — nothing is taken away at request time', async () => {
    const workspaceId = await freshWorkspace('fixture-large');
    await subscriptions.changePlan({
      workspaceId,
      terms: termsFor(catalogueDetail[1]!, 'SAR', null)!,
      currentTier: 0,
      downgradeTiming: 'period_end',
    });

    const after = await subscriptions.changePlan({
      workspaceId,
      terms: termsFor(catalogueDetail[0]!, 'SAR', null)!,
      currentTier: 2,
      downgradeTiming: 'period_end',
    });

    // Still on the larger plan; the smaller one waits for the boundary.
    expect(after.planKey).toBe('fixture-large');
    expect(after.pendingPlanKey).toBe('fixture-small');
    expect(after.pendingPlanEffectiveAt).not.toBeNull();
  });

  it('the scheduled downgrade applies when the cycle advances', async () => {
    const workspaceId = await freshWorkspace('fixture-large');
    await subscriptions.changePlan({
      workspaceId,
      terms: termsFor(catalogueDetail[1]!, 'SAR', null)!,
      currentTier: 0,
      downgradeTiming: 'period_end',
    });
    await subscriptions.changePlan({
      workspaceId,
      terms: termsFor(catalogueDetail[0]!, 'SAR', null)!,
      currentTier: 2,
      downgradeTiming: 'period_end',
    });

    const advanced = await subscriptions.advanceCycle(
      workspaceId,
      termsFor(catalogueDetail[0]!, 'SAR', null),
    );

    expect(advanced.planKey).toBe('fixture-small');
    expect(advanced.pendingPlanKey).toBeNull();
    expect(advanced.pinnedMonthlyMinor).toBe(100);
  });
});
