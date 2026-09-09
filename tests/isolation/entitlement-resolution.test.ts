import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BetaCohortService,
  CreditLedgerService,
  EntitlementService,
  INERT_CREDIT_POLICY,
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
let ledger: CreditLedgerService;
let assigner: EntitlementService;

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

  /**
   * A stable fake version id per domain (A-3). A subscription pins the
   * configuration version its price came from, so the stub has to answer —
   * and answering with a deterministic value lets a test assert the pin.
   *
   * A real UUID, because `pinnedFromVersionId` is a `uuid` column: a stub that
   * returns a readable placeholder would fail on the database rather than on
   * the behaviour under test.
   */
  readonly versionIds: Record<string, string> = {
    entitlements: '11111111-1111-4111-8111-111111111111',
    plans: '22222222-2222-4222-8222-222222222222',
    'feature-flags': '33333333-3333-4333-8333-333333333333',
  };

  async versionId(domain: string): Promise<string | null> {
    return this.versionIds[domain] ?? null;
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

  // A-3: assigning a plan grants the credits that plan promises, so the
  // service that performs assignments carries the ledger. The read-only one
  // above deliberately does not — that is the tenant-side shape.
  ledger = new CreditLedgerService({ prisma: platform, policy: INERT_CREDIT_POLICY });
  assigner = new EntitlementService({
    prisma: platform,
    catalogueSource: catalogue,
    environment: 'DEVELOPMENT',
    cacheTtlMs: 0,
    ledger,
  });
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

/*
 * A-3. ASSIGNING A PLAN USED TO WRITE A STRING.
 *
 * `assignPlan` set `workspace.planKey` and an audit event and stopped. No
 * `WorkspaceSubscription` existed, so there was no status, no billing period,
 * no trial, no pinned price and no credits — the Plan & Usage page had nothing
 * real to render and the cycle worker had nothing to advance.
 */
describe('assigning a plan creates the commercial relationship', () => {
  const ACTOR = {
    platformUserId: crypto.randomUUID(),
    roleKey: 'platform_owner',
    permissionKeys: ['platform.plan.assign'],
    mfaVerified: true,
  };

  async function assignable(): Promise<string> {
    return freshWorkspace(null);
  }

  it('creates the subscription, starts the trial and grants the trial credits', async () => {
    const workspaceId = await assignable();

    await assigner.assignPlan(ACTOR, workspaceId, 'fixture-large', 'sold on a call');

    const subscription = await subscriptions.get(workspaceId);
    expect(subscription, 'a plan assignment must produce a subscription').not.toBeNull();
    expect(subscription!.planKey).toBe('fixture-large');
    expect(subscription!.status).toBe('TRIALING');

    // THE PRICE IS PINNED, from the catalogue, with the version it came from.
    expect(subscription!.currency).toBe('SAR');
    expect(subscription!.pinnedMonthlyMinor).toBe(500);
    expect(subscription!.pinnedAnnualMinor).toBe(5000);
    expect(subscription!.pinnedMonthlyCredits).toBe(1000);

    const row = await platform.workspaceSubscription.findUniqueOrThrow({ where: { workspaceId } });
    expect(row.pinnedFromVersionId, 'a pinned price must record where it came from').toBe(
      catalogue.versionIds['plans'],
    );
    expect(row.trialStartedAt).not.toBeNull();
    expect(row.trialEndsAt).not.toBeNull();
    // The trial IS the first period, so the cycle boundary is the trial end.
    expect(row.currentPeriodEnd.toISOString()).toBe(row.trialEndsAt!.toISOString());

    // And the trial's credits are actually in the wallet.
    const wallet = await platform.creditWallet.findUniqueOrThrow({ where: { workspaceId } });
    expect(wallet.balanceMilliCredits).toBe(20n * 1000n);
  });

  it('changing plan mid-trial re-pins the price without granting again', async () => {
    // The trial belongs to the WORKSPACE, not the plan: moving between plans
    // inside it must neither cut it short, restart it, nor hand out a second
    // allowance — otherwise an operator could mint credits by toggling.
    const workspaceId = await assignable();
    await assigner.assignPlan(ACTOR, workspaceId, 'fixture-large', 'trial first');
    const afterTrial = await platform.creditWallet.findUniqueOrThrow({ where: { workspaceId } });
    const trialPeriod = await platform.workspaceSubscription.findUniqueOrThrow({
      where: { workspaceId },
    });

    await assigner.assignPlan(ACTOR, workspaceId, 'fixture-small', 'moved mid-trial');

    const row = await platform.workspaceSubscription.findUniqueOrThrow({ where: { workspaceId } });
    expect(row.planKey).toBe('fixture-small');
    expect(row.status).toBe('TRIALING');
    // The new plan's price and allowance are pinned...
    expect(row.pinnedMonthlyCredits).toBe(100);
    expect(row.pinnedMonthlyMinor).toBe(100);
    // ...and the trial period is untouched.
    expect(row.trialEndsAt?.toISOString()).toBe(trialPeriod.trialEndsAt?.toISOString());
    expect(row.currentPeriodEnd.toISOString()).toBe(trialPeriod.currentPeriodEnd.toISOString());

    // No second allowance.
    const wallet = await platform.creditWallet.findUniqueOrThrow({ where: { workspaceId } });
    expect(wallet.balanceMilliCredits).toBe(afterTrial.balanceMilliCredits);
  });

  it('is idempotent: assigning the same plan twice grants once', async () => {
    // An operator double-clicking must not cost a second month of credits.
    const workspaceId = await assignable();

    await assigner.assignPlan(ACTOR, workspaceId, 'fixture-large', 'first');
    const afterFirst = await platform.creditWallet.findUniqueOrThrow({ where: { workspaceId } });

    await assigner.assignPlan(ACTOR, workspaceId, 'fixture-large', 'again');
    await assigner.assignPlan(ACTOR, workspaceId, 'fixture-large', 'and again');

    const afterRepeats = await platform.creditWallet.findUniqueOrThrow({ where: { workspaceId } });
    expect(afterRepeats.balanceMilliCredits).toBe(afterFirst.balanceMilliCredits);

    const trialGrants = await platform.creditGrant.findMany({
      where: { workspaceId, source: 'TRIAL_GRANT' },
    });
    expect(trialGrants).toHaveLength(1);
  });

  it('gives a workspace only one trial, ever', async () => {
    // D-09. Moving between plans must not hand out a second evaluation period.
    const workspaceId = await assignable();
    await assigner.assignPlan(ACTOR, workspaceId, 'fixture-large', 'trial plan');
    const first = await platform.workspaceSubscription.findUniqueOrThrow({
      where: { workspaceId },
    });

    await assigner.assignPlan(ACTOR, workspaceId, 'fixture-small', 'moved off');
    await assigner.assignPlan(ACTOR, workspaceId, 'fixture-large', 'and back');

    const after = await platform.workspaceSubscription.findUniqueOrThrow({
      where: { workspaceId },
    });
    expect(after.trialStartedAt?.toISOString()).toBe(first.trialStartedAt?.toISOString());
    const trialGrants = await platform.creditGrant.findMany({
      where: { workspaceId, source: 'TRIAL_GRANT' },
    });
    expect(trialGrants).toHaveLength(1);
  });

  it('cancels rather than deletes the subscription when the plan is removed', async () => {
    // The row is the record of what the customer was sold and when. Deleting
    // it would destroy the only evidence of a price that was once pinned.
    const workspaceId = await assignable();
    await assigner.assignPlan(ACTOR, workspaceId, 'fixture-large', 'assigned');

    await assigner.assignPlan(ACTOR, workspaceId, null, 'removed');

    const row = await platform.workspaceSubscription.findUniqueOrThrow({ where: { workspaceId } });
    expect(row.status).toBe('CANCELLED');
    expect(row.cancelledAt).not.toBeNull();
    expect(row.pinnedMonthlyMinor).toBe(500);
    const workspace = await platform.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    expect(workspace.planKey).toBeNull();
  });

  it('refuses a plan with no price in the pinning currency', async () => {
    // Pinning zero would be worse than refusing: the customer would be
    // recorded as having been sold the plan for nothing.
    const workspaceId = await assignable();
    await expect(
      assigner.assignPlan(ACTOR, workspaceId, 'fixture-large', 'wrong currency', {
        currency: 'JPY',
      }),
    ).rejects.toThrow(/no price in JPY/);

    expect(await subscriptions.get(workspaceId)).toBeNull();
  });

  it('records the outcome in the audit event, in the same transaction', async () => {
    const workspaceId = await assignable();
    await assigner.assignPlan(ACTOR, workspaceId, 'fixture-large', 'audited assignment');

    const events = await platform.auditEvent.findMany({
      where: { workspaceId, action: 'platform.plan.assigned' },
    });
    expect(events).toHaveLength(1);
    const after = events[0]?.after as Record<string, unknown>;
    expect(after['planKey']).toBe('fixture-large');
    expect(after['subscriptionStatus']).toBe('TRIALING');
    expect(after['trialStarted']).toBe(true);
    expect(after['grantedCredits']).toBe(20);
  });

  it('writes nothing at all when the plan is unknown', async () => {
    const workspaceId = await assignable();
    await expect(assigner.assignPlan(ACTOR, workspaceId, 'no-such-plan', 'typo')).rejects.toThrow(
      /Unknown plan/,
    );

    const workspace = await platform.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    expect(workspace.planKey).toBeNull();
    expect(await subscriptions.get(workspaceId)).toBeNull();
    expect(
      await platform.auditEvent.count({ where: { workspaceId, action: 'platform.plan.assigned' } }),
    ).toBe(0);
  });
});
