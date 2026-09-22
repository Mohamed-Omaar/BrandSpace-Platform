import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QuotaExceededError, UsageService, quotaWindow } from '@brandspace/entitlements';

/**
 * Quota enforcement against a real PostgreSQL.
 *
 * The property under test is ATOMICITY, and it cannot be demonstrated without a
 * database. A read-then-write implementation passes every sequential test and
 * fails the moment two requests arrive together — which is the normal outcome
 * of two clicks, not a rare interleaving.
 */

let platform: PrismaClient;
let usage: UsageService;

async function freshWorkspace(): Promise<string> {
  const run = crypto.randomUUID();
  const user = await platform.user.create({
    data: {
      email: `quota-${run}@example.local`,
      name: 'Quota Fixture',
      status: 'ACTIVE',
      timezone: 'UTC',
    },
  });
  const workspace = await platform.workspace.create({
    data: {
      country: 'US',
      defaultLocale: 'EN',
      timezone: 'UTC',
      currency: 'USD',
      id: run,
      workspaceId: run,
      slug: `quota-${run.slice(0, 12)}`,
      name: 'Quota Fixture Workspace',
      ownerUserId: user.id,
      status: 'ACTIVE',
    },
  });
  return workspace.id;
}

beforeAll(async () => {
  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) throw new Error('DATABASE_PLATFORM_URL is required.');
  platform = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  usage = new UsageService({ prisma: platform });
}, 60_000);

afterAll(async () => {
  await platform?.$disconnect();
});

