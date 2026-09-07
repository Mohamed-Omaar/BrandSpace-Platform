import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CreditLedgerService,
  InsufficientCreditsError,
  MILLI_PER_CREDIT,
  type CreditPolicy,
} from '@brandspace/entitlements';
import { appRoleClient } from './fixtures';

/**
 * `reserve → confirm → settle` against a real PostgreSQL.
 *
 * These are the guarantees CLAUDE.md §2.4 states, and none of them can be
 * demonstrated without a database: they are properties of row locks, unique
 * indexes and CHECK constraints, not of TypeScript.
 *
 *   - a failed request never deducts a credit
 *   - a retry never deducts twice
 *   - a balance never goes negative, under any interleaving
 *   - replaying the ledger reproduces the balance exactly
 *   - the soonest-expiring credits are spent first
 *
 * Concurrency is exercised with real parallel transactions, not by calling the
 * methods in sequence and hoping. A test that awaits each call in turn proves
 * nothing about locking.
 */

const POLICY: CreditPolicy = {
  hardStopAtZero: true,
  purchasedPackExpiryMonths: 12,
  promotionalExpiryMonths: 3,
  planGrantExpiryMonths: 0,
  lowBalanceThresholdPercents: [20, 5],
  reservationTimeoutSeconds: 900,
};

let app: PrismaClient;
let platform: PrismaClient;
let ledger: CreditLedgerService;

/**
 * A workspace with an EMPTY wallet.
 *
 * Deliberately not `createIsolationFixtures`, for two reasons. That helper
 * seeds a wallet with a starting balance and a grant bucket, which would make
 * every absolute assertion below relative to a fixture detail; and it builds
 * two complete tenants, which is a great deal of work to repeat per test.
 *
 * Provisioned on the PLATFORM pool, exactly as production platform code does.
 */
async function freshWorkspace(): Promise<string> {
  const run = crypto.randomUUID();
  const user = await platform.user.create({
    data: {
      email: `credit-${run}@example.local`,
      name: 'Credit Fixture',
      status: 'ACTIVE',
    },
  });
  const workspace = await platform.workspace.create({
    data: {
      id: run,
      workspaceId: run,
      slug: `credit-${run.slice(0, 12)}`,
      name: 'Credit Fixture Workspace',
      ownerUserId: user.id,
      status: 'ACTIVE',
    },
  });
  await platform.creditWallet.create({ data: { workspaceId: workspace.id } });
  return workspace.id;
}

beforeAll(async () => {
  app = appRoleClient();
  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) throw new Error('DATABASE_PLATFORM_URL is required.');
  platform = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  ledger = new CreditLedgerService({ prisma: platform, policy: POLICY });
}, 90_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

async function balanceOf(workspaceId: string): Promise<bigint> {
  const wallet = await platform.creditWallet.findUnique({ where: { workspaceId } });
  return wallet?.balanceMilliCredits ?? 0n;
}

async function reservedOf(workspaceId: string): Promise<bigint> {
  const wallet = await platform.creditWallet.findUnique({ where: { workspaceId } });
  return wallet?.reservedMilliCredits ?? 0n;
}

/** Replay the whole ledger — the reconciliation docs/DATABASE.md §7.1 requires. */
async function replay(workspaceId: string): Promise<bigint> {
  const rows = await platform.creditTransaction.findMany({
    where: { workspaceId },
    orderBy: { occurredAt: 'asc' },
  });
  return rows.reduce((sum, row) => sum + row.amountMilliCredits, 0n);
}

