import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { ConfigurationService } from '@brandspace/config';
import { PLATFORM_PERMISSIONS } from '@brandspace/shared';
import {
  ATTENTION_INBOX_STATUSES,
  FinancialReconciler,
  eventsNeedingAttention,
} from '@brandspace/billing';
import {
  ConfigurationCatalogueSource,
  CreditLedgerService,
  EntitlementService,
  QUOTA_FEATURES,
  SubscriptionService,
  readPlanCatalogue,
  termsFor,
} from '@brandspace/entitlements';
import { MaintenanceScheduler } from '../../apps/api/src/scheduler';
import { ensurePlatformRole, platformRoleClient } from './fixtures';

/**
 * CURRENT EXECUTION PHASE 3 — the financial operations, against a real
 * PostgreSQL.
 *
 * WHAT THIS SUITE IS ACTUALLY ABOUT, and why it is not another credit-ledger
 * test. `tests/isolation/credit-protocol.test.ts` already proves that
 * `expireLapsedGrants`, `sweepAbandonedReservations` and `runCycleReset` do the
 * right thing. Every one of them had NO CALLER outside that file:
 * `SubscriptionService.dueForCycle`, whose entire purpose is to be the input to
 * a sweep, had no caller at all. So the platform granted a monthly allowance
 * once, at plan assignment, and never again; credits never expired; an
 * abandoned reservation held a customer's balance for ever; a scheduled
 * downgrade never took effect; `cancelAtPeriodEnd` ended nothing; and a
 * past-due subscription never escalated.
 *
 * THE ASSERTIONS ARE THEREFORE ABOUT THE SCHEDULER, NOT THE SERVICES. Every
 * test below calls `MaintenanceScheduler` — the thing a running deployment
 * actually runs — rather than the helper underneath it. A test that calls the
 * helper would have passed before this phase and after it, which is exactly how
 * the gap survived.
 *
 * IT MAKES ITS OWN WORKSPACES. The shared fixtures are read by a dozen suites
 * and these sweeps are platform-wide, so everything here is created fresh with
 * a run token and asserted about by id. Nothing asserts a platform-wide total.
 */

const ENV = 'DEVELOPMENT' as const;
const RUN = crypto.randomUUID().slice(0, 8);

/** A plan shape that is complete enough for the catalogue reader. Invented. */
const FIXTURE_PLAN = {
  key: `p3-${RUN}`,
  name: { ar: 'خطة اختبار', en: 'Fixture Plan' },
  description: { ar: 'وصف', en: 'Description' },
  tier: 1,
  visibility: 'private',
  status: 'active',
  prices: [{ currency: 'SAR', monthlyMinor: 100, annualMinor: 1000 }],
  taxBehavior: 'exclusive',
  trialDays: 7,
  trialRequiresCard: false,
  trialCredits: 10,
  monthlyCredits: 50,
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
};

/** A cheaper plan, so a scheduled downgrade has somewhere to go. */
const SMALLER_PLAN = {
  ...FIXTURE_PLAN,
  key: `p3-small-${RUN}`,
  tier: 0,
  monthlyCredits: 10,
  prices: [{ currency: 'SAR', monthlyMinor: 10, annualMinor: 100 }],
  sortOrder: 0,
};

const MILLI = 1000n;

let platform: PrismaClient;
let scheduler: MaintenanceScheduler;
let ownerId: string;
let now: Date;

/** The injected clock. Every sweep reads it, so a test can move time. */
const clock = { now: () => now };

function actor() {
  return {
    platformUserId: ownerId,
    roleKey: 'platform_owner',
    mfaVerified: true,
    permissionKeys: PLATFORM_PERMISSIONS.map((p) => p.key),
  };
}

let created: string[] = [];

/** A workspace of this suite's own, with a wallet and nothing else. */
async function freshWorkspace(planKey: string | null): Promise<string> {
  const id = crypto.randomUUID();
  const user = await platform.user.create({
    data: {
      email: `p3-${id}@example.local`,
      name: 'Phase 3 Fixture',
      status: 'ACTIVE',
      timezone: 'UTC',
    },
  });
  await platform.workspace.create({
    data: {
      id,
      workspaceId: id,
      slug: `p3-${id.slice(0, 12)}`,
      name: 'Phase 3 Fixture Workspace',
      ownerUserId: user.id,
      status: 'ACTIVE',
      country: 'SA',
      currency: 'SAR',
      defaultLocale: 'EN',
      timezone: 'UTC',
      planKey,
    },
  });
  await platform.creditWallet.create({ data: { workspaceId: id } });
  created.push(id);
  return id;
}

/** A subscription whose period has already ended — the sweep's input. */
async function dueSubscription(
  workspaceId: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await platform.workspaceSubscription.create({
    data: {
      workspaceId,
      planKey: FIXTURE_PLAN.key,
      status: 'ACTIVE',
      billingInterval: 'MONTH',
      currency: 'SAR',
      pinnedMonthlyMinor: 100,
      pinnedAnnualMinor: 1000,
      pinnedMonthlyCredits: FIXTURE_PLAN.monthlyCredits,
      currentPeriodStart: new Date(now.getTime() - 60 * 86_400_000),
      currentPeriodEnd: new Date(now.getTime() - 86_400_000),
      ...overrides,
    },
  });
}

async function wallet(workspaceId: string) {
  return platform.creditWallet.findUniqueOrThrow({ where: { workspaceId } });
}

async function subscription(workspaceId: string) {
  return platform.workspaceSubscription.findUniqueOrThrow({ where: { workspaceId } });
}