describe('consuming a quota', () => {
  it('counts up to the limit', async () => {
    const workspaceId = await freshWorkspace();
    for (let i = 0; i < 3; i += 1) {
      const result = await usage.consume({
        workspaceId,
        featureKey: 'limit.scheduled_posts',
        limitValue: 3,
        period: 'month',
        idempotencyKey: `q-${workspaceId}-${i}`,
      });
      expect(result.used).toBe(i + 1);
    }
  });

  it('refuses the request that would exceed it', async () => {
    const workspaceId = await freshWorkspace();
    await usage.consume({
      workspaceId,
      featureKey: 'limit.brands',
      limitValue: 1,
      period: 'total',
      idempotencyKey: `b-${workspaceId}-1`,
    });

    await expect(
      usage.consume({
        workspaceId,
        featureKey: 'limit.brands',
        limitValue: 1,
        period: 'total',
        idempotencyKey: `b-${workspaceId}-2`,
      }),
    ).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it('the refusal names the feature, the limit and the usage — and nothing else', async () => {
    // A customer may see their OWN plan's limit and their OWN usage. What must
    // not appear is the plan key, the price, or anything about another tenant.
    const workspaceId = await freshWorkspace();
    await usage.consume({
      workspaceId,
      featureKey: 'limit.brands',
      limitValue: 1,
      period: 'total',
      idempotencyKey: `bd-${workspaceId}-1`,
    });

    try {
      await usage.consume({
        workspaceId,
        featureKey: 'limit.brands',
        limitValue: 1,
        period: 'total',
        idempotencyKey: `bd-${workspaceId}-2`,
      });
      expect.unreachable('the quota should have refused');
    } catch (error) {
      const quota = error as QuotaExceededError;
      expect(quota.code).toBe('QUOTA_EXCEEDED');
      expect(quota.publicDetails).toEqual({
        featureKey: 'limit.brands',
        limitValue: 1,
        used: 1,
      });
    }
  });

  it('a first use already over the limit is refused, and records nothing', async () => {
    const workspaceId = await freshWorkspace();
    await expect(
      usage.consume({
        workspaceId,
        featureKey: 'limit.seats',
        limitValue: 2,
        period: 'total',
        amount: 5,
        idempotencyKey: `s-${workspaceId}`,
      }),
    ).rejects.toBeInstanceOf(QuotaExceededError);

    // The transaction rolled the INSERT back: there is no counter at all.
    const after = await usage.consumption({
      workspaceId,
      featureKey: 'limit.seats',
      limitValue: 2,
      period: 'total',
    });
    expect(after.used).toBe(0);
  });

  it('an unlimited quota still counts but never refuses', async () => {
    // The customer's usage view and the platform's reporting both need the
    // number, and `null` means unlimited — not zero.
    const workspaceId = await freshWorkspace();
    for (let i = 0; i < 5; i += 1) {
      await usage.consume({
        workspaceId,
        featureKey: 'limit.brands',
        limitValue: null,
        period: 'total',
        idempotencyKey: `u-${workspaceId}-${i}`,
      });
    }
    const result = await usage.consumption({
      workspaceId,
      featureKey: 'limit.brands',
      limitValue: null,
      period: 'total',
    });
    expect(result.used).toBe(5);
    expect(result.remaining).toBeNull();
  });
});

describe('idempotency', () => {
  it('a repeated recording does not consume twice', async () => {
    const workspaceId = await freshWorkspace();
    const key = `idem-${workspaceId}`;

    await usage.consume({
      workspaceId,
      featureKey: 'limit.scheduled_posts',
      limitValue: 10,
      period: 'month',
      idempotencyKey: key,
    });
    const second = await usage.consume({
      workspaceId,
      featureKey: 'limit.scheduled_posts',
      limitValue: 10,
      period: 'month',
      idempotencyKey: key,
    });

    expect(second.used).toBe(1);
  });

  it('a retry that RACES the first call still reports success, not an error', async () => {
    // Both calls see no idempotency record, both enter a transaction, one loses
    // the unique key. The work was recorded exactly once — so the loser must
    // report the current state rather than surfacing a failure for work that
    // actually succeeded. Twenty at once, so the race is real rather than hoped
    // for.
    const workspaceId = await freshWorkspace();
    const key = `race-ok-${workspaceId}`;

    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        usage.consume({
          workspaceId,
          featureKey: 'limit.scheduled_posts',
          limitValue: 100,
          period: 'month',
          idempotencyKey: key,
        }),
      ),
    );

    const rejected = attempts.filter((a) => a.status === 'rejected');
    expect(
      rejected.map((a) => String((a as PromiseRejectedResult).reason)),
      'a raced retry surfaced an error for work that succeeded',
    ).toEqual([]);
    const final = await usage.consumption({
      workspaceId,
      featureKey: 'limit.scheduled_posts',
      limitValue: 100,
      period: 'month',
    });
    expect(final.used).toBe(1);
  });

  it('a retry at the limit does not refuse — the work was already recorded', async () => {
    // The nasty case: the request succeeded, the response was lost, the client
    // retried, and the workspace is now exactly at its limit. Refusing would
    // report a failure for work that actually completed.
    const workspaceId = await freshWorkspace();
    const key = `idem-limit-${workspaceId}`;

    await usage.consume({
      workspaceId,
      featureKey: 'limit.brands',
      limitValue: 1,
      period: 'total',
      idempotencyKey: key,
    });

    const retry = await usage.consume({
      workspaceId,
      featureKey: 'limit.brands',
      limitValue: 1,
      period: 'total',
      idempotencyKey: key,
    });
    expect(retry.used).toBe(1);
  });
});

describe('concurrency', () => {
  it('twenty parallel requests against a limit of five consume exactly five', async () => {
    // The property a read-then-write implementation cannot have. If the check
    // and the increment were separate statements, several of these would read
    // the same value and all pass.
    const workspaceId = await freshWorkspace();

    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        usage.consume({
          workspaceId,
          featureKey: 'limit.scheduled_posts',
          limitValue: 5,
          period: 'month',
          idempotencyKey: `c-${workspaceId}-${i}`,
        }),
      ),
    );

    const accepted = attempts.filter((a) => a.status === 'fulfilled').length;
    expect(accepted).toBe(5);

    const final = await usage.consumption({
      workspaceId,
      featureKey: 'limit.scheduled_posts',
      limitValue: 5,
      period: 'month',
    });
    expect(final.used).toBe(5);
    expect(final.remaining).toBe(0);
  });

  it('the same key raced twenty times consumes exactly one', async () => {
    const workspaceId = await freshWorkspace();
    const key = `race-${workspaceId}`;

    await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        usage.consume({
          workspaceId,
          featureKey: 'limit.scheduled_posts',
          limitValue: 100,
          period: 'month',
          idempotencyKey: key,
        }),
      ),
    );

    const final = await usage.consumption({
      workspaceId,
      featureKey: 'limit.scheduled_posts',
      limitValue: 100,
      period: 'month',
    });
    expect(final.used).toBe(1);
  });
});