describe('granting credits', () => {
  it('creates a bucket and moves the balance together', async () => {
    const workspaceId = await freshWorkspace();
    const before = await balanceOf(workspaceId);

    const grant = await ledger.grant({
      workspaceId,
      source: 'PLAN_GRANT',
      credits: 100,
      reason: 'test allowance',
      idempotencyKey: `grant-${workspaceId}-1`,
    });

    expect(grant.remainingMilliCredits).toBe(100n * MILLI_PER_CREDIT);
    expect(await balanceOf(workspaceId)).toBe(before + 100n * MILLI_PER_CREDIT);
  });

  it('a repeated grant key adds nothing the second time', async () => {
    const workspaceId = await freshWorkspace();
    const key = `grant-once-${workspaceId}`;

    await ledger.grant({
      workspaceId,
      source: 'PROMOTIONAL_GRANT',
      credits: 50,
      reason: 'promotional',
      idempotencyKey: key,
    });
    const after = await balanceOf(workspaceId);

    await ledger.grant({
      workspaceId,
      source: 'PROMOTIONAL_GRANT',
      credits: 50,
      reason: 'promotional',
      idempotencyKey: key,
    });

    expect(await balanceOf(workspaceId)).toBe(after);
    expect(
      await platform.creditGrant.count({ where: { workspaceId, source: 'PROMOTIONAL_GRANT' } }),
    ).toBe(1);
  });

  it('applies the policy expiry for the grant source', async () => {
    const workspaceId = await freshWorkspace();
    const pack = await ledger.grant({
      workspaceId,
      source: 'PACK_PURCHASE',
      credits: 10,
      reason: 'top-up',
      idempotencyKey: `pack-${workspaceId}`,
    });
    const plan = await ledger.grant({
      workspaceId,
      source: 'PLAN_GRANT',
      credits: 10,
      reason: 'allowance',
      idempotencyKey: `plan-${workspaceId}`,
    });

    // 12 months for a pack, and the fixture policy sets 0 for a plan grant,
    // which means it never expires.
    expect(pack.expiresAt).not.toBeNull();
    expect(plan.expiresAt).toBeNull();
  });

  it('refuses a non-positive grant', async () => {
    const workspaceId = await freshWorkspace();
    await expect(
      ledger.grant({
        workspaceId,
        source: 'PLAN_GRANT',
        credits: 0,
        reason: 'nothing',
        idempotencyKey: `zero-${workspaceId}`,
      }),
    ).rejects.toThrow(/positive whole number/);
  });
});