beforeAll(async () => {
  platform = platformRoleClient();
  now = new Date();

  const roleId = await ensurePlatformRole(platform);
  const owner = await platform.platformUser.create({
    data: {
      email: `p3-owner-${RUN}@brandspace.local`,
      name: 'Phase 3 Owner',
      status: 'ACTIVE',
      roleId,
    },
  });
  ownerId = owner.id;

  /*
   * THE PLAN CATALOGUE THE SWEEP READS IS A REAL ACTIVATED DOCUMENT.
   *
   * The scheduler resolves plans through `ConfigurationService`, so a stub
   * catalogue would test a path production does not have. Activation runs the
   * same schema parse, cross-domain validation and high-impact acknowledgement
   * an activation from Platform Admin runs. Every number in it is invented for
   * this suite; no approved commercial value is written anywhere (AC-04.3).
   */
  const configuration = new ConfigurationService({ prisma: platform, cacheTtlMs: 0 });
  const draft = await configuration.createDraft(
    actor(),
    'plans',
    ENV,
    `Phase 3 operations fixture ${RUN}`,
    { plans: [SMALLER_PLAN, FIXTURE_PLAN] },
  );
  const report = await configuration.validateDraft(actor(), draft.id);
  if (!report.valid) {
    throw new Error(
      `the plan fixture did not validate: ${report.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  await configuration.activate(actor(), draft.id, { acknowledgeHighImpact: true });

  /*
   * EVERY OTHER SUBSCRIPTION IS PARKED OUT OF THE WAY.
   *
   * F-23, the same reason `phase7-round4` parks automation rules: other suites
   * leave `workspace_subscription` rows in this database, `dueForCycle` is
   * BOUNDED and ordered by the boundary being waited on, and a sweep asserted
   * with `take: 200` proves nothing if the batch is full of somebody else's
   * overdue rows. Parking them uses the sweep's own selection rule rather than
   * a back door around it, and this suite creates every row it asserts on
   * afterwards.
   */
  await platform.workspaceSubscription.updateMany({
    where: { currentPeriodEnd: { lte: new Date(now.getTime() + 365 * 86_400_000) } },
    data: { currentPeriodEnd: new Date('2099-01-01T00:00:00.000Z') },
  });

  scheduler = new MaintenanceScheduler({ environment: ENV, clock });
}, 60_000);

afterAll(async () => {
  // The workspaces this suite made, and nothing else. Cascades take the wallet,
  // the ledger, the grants and the subscription with them.
  if (created.length > 0) {
    await platform.workspace.deleteMany({ where: { id: { in: created } } }).catch(() => undefined);
  }
  created = [];
  await platform.$disconnect().catch(() => undefined);
});

// ---------------------------------------------------------------------------
// The billing cycle
// ---------------------------------------------------------------------------

describe('the cycle boundary is crossed by the scheduler, exactly once', () => {
  it('advances the period and grants the PINNED allowance', async () => {
    const workspaceId = await freshWorkspace(FIXTURE_PLAN.key);
    await dueSubscription(workspaceId);
    const before = await subscription(workspaceId);

    const result = await scheduler.advanceBillingCycles(200);
    expect(result.advanced).toBeGreaterThanOrEqual(1);

    const after = await subscription(workspaceId);
    expect(after.currentPeriodStart.getTime()).toBe(before.currentPeriodEnd.getTime());
    expect(after.currentPeriodEnd.getTime()).toBeGreaterThan(before.currentPeriodEnd.getTime());
    expect(after.status).toBe('ACTIVE');

    // The allowance is the one the subscription PINNED, not the catalogue's
    // current number — AC-04.7.
    expect((await wallet(workspaceId)).balanceMilliCredits).toBe(
      BigInt(FIXTURE_PLAN.monthlyCredits) * MILLI,
    );
  });

  it('A DUPLICATED TICK GRANTS NOTHING MORE — the whole point of a sweep', async () => {
    const workspaceId = await freshWorkspace(FIXTURE_PLAN.key);
    await dueSubscription(workspaceId);

    await scheduler.advanceBillingCycles(200);
    const afterFirst = await subscription(workspaceId);
    const balanceAfterFirst = (await wallet(workspaceId)).balanceMilliCredits;

    // Time has not moved, so the period is no longer due and the second pass
    // must find nothing to do for this workspace.
    await scheduler.advanceBillingCycles(200);

    const afterSecond = await subscription(workspaceId);
    expect(afterSecond.currentPeriodStart.getTime()).toBe(afterFirst.currentPeriodStart.getTime());
    expect((await wallet(workspaceId)).balanceMilliCredits).toBe(balanceAfterFirst);
  });

  it('TWO SIMULTANEOUS BOUNDARY CROSSINGS MOVE THE PERIOD ONCE', async () => {
    const workspaceId = await freshWorkspace(FIXTURE_PLAN.key);
    await dueSubscription(workspaceId);
    const before = await subscription(workspaceId);

    /*
     * BOTH CALLS READ THE SAME PERIOD END AND THEN RACE THE WRITE. The update
     * is conditional on the value that was read, so exactly one matches a row.
     * A sequential "call it twice" would prove nothing about this: the second
     * call would simply read the new period.
     */
    const subscriptions = new SubscriptionService({ prisma: platform, clock });
    await Promise.all([
      subscriptions.advanceCycle(workspaceId, null),
      subscriptions.advanceCycle(workspaceId, null),
    ]);

    const after = await subscription(workspaceId);
    expect(after.currentPeriodStart.getTime()).toBe(before.currentPeriodEnd.getTime());
    // ONE month, not two.
    const months =
      (after.currentPeriodEnd.getFullYear() - after.currentPeriodStart.getFullYear()) * 12 +
      (after.currentPeriodEnd.getMonth() - after.currentPeriodStart.getMonth());
    expect(months).toBe(1);
  });

  it('CANCEL-AT-PERIOD-END ACTUALLY ENDS IT, and grants nothing', async () => {
    const workspaceId = await freshWorkspace(FIXTURE_PLAN.key);
    await dueSubscription(workspaceId, { cancelAtPeriodEnd: true, cancelRequestedAt: now });
    const before = await subscription(workspaceId);

    await scheduler.advanceBillingCycles(200);

    const after = await subscription(workspaceId);
    expect(after.status).toBe('CANCELLED');
    // The period is left where it ended. A cancelled subscription must not be
    // shown a period the customer neither paid for nor holds.
    expect(after.currentPeriodEnd.getTime()).toBe(before.currentPeriodEnd.getTime());
    expect((await wallet(workspaceId)).balanceMilliCredits).toBe(0n);
  });

  it('a trial that reaches its boundary EXPIRES rather than becoming paid', async () => {
    const workspaceId = await freshWorkspace(FIXTURE_PLAN.key);
    await dueSubscription(workspaceId, {
      status: 'TRIALING',
      trialStartedAt: new Date(now.getTime() - 30 * 86_400_000),
      trialEndsAt: new Date(now.getTime() - 86_400_000),
    });

    await scheduler.advanceBillingCycles(200);

    expect((await subscription(workspaceId)).status).toBe('EXPIRED');
    expect((await wallet(workspaceId)).balanceMilliCredits).toBe(0n);
  });

  it('applies a scheduled downgrade at the boundary, and pins its price', async () => {
    const workspaceId = await freshWorkspace(FIXTURE_PLAN.key);
    await dueSubscription(workspaceId, {
      pendingPlanKey: SMALLER_PLAN.key,
      pendingPlanEffectiveAt: new Date(now.getTime() - 86_400_000),
    });

    await scheduler.advanceBillingCycles(200);

    const after = await subscription(workspaceId);
    expect(after.planKey).toBe(SMALLER_PLAN.key);
    expect(after.pendingPlanKey).toBeNull();
    expect(after.pinnedMonthlyMinor).toBe(SMALLER_PLAN.prices[0]!.monthlyMinor);
    expect(after.pinnedMonthlyCredits).toBe(SMALLER_PLAN.monthlyCredits);
  });

  it('ONE WORKSPACE FAILING DOES NOT STOP THE NEXT — AND ITS OWN PERIOD DOES NOT MOVE', async () => {
    /*
     * A subscription on a plan the catalogue does not define. The sweep cannot
     * grant an allowance it has no number for, and must not let that stop
     * everyone behind it in the batch.
     *
     * IT MUST ALSO NOT ADVANCE THAT WORKSPACE'S PERIOD. This test used to
     * assert the opposite — "the broken one still advanced its period, the
     * failure was the grant" — which described the defect rather than the
     * requirement: `dueForCycle` selects on the period end, so a period that
     * moved without its allowance leaves the workspace no longer due and the
     * missed month is never granted by any later sweep.
     */
    const broken = await freshWorkspace('a-plan-that-does-not-exist');
    await dueSubscription(broken, { planKey: 'a-plan-that-does-not-exist' });
    const brokenBefore = await subscription(broken);
    const healthy = await freshWorkspace(FIXTURE_PLAN.key);
    await dueSubscription(healthy);

    await expect(scheduler.advanceBillingCycles(200)).resolves.toBeTruthy();

    expect((await wallet(healthy)).balanceMilliCredits).toBe(
      BigInt(FIXTURE_PLAN.monthlyCredits) * MILLI,
    );

    const brokenAfter = await subscription(broken);
    expect(brokenAfter.currentPeriodStart.getTime()).toBe(
      brokenBefore.currentPeriodStart.getTime(),
    );
    expect(brokenAfter.currentPeriodEnd.getTime()).toBe(brokenBefore.currentPeriodEnd.getTime());
    expect((await wallet(broken)).balanceMilliCredits).toBe(0n);
    // STILL DUE, so an operator who fixes the catalogue gets the missed cycle.
    const due = await new SubscriptionService({ prisma: platform, clock }).dueForCycle(1000);
    expect(due.map((row) => row.workspaceId)).toContain(broken);
  });
});

// ---------------------------------------------------------------------------
// The boundary and its allowance are one unit
// ---------------------------------------------------------------------------

describe('a period and the credits that belong to it cannot split', () => {
  /**
   * Make the credit reset fail PART WAY THROUGH, using nothing but data.
   *
   * A cycle reset expires lapsed buckets before it does anything else, and a
   * write-off is refused by `CHECK (balanceMilliCredits >= 0)` if it would take
   * the wallet below zero. A lapsed bucket that the wallet balance does not
   * cover therefore fails INSIDE `runCycleReset`, after the period transition
   * has already been written in the same transaction — which is exactly the
   * window this test is about.
   *
   * NO SEAM IS ADDED TO PRODUCTION CODE to make this testable, and the cause is
   * a row, so it can be cleared and the boundary retried.
   */
  async function plantUnpayableExpiry(workspaceId: string): Promise<string> {
    const w = await wallet(workspaceId);
    const transaction = await platform.creditTransaction.create({
      data: {
        workspaceId,
        walletId: w.id,
        type: 'PLAN_GRANT',
        amountMilliCredits: 0n,
        balanceAfterMilliCredits: 0n,
        reason: 'phase 3 fixture: a bucket the wallet cannot pay for',
        idempotencyKey: `p3-unpayable-${crypto.randomUUID()}`,
        actorType: 'SYSTEM',
      },
    });
    const bucket = await platform.creditGrant.create({
      data: {
        workspaceId,
        walletId: w.id,
        source: 'PLAN_GRANT',
        amountMilliCredits: 9n * MILLI,
        // Remaining, lapsed, and NOT reflected in the wallet balance: expiring
        // it would drive the balance negative.
        remainingMilliCredits: 9n * MILLI,
        expiresAt: new Date(now.getTime() - 86_400_000),
        sourceTransactionId: transaction.id,
        reason: 'phase 3 fixture: a bucket the wallet cannot pay for',
      },
    });
    return bucket.id;
  }

  it('A — A FAILURE DURING THE GRANT LEAVES THE PERIOD WHERE IT WAS', async () => {
    const workspaceId = await freshWorkspace(FIXTURE_PLAN.key);
    await dueSubscription(workspaceId);
    const before = await subscription(workspaceId);
    const bucketId = await plantUnpayableExpiry(workspaceId);

    await scheduler.advanceBillingCycles(200);

    // THE PERIOD DID NOT MOVE. It was written inside the boundary transaction
    // and rolled back with the failed reset — which is the whole property.
    const after = await subscription(workspaceId);
    expect(after.currentPeriodStart.getTime()).toBe(before.currentPeriodStart.getTime());
    expect(after.currentPeriodEnd.getTime()).toBe(before.currentPeriodEnd.getTime());
    expect((await wallet(workspaceId)).balanceMilliCredits).toBe(0n);
    expect(
      await platform.creditTransaction.count({ where: { workspaceId, type: 'PLAN_GRANT' } }),
      // Only the fixture's own marker row; no allowance was granted.
    ).toBe(1);

    // STILL DUE, so the next sweep will try again.
    const stillDue = await new SubscriptionService({ prisma: platform, clock }).dueForCycle(1000);
    expect(stillDue.map((row) => row.workspaceId)).toContain(workspaceId);

    // B — THE SAME BOUNDARY SUCCEEDS ONCE THE CAUSE IS GONE, AND GRANTS ONCE.
    await platform.creditGrant.update({
      where: { id: bucketId },
      data: { remainingMilliCredits: 0n },
    });

    await scheduler.advanceBillingCycles(200);
    const recovered = await subscription(workspaceId);
    expect(recovered.currentPeriodStart.getTime()).toBe(before.currentPeriodEnd.getTime());
    expect((await wallet(workspaceId)).balanceMilliCredits).toBe(
      BigInt(FIXTURE_PLAN.monthlyCredits) * MILLI,
    );

    // And a third sweep, with nothing due, adds nothing further.
    await scheduler.advanceBillingCycles(200);
    expect((await wallet(workspaceId)).balanceMilliCredits).toBe(
      BigInt(FIXTURE_PLAN.monthlyCredits) * MILLI,
    );
    expect(
      await platform.creditTransaction.count({
        where: { workspaceId, type: 'PLAN_GRANT', reason: 'Monthly plan allowance.' },
      }),
    ).toBe(1);
  });

  it('A SCHEDULED CHANGE THE CATALOGUE CANNOT RESOLVE DOES NOT RENEW THE OLD TERMS', async () => {
    /*
     * THE DEFECT THIS REPLACES. `applyPending` read `nextTerms !== null` and,
     * when the scheduled plan could not be resolved, simply did not apply it —
     * so the subscription RENEWED FOR ANOTHER PERIOD ON THE OLD PLAN, kept its
     * unresolved `pendingPlanKey`, and was granted the OLD plan's allowance.
     * The boundary was consumed, the change the customer asked for silently did
     * not happen, and the more expensive terms carried on being charged.
     *
     * There is no correct terms to substitute, so the boundary is refused and
     * the workspace stays due for an operator to fix the catalogue or withdraw
     * the change — the same treatment an unresolvable CURRENT plan gets.
     */
    const workspaceId = await freshWorkspace(FIXTURE_PLAN.key);
    await dueSubscription(workspaceId, {
      pendingPlanKey: `absent-from-the-catalogue-${RUN}`,
      pendingPlanEffectiveAt: new Date(now.getTime() - 86_400_000),
    });
    const before = await subscription(workspaceId);

    await scheduler.advanceBillingCycles(500);

    const after = await subscription(workspaceId);
    expect(after.currentPeriodStart.getTime()).toBe(before.currentPeriodStart.getTime());
    expect(after.currentPeriodEnd.getTime()).toBe(before.currentPeriodEnd.getTime());
    expect(after.planKey).toBe(FIXTURE_PLAN.key);
    // The scheduled change is still scheduled — nothing was silently dropped.
    expect(after.pendingPlanKey).toBe(`absent-from-the-catalogue-${RUN}`);
    // AND NO ALLOWANCE. The old plan's credits for a period nobody agreed to.
    expect((await wallet(workspaceId)).balanceMilliCredits).toBe(0n);

    const stillDue = await new SubscriptionService({ prisma: platform, clock }).dueForCycle(1000);
    expect(stillDue.map((row) => row.workspaceId)).toContain(workspaceId);
  });

  it('THE SAME, when the scheduled plan has no price in the billing currency (D-08)', async () => {
    /*
     * The plan is in the catalogue; what is missing is a price in the currency
     * this customer is billed in. D-08 forbids converting one at runtime, so
     * there is nothing to pin and the boundary is refused identically. The two
     * causes differ only in the line the sweep logs.
     */
    const workspaceId = await freshWorkspace(FIXTURE_PLAN.key);
    await dueSubscription(workspaceId, {
      // The fixture plans carry a SAR price only.
      currency: 'USD',
      pendingPlanKey: SMALLER_PLAN.key,
      pendingPlanEffectiveAt: new Date(now.getTime() - 86_400_000),
    });
    const before = await subscription(workspaceId);

    await scheduler.advanceBillingCycles(500);

    const after = await subscription(workspaceId);
    expect(after.currentPeriodStart.getTime()).toBe(before.currentPeriodStart.getTime());
    expect(after.planKey).toBe(FIXTURE_PLAN.key);
    expect(after.pendingPlanKey).toBe(SMALLER_PLAN.key);
    expect((await wallet(workspaceId)).balanceMilliCredits).toBe(0n);
  });

  it('A RESOLVABLE scheduled change still applies, and grants the NEW plan', async () => {
    // The control: the refusal above is about terms that cannot be resolved,
    // not about scheduled changes in general.
    const workspaceId = await freshWorkspace(FIXTURE_PLAN.key);
    await dueSubscription(workspaceId, {
      pendingPlanKey: SMALLER_PLAN.key,
      pendingPlanEffectiveAt: new Date(now.getTime() - 86_400_000),
    });

    await scheduler.advanceBillingCycles(500);

    const after = await subscription(workspaceId);
    expect(after.planKey).toBe(SMALLER_PLAN.key);
    expect(after.pendingPlanKey).toBeNull();
    expect(after.pinnedMonthlyCredits).toBe(SMALLER_PLAN.monthlyCredits);
    expect((await wallet(workspaceId)).balanceMilliCredits).toBe(
      BigInt(SMALLER_PLAN.monthlyCredits) * MILLI,
    );
  });

  it('terms that are not the SCHEDULED plan’s are refused outright', async () => {
    // A caller handing over some other plan's terms would move the customer
    // onto a plan nobody scheduled. Asserted at the service, because that is
    // where the rule lives and every caller gets it.
    const workspaceId = await freshWorkspace(FIXTURE_PLAN.key);
    await dueSubscription(workspaceId, {
      pendingPlanKey: SMALLER_PLAN.key,
      pendingPlanEffectiveAt: new Date(now.getTime() - 86_400_000),
    });
    const subscriptions = new SubscriptionService({ prisma: platform, clock });
    const wrong = termsFor(readPlanCatalogue({ plans: [FIXTURE_PLAN] })[0]!, 'SAR', null);

    await expect(subscriptions.advanceCycle(workspaceId, wrong)).rejects.toThrow(/scheduled/i);
    expect((await subscription(workspaceId)).planKey).toBe(FIXTURE_PLAN.key);
  });

  it('C — TWO SCHEDULER INSTANCES RACING ONE BOUNDARY: one period, one allowance', async () => {
    const workspaceId = await freshWorkspace(FIXTURE_PLAN.key);
    await dueSubscription(workspaceId);
    const before = await subscription(workspaceId);

    /*
     * TWO INSTANCES, NOT TWO CALLS ON ONE. Each has its own state, which is
     * what two API containers running the same sweep actually looks like, and
     * both read the same due row before either commits.
     */
    const a = new MaintenanceScheduler({ environment: ENV, clock });
    const b = new MaintenanceScheduler({ environment: ENV, clock });
    const results = await Promise.allSettled([
      a.advanceBillingCycles(200),
      b.advanceBillingCycles(200),
    ]);
    // Neither instance is allowed to blow up; one of them simply finds nothing
    // left to do.
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);

    const after = await subscription(workspaceId);
    expect(after.currentPeriodStart.getTime()).toBe(before.currentPeriodEnd.getTime());
    const months =
      (after.currentPeriodEnd.getFullYear() - after.currentPeriodStart.getFullYear()) * 12 +
      (after.currentPeriodEnd.getMonth() - after.currentPeriodStart.getMonth());
    expect(months).toBe(1);

    expect((await wallet(workspaceId)).balanceMilliCredits).toBe(
      BigInt(FIXTURE_PLAN.monthlyCredits) * MILLI,
    );
    expect(
      await platform.creditTransaction.count({ where: { workspaceId, type: 'PLAN_GRANT' } }),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// A subscription that ended stops granting its plan
// ---------------------------------------------------------------------------

describe('the entitlement resolver agrees with the subscription that ended', () => {
  /**
   * The engine as the platform reads it.
   *
   * `limit.seats` is the dimension asserted on for a mundane reason: the
   * development fixtures switch several quota features ON with a global flag so
   * the product is usable on a fresh database, and a flag decides BEFORE the
   * plan does. `limit.seats` is not one of them, so what comes back here is the
   * plan's own answer and nothing else's.
   */
  function entitlements(): EntitlementService {
    return new EntitlementService({
      prisma: platform,
      catalogueSource: new ConfigurationCatalogueSource(
        new ConfigurationService({ prisma: platform, cacheTtlMs: 0 }),
        ENV,
      ),
      environment: ENV,
      clock,
      cacheTtlMs: 0,
    });
  }

  const seats = () => FIXTURE_PLAN.quotas.seats;

  it('BEFORE THE PERIOD ENDS, a requested cancellation takes nothing away', async () => {
    const workspaceId = await freshWorkspace(FIXTURE_PLAN.key);
    await platform.workspaceSubscription.create({
      data: {
        workspaceId,
        planKey: FIXTURE_PLAN.key,
        status: 'ACTIVE',
        billingInterval: 'MONTH',
        currency: 'SAR',
        pinnedMonthlyMinor: 100,
        pinnedAnnualMinor: 1000,
        pinnedMonthlyCredits: FIXTURE_PLAN.monthlyCredits,
        currentPeriodStart: new Date(now.getTime() - 86_400_000),
        // NOT due: the period the customer paid for is still running.
        currentPeriodEnd: new Date(now.getTime() + 30 * 86_400_000),
        cancelAtPeriodEnd: true,
        cancelRequestedAt: now,
      },
    });

    // "Access continues until then" — docs/BILLING-AND-CREDITS.md §3.4.
    expect(await entitlements().limit(workspaceId, QUOTA_FEATURES.seats)).toBe(seats());
  });

  it('AFTER THE BOUNDARY, a cancelled subscription no longer grants its plan', async () => {
    const workspaceId = await freshWorkspace(FIXTURE_PLAN.key);
    await dueSubscription(workspaceId, { cancelAtPeriodEnd: true, cancelRequestedAt: now });
    expect(await entitlements().limit(workspaceId, QUOTA_FEATURES.seats)).toBe(seats());

    await scheduler.advanceBillingCycles(200);
    expect((await subscription(workspaceId)).status).toBe('CANCELLED');

    /*
     * THE COMMERCIAL RECORD IS UNTOUCHED AND THE PLAN NO LONGER APPLIES.
     * `Workspace.planKey` still says what was bought — history is not deleted —
     * and the resolver stops claiming it. Before this, the cycle boundary, the
     * billing screen and the audit trail all said the relationship was over
     * while `can()` and `limit()` went on granting the paid plan.
     */
    expect(await entitlements().limit(workspaceId, QUOTA_FEATURES.seats)).toBe(0);
    const workspace = await platform.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    expect(workspace.planKey).toBe(FIXTURE_PLAN.key);
  });

  it('a trial that expired behaves the same way', async () => {
    const workspaceId = await freshWorkspace(FIXTURE_PLAN.key);
    await dueSubscription(workspaceId, {
      status: 'TRIALING',
      trialStartedAt: new Date(now.getTime() - 30 * 86_400_000),
      trialEndsAt: new Date(now.getTime() - 86_400_000),
    });
    expect(await entitlements().limit(workspaceId, QUOTA_FEATURES.seats)).toBe(seats());

    await scheduler.advanceBillingCycles(200);
    expect((await subscription(workspaceId)).status).toBe('EXPIRED');
    expect(await entitlements().limit(workspaceId, QUOTA_FEATURES.seats)).toBe(0);
  });

  it('PAST_DUE keeps full access while dunning runs', async () => {
    const workspaceId = await freshWorkspace(FIXTURE_PLAN.key);
    await dueSubscription(workspaceId, {
      status: 'PAST_DUE',
      pastDueSince: new Date(now.getTime() - 86_400_000),
      currentPeriodEnd: new Date(now.getTime() + 30 * 86_400_000),
    });
    // §3.5: "past_due (full access, banner + email)".
    expect(await entitlements().limit(workspaceId, QUOTA_FEATURES.seats)).toBe(seats());
  });

  it('SUSPENDED IS LEFT EXACTLY AS IT WAS — D-234 has not been answered', async () => {
    const workspaceId = await freshWorkspace(FIXTURE_PLAN.key);
    await dueSubscription(workspaceId, {
      status: 'SUSPENDED',
      suspendedAt: now,
      currentPeriodEnd: new Date(now.getTime() + 30 * 86_400_000),
    });

    /*
     * DELIBERATE, AND ASSERTED SO IT CANNOT DRIFT. What a billing suspension
     * withdraws is an open product decision: §3.5 promises "AI and publishing
     * stop, export remains available", and the platform's only suspension
     * mechanism removes the workspace from its members' sessions entirely,
     * which would take the export with it. Guessing here would be taking that
     * decision instead of recording it.
     */
    expect(await entitlements().limit(workspaceId, QUOTA_FEATURES.seats)).toBe(seats());
  });

  it('a workspace with no subscription at all is unaffected', async () => {
    // An admin-assigned plan with no commercial relationship behind it still
    // resolves: the rule is about subscriptions that ENDED, not about their
    // absence.
    const workspaceId = await freshWorkspace(FIXTURE_PLAN.key);
    expect(await entitlements().limit(workspaceId, QUOTA_FEATURES.seats)).toBe(seats());
  });
});

// ---------------------------------------------------------------------------
// Credit expiry and abandoned reservations
// ---------------------------------------------------------------------------

describe('credits expire and abandoned holds are released, because a sweep runs', () => {
  async function grant(
    workspaceId: string,
    amount: bigint,
    expiresAt: Date | null,
  ): Promise<string> {
    const w = await wallet(workspaceId);
    const transaction = await platform.creditTransaction.create({
      data: {
        workspaceId,
        walletId: w.id,
        type: 'PLAN_GRANT',
        amountMilliCredits: amount,
        balanceAfterMilliCredits: w.balanceMilliCredits + amount,
        reason: 'phase 3 fixture grant',
        idempotencyKey: `p3-grant-${crypto.randomUUID()}`,
        actorType: 'SYSTEM',
        expiresAt,
      },
    });
    const bucket = await platform.creditGrant.create({
      data: {
        workspaceId,
        walletId: w.id,
        source: 'PLAN_GRANT',
        amountMilliCredits: amount,
        remainingMilliCredits: amount,
        expiresAt,
        sourceTransactionId: transaction.id,
        reason: 'phase 3 fixture grant',
      },
    });
    await platform.creditWallet.update({
      where: { workspaceId },
      data: { balanceMilliCredits: w.balanceMilliCredits + amount },
    });
    return bucket.id;
  }

  it('writes off a lapsed bucket and leaves the ledger reproducing the balance', async () => {
    const workspaceId = await freshWorkspace(null);
    await grant(workspaceId, 5n * MILLI, new Date(now.getTime() - 86_400_000));

    const touched = await scheduler.expireCredits(200);
    expect(touched).toBeGreaterThanOrEqual(1);

    expect((await wallet(workspaceId)).balanceMilliCredits).toBe(0n);
    const expiry = await platform.creditTransaction.findFirst({
      where: { workspaceId, type: 'EXPIRY' },
    });
    expect(expiry?.amountMilliCredits).toBe(-5n * MILLI);
  });

  it('LEAVES A LAPSED BUCKET THAT IS ENTIRELY RESERVED, and is not stuck behind it', async () => {
    const held = await freshWorkspace(null);
    const bucketId = await grant(held, 4n * MILLI, new Date(now.getTime() - 86_400_000));
    // Every remaining milli-credit is held against a request in flight, so
    // there is nothing to write off — and the sweep must not park on it.
    await platform.creditGrant.update({
      where: { id: bucketId },
      data: { reservedMilliCredits: 4n * MILLI },
    });
    await platform.creditWallet.update({
      where: { workspaceId: held },
      data: { reservedMilliCredits: 4n * MILLI },
    });

    const other = await freshWorkspace(null);
    await grant(other, 7n * MILLI, new Date(now.getTime() - 86_400_000));

    await scheduler.expireCredits(200);

    expect((await wallet(held)).balanceMilliCredits).toBe(4n * MILLI);
    expect((await wallet(other)).balanceMilliCredits).toBe(0n);
  });

  it('releases a reservation whose request never came back', async () => {
    const workspaceId = await freshWorkspace(null);
    const ledger = new CreditLedgerService({ prisma: platform, clock });
    await grant(workspaceId, 10n * MILLI, null);

    const reservation = await ledger.reserve({
      workspaceId,
      estimateMilliCredits: 6n * MILLI,
      purpose: 'phase3.test',
      idempotencyKey: `p3-reserve-${crypto.randomUUID()}`,
      ttlSeconds: 60,
    });
    expect((await wallet(workspaceId)).reservedMilliCredits).toBe(6n * MILLI);

    // The request died. Time passes; nothing settles it.
    now = new Date(now.getTime() + 10 * 60_000);
    await scheduler.sweepCreditReservations(500);
    now = new Date(now.getTime() - 10 * 60_000);

    expect((await wallet(workspaceId)).reservedMilliCredits).toBe(0n);
    expect((await wallet(workspaceId)).balanceMilliCredits).toBe(10n * MILLI);
    // EXPIRED, not RELEASED: the sweep records WHY the hold ended, and "the
    // request never came back" is a different fact from "the caller cancelled".
    expect((await ledger.reservation(reservation.id)).status).toBe('EXPIRED');
  });
});

// ---------------------------------------------------------------------------
// Dunning
// ---------------------------------------------------------------------------

describe('the dunning ladder advances, because a sweep runs', () => {
  it('suspends a subscription past its grace period, once, with a CRITICAL record', async () => {
    const workspaceId = await freshWorkspace(FIXTURE_PLAN.key);
    await dueSubscription(workspaceId, {
      status: 'PAST_DUE',
      // Far enough back that no configured grace period can still be running.
      pastDueSince: new Date(now.getTime() - 365 * 86_400_000),
      currentPeriodEnd: new Date(now.getTime() + 30 * 86_400_000),
    });

    /*
     * THE ATTEMPT HISTORY IS PART OF THE INPUT, and the ladder reads it rather
     * than assuming it. The configured schedule retries on four days before the
     * grace period can end, so five recorded failures is what "retries are
     * exhausted" looks like in rows.
     */
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await platform.paymentAttempt.create({
        data: {
          workspaceId,
          status: 'FAILED',
          currency: 'SAR',
          currencyScale: 2,
          amountMinor: 100n,
          failureCode: 'card_declined',
          attemptNumber: attempt,
          idempotencyKey: `p3-attempt-${attempt}`,
          attemptedAt: new Date(now.getTime() - (10 - attempt) * 86_400_000),
        },
      });
    }

    const suspended = await scheduler.advanceDunning(200);
    expect(suspended).toBeGreaterThanOrEqual(1);

    const after = await subscription(workspaceId);
    expect(after.status).toBe('SUSPENDED');
    expect(after.suspendedAt).not.toBeNull();

    const events = await platform.auditEvent.findMany({
      where: { workspaceId, action: 'billing.subscription.suspended' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.severity).toBe('CRITICAL');
    /*
     * AND IT DOES NOT CLAIM SOMETHING THAT DID NOT HAPPEN. The record used to
     * say `accessWithdrawn: true` while the entitlements engine resolved
     * against `Workspace.planKey` and never looked at this status — so the
     * subscription was suspended and nothing was withdrawn. What suspension
     * should take away is a product decision (D-234); saying it took something
     * away was not.
     */
    expect(events[0]?.after).toMatchObject({ accessChanged: false, dataRetained: true });

    // A SUSPENDED row has left the candidate set, so a second pass suspends
    // nothing again and writes no second record.
    await scheduler.advanceDunning(200);
    expect(
      await platform.auditEvent.count({
        where: { workspaceId, action: 'billing.subscription.suspended' },
      }),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

describe('reconciliation reports drift and repairs nothing', () => {
  const reconciler = () => new FinancialReconciler({ prisma: platform });

  /** Read one workspace, wherever it falls in the platform-wide order. */
  async function driftFor(workspaceId: string) {
    let after: string | null = null;
    for (;;) {
      const page = await reconciler().run({ limit: 200, after });
      const mine = page.drifts.filter((drift) => drift.workspaceId === workspaceId);
      if (mine.length > 0) return mine;
      if (page.exhausted) return [];
      after = page.cursor;
    }
  }

  it('finds a wallet that disagrees with its ledger, and does NOT fix it', async () => {
    const workspaceId = await freshWorkspace(null);
    // A balance nothing in the ledger accounts for — the shape of the bug this
    // pass exists to catch.
    await platform.creditWallet.update({
      where: { workspaceId },
      data: { balanceMilliCredits: 42n * MILLI },
    });

    const drifts = await driftFor(workspaceId);
    expect(drifts.map((d) => d.kind)).toContain('wallet_vs_ledger');
    expect(drifts.find((d) => d.kind === 'wallet_vs_ledger')?.foundMilliCredits).toBe(
      String(42n * MILLI),
    );

    // STILL WRONG afterwards, deliberately. Rewriting the balance would destroy
    // the evidence and leave the cause in place.
    expect((await wallet(workspaceId)).balanceMilliCredits).toBe(42n * MILLI);
  });

  it('finds a held amount that no open reservation accounts for', async () => {
    const workspaceId = await freshWorkspace(null);
    await platform.creditWallet.update({
      where: { workspaceId },
      data: { reservedMilliCredits: 9n * MILLI },
    });

    const kinds = (await driftFor(workspaceId)).map((d) => d.kind);
    expect(kinds).toContain('reserved_vs_reservations');
    expect(kinds).toContain('reserved_vs_buckets');
  });

  it('reports a clean workspace as clean', async () => {
    const workspaceId = await freshWorkspace(null);
    expect(await driftFor(workspaceId)).toEqual([]);
  });

  it('the scheduler writes a CRITICAL audit record when it finds drift', async () => {
    const workspaceId = await freshWorkspace(null);
    await platform.creditWallet.update({
      where: { workspaceId },
      data: { balanceMilliCredits: 13n * MILLI },
    });

    const before = new Date();
    /*
     * THE SWEEP ROTATES THROUGH THE PLATFORM A PAGE AT A TIME, so this workspace
     * is reached after however many pages its id falls behind. Running until the
     * record that names it appears is the assertion: a bounded pass that never
     * came round to it would be a sweep with a blind spot.
     */
    let named: { severity: string; after: unknown } | undefined;
    for (let pass = 0; pass < 100 && !named; pass += 1) {
      await scheduler.reconcileFinancials(200);
      const audited = await platform.auditEvent.findMany({
        where: {
          workspaceId: null,
          action: 'platform.billing.reconciliation.drift',
          occurredAt: { gte: before },
        },
      });
      named = audited.find((row) => JSON.stringify(row.after).includes(workspaceId));
    }
    expect(named).toBeDefined();
    expect(named?.severity).toBe('CRITICAL');
    // Reported, not repaired.
    expect((await wallet(workspaceId)).balanceMilliCredits).toBe(13n * MILLI);
  });
});

describe('a clean rotation means the whole rotation was clean', () => {
  /*
   * ONE WALLET PER PAGE, so the rotation is many pages and its LAST page is
   * guaranteed to contain no drift — the pass ends on an empty page. That is
   * exactly the shape the defect needed: drift early, a clean ending, and a
   * clean record written over the top of a CRITICAL one.
   */
  it('A/C/D — DRIFT ON AN EARLY PAGE SUPPRESSES THE CLEAN RECORD FOR THE WHOLE ROTATION', async () => {
    /*
     * ONE WALLET PER PAGE MAKES THE ROTATION END ON AN EMPTY PAGE, which by
     * construction contains no drift. So the rotation is guaranteed to finish
     * "clean" on its last page while having found drift earlier — exactly the
     * sequence the defect turned into a clean record.
     */
    const dirty = await freshWorkspace(null);
    await platform.creditWallet.update({
      where: { workspaceId: dirty },
      data: { balanceMilliCredits: 77n * MILLI },
    });

    const wallets = await platform.creditWallet.count();
    // A FRESH INSTANCE, so the rotation starts at the top and this test is not
    // reading somebody else's cursor.
    const rotating = new MaintenanceScheduler({ environment: ENV, clock });
    const before = new Date();

    // Exactly one full rotation: one page per wallet, then the empty page that
    // ends it.
    for (let pass = 0; pass <= wallets; pass += 1) {
      await rotating.reconcileFinancials(1);
    }

    const audits = await platform.auditEvent.findMany({
      where: {
        workspaceId: null,
        action: {
          in: ['platform.billing.reconciliation.drift', 'platform.billing.reconciliation.clean'],
        },
        occurredAt: { gte: before },
      },
      select: { action: true, severity: true, after: true },
    });

    // C — the page that found it still says so, at CRITICAL.
    const drifts = audits.filter((row) => row.action === 'platform.billing.reconciliation.drift');
    expect(drifts.length).toBeGreaterThanOrEqual(1);
    expect(drifts.every((row) => row.severity === 'CRITICAL')).toBe(true);
    expect(drifts.some((row) => JSON.stringify(row.after).includes(dirty))).toBe(true);

    // A — and the rotation as a whole makes no clean claim, however clean its
    // last page was. This is the assertion the defect failed.
    expect(audits.filter((row) => row.action === 'platform.billing.reconciliation.clean')).toEqual(
      [],
    );

    // D — and nothing was repaired.
    expect((await wallet(dirty)).balanceMilliCredits).toBe(77n * MILLI);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// The billing inbox an operator can see
// ---------------------------------------------------------------------------

describe('the events that stopped can be enumerated', () => {
  const EVENT_IDS: string[] = [];

  async function inboxRow(status: string): Promise<string> {
    const row = await platform.billingEvent.create({
      data: {
        providerKey: `p3-provider-${RUN}`,
        externalEventId: `p3-${crypto.randomUUID()}`,
        eventType: 'invoice.paid',
        occurredAt: now,
        signatureVerified: true,
        // Something recognisable, so the "never returns the payload" assertion
        // below has a needle to look for.
        payload: { secretish: `payload-${RUN}` },
        status: status as never,
        attempts: 8,
        failureReason: 'fixture',
      },
    });
    EVENT_IDS.push(row.id);
    return row.id;
  }

  afterAll(async () => {
    await platform.billingEvent
      .deleteMany({ where: { id: { in: EVENT_IDS } } })
      .catch(() => undefined);
  });

  it('lists the statuses that need a person, and NEVER the payload', async () => {
    const dead = await inboxRow('DEAD_LETTER');
    const processed = await inboxRow('PROCESSED');

    const rows = await eventsNeedingAttention(platform, { limit: 200 });
    const ids = rows.map((row) => row.id);
    expect(ids).toContain(dead);
    // A settled event is not waiting for anybody.
    expect(ids).not.toContain(processed);
    for (const row of rows) {
      expect(ATTENTION_INBOX_STATUSES as readonly string[]).toContain(row.status);
    }
    expect(JSON.stringify(rows)).not.toContain(`payload-${RUN}`);
  });

  it('is bounded', async () => {
    await inboxRow('FAILED');
    await inboxRow('UNRESOLVED');
    expect((await eventsNeedingAttention(platform, { limit: 1 })).length).toBe(1);
  });
});