describe('refunding usage', () => {
  it('returns a slot when the work is undone', async () => {
    const workspaceId = await freshWorkspace();
    await usage.consume({
      workspaceId,
      featureKey: 'limit.scheduled_posts',
      limitValue: 5,
      period: 'month',
      idempotencyKey: `rf-${workspaceId}`,
    });

    await usage.refund({
      workspaceId,
      featureKey: 'limit.scheduled_posts',
      period: 'month',
      idempotencyKey: `rf-undo-${workspaceId}`,
    });

    const after = await usage.consumption({
      workspaceId,
      featureKey: 'limit.scheduled_posts',
      limitValue: 5,
      period: 'month',
    });
    expect(after.used).toBe(0);
  });

  it('floors at zero rather than going negative', async () => {
    const workspaceId = await freshWorkspace();
    await usage.consume({
      workspaceId,
      featureKey: 'limit.brands',
      limitValue: 5,
      period: 'total',
      idempotencyKey: `rf0-${workspaceId}`,
    });
    await usage.refund({
      workspaceId,
      featureKey: 'limit.brands',
      period: 'total',
      amount: 99,
      idempotencyKey: `rf0-undo-${workspaceId}`,
    });

    const after = await usage.consumption({
      workspaceId,
      featureKey: 'limit.brands',
      limitValue: 5,
      period: 'total',
    });
    expect(after.used).toBe(0);
  });
});

