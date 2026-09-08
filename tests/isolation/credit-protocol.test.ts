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
 * Every workspace this RUN provisioned — see the cleanup in `afterAll`.
 *
 * F-53's second half, in a suite that is not about secrets at all. This one
 * leaves OPEN reservations past their deadline behind on every run, and
 * `sweepAbandonedReservations` reads a BOUNDED window of them (200). Once the
 * residue passed that window the sweeper tests started failing intermittently:
 * the sweep filled its window with rows from runs months old and never reached
 * the reservation the test had just made. The suite was right and the data was
 * stale, which is exactly the shape F-53 had.
 */
const CREATED_WORKSPACE_IDS: string[] = [];

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
  CREATED_WORKSPACE_IDS.push(workspace.id);
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
  /*
   * Remove this run's RESERVATIONS — only those, and only for the workspaces
   * this run created.
   *
   * Reservations are the rows that matter here because a global, bounded query
   * reads them: leave enough behind and the sweeper's window never reaches a
   * fresh one. The grants, transactions, wallets and workspaces also linger,
   * but nothing queries those under a limit, so they are left alone rather
   * than widening this into a general-purpose delete (see F-61).
   *
   * Scoped by id to workspaces provisioned in THIS process, so a suite running
   * in parallel keeps its own fixtures.
   */
  if (platform && CREATED_WORKSPACE_IDS.length > 0) {
    await platform.creditReservation.deleteMany({
      where: { workspaceId: { in: CREATED_WORKSPACE_IDS } },
    });
  }
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

  it('creates the wallet on first movement, even under a race', async () => {
    // A workspace whose first credit movement arrives from several requests at
    // once. `ON CONFLICT DO NOTHING` rather than a caught unique violation: a
    // failed statement aborts the surrounding PostgreSQL transaction, so the
    // catch would leave every later statement in that transaction failing.
    const run = crypto.randomUUID();
    const user = await platform.user.create({
      data: { email: `race-${run}@example.local`, name: 'Race Fixture', status: 'ACTIVE' },
    });
    const workspace = await platform.workspace.create({
      data: {
        id: run,
        workspaceId: run,
        slug: `race-${run.slice(0, 12)}`,
        name: 'Race Fixture Workspace',
        ownerUserId: user.id,
        status: 'ACTIVE',
      },
    });
    // Deliberately NO wallet.

    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        ledger.grant({
          workspaceId: workspace.id,
          source: 'PROMOTIONAL_GRANT',
          credits: 10,
          reason: 'concurrent first movement',
          idempotencyKey: `first-${workspace.id}-${i}`,
        }),
      ),
    );

    expect(attempts.every((a) => a.status === 'fulfilled')).toBe(true);
    expect(await balanceOf(workspace.id)).toBe(50n * MILLI_PER_CREDIT);
    expect(await platform.creditWallet.count({ where: { workspaceId: workspace.id } })).toBe(1);
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

  /*
   * A-7 / F-62. A SWEEP MUST NOT BE STARVABLE.
   *
   * The old sweeper read one unordered window of `take: limit` rows. An
   * unreleasable reservation is reported and stays OPEN, so it came back in
   * every window: once `limit` of them existed the sweep released nothing, for
   * ever, and every valid reservation behind them leaked. These are the
   * assertions that would have caught that.
   */
  describe('the sweep cannot be starved by rows it can never release', () => {
    /** A reservation whose bucket records no hold, so releasing it is refused. */
    async function unreleasable(workspaceId: string, walletId: string, grantId: string, n: number) {
      return platform.creditReservation.create({
        data: {
          workspaceId,
          walletId,
          idempotencyKey: `starve-corrupt-${workspaceId}-${n}`,
          estimateMilliCredits: 1000n,
          allocations: [{ grantId, milliCredits: '1000' }],
          purpose: 'corrupt.fixture',
          // Oldest of all, so a deterministic oldest-first order puts every one
          // of them AHEAD of the healthy row. Without progress semantics the
          // healthy row is never reached.
          expiresAt: new Date(Date.now() - 3_600_000),
        },
      });
    }

    it('releases a healthy reservation sitting behind a full window of failures', async () => {
      const corruptWorkspace = await freshWorkspace();
      const bucket = await ledger.grant({
        workspaceId: corruptWorkspace,
        source: 'PLAN_GRANT',
        credits: 50,
        reason: 'allowance',
        idempotencyKey: `g-starve-${corruptWorkspace}`,
      });
      const wallet = await platform.creditWallet.findUniqueOrThrow({
        where: { workspaceId: corruptWorkspace },
      });

      // MORE unreleasable rows than one batch holds, all older than the
      // healthy one. This is the exact shape that made the sweep useless.
      const BLOCKERS = 60;
      for (let i = 0; i < BLOCKERS; i += 1) {
        await unreleasable(corruptWorkspace, wallet.id, bucket.id, i);
      }

      const healthyWorkspace = await freshWorkspace();
      await ledger.grant({
        workspaceId: healthyWorkspace,
        source: 'PLAN_GRANT',
        credits: 50,
        reason: 'allowance',
        idempotencyKey: `g-starve-healthy-${healthyWorkspace}`,
      });
      const healthy = await ledger.reserve({
        workspaceId: healthyWorkspace,
        estimateMilliCredits: 10n * MILLI_PER_CREDIT,
        purpose: 'caption.generate',
        idempotencyKey: `r-starve-healthy-${healthyWorkspace}`,
        ttlSeconds: 1,
      });
      await platform.creditReservation.update({
        where: { id: healthy.id },
        // Newer than every blocker, so oldest-first reaches it LAST.
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });

      const result = await ledger.sweepAbandonedReservations();

      expect(result.failed.length).toBeGreaterThanOrEqual(BLOCKERS);
      expect(result.swept, 'the sweep must get past the blockers').toBeGreaterThanOrEqual(1);
      expect((await ledger.reservation(healthy.id)).status).toBe('EXPIRED');
      expect(await reservedOf(healthyWorkspace)).toBe(0n);
      // It examined more rows than it released, which is the progress semantics.
      expect(result.attempted).toBeGreaterThan(result.swept);
    });

    it('orders oldest-first, deterministically', async () => {
      const workspaceId = await freshWorkspace();
      await ledger.grant({
        workspaceId,
        source: 'PLAN_GRANT',
        credits: 100,
        reason: 'allowance',
        idempotencyKey: `g-order-${workspaceId}`,
      });

      // Three abandoned reservations, deadlines an hour apart, created in the
      // WRONG order so insertion order cannot be what the sweep follows.
      const ages = [1_000, 7_200_000, 3_600_000];
      const made: { id: string; age: number }[] = [];
      for (const [i, age] of ages.entries()) {
        const r = await ledger.reserve({
          workspaceId,
          estimateMilliCredits: 5n * MILLI_PER_CREDIT,
          purpose: 'caption.generate',
          idempotencyKey: `r-order-${workspaceId}-${i}`,
          ttlSeconds: 1,
        });
        await platform.creditReservation.update({
          where: { id: r.id },
          data: { expiresAt: new Date(Date.now() - age) },
        });
        made.push({ id: r.id, age });
      }

      /*
       * THE ASSERTION IS ABOUT MY THREE ROWS, not about the whole table.
       *
       * The sweep is global by design, and this database is shared: it holds
       * abandoned rows from other suites and from runs long past. Asserting
       * "the globally oldest row was released" would be asserting a fact about
       * that residue, not about the ordering. What the ordering guarantees,
       * and what is immune to whatever else is in the table, is that the FIRST
       * OF MINE to be released is MY OLDEST.
       *
       * `maxAttempts` is generous because each pass re-attempts every
       * unreleasable row ahead of mine — that is the cost of a shared
       * database, not a property of the sweep.
       */
      const oldest = made.reduce((a, b) => (b.age > a.age ? b : a));
      let firstOfMine: string | null = null;

      for (let pass = 0; pass < 5 && firstOfMine === null; pass += 1) {
        await ledger.sweepAbandonedReservations(1, { maxAttempts: 5_000 });
        for (const row of made) {
          if ((await ledger.reservation(row.id)).status === 'EXPIRED') {
            firstOfMine = row.id;
            break;
          }
        }
      }

      expect(firstOfMine, "the sweep released none of this test's rows").not.toBeNull();
      expect(firstOfMine, 'the oldest leak must be released first').toBe(oldest.id);
    });

    it('reports whether it reached the end of the abandoned set', async () => {
      // `swept` alone cannot tell "no leak left" from "hit the bound, more to
      // do". A caller alerting on leaks needs that difference.
      const workspaceId = await freshWorkspace();
      await ledger.grant({
        workspaceId,
        source: 'PLAN_GRANT',
        credits: 100,
        reason: 'allowance',
        idempotencyKey: `g-exhaust-${workspaceId}`,
      });
      const r = await ledger.reserve({
        workspaceId,
        estimateMilliCredits: 5n * MILLI_PER_CREDIT,
        purpose: 'caption.generate',
        idempotencyKey: `r-exhaust-${workspaceId}`,
        ttlSeconds: 1,
      });
      await platform.creditReservation.update({
        where: { id: r.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      // Stopping AT THE LIMIT is reported as "not exhausted": there may well
      // be more to do. That is the distinction a bare count cannot make.
      const bounded = await ledger.sweepAbandonedReservations(1, { maxAttempts: 5_000 });
      expect(bounded.swept, 'the limit bounds RELEASES').toBe(1);
      expect(bounded.exhausted, 'stopping at the limit is not exhaustion').toBe(false);
      /*
       * Deliberately NOT asserting that `r` is the row that got released. The
       * sweep is global and oldest-first, and other rows in this shared
       * database are older; a limit of one goes to whichever of THOSE comes
       * first. What this test is about is the reporting, and `r` is confirmed
       * released by the drain below.
       */

      // Now drain: with a bound generous enough to try every candidate, the
      // sweep must eventually report that it reached the end — including when
      // everything left is unreleasable, which is precisely the state that
      // used to look identical to "nothing to do".
      for (let pass = 0; pass < 20; pass += 1) {
        const drain = await ledger.sweepAbandonedReservations(500, { maxAttempts: 5_000 });
        if (drain.exhausted) {
          expect(drain.attempted).toBeGreaterThanOrEqual(drain.swept);
          // Reaching the end means every releasable row was released,
          // this test's included.
          expect((await ledger.reservation(r.id)).status).toBe('EXPIRED');
          return;
        }
      }
      throw new Error('the sweep never reported reaching the end of the abandoned set');
    });

    it('bounds its own work rather than looping on unreleasable rows', async () => {
      const workspaceId = await freshWorkspace();
      const bucket = await ledger.grant({
        workspaceId,
        source: 'PLAN_GRANT',
        credits: 50,
        reason: 'allowance',
        idempotencyKey: `g-bound-${workspaceId}`,
      });
      const wallet = await platform.creditWallet.findUniqueOrThrow({ where: { workspaceId } });
      for (let i = 0; i < 12; i += 1) {
        await unreleasable(workspaceId, wallet.id, bucket.id, 1000 + i);
      }

      // Nothing releasable exists for these rows, so the sweep must stop by
      // its own bound instead of re-reading the same failures for ever.
      const result = await ledger.sweepAbandonedReservations(2, { maxAttempts: 5 });
      expect(result.attempted).toBeLessThanOrEqual(5);
      expect(result.exhausted).toBe(false);
    });
  });
});

/*
 * A-8. A RETRY IS A NORMAL EVENT, NOT AN ERROR.
 *
 * `settle` and `release` read the reservation status through an UNLOCKED
 * findUnique, so two concurrent calls both saw OPEN and both proceeded. They
 * serialised on the wallet lock, by which point the loser was already
 * committed to writing: it decremented every hold a second time and reused the
 * winner's idempotency key, surfacing a CHECK violation or a P2002 as a 500 —
 * for work that had actually succeeded.
 *
 * The constraints were right. What was missing is that the loser must observe
 * a terminal status and stop.
 */
describe('concurrent settlement and release are idempotent', () => {
  /** A workspace with a grant and one OPEN reservation against it. */
  async function reservationFor(tag: string, estimateCredits = 10) {
    const workspaceId = await freshWorkspace();
    await ledger.grant({
      workspaceId,
      source: 'PLAN_GRANT',
      credits: 100,
      reason: 'allowance',
      idempotencyKey: `g-${tag}-${workspaceId}`,
    });
    const reservation = await ledger.reserve({
      workspaceId,
      estimateMilliCredits: BigInt(estimateCredits) * MILLI_PER_CREDIT,
      purpose: 'caption.generate',
      idempotencyKey: `r-${tag}-${workspaceId}`,
    });
    return { workspaceId, reservation };
  }

  it('settles once under eight concurrent settlements, with no 500s', async () => {
    const { workspaceId, reservation } = await reservationFor('settle-race');
    const before = await balanceOf(workspaceId);
    const charge = 6n * MILLI_PER_CREDIT;

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => ledger.settle(reservation.id, charge, 'concurrent settle')),
    );

    // EVERY call succeeds. The old behaviour was seven rejections carrying a
    // constraint violation, which is a 500 to whoever retried.
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(
      rejected.map((r) => String((r as PromiseRejectedResult).reason)),
      'a retry must not surface an error',
    ).toEqual([]);

    // Charged exactly once.
    expect(await balanceOf(workspaceId)).toBe(before - charge);
    expect((await ledger.reservation(reservation.id)).status).toBe('SETTLED');
    expect(await reservedOf(workspaceId)).toBe(0n);

    const charges = await platform.creditTransaction.findMany({
      where: { reservationId: reservation.id, type: 'USAGE_CHARGE' },
    });
    expect(charges).toHaveLength(1);
  });

  it('releases once under eight concurrent releases, with no 500s', async () => {
    const { workspaceId, reservation } = await reservationFor('release-race');
    const before = await balanceOf(workspaceId);

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => ledger.release(reservation.id, 'concurrent release')),
    );

    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    expect(await balanceOf(workspaceId)).toBe(before);
    expect(await reservedOf(workspaceId)).toBe(0n);
    expect((await ledger.reservation(reservation.id)).status).toBe('RELEASED');

    const releases = await platform.creditTransaction.findMany({
      where: { reservationId: reservation.id, type: 'RESERVATION_RELEASE' },
    });
    expect(releases).toHaveLength(1);
  });

  it('settle racing release resolves to exactly one outcome', async () => {
    // The cross case. Whichever wins, the other must observe the terminal
    // status and stop — and the hold must be given back exactly once either
    // way, never twice.
    const { workspaceId, reservation } = await reservationFor('cross-race');
    const before = await balanceOf(workspaceId);
    const charge = 4n * MILLI_PER_CREDIT;

    const results = await Promise.allSettled([
      ledger.settle(reservation.id, charge, 'racing settle'),
      ledger.release(reservation.id, 'racing release'),
      ledger.settle(reservation.id, charge, 'racing settle again'),
      ledger.release(reservation.id, 'racing release again'),
    ]);
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);

    const final = await ledger.reservation(reservation.id);
    expect(['SETTLED', 'RELEASED']).toContain(final.status);
    expect(await reservedOf(workspaceId)).toBe(0n);

    // The balance matches the outcome that actually happened — not some
    // interleaving of both.
    const after = await balanceOf(workspaceId);
    expect(after).toBe(final.status === 'SETTLED' ? before - charge : before);

    const charges = await platform.creditTransaction.findMany({
      where: { reservationId: reservation.id, type: 'USAGE_CHARGE' },
    });
    expect(charges).toHaveLength(final.status === 'SETTLED' ? 1 : 0);
  });

  it('a sweep racing a settle does not double-release the hold', async () => {
    // The sweeper is just another caller of `release`, and it runs on a timer
    // against reservations a request may be settling at that very moment.
    const { workspaceId, reservation } = await reservationFor('sweep-race');
    await platform.creditReservation.update({
      where: { id: reservation.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const before = await balanceOf(workspaceId);

    const results = await Promise.allSettled([
      ledger.settle(reservation.id, 3n * MILLI_PER_CREDIT, 'settled just in time'),
      ledger.sweepAbandonedReservations(500, { maxAttempts: 5_000 }),
    ]);
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);

    const final = await ledger.reservation(reservation.id);
    expect(['SETTLED', 'EXPIRED']).toContain(final.status);
    expect(await reservedOf(workspaceId)).toBe(0n);
    expect(await balanceOf(workspaceId)).toBe(
      final.status === 'SETTLED' ? before - 3n * MILLI_PER_CREDIT : before,
    );
  });
});