describe('reserve', () => {
  it('holds the estimate without spending it', async () => {
    const workspaceId = await freshWorkspace();
    await ledger.grant({
      workspaceId,
      source: 'PLAN_GRANT',
      credits: 100,
      reason: 'allowance',
      idempotencyKey: `g-${workspaceId}`,
    });
    const before = await balanceOf(workspaceId);

    await ledger.reserve({
      workspaceId,
      estimateMilliCredits: 20n * MILLI_PER_CREDIT,
      purpose: 'caption.generate',
      idempotencyKey: `r-${workspaceId}`,
    });

    // The balance is UNCHANGED. Only the hold moved.
    expect(await balanceOf(workspaceId)).toBe(before);
    expect(await reservedOf(workspaceId)).toBe(20n * MILLI_PER_CREDIT);
  });

  it('refuses when the wallet cannot cover the estimate (D-11 hard stop)', async () => {
    const workspaceId = await freshWorkspace();
    await ledger.grant({
      workspaceId,
      source: 'PLAN_GRANT',
      credits: 5,
      reason: 'allowance',
      idempotencyKey: `g-small-${workspaceId}`,
    });

    await expect(
      ledger.reserve({
        workspaceId,
        estimateMilliCredits: 50n * MILLI_PER_CREDIT,
        purpose: 'caption.generate',
        idempotencyKey: `r-big-${workspaceId}`,
      }),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);
  });

  it('the refusal creates no charge and no invoice line (AC-05.10)', async () => {
    const workspaceId = await freshWorkspace();
    const before = await balanceOf(workspaceId);

    await expect(
      ledger.reserve({
        workspaceId,
        estimateMilliCredits: 1_000_000n,
        purpose: 'caption.generate',
        idempotencyKey: `r-refused-${workspaceId}`,
      }),
    ).rejects.toThrow();

    expect(await balanceOf(workspaceId)).toBe(before);
    expect(
      await platform.creditTransaction.count({ where: { workspaceId, type: 'USAGE_CHARGE' } }),
    ).toBe(0);
  });

  it('a retried reserve returns the SAME reservation, not a second hold', async () => {
    const workspaceId = await freshWorkspace();
    await ledger.grant({
      workspaceId,
      source: 'PLAN_GRANT',
      credits: 100,
      reason: 'allowance',
      idempotencyKey: `g-retry-${workspaceId}`,
    });

    const key = `r-retry-${workspaceId}`;
    const first = await ledger.reserve({
      workspaceId,
      estimateMilliCredits: 10n * MILLI_PER_CREDIT,
      purpose: 'caption.generate',
      idempotencyKey: key,
    });
    const second = await ledger.reserve({
      workspaceId,
      estimateMilliCredits: 10n * MILLI_PER_CREDIT,
      purpose: 'caption.generate',
      idempotencyKey: key,
    });

    expect(second.id).toBe(first.id);
    expect(await reservedOf(workspaceId)).toBe(10n * MILLI_PER_CREDIT);
  });

  it('takes from the soonest-expiring bucket first (D-12)', async () => {
    const workspaceId = await freshWorkspace();
    await ledger.grant({
      workspaceId,
      source: 'PLAN_GRANT',
      credits: 50,
      reason: 'never expires',
      idempotencyKey: `g-perm-${workspaceId}`,
      expiresAt: null,
    });
    const expiring = await ledger.grant({
      workspaceId,
      source: 'PROMOTIONAL_GRANT',
      credits: 50,
      reason: 'expires soon',
      idempotencyKey: `g-exp-${workspaceId}`,
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const reservation = await ledger.reserve({
      workspaceId,
      estimateMilliCredits: 30n * MILLI_PER_CREDIT,
      purpose: 'caption.generate',
      idempotencyKey: `r-fifo-${workspaceId}`,
    });

    expect(reservation.allocations).toEqual([
      { grantId: expiring.id, milliCredits: 30n * MILLI_PER_CREDIT },
    ]);
  });
});

describe('settle', () => {
  async function reserved(credits: number, estimate: bigint) {
    const workspaceId = await freshWorkspace();
    await ledger.grant({
      workspaceId,
      source: 'PLAN_GRANT',
      credits,
      reason: 'allowance',
      idempotencyKey: `g-${workspaceId}`,
    });
    const reservation = await ledger.reserve({
      workspaceId,
      estimateMilliCredits: estimate,
      purpose: 'caption.generate',
      idempotencyKey: `r-${workspaceId}`,
    });
    return { workspaceId, reservation };
  }

  it('charges the actual and releases the difference', async () => {
    const { workspaceId, reservation } = await reserved(100, 20n * MILLI_PER_CREDIT);

    await ledger.settle(reservation.id, 8n * MILLI_PER_CREDIT, 'caption generated');

    expect(await balanceOf(workspaceId)).toBe(92n * MILLI_PER_CREDIT);
    // Nothing is left held: the estimate is gone whether it was spent or not.
    expect(await reservedOf(workspaceId)).toBe(0n);
  });

  it('settling twice charges once', async () => {
    const { workspaceId, reservation } = await reserved(100, 20n * MILLI_PER_CREDIT);

    await ledger.settle(reservation.id, 8n * MILLI_PER_CREDIT, 'caption generated');
    const after = await balanceOf(workspaceId);
    await ledger.settle(reservation.id, 8n * MILLI_PER_CREDIT, 'caption generated');

    expect(await balanceOf(workspaceId)).toBe(after);
    expect(
      await platform.creditTransaction.count({ where: { workspaceId, type: 'USAGE_CHARGE' } }),
    ).toBe(1);
  });

  it('refuses to settle above the reserved amount', async () => {
    const { reservation } = await reserved(100, 10n * MILLI_PER_CREDIT);
    await expect(ledger.settle(reservation.id, 50n * MILLI_PER_CREDIT, 'over')).rejects.toThrow(
      /cannot exceed/,
    );
  });

  it('a zero-cost settlement spends nothing but closes the hold', async () => {
    const { workspaceId, reservation } = await reserved(100, 20n * MILLI_PER_CREDIT);
    const before = await balanceOf(workspaceId);

    await ledger.settle(reservation.id, 0n, 'succeeded, consumed nothing');

    expect(await balanceOf(workspaceId)).toBe(before);
    expect(await reservedOf(workspaceId)).toBe(0n);
  });

  it('records which bucket each charge drew from', async () => {
    const { workspaceId, reservation } = await reserved(100, 20n * MILLI_PER_CREDIT);
    await ledger.settle(reservation.id, 20n * MILLI_PER_CREDIT, 'used in full');

    const charges = await platform.creditTransaction.findMany({
      where: { workspaceId, type: 'USAGE_CHARGE' },
    });
    expect(charges).toHaveLength(1);
    expect(charges[0]?.sourceGrantId).toBe(reservation.allocations[0]?.grantId);
  });
});

describe('release — the failure path', () => {
  it('a failed request costs nothing (CLAUDE.md §2.4)', async () => {
    const workspaceId = await freshWorkspace();
    await ledger.grant({
      workspaceId,
      source: 'PLAN_GRANT',
      credits: 100,
      reason: 'allowance',
      idempotencyKey: `g-fail-${workspaceId}`,
    });
    const before = await balanceOf(workspaceId);

    const reservation = await ledger.reserve({
      workspaceId,
      estimateMilliCredits: 30n * MILLI_PER_CREDIT,
      purpose: 'caption.generate',
      idempotencyKey: `r-fail-${workspaceId}`,
    });
    await ledger.release(reservation.id, 'provider returned an error');

    expect(await balanceOf(workspaceId)).toBe(before);
    expect(await reservedOf(workspaceId)).toBe(0n);
    expect(
      await platform.creditTransaction.count({ where: { workspaceId, type: 'USAGE_CHARGE' } }),
    ).toBe(0);
  });

  it('releasing a settled reservation does not refund it', async () => {
    const workspaceId = await freshWorkspace();
    await ledger.grant({
      workspaceId,
      source: 'PLAN_GRANT',
      credits: 100,
      reason: 'allowance',
      idempotencyKey: `g-rs-${workspaceId}`,
    });
    const reservation = await ledger.reserve({
      workspaceId,
      estimateMilliCredits: 30n * MILLI_PER_CREDIT,
      purpose: 'caption.generate',
      idempotencyKey: `r-rs-${workspaceId}`,
    });
    await ledger.settle(reservation.id, 30n * MILLI_PER_CREDIT, 'used');
    const after = await balanceOf(workspaceId);

    await ledger.release(reservation.id, 'late release attempt');

    expect(await balanceOf(workspaceId)).toBe(after);
  });

  it('the sweeper releases an abandoned reservation', async () => {
    const workspaceId = await freshWorkspace();
    await ledger.grant({
      workspaceId,
      source: 'PLAN_GRANT',
      credits: 100,
      reason: 'allowance',
      idempotencyKey: `g-sweep-${workspaceId}`,
    });
    const reservation = await ledger.reserve({
      workspaceId,
      estimateMilliCredits: 30n * MILLI_PER_CREDIT,
      purpose: 'caption.generate',
      idempotencyKey: `r-sweep-${workspaceId}`,
      // Already past its deadline.
      ttlSeconds: 1,
    });
    await platform.creditReservation.update({
      where: { id: reservation.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const result = await ledger.sweepAbandonedReservations();

    expect(result.swept).toBeGreaterThanOrEqual(1);
    expect((await ledger.reservation(reservation.id)).status).toBe('EXPIRED');
    expect(await reservedOf(workspaceId)).toBe(0n);
  });

  it('one unreleasable reservation does not stop the sweep', async () => {
    // A reservation whose bucket does not record the hold it claims cannot be
    // released: the decrement would take `reserved` below zero and the CHECK
    // constraint refuses it. That row must be REPORTED, not allowed to abort
    // the batch — reservation leaks are a metric that must stay at zero, and a
    // sweeper that dies on the first bad row stops releasing every valid
    // reservation behind it.
    //
    // The two live in SEPARATE workspaces on purpose. Sharing a bucket would
    // let the healthy reservation's hold absorb the corrupt one's decrement,
    // and the release would quietly succeed — testing nothing.
    const corruptWorkspace = await freshWorkspace();
    const healthyWorkspace = await freshWorkspace();

    const bucket = await ledger.grant({
      workspaceId: corruptWorkspace,
      source: 'PLAN_GRANT',
      credits: 50,
      reason: 'allowance',
      idempotencyKey: `g-corrupt-${corruptWorkspace}`,
    });
    const corruptWallet = await platform.creditWallet.findUniqueOrThrow({
      where: { workspaceId: corruptWorkspace },
    });
    const corrupt = await platform.creditReservation.create({
      data: {
        workspaceId: corruptWorkspace,
        walletId: corruptWallet.id,
        idempotencyKey: `corrupt-${corruptWorkspace}`,
        estimateMilliCredits: 1000n,
        // The bucket records NO hold, so this allocation is unbacked.
        allocations: [{ grantId: bucket.id, milliCredits: '1000' }],
        purpose: 'corrupt.fixture',
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    await ledger.grant({
      workspaceId: healthyWorkspace,
      source: 'PLAN_GRANT',
      credits: 50,
      reason: 'allowance',
      idempotencyKey: `g-healthy-${healthyWorkspace}`,
    });
    const healthy = await ledger.reserve({
      workspaceId: healthyWorkspace,
      estimateMilliCredits: 10n * MILLI_PER_CREDIT,
      purpose: 'caption.generate',
      idempotencyKey: `r-healthy-${healthyWorkspace}`,
      ttlSeconds: 1,
    });
    await platform.creditReservation.update({
      where: { id: healthy.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const result = await ledger.sweepAbandonedReservations();

    expect(result.failed).toContain(corrupt.id);
    // The valid one behind it was still released.
    expect((await ledger.reservation(healthy.id)).status).toBe('EXPIRED');
    expect(await reservedOf(healthyWorkspace)).toBe(0n);
  });
});

describe('concurrency', () => {
  it('parallel reservations cannot together exceed the balance', async () => {
    // The property CLAUDE.md §2.4 states: "balances must never go negative;
    // concurrency is controlled by database-level locking". Ten parallel
    // requests against a wallet sized for three.
    const workspaceId = await freshWorkspace();
    await ledger.grant({
      workspaceId,
      source: 'PLAN_GRANT',
      credits: 30,
      reason: 'allowance',
      idempotencyKey: `g-conc-${workspaceId}`,
    });

    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        ledger.reserve({
          workspaceId,
          estimateMilliCredits: 10n * MILLI_PER_CREDIT,
          purpose: 'caption.generate',
          idempotencyKey: `r-conc-${workspaceId}-${i}`,
        }),
      ),
    );

    const granted = attempts.filter((a) => a.status === 'fulfilled').length;
    expect(granted).toBe(3);
    expect(await reservedOf(workspaceId)).toBe(30n * MILLI_PER_CREDIT);
    // And the balance never went below zero at any point.
    expect(await balanceOf(workspaceId)).toBeGreaterThanOrEqual(0n);
  });

  it('parallel settlements of distinct reservations all land', async () => {
    const workspaceId = await freshWorkspace();
    await ledger.grant({
      workspaceId,
      source: 'PLAN_GRANT',
      credits: 100,
      reason: 'allowance',
      idempotencyKey: `g-settle-conc-${workspaceId}`,
    });

    const reservations = [];
    for (let i = 0; i < 5; i += 1) {
      reservations.push(
        await ledger.reserve({
          workspaceId,
          estimateMilliCredits: 10n * MILLI_PER_CREDIT,
          purpose: 'caption.generate',
          idempotencyKey: `r-settle-conc-${workspaceId}-${i}`,
        }),
      );
    }

    await Promise.all(reservations.map((r) => ledger.settle(r.id, 10n * MILLI_PER_CREDIT, 'used')));

    expect(await balanceOf(workspaceId)).toBe(50n * MILLI_PER_CREDIT);
    expect(await reservedOf(workspaceId)).toBe(0n);
  });

  it('the same idempotency key raced ten times produces ONE hold', async () => {
    const workspaceId = await freshWorkspace();
    await ledger.grant({
      workspaceId,
      source: 'PLAN_GRANT',
      credits: 100,
      reason: 'allowance',
      idempotencyKey: `g-race-${workspaceId}`,
    });

    const key = `r-race-${workspaceId}`;
    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        ledger.reserve({
          workspaceId,
          estimateMilliCredits: 10n * MILLI_PER_CREDIT,
          purpose: 'caption.generate',
          idempotencyKey: key,
        }),
      ),
    );

    // Some may lose the unique-index race and throw; what must NOT happen is
    // two holds against the wallet.
    expect(attempts.some((a) => a.status === 'fulfilled')).toBe(true);
    expect(await reservedOf(workspaceId)).toBe(10n * MILLI_PER_CREDIT);
  });
});

describe('ledger replay reproduces the balance exactly', () => {
  it('after a full grant / reserve / settle / release / expire cycle', async () => {
    const workspaceId = await freshWorkspace();

    await ledger.grant({
      workspaceId,
      source: 'PLAN_GRANT',
      credits: 100,
      reason: 'allowance',
      idempotencyKey: `rp-g1-${workspaceId}`,
    });
    await ledger.grant({
      workspaceId,
      source: 'PACK_PURCHASE',
      credits: 40,
      reason: 'top-up',
      idempotencyKey: `rp-g2-${workspaceId}`,
    });

    const settled = await ledger.reserve({
      workspaceId,
      estimateMilliCredits: 25n * MILLI_PER_CREDIT,
      purpose: 'caption.generate',
      idempotencyKey: `rp-r1-${workspaceId}`,
    });
    await ledger.settle(settled.id, 12n * MILLI_PER_CREDIT, 'used');

    const released = await ledger.reserve({
      workspaceId,
      estimateMilliCredits: 15n * MILLI_PER_CREDIT,
      purpose: 'caption.generate',
      idempotencyKey: `rp-r2-${workspaceId}`,
    });
    await ledger.release(released.id, 'failed');

    // The whole point of an immutable ledger: replay must equal the projection.
    expect(await replay(workspaceId)).toBe(await balanceOf(workspaceId));
  });

  it('the buckets sum to the wallet balance', async () => {
    const workspaceId = await freshWorkspace();
    await ledger.grant({
      workspaceId,
      source: 'PLAN_GRANT',
      credits: 60,
      reason: 'allowance',
      idempotencyKey: `sum-g1-${workspaceId}`,
    });
    const reservation = await ledger.reserve({
      workspaceId,
      estimateMilliCredits: 20n * MILLI_PER_CREDIT,
      purpose: 'caption.generate',
      idempotencyKey: `sum-r1-${workspaceId}`,
    });
    await ledger.settle(reservation.id, 20n * MILLI_PER_CREDIT, 'used');

    const buckets = await platform.creditGrant.findMany({ where: { workspaceId } });
    const bucketTotal = buckets.reduce((sum, b) => sum + b.remainingMilliCredits, 0n);
    expect(bucketTotal).toBe(await balanceOf(workspaceId));
  });
});

describe('expiry', () => {
  it('writes off a lapsed bucket and the balance follows', async () => {
    const workspaceId = await freshWorkspace();
    await ledger.grant({
      workspaceId,
      source: 'PROMOTIONAL_GRANT',
      credits: 25,
      reason: 'lapsed promo',
      idempotencyKey: `exp-g-${workspaceId}`,
      expiresAt: new Date(Date.now() - 86_400_000),
    });
    const before = await balanceOf(workspaceId);
    expect(before).toBe(25n * MILLI_PER_CREDIT);

    const expired = await ledger.expireLapsedGrants(workspaceId);

    expect(expired).toBe(25n * MILLI_PER_CREDIT);
    expect(await balanceOf(workspaceId)).toBe(0n);
    expect(await replay(workspaceId)).toBe(0n);
  });

  it('leaves credits that are reserved by a request in flight', async () => {
    // A sweep must not make a settlement fail because it ran first.
    const workspaceId = await freshWorkspace();
    const bucket = await ledger.grant({
      workspaceId,
      source: 'PROMOTIONAL_GRANT',
      credits: 30,
      reason: 'promo',
      idempotencyKey: `exp-hold-g-${workspaceId}`,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const reservation = await ledger.reserve({
      workspaceId,
      estimateMilliCredits: 10n * MILLI_PER_CREDIT,
      purpose: 'caption.generate',
      idempotencyKey: `exp-hold-r-${workspaceId}`,
    });

    await platform.creditGrant.update({
      where: { id: bucket.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await ledger.expireLapsedGrants(workspaceId);

    // 20 written off, 10 still held for the in-flight request.
    expect(await balanceOf(workspaceId)).toBe(10n * MILLI_PER_CREDIT);
    await ledger.settle(reservation.id, 10n * MILLI_PER_CREDIT, 'completed after the sweep');
    expect(await balanceOf(workspaceId)).toBe(0n);
  });

  it('an expired bucket is not spendable even though the total looks sufficient', async () => {
    const workspaceId = await freshWorkspace();
    await ledger.grant({
      workspaceId,
      source: 'PROMOTIONAL_GRANT',
      credits: 100,
      reason: 'promo',
      idempotencyKey: `exp-unspend-${workspaceId}`,
      expiresAt: new Date(Date.now() - 1000),
    });

    await expect(
      ledger.reserve({
        workspaceId,
        estimateMilliCredits: 50n * MILLI_PER_CREDIT,
        purpose: 'caption.generate',
        idempotencyKey: `exp-unspend-r-${workspaceId}`,
      }),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);
  });
});

describe('cycle reset (D-12)', () => {
  it('caps the rollover at one monthly allowance and grants the new one', async () => {
    const workspaceId = await freshWorkspace();
    await ledger.grant({
      workspaceId,
      source: 'PLAN_GRANT',
      credits: 900,
      reason: 'unspent from previous cycles',
      idempotencyKey: `cyc-g-${workspaceId}`,
    });

    const result = await ledger.runCycleReset({
      workspaceId,
      monthlyCredits: 500,
      rolloverPolicy: 'capped',
      rolloverCapMultiplier: 1,
      cycleKey: `${workspaceId}:2026-02`,
      nextResetAt: new Date(Date.now() + 30 * 86_400_000),
    });

    // 900 carried, capped to 500, so 400 forfeited; then 500 granted.
    expect(result.forfeited).toBe(400n * MILLI_PER_CREDIT);
    expect(await balanceOf(workspaceId)).toBe(1000n * MILLI_PER_CREDIT);
    expect(await replay(workspaceId)).toBe(await balanceOf(workspaceId));
  });

  it('a "none" policy forfeits the whole carried balance', async () => {
    const workspaceId = await freshWorkspace();
    await ledger.grant({
      workspaceId,
      source: 'PLAN_GRANT',
      credits: 300,
      reason: 'unspent',
      idempotencyKey: `cyc-none-g-${workspaceId}`,
    });

    await ledger.runCycleReset({
      workspaceId,
      monthlyCredits: 100,
      rolloverPolicy: 'none',
      rolloverCapMultiplier: 0,
      cycleKey: `${workspaceId}:none`,
      nextResetAt: null,
    });

    expect(await balanceOf(workspaceId)).toBe(100n * MILLI_PER_CREDIT);
  });

  it('expires before it rolls over, so lapsed credits are never carried', async () => {
    const workspaceId = await freshWorkspace();
    await ledger.grant({
      workspaceId,
      source: 'PROMOTIONAL_GRANT',
      credits: 200,
      reason: 'lapsed',
      idempotencyKey: `cyc-exp-${workspaceId}`,
      expiresAt: new Date(Date.now() - 1000),
    });

    await ledger.runCycleReset({
      workspaceId,
      monthlyCredits: 100,
      rolloverPolicy: 'full',
      rolloverCapMultiplier: 0,
      cycleKey: `${workspaceId}:exp`,
      nextResetAt: null,
    });

    // The 200 lapsed rather than rolling over under a `full` policy.
    expect(await balanceOf(workspaceId)).toBe(100n * MILLI_PER_CREDIT);
  });

  it('a repeated cycle key grants the allowance only once', async () => {
    const workspaceId = await freshWorkspace();
    const cycleKey = `${workspaceId}:repeat`;

    await ledger.runCycleReset({
      workspaceId,
      monthlyCredits: 100,
      rolloverPolicy: 'full',
      rolloverCapMultiplier: 0,
      cycleKey,
      nextResetAt: null,
    });
    const after = await balanceOf(workspaceId);

    await ledger.runCycleReset({
      workspaceId,
      monthlyCredits: 100,
      rolloverPolicy: 'full',
      rolloverCapMultiplier: 0,
      cycleKey,
      nextResetAt: null,
    });

    expect(await balanceOf(workspaceId)).toBe(after);
  });
});

describe('low-balance notice', () => {
  it('reports a crossing once, then stays quiet', async () => {
    const workspaceId = await freshWorkspace();
    await ledger.grant({
      workspaceId,
      source: 'PLAN_GRANT',
      credits: 10,
      reason: 'nearly empty',
      idempotencyKey: `low-${workspaceId}`,
    });

    expect(await ledger.noteLowBalance(workspaceId, 100)).toBe(20);
    expect(await ledger.noteLowBalance(workspaceId, 100)).toBeNull();
  });
});