describe('windows', () => {
  it('a monthly quota starts a new count in a new month', async () => {
    const january = quotaWindow('month', new Date('2026-01-15T00:00:00.000Z'));
    const february = quotaWindow('month', new Date('2026-02-15T00:00:00.000Z'));
    expect(january.start.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(february.start.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });

  it('a billing-cycle quota uses the subscription period, not the calendar', async () => {
    // A customer who subscribed on the 20th resets on the 20th
    // (docs/BILLING-AND-CREDITS.md §11).
    const cycle = {
      start: new Date('2026-01-20T00:00:00.000Z'),
      end: new Date('2026-02-20T00:00:00.000Z'),
    };
    const window = quotaWindow('billing_cycle', new Date('2026-02-01T00:00:00.000Z'), cycle);
    expect(window).toEqual(cycle);
  });

  it('a billing-cycle quota with no cycle falls back to the month, not to forever', async () => {
    const window = quotaWindow('billing_cycle', new Date('2026-02-05T00:00:00.000Z'), null);
    expect(window.start.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });

  it('a total quota occupies exactly one row for all time', async () => {
    const a = quotaWindow('total', new Date('2026-01-01T00:00:00.000Z'));
    const b = quotaWindow('total', new Date('2030-06-01T00:00:00.000Z'));
    expect(a.start.getTime()).toBe(b.start.getTime());
  });

  it('counts in different windows do not interfere', async () => {
    const workspaceId = await freshWorkspace();
    await usage.consume({
      workspaceId,
      featureKey: 'limit.scheduled_posts',
      limitValue: 5,
      period: 'month',
      idempotencyKey: `w1-${workspaceId}`,
    });
    await usage.consume({
      workspaceId,
      featureKey: 'limit.brands',
      limitValue: 5,
      period: 'total',
      idempotencyKey: `w2-${workspaceId}`,
    });

    const counters = await usage.currentCounters(workspaceId);
    expect(counters.map((c) => c.featureKey).sort()).toEqual([
      'limit.brands',
      'limit.scheduled_posts',
    ]);
  });
});

/*
 * A-9. AN IDEMPOTENCY KEY NAMES ONE REQUEST, NOT ANY REQUEST WEARING IT.
 *
 * `consume` returned the CALLER's consumption for any known key and skipped the
 * increment. A key reused across workspaces therefore meant the second
 * workspace's usage was silently never recorded, while the caller was told it
 * had been — free quota, invisible in the counters precisely because the branch
 * writes nothing.
 */
describe('idempotency replays are scoped to the original request', () => {
  it('refuses a usage key replayed against a different workspace', async () => {
    const first = await freshWorkspace();
    const second = await freshWorkspace();
    const key = `cross-ws-${crypto.randomUUID()}`;

    await usage.consume({
      workspaceId: first,
      featureKey: 'limit.scheduled_posts',
      limitValue: 5,
      period: 'month',
      idempotencyKey: key,
    });

    await expect(
      usage.consume({
        workspaceId: second,
        featureKey: 'limit.scheduled_posts',
        limitValue: 5,
        period: 'month',
        idempotencyKey: key,
      }),
    ).rejects.toThrow('That idempotency key was used for a different usage event.');

    // And the second workspace's counter is untouched — neither incremented
    // nor quietly credited with the first workspace's recording.
    const after = await usage.consumption({
      workspaceId: second,
      featureKey: 'limit.scheduled_posts',
      limitValue: 5,
      period: 'month',
    });
    expect(after.used).toBe(0);
  });

  it('refuses a usage key replayed for a different feature or amount', async () => {
    const workspaceId = await freshWorkspace();
    const key = `mismatch-${crypto.randomUUID()}`;
    await usage.consume({
      workspaceId,
      featureKey: 'limit.scheduled_posts',
      limitValue: 10,
      period: 'month',
      amount: 2,
      idempotencyKey: key,
    });

    await expect(
      usage.consume({
        workspaceId,
        featureKey: 'limit.brands',
        limitValue: 10,
        period: 'total',
        amount: 2,
        idempotencyKey: key,
      }),
    ).rejects.toThrow('That idempotency key was used for a different usage event.');

    await expect(
      usage.consume({
        workspaceId,
        featureKey: 'limit.scheduled_posts',
        limitValue: 10,
        period: 'month',
        amount: 7,
        idempotencyKey: key,
      }),
    ).rejects.toThrow('That idempotency key was used for a different usage event.');
  });

  it('still treats a genuine retry as a no-op', async () => {
    // The rule tightens what counts as a replay; it must not break the case
    // idempotency exists for.
    const workspaceId = await freshWorkspace();
    const key = `same-${crypto.randomUUID()}`;
    const input = {
      workspaceId,
      featureKey: 'limit.scheduled_posts',
      limitValue: 10,
      period: 'month' as const,
      amount: 3,
      idempotencyKey: key,
    };

    const first = await usage.consume(input);
    const second = await usage.consume(input);
    expect(first.used).toBe(3);
    expect(second.used).toBe(3);
  });
});

/*
 * A-9, refunds. A REFUND THAT CHARGES IS NOT A REFUND.
 */
describe('refunds require a positive amount and their own key', () => {
  it('refuses a negative amount, which used to INCREASE the counter', async () => {
    const workspaceId = await freshWorkspace();
    await usage.consume({
      workspaceId,
      featureKey: 'limit.scheduled_posts',
      limitValue: 10,
      period: 'month',
      amount: 4,
      idempotencyKey: `neg-seed-${workspaceId}`,
    });

    // `GREATEST(0, used − (−5))` is `used + 5`. The floor that looks like a
    // guard never fires, because the subtraction never went negative.
    await expect(
      usage.refund({
        workspaceId,
        featureKey: 'limit.scheduled_posts',
        period: 'month',
        amount: -5,
        idempotencyKey: `neg-${workspaceId}`,
      }),
    ).rejects.toThrow('A refund is a positive whole number of units.');

    const after = await usage.consumption({
      workspaceId,
      featureKey: 'limit.scheduled_posts',
      limitValue: 10,
      period: 'month',
    });
    expect(after.used, 'a rejected refund must not move the counter').toBe(4);
  });

  it('refuses a fractional or zero amount', async () => {
    const workspaceId = await freshWorkspace();
    for (const amount of [0, 1.5]) {
      await expect(
        usage.refund({
          workspaceId,
          featureKey: 'limit.scheduled_posts',
          period: 'month',
          amount,
          idempotencyKey: `bad-${amount}-${workspaceId}`,
        }),
      ).rejects.toThrow('A refund is a positive whole number of units.');
    }
  });

  it('requires an idempotency key', async () => {
    const workspaceId = await freshWorkspace();
    await expect(
      usage.refund({
        workspaceId,
        featureKey: 'limit.scheduled_posts',
        period: 'month',
        idempotencyKey: '   ',
      }),
    ).rejects.toThrow('An idempotency key is required.');
  });

  it('gives the slot back exactly once when the refund is retried', async () => {
    // A duplicated webhook or a job that ran twice used to refund again, and
    // the customer kept the quota.
    const workspaceId = await freshWorkspace();
    await usage.consume({
      workspaceId,
      featureKey: 'limit.scheduled_posts',
      limitValue: 10,
      period: 'month',
      amount: 5,
      idempotencyKey: `retry-seed-${workspaceId}`,
    });

    const refundInput = {
      workspaceId,
      featureKey: 'limit.scheduled_posts',
      period: 'month' as const,
      amount: 2,
      idempotencyKey: `retry-refund-${workspaceId}`,
    };
    await usage.refund(refundInput);
    await usage.refund(refundInput);
    await usage.refund(refundInput);

    const after = await usage.consumption({
      workspaceId,
      featureKey: 'limit.scheduled_posts',
      limitValue: 10,
      period: 'month',
    });
    expect(after.used, 'three attempts, one refund').toBe(3);
  });

  it('refuses a refund key replayed for a different workspace', async () => {
    const first = await freshWorkspace();
    const second = await freshWorkspace();
    for (const workspaceId of [first, second]) {
      await usage.consume({
        workspaceId,
        featureKey: 'limit.scheduled_posts',
        limitValue: 10,
        period: 'month',
        amount: 3,
        idempotencyKey: `rk-seed-${workspaceId}`,
      });
    }
    const key = `rk-${crypto.randomUUID()}`;
    await usage.refund({
      workspaceId: first,
      featureKey: 'limit.scheduled_posts',
      period: 'month',
      idempotencyKey: key,
    });

    await expect(
      usage.refund({
        workspaceId: second,
        featureKey: 'limit.scheduled_posts',
        period: 'month',
        idempotencyKey: key,
      }),
    ).rejects.toThrow('That idempotency key was used for a different movement.');
  });

  it('records the refund as a negative event, so the record stays append-only', async () => {
    const workspaceId = await freshWorkspace();
    await usage.consume({
      workspaceId,
      featureKey: 'limit.scheduled_posts',
      limitValue: 10,
      period: 'month',
      amount: 4,
      idempotencyKey: `ev-seed-${workspaceId}`,
    });
    await usage.refund({
      workspaceId,
      featureKey: 'limit.scheduled_posts',
      period: 'month',
      amount: 3,
      idempotencyKey: `ev-refund-${workspaceId}`,
    });

    const events = await platform.usageEvent.findMany({
      where: { workspaceId },
      orderBy: { occurredAt: 'asc' },
    });
    expect(events.map((e) => e.amount)).toEqual([4, -3]);
  });
});

/*
 * A-9 ON THE CONCURRENT PATH.
 *
 * The pre-check enforced "a key names ONE request" whenever it SAW the stored
 * event. Two requests that both looked before either wrote took a different
 * path: one won the unique index, the other caught the violation and was told
 * it had replayed successfully — and nothing on that path ever compared the
 * two. So the sequential path refused what the concurrent path accepted, which
 * is the worst combination: the rule appeared to hold every time it was tested.
 *
 * THE RACE IS FORCED, NOT HOPED FOR. A transaction is held open with the
 * winning event already inserted and not yet committed. The second caller's
 * pre-check sees nothing (the row is invisible), it proceeds, and its own
 * insert BLOCKS on the uncommitted unique key until the holder commits — which
 * is precisely the interleaving, every time, rather than a timing coincidence
 * that may not reproduce.
 */
describe('a key raced by two DIFFERENT requests refuses the loser', () => {
  /** Somewhere for the held event's `counterId` to point. */
  async function seedCounter(workspaceId: string, featureKey: string): Promise<string> {
    await usage.consume({
      workspaceId,
      featureKey,
      limitValue: null,
      period: 'month',
      idempotencyKey: `seed-${crypto.randomUUID()}`,
    });
    const counter = await platform.usageCounter.findFirstOrThrow({
      where: { workspaceId, featureKey },
      select: { id: true },
    });
    return counter.id;
  }

  /**
   * Hold an uncommitted `UsageEvent` for `key`, and return the lever that
   * commits it. Everything the racer does in between blocks on the unique index.
   */
  async function holdWinner(input: {
    workspaceId: string;
    featureKey: string;
    counterId: string;
    key: string;
    amount: number;
  }): Promise<{ commit: () => void; done: Promise<unknown> }> {
    let release: () => void = () => undefined;
    let inserted: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      inserted = resolve;
    });
    const done = platform.$transaction(
      async (tx) => {
        await tx.usageEvent.create({
          data: {
            workspaceId: input.workspaceId,
            featureKey: input.featureKey,
            idempotencyKey: input.key,
            amount: input.amount,
            counterId: input.counterId,
          },
        });
        inserted();
        await gate;
      },
      { timeout: 20_000 },
    );
    await ready;
    return { commit: release, done };
  }

  /**
   * The race is only a race while the winner is UNCOMMITTED. Committing on a
   * bare `then()` let the loser's pre-check sometimes run after the commit, so
   * it took the sequential path and these tests passed for the wrong reason —
   * they missed a planted defect about one run in three. Block until the loser
   * is genuinely waiting on the unique index.
   */
  async function racerIsBlocked(): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const waiting = await platform.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n
          FROM pg_stat_activity
         WHERE datname = current_database()
           AND wait_event_type = 'Lock'
           AND query ILIKE '%usage_event%'`;
      if ((waiting[0]?.n ?? 0n) > 0n) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('the racing call never reached the unique index');
  }

  it('CONSUME: a different AMOUNT under the same key is a CONFLICT, not a replay', async () => {
    const workspaceId = await freshWorkspace();
    const featureKey = 'limit.scheduled_posts';
    const counterId = await seedCounter(workspaceId, featureKey);
    const key = `race-amount-${crypto.randomUUID()}`;

    const winner = await holdWinner({ workspaceId, featureKey, counterId, key, amount: 1 });

    // The loser's pre-check sees nothing and its insert blocks on the
    // uncommitted key. Three is not one, so this is a different request.
    const loser = usage.consume({
      workspaceId,
      featureKey,
      limitValue: null,
      period: 'month',
      amount: 3,
      idempotencyKey: key,
    });
    const settled = loser.then(
      () => 'accepted',
      (error: unknown) => String((error as { message?: string }).message ?? error),
    );

    await racerIsBlocked();
    winner.commit();
    await winner.done;

    expect(await settled).toMatch(/different usage event/i);
  });

  it('CONSUME: a different FEATURE under the same key is a CONFLICT', async () => {
    const workspaceId = await freshWorkspace();
    const counterId = await seedCounter(workspaceId, 'limit.scheduled_posts');
    const key = `race-feature-${crypto.randomUUID()}`;

    const winner = await holdWinner({
      workspaceId,
      featureKey: 'limit.scheduled_posts',
      counterId,
      key,
      amount: 1,
    });

    const settled = usage
      .consume({
        workspaceId,
        featureKey: 'limit.brands',
        limitValue: null,
        period: 'total',
        idempotencyKey: key,
      })
      .then(
        () => 'accepted',
        (error: unknown) => String((error as { message?: string }).message ?? error),
      );

    await racerIsBlocked();
    winner.commit();
    await winner.done;

    expect(await settled).toMatch(/different usage event/i);
    // AND NOTHING WAS RECORDED for the feature that lost.
    expect(
      await platform.usageCounter.findFirst({ where: { workspaceId, featureKey: 'limit.brands' } }),
    ).toBeNull();
  });

  it('CONSUME: the SAME request racing itself is still a replay, not an error', async () => {
    const workspaceId = await freshWorkspace();
    const featureKey = 'limit.scheduled_posts';
    const counterId = await seedCounter(workspaceId, featureKey);
    const key = `race-same-${crypto.randomUUID()}`;

    const winner = await holdWinner({ workspaceId, featureKey, counterId, key, amount: 2 });

    const settled = usage
      .consume({
        workspaceId,
        featureKey,
        limitValue: null,
        period: 'month',
        amount: 2,
        idempotencyKey: key,
      })
      .then(
        (result) => `used:${result.used}`,
        (error: unknown) => String((error as { message?: string }).message ?? error),
      );

    await racerIsBlocked();
    winner.commit();
    await winner.done;

    // An ordinary duplicate submit must not surface as a failure for work that
    // actually succeeded.
    expect(await settled).toMatch(/^used:/);
  });

  it('REFUND: a different AMOUNT under the same key is a CONFLICT, not a no-op', async () => {
    const workspaceId = await freshWorkspace();
    const featureKey = 'limit.scheduled_posts';
    await usage.consume({
      workspaceId,
      featureKey,
      limitValue: null,
      period: 'month',
      amount: 9,
      idempotencyKey: `refund-seed-${crypto.randomUUID()}`,
    });
    const counter = await platform.usageCounter.findFirstOrThrow({
      where: { workspaceId, featureKey },
      select: { id: true, usedValue: true },
    });
    const key = `race-refund-${crypto.randomUUID()}`;

    // The winner gives back ONE.
    const winner = await holdWinner({
      workspaceId,
      featureKey,
      counterId: counter.id,
      key,
      amount: -1,
    });

    // The loser tries to give back FOUR under the same key.
    const settled = usage
      .refund({ workspaceId, featureKey, period: 'month', amount: 4, idempotencyKey: key })
      .then(
        () => 'accepted',
        (error: unknown) => String((error as { message?: string }).message ?? error),
      );

    await racerIsBlocked();
    winner.commit();
    await winner.done;

    expect(await settled).toMatch(/different movement/i);
  });

  it('REFUND: the SAME movement racing itself gives the slot back exactly once', async () => {
    const workspaceId = await freshWorkspace();
    const featureKey = 'limit.scheduled_posts';
    await usage.consume({
      workspaceId,
      featureKey,
      limitValue: null,
      period: 'month',
      amount: 5,
      idempotencyKey: `refund-same-seed-${crypto.randomUUID()}`,
    });
    const counter = await platform.usageCounter.findFirstOrThrow({
      where: { workspaceId, featureKey },
      select: { id: true },
    });
    const key = `race-refund-same-${crypto.randomUUID()}`;

    const winner = await holdWinner({
      workspaceId,
      featureKey,
      counterId: counter.id,
      key,
      amount: -2,
    });

    const settled = usage
      .refund({ workspaceId, featureKey, period: 'month', amount: 2, idempotencyKey: key })
      .then(
        () => 'accepted',
        (error: unknown) => String((error as { message?: string }).message ?? error),
      );

    await racerIsBlocked();
    winner.commit();
    await winner.done;

    // A retried disconnection must not report a database violation for work
    // that had been recorded.
    expect(await settled).toBe('accepted');
    // And the slot came back once: the holder's own event is the only one.
    expect(await platform.usageEvent.count({ where: { idempotencyKey: key } })).toBe(1);
  });
});