/*
 * A-9, grants. The same rule, in the ledger.
 *
 * `grant` returned the stored bucket for ANY request carrying a known key. A
 * caller for workspace B replaying workspace A's key was handed A's bucket and
 * told the grant had happened — a view of another tenant's row, reached through
 * an idempotency check rather than a query.
 */
describe('grant replays are scoped to the original request', () => {
  it('refuses a grant key replayed against a different workspace', async () => {
    const first = await freshWorkspace();
    const second = await freshWorkspace();
    const key = `grant-cross-${crypto.randomUUID()}`;

    const original = await ledger.grant({
      workspaceId: first,
      source: 'PLAN_GRANT',
      credits: 100,
      reason: 'allowance',
      idempotencyKey: key,
    });

    await expect(
      ledger.grant({
        workspaceId: second,
        source: 'PLAN_GRANT',
        credits: 100,
        reason: 'allowance',
        idempotencyKey: key,
      }),
    ).rejects.toThrow('That idempotency key was used for a different credit movement.');

    // The second workspace got nothing — not a balance, and not a handle on
    // the first workspace's bucket.
    expect(await balanceOf(second)).toBe(0n);
    const bucketsForSecond = await platform.creditGrant.findMany({
      where: { workspaceId: second },
    });
    expect(bucketsForSecond).toHaveLength(0);
    // And the first workspace's bucket is still exactly where it was.
    const originalRow = await platform.creditGrant.findUniqueOrThrow({
      where: { id: original.id },
    });
    expect(originalRow.workspaceId).toBe(first);
  });

  it('refuses a grant key replayed with a different amount or source', async () => {
    const workspaceId = await freshWorkspace();
    const key = `grant-mismatch-${crypto.randomUUID()}`;
    await ledger.grant({
      workspaceId,
      source: 'PLAN_GRANT',
      credits: 100,
      reason: 'allowance',
      idempotencyKey: key,
    });
    const before = await balanceOf(workspaceId);

    await expect(
      ledger.grant({
        workspaceId,
        source: 'PLAN_GRANT',
        credits: 5000,
        reason: 'allowance',
        idempotencyKey: key,
      }),
    ).rejects.toThrow('That idempotency key was used for a different credit movement.');

    await expect(
      ledger.grant({
        workspaceId,
        source: 'PROMOTIONAL_GRANT',
        credits: 100,
        reason: 'allowance',
        idempotencyKey: key,
      }),
    ).rejects.toThrow('That idempotency key was used for a different credit movement.');

    expect(await balanceOf(workspaceId)).toBe(before);
  });

  it('still treats a genuine retry as the same grant', async () => {
    const workspaceId = await freshWorkspace();
    const input = {
      workspaceId,
      source: 'PLAN_GRANT' as const,
      credits: 100,
      reason: 'allowance',
      idempotencyKey: `grant-same-${crypto.randomUUID()}`,
    };
    const first = await ledger.grant(input);
    const second = await ledger.grant(input);

    expect(second.id).toBe(first.id);
    // Credited once, which is the property the key exists to guarantee.
    expect(await balanceOf(workspaceId)).toBe(100n * MILLI_PER_CREDIT);
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

/*
 * A-6. THE CYCLE BOUNDARY IS ONE UNIT, AND IT KNOWS ABOUT RESERVED CREDITS.
 *
 * It used to be four independent transactions with no cycle-level idempotency,
 * and the rollover cap was computed against a balance that included credits
 * reserved against in-flight requests — an excess that could not actually be
 * taken, whose shortfall nobody read.
 */
describe('cycle reset is atomic and retry-safe', () => {
  it('applies a repeated cycle exactly once', async () => {
    // A duplicated scheduler tick, a retried job, a redelivered message. The
    // grant was already keyed on the cycle and no-opped correctly; the
    // FORFEITURE was keyed per bucket, so a second pass ran FIFO against the
    // buckets that survived the first and charged the customer again.
    const workspaceId = await freshWorkspace();
    await ledger.grant({
      workspaceId,
      source: 'PLAN_GRANT',
      credits: 900,
      reason: 'unspent from previous cycles',
      idempotencyKey: `twice-g-${workspaceId}`,
    });

    const cycle = {
      workspaceId,
      monthlyCredits: 500,
      rolloverPolicy: 'capped' as const,
      rolloverCapMultiplier: 1,
      cycleKey: `${workspaceId}:2026-03`,
      nextResetAt: new Date(Date.now() + 30 * 86_400_000),
    };

    const first = await ledger.runCycleReset(cycle);
    expect(first.alreadyApplied).toBe(false);
    expect(first.forfeited).toBe(400n * MILLI_PER_CREDIT);
    const afterFirst = await balanceOf(workspaceId);
    expect(afterFirst).toBe(1000n * MILLI_PER_CREDIT);

    for (let repeat = 0; repeat < 3; repeat += 1) {
      const again = await ledger.runCycleReset(cycle);
      expect(again.alreadyApplied, 'a repeated cycle must say so').toBe(true);
      expect(again.forfeited).toBe(0n);
    }

    expect(await balanceOf(workspaceId), 'three retries cost nothing').toBe(afterFirst);
    expect(await replay(workspaceId)).toBe(await balanceOf(workspaceId));
  });

  it('refuses a cycle key belonging to another workspace', async () => {
    const first = await freshWorkspace();
    const second = await freshWorkspace();
    const cycleKey = `shared-cycle-${crypto.randomUUID()}`;

    await ledger.runCycleReset({
      workspaceId: first,
      monthlyCredits: 100,
      rolloverPolicy: 'none',
      rolloverCapMultiplier: 0,
      cycleKey,
      nextResetAt: null,
    });

    await expect(
      ledger.runCycleReset({
        workspaceId: second,
        monthlyCredits: 100,
        rolloverPolicy: 'none',
        rolloverCapMultiplier: 0,
        cycleKey,
        nextResetAt: null,
      }),
    ).rejects.toThrow('That cycle key was used for a different workspace.');

    // The second workspace got no allowance out of the collision.
    expect(await balanceOf(second)).toBe(0n);
  });

  it('leaves nothing half-applied when the boundary fails partway', async () => {
    /*
     * INJECTED FAILURE. The grant carries `plan-grant:<cycle>`; writing a row
     * under that key first makes the grant inside the reset collide, so the
     * transaction aborts AFTER expiry and forfeiture would have been written.
     *
     * Before this was one transaction, that left the customer forfeited with
     * no new allowance and no advanced timestamps — and a retry forfeited them
     * a second time.
     */
    const workspaceId = await freshWorkspace();
    await ledger.grant({
      workspaceId,
      source: 'PLAN_GRANT',
      credits: 900,
      reason: 'unspent',
      idempotencyKey: `partial-g-${workspaceId}`,
    });
    const before = await balanceOf(workspaceId);
    const cycleKey = `${workspaceId}:2026-04`;

    // Squat on the grant's idempotency key with a DIFFERENT amount, so the
    // replay-scope check inside the grant rejects it.
    await ledger.grant({
      workspaceId,
      source: 'PLAN_GRANT',
      credits: 7,
      reason: 'squatter',
      idempotencyKey: `plan-grant:${cycleKey}`,
    });
    const withSquatter = await balanceOf(workspaceId);

    await expect(
      ledger.runCycleReset({
        workspaceId,
        monthlyCredits: 500,
        rolloverPolicy: 'capped',
        rolloverCapMultiplier: 1,
        cycleKey,
        nextResetAt: new Date(Date.now() + 30 * 86_400_000),
      }),
    ).rejects.toThrow();

    // NOTHING was applied: not the forfeiture, not the timestamps, not a
    // completion marker.
    expect(await balanceOf(workspaceId)).toBe(withSquatter);
    expect(withSquatter).toBeGreaterThan(before);
    const resets = await platform.creditTransaction.findMany({
      where: { workspaceId, type: 'RESET' },
    });
    expect(resets, 'a failed boundary writes no RESET rows at all').toHaveLength(0);
    expect(await replay(workspaceId)).toBe(await balanceOf(workspaceId));
  });

  it('advances the cycle timestamps in the same unit as the money', async () => {
    const workspaceId = await freshWorkspace();
    const nextResetAt = new Date(Date.now() + 30 * 86_400_000);
    await ledger.runCycleReset({
      workspaceId,
      monthlyCredits: 250,
      rolloverPolicy: 'none',
      rolloverCapMultiplier: 0,
      cycleKey: `${workspaceId}:2026-05`,
      nextResetAt,
    });

    const wallet = await platform.creditWallet.findUniqueOrThrow({ where: { workspaceId } });
    expect(wallet.lastResetAt).not.toBeNull();
    expect(wallet.nextResetAt?.toISOString()).toBe(nextResetAt.toISOString());
    expect(wallet.balanceMilliCredits).toBe(250n * MILLI_PER_CREDIT);
  });
});

describe('the rollover cap accounts for reserved credits', () => {
  it('does not forfeit credits that are reserved against an in-flight request', async () => {
    /*
     * 900 carried, 700 of it reserved. The cap is 100, so 800 "should" be
     * forfeited — but only 200 is actually spendable. The old code asked
     * `allocateFifo` for 800, got 200 with a shortfall of 600, and threw the
     * shortfall away: the customer kept 700 above the cap, and got it back as
     * spendable balance the moment the request released.
     */
    const workspaceId = await freshWorkspace();
    await ledger.grant({
      workspaceId,
      source: 'PLAN_GRANT',
      credits: 900,
      reason: 'unspent',
      idempotencyKey: `res-cap-g-${workspaceId}`,
    });
    const reservation = await ledger.reserve({
      workspaceId,
      estimateMilliCredits: 700n * MILLI_PER_CREDIT,
      purpose: 'caption.generate',
      idempotencyKey: `res-cap-r-${workspaceId}`,
    });

    const result = await ledger.runCycleReset({
      workspaceId,
      monthlyCredits: 100,
      rolloverPolicy: 'capped',
      rolloverCapMultiplier: 1,
      cycleKey: `${workspaceId}:2026-06`,
      nextResetAt: null,
    });

    // Only the spendable 200 could be taken...
    expect(result.forfeited).toBe(200n * MILLI_PER_CREDIT);
    // ...and the 600 that could not is REPORTED rather than discarded.
    expect(
      result.unforfeitable,
      'excess that cannot be taken must not look like credit the customer kept legitimately',
    ).toBe(600n * MILLI_PER_CREDIT);

    // The in-flight request is untouched and still settles.
    expect((await ledger.reservation(reservation.id)).status).toBe('OPEN');
    await ledger.settle(reservation.id, 700n * MILLI_PER_CREDIT, 'settled after the boundary');
    expect(await replay(workspaceId)).toBe(await balanceOf(workspaceId));
  });

  it('reports no shortfall when nothing is reserved', async () => {
    const workspaceId = await freshWorkspace();
    await ledger.grant({
      workspaceId,
      source: 'PLAN_GRANT',
      credits: 900,
      reason: 'unspent',
      idempotencyKey: `nores-g-${workspaceId}`,
    });

    const result = await ledger.runCycleReset({
      workspaceId,
      monthlyCredits: 500,
      rolloverPolicy: 'capped',
      rolloverCapMultiplier: 1,
      cycleKey: `${workspaceId}:2026-07`,
      nextResetAt: null,
    });

    expect(result.forfeited).toBe(400n * MILLI_PER_CREDIT);
    expect(result.unforfeitable).toBe(0n);
  });
});
