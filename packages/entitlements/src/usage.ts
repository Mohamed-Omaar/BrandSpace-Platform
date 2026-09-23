import type { PrismaClient, TenantScopedClient } from '@brandspace/database';
import { AppError, type Clock, systemClock } from '@brandspace/shared';

/**
 * Usage quotas — docs/ADMIN-CONTROL-CENTER.md §4.1 "Volume",
 * docs/PRODUCT.md §10A.3, roadmap Phase 3 §6.
 *
 * A quota is a feature whose effective value is a NUMBER: how many of a thing
 * the workspace may have or do in a window. The limit itself comes from the
 * entitlements engine — plan, override, flag, default, in that precedence — so
 * this service never decides what the limit IS. It counts, and it refuses.
 *
 * THE ATOMICITY PROBLEM, and why this is not a read-then-write.
 *
 * The obvious implementation reads the counter, compares it with the limit, and
 * writes back. Two requests that both read 99 against a limit of 100 both pass,
 * and the workspace ends up at 101. That is not a rare interleaving; it is the
 * normal outcome of two clicks.
 *
 * So the check and the increment are ONE statement:
 *
 *   INSERT … ON CONFLICT (workspace, feature, periodStart)
 *   DO UPDATE SET "usedValue" = usage_counter."usedValue" + $n
 *   WHERE usage_counter."usedValue" + $n <= $limit
 *   RETURNING "usedValue"
 *
 * PostgreSQL evaluates the WHERE against the row it has just locked for update,
 * so the losing request updates nothing and gets no row back. No application
 * code holds a lock, and the outcome does not depend on isolation level.
 *
 * IDEMPOTENCY is a second, independent mechanism: the `UsageEvent` row is
 * inserted in the same transaction and its key is unique, so a retried
 * recording aborts the transaction and leaves the counter untouched.
 *
 * THE BASELINE PROBLEM, and why a counter alone is not enough for a TOTAL
 * quota.
 *
 * A counter records what has been consumed THROUGH IT. A `total` quota counts
 * things that EXIST — brands, connected accounts — and those things predate the
 * day their dimension was wired up. So a workspace with four connected accounts
 * and a counter of zero was admitted four more under a limit of five, and two
 * simultaneous callbacks could take the same last slot because the counter each
 * of them incremented had never known about the other four.
 *
 * Counting the resources and comparing before creating is the read-then-write
 * this file exists to avoid. So the count happens INSIDE the transaction,
 * BEHIND THE COUNTER ROW'S OWN LOCK:
 *
 *   1. create-or-lock the counter row (`ON CONFLICT … DO UPDATE SET x = x`
 *      locks the conflicting row, which is the whole point of writing it that
 *      way rather than reading it);
 *   2. ask the caller for the authoritative live count, on this transaction;
 *   3. admit on `GREATEST(counter, live) + n <= limit`, in one statement.
 *
 * Two concurrent creates serialise on the lock, and the loser re-reads a live
 * count that now includes the winner's row. `GREATEST` is what makes this
 * idempotent and non-double-counting: a resource already represented in the
 * counter is also in the live count, and the greater of the two is one of them,
 * never their sum.
 */

export const QUOTA_FEATURE_PREFIX = 'limit.';

/**
 * The six quota dimensions a plan carries (docs/PRODUCT.md §10A.3).
 *
 * These are KEYS, not values. Application code names a quota the same way
 * docs/ADMIN-CONTROL-CENTER.md §5.1 has it name a feature; every number behind
 * them is configuration the owner sets, which is what AC-04.3 requires.
 */
export const QUOTA_FEATURES = {
  seats: 'limit.seats',
  brands: 'limit.brands',
  socialAccounts: 'limit.social_accounts',
  scheduledPostsPerMonth: 'limit.scheduled_posts',
  storageGb: 'limit.storage_gb',
  analyticsRetentionDays: 'limit.analytics_retention_days',
} as const;

export type QuotaDimension = keyof typeof QUOTA_FEATURES;

/** Which window a quota is counted over. */
export type QuotaPeriod = 'day' | 'month' | 'billing_cycle' | 'total';

/** A fixed epoch for `total` quotas, so they occupy exactly one counter row. */
const TOTAL_PERIOD_START = new Date(Date.UTC(1970, 0, 1));
const TOTAL_PERIOD_END = new Date(Date.UTC(9999, 0, 1));

export interface QuotaWindow {
  readonly start: Date;
  readonly end: Date;
}

/**
 * The window a quota is counted in.
 *
 * `billing_cycle` needs the subscription's own boundaries — a customer who
 * subscribed on the 20th resets on the 20th (docs/BILLING-AND-CREDITS.md §11) —
 * so the caller supplies them. Without them it falls back to the calendar
 * month rather than silently counting forever.
 */
export function quotaWindow(
  period: QuotaPeriod,
  now: Date,
  cycle?: QuotaWindow | null,
): QuotaWindow {
  if (period === 'total') {
    return { start: TOTAL_PERIOD_START, end: TOTAL_PERIOD_END };
  }
  if (period === 'day') {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return { start, end: new Date(start.getTime() + 86_400_000) };
  }
  if (period === 'billing_cycle' && cycle) {
    return cycle;
  }
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

export interface QuotaConsumption {
  readonly featureKey: string;
  readonly used: number;
  readonly limit: number | null;
  readonly window: QuotaWindow;
  /** null limit means unlimited, and `remaining` is then null rather than 0. */
  readonly remaining: number | null;
}

/** Raised when a quota refuses. Carries the shape a prompt needs, nothing more. */
export class QuotaExceededError extends AppError {
  readonly featureKey: string;
  readonly limitValue: number;
  readonly used: number;

  constructor(featureKey: string, limitValue: number, used: number) {
    super('QUOTA_EXCEEDED', `The workspace is at its limit for "${featureKey}".`, {
      // Safe for a customer: it is their own plan's limit and their own usage.
      // The plan KEY, the price and every other workspace's numbers stay unsaid.
      featureKey,
      limitValue,
      used,
    });
    this.featureKey = featureKey;
    this.limitValue = limitValue;
    this.used = used;
  }
}

/**
 * The client one consumption runs on — a `PrismaClient` or a transaction of
 * one. Named because the baseline path threads the same transaction through
 * three statements and a caller-supplied count.
 */
export type UsageTx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'
>;

/**
 * The immutable fields that decide whether two recordings are the same request.
 *
 * `amount` is SIGNED: a refund is stored as the negative of what it reverses,
 * so "the same key for a consumption and for a refund" is two different
 * requests by this comparison, which is what it has to be.
 */
interface UsageEventIdentity {
  readonly workspaceId: string;
  readonly featureKey: string;
  readonly amount: number;
}

function sameUsageRequest(stored: UsageEventIdentity, wanted: UsageEventIdentity): boolean {
  return (
    stored.workspaceId === wanted.workspaceId &&
    stored.featureKey === wanted.featureKey &&
    stored.amount === wanted.amount
  );
}

export interface UsageServiceOptions {
  readonly prisma: PrismaClient;
  readonly clock?: Clock;
}

export class UsageService {
  readonly #prisma: PrismaClient;
  readonly #clock: Clock;

  constructor(options: UsageServiceOptions) {
    this.#prisma = options.prisma;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Consume `amount` of a quota, or refuse.
   *
   * `limitValue === null` means unlimited: the counter still moves, because the
   * customer's usage view and the platform's reporting both need the number,
   * but nothing is refused.
   *
   * Returns the consumption AFTER the increment.
   */
  async consume(input: {
    readonly workspaceId: string;
    readonly featureKey: string;
    readonly limitValue: number | null;
    readonly period: QuotaPeriod;
    readonly amount?: number;
    readonly idempotencyKey: string;
    readonly cycle?: QuotaWindow | null;
    /**
     * The authoritative number of things that already exist, for a TOTAL
     * resource quota.
     *
     * Supplied by the caller because only the caller knows what the dimension
     * counts: this package must not learn about brands or social connections to
     * answer "how many". It is called INSIDE the consuming transaction, on that
     * transaction's client, and behind the counter row's lock — so what it
     * returns cannot change between being read and being acted on.
     *
     * Absent for a quota that counts EVENTS rather than things (scheduled posts
     * in a month): there is no live population to reconcile against, and the
     * counter is the only record there has ever been.
     */
    readonly baselineCount?: (db: TenantScopedClient) => Promise<number>;
  }): Promise<QuotaConsumption> {
    const amount = input.amount ?? 1;
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new AppError('VALIDATION_FAILED', 'A usage amount is a positive whole number.');
    }
    if (!input.idempotencyKey.trim()) {
      throw new AppError('VALIDATION_FAILED', 'An idempotency key is required.');
    }

    const now = this.#clock.now();
    const window = quotaWindow(input.period, now, input.cycle ?? null);

    // A repeat of a recording that already happened returns the CURRENT state
    // rather than incrementing again. Checked before the write so the common
    // retry does not have to provoke a constraint violation to be safe.
    const wanted: UsageEventIdentity = {
      workspaceId: input.workspaceId,
      featureKey: input.featureKey,
      amount,
    };
    const replay = await this.#recordedRequest(input.idempotencyKey);
    if (replay) {
      /*
       * A REPLAY MUST BE THE SAME REQUEST — A-9.
       *
       * This used to accept any request carrying a known key and return the
       * CALLER's consumption, skipping the increment. So a key reused across
       * workspaces — by a buggy client deriving keys from something not
       * workspace-scoped, or deliberately — meant workspace B's usage was
       * silently not recorded while B was told the recording had happened.
       * That is free quota, and it is invisible in the counters because the
       * whole point of the branch is that it writes nothing.
       *
       * The stored event's immutable fields decide whether this is the same
       * request. A different workspace, feature or amount is a CONFLICT.
       */
      if (!sameUsageRequest(replay, wanted)) {
        throw new AppError(
          'CONFLICT',
          'That idempotency key was used for a different usage event.',
        );
      }
      return this.consumption({
        workspaceId: input.workspaceId,
        featureKey: input.featureKey,
        limitValue: input.limitValue,
        period: input.period,
        cycle: input.cycle ?? null,
      });
    }

    const used = await this.#prisma
      .$transaction(async (tx) => {
        if (input.baselineCount) {
          const row = await this.#consumeAgainstLive(tx, {
            workspaceId: input.workspaceId,
            featureKey: input.featureKey,
            limitValue: input.limitValue,
            amount,
            window,
            baselineCount: input.baselineCount,
          });
          await tx.usageEvent.create({
            data: {
              workspaceId: input.workspaceId,
              featureKey: input.featureKey,
              idempotencyKey: input.idempotencyKey,
              amount,
              counterId: row.id,
              occurredAt: now,
            },
          });
          return row.usedValue;
        }

        // ONE statement: the limit is in the WHERE, so the check and the
        // increment cannot be separated by another transaction.
        const rows =
          input.limitValue === null
            ? await tx.$queryRaw<{ usedValue: number; id: string }[]>`
              INSERT INTO "usage_counter"
                ("id", "workspaceId", "featureKey", "periodStart", "periodEnd", "usedValue", "updatedAt")
              VALUES
                (gen_random_uuid(), ${input.workspaceId}::uuid, ${input.featureKey},
                 ${window.start}, ${window.end}, ${amount}, now())
              ON CONFLICT ("workspaceId", "featureKey", "periodStart")
              DO UPDATE SET "usedValue" = "usage_counter"."usedValue" + ${amount},
                            "updatedAt" = now()
              RETURNING "usedValue", "id"`
            : await tx.$queryRaw<{ usedValue: number; id: string }[]>`
              INSERT INTO "usage_counter"
                ("id", "workspaceId", "featureKey", "periodStart", "periodEnd", "usedValue", "updatedAt")
              VALUES
                (gen_random_uuid(), ${input.workspaceId}::uuid, ${input.featureKey},
                 ${window.start}, ${window.end}, ${amount}, now())
              ON CONFLICT ("workspaceId", "featureKey", "periodStart")
              DO UPDATE SET "usedValue" = "usage_counter"."usedValue" + ${amount},
                            "updatedAt" = now()
              WHERE "usage_counter"."usedValue" + ${amount} <= ${input.limitValue}
              RETURNING "usedValue", "id"`;

        const row = rows[0];
        if (!row) {
          // No row came back: the WHERE refused the update, so the workspace is
          // at or over its limit. The INSERT path cannot refuse, because a first
          // use above the limit is caught by the guard below.
          const current = await tx.usageCounter.findUnique({
            where: {
              workspaceId_featureKey_periodStart: {
                workspaceId: input.workspaceId,
                featureKey: input.featureKey,
                periodStart: window.start,
              },
            },
            select: { usedValue: true },
          });
          throw new QuotaExceededError(
            input.featureKey,
            input.limitValue ?? 0,
            current?.usedValue ?? 0,
          );
        }

        // A brand new counter is created by the INSERT branch, which the WHERE
        // does not guard. Refusing here keeps "first use already over the limit"
        // consistent with every later refusal, and the transaction rolls the
        // insert back.
        if (input.limitValue !== null && row.usedValue > input.limitValue) {
          throw new QuotaExceededError(input.featureKey, input.limitValue, row.usedValue);
        }

        // The idempotency record, in the SAME transaction. A retry that got past
        // the pre-check above races here instead, violates the unique key, and
        // rolls the increment back with it.
        await tx.usageEvent.create({
          data: {
            workspaceId: input.workspaceId,
            featureKey: input.featureKey,
            idempotencyKey: input.idempotencyKey,
            amount,
            counterId: row.id,
            occurredAt: now,
          },
        });

        return row.usedValue;
      })
      .catch(async (error: unknown) => {
        /*
         * A retry that RACED the pre-check above lands here instead: both calls
         * saw no idempotency record, both entered a transaction, and one lost
         * the unique key. The work was recorded exactly once, which is the
         * guarantee — so the loser reports the current state rather than an
         * error. Without this, an ordinary duplicate submit surfaces as a
         * failure for work that actually succeeded.
         *
         * BUT ONLY IF IT WAS THE SAME REQUEST. This path used to establish that
         * the collision was on `idempotencyKey` and stop there, so two
         * genuinely DIFFERENT requests sharing one key concurrently produced
         * one recording and two callers believing their own had been made —
         * free quota, invisible in the counters, and refused by the sequential
         * path on the way in. The winning row is read and compared by the same
         * rule the pre-check applies.
         */
        /*
         * A CONCURRENT REPLAY THAT LOST THE RACE IS REFUSED BY THE CEILING
         * BEFORE IT EVER REACHES THE UNIQUE KEY (P6-03b).
         *
         * The duplicate-key path below only catches a loser that got as far as
         * writing its idempotency record. Under a ceiling the WINNER just
         * filled, the loser never gets there: it blocks on the counter row,
         * wakes to find the slot taken, and throws `QUOTA_EXCEEDED` from inside
         * the transaction. So two simultaneous clicks on "create brand", under
         * a plan granting one brand, produced one brand and one alarming quota
         * error — for work the customer's own first click had just completed.
         *
         * THE SEQUENTIAL REPLAY OF THAT SAME KEY DOES NOT REFUSE: the
         * pre-check at the top of `consume` finds the record and returns the
         * current consumption. This makes the concurrent path agree with it,
         * by the same rule and the same comparison — a key already recorded for
         * THIS request has taken its slot, and is not asking for a second one.
         *
         * A GENUINE REFUSAL IS UNTOUCHED, because it has no record to find: a
         * different key over the ceiling still throws, which is what every
         * `brands = 0` and every second-brand case depends on. A different
         * request wearing this key is a CONFLICT by the same rule as everywhere
         * else, not a quiet success.
         */
        if (error instanceof QuotaExceededError) {
          const recorded = await this.#recordedRequest(input.idempotencyKey);
          if (!recorded) throw error;
          if (!sameUsageRequest(recorded, wanted)) {
            throw new AppError(
              'CONFLICT',
              'That idempotency key was used for a different usage event.',
            );
          }
          const replayed = await this.consumption({
            workspaceId: input.workspaceId,
            featureKey: input.featureKey,
            limitValue: input.limitValue,
            period: input.period,
            cycle: input.cycle ?? null,
          });
          return replayed.used;
        }
        if (!isDuplicateIdempotencyKey(error)) throw error;
        const winner = await this.#recordedRequest(input.idempotencyKey);
        // The unique index said the row exists; if it does not, something other
        // than a replay happened and the original error is the honest answer.
        if (!winner) throw error;
        if (!sameUsageRequest(winner, wanted)) {
          throw new AppError(
            'CONFLICT',
            'That idempotency key was used for a different usage event.',
          );
        }
        const current = await this.consumption({
          workspaceId: input.workspaceId,
          featureKey: input.featureKey,
          limitValue: input.limitValue,
          period: input.period,
          cycle: input.cycle ?? null,
        });
        return current.used;
      });

    return {
      featureKey: input.featureKey,
      used,
      limit: input.limitValue,
      window,
      remaining: input.limitValue === null ? null : Math.max(0, input.limitValue - used),
    };
  }

  /** Read a quota's consumption without changing it. */
  async consumption(input: {
    readonly workspaceId: string;
    readonly featureKey: string;
    readonly limitValue: number | null;
    readonly period: QuotaPeriod;
    readonly cycle?: QuotaWindow | null;
  }): Promise<QuotaConsumption> {
    const window = quotaWindow(input.period, this.#clock.now(), input.cycle ?? null);
    const row = await this.#prisma.usageCounter.findUnique({
      where: {
        workspaceId_featureKey_periodStart: {
          workspaceId: input.workspaceId,
          featureKey: input.featureKey,
          periodStart: window.start,
        },
      },
      select: { usedValue: true },
    });
    const used = row?.usedValue ?? 0;
    return {
      featureKey: input.featureKey,
      used,
      limit: input.limitValue,
      window,
      remaining: input.limitValue === null ? null : Math.max(0, input.limitValue - used),
    };
  }

  /**
   * Give back usage that was recorded and then undone.
   *
   * Deleting a scheduled post should return its slot. The counter floors at
   * zero — the CHECK constraint refuses a negative — and the `UsageEvent` rows
   * stay, because they are the idempotency record and are append-only.
   *
   * TWO THINGS THIS DID NOT DO — A-9.
   *
   * 1. IT DID NOT CHECK THE SIGN. `amount` was interpolated straight into
   *    `usedValue - ${amount}`, so a negative refund INCREMENTED the counter:
   *    `GREATEST(0, used − (−5))` is `used + 5`. A refund that charges is not
   *    a refund, and the floor that looks like a guard does nothing about it
   *    because the subtraction never went negative in the first place.
   *
   * 2. IT HAD NO IDEMPOTENCY KEY AT ALL, while every other movement in this
   *    file has one. A retried delete — a duplicated webhook, a job that ran
   *    twice — refunded the slot again, and the customer kept the quota. The
   *    key is now required and recorded as a `UsageEvent` of its own, so the
   *    second attempt is a no-op rather than a second gift.
   *
   * The refund's event carries a NEGATIVE `amount`, which is what distinguishes
   * it in the append-only record from the consumption it reverses.
   */
  async refund(input: {
    readonly workspaceId: string;
    readonly featureKey: string;
    readonly period: QuotaPeriod;
    readonly amount?: number;
    readonly idempotencyKey: string;
    readonly cycle?: QuotaWindow | null;
  }): Promise<void> {
    const amount = input.amount ?? 1;
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new AppError('VALIDATION_FAILED', 'A refund is a positive whole number of units.');
    }
    if (!input.idempotencyKey.trim()) {
      throw new AppError('VALIDATION_FAILED', 'An idempotency key is required.');
    }

    const window = quotaWindow(input.period, this.#clock.now(), input.cycle ?? null);

    /*
     * SIGNED, and that is the rule rather than a detail: a refund is stored as
     * the NEGATIVE of what it reverses, so the same key used for a consumption
     * and for a refund is two different requests by this comparison — which is
     * what it has to be.
     */
    const wanted: UsageEventIdentity = {
      workspaceId: input.workspaceId,
      featureKey: input.featureKey,
      amount: -amount,
    };
    const replay = await this.#recordedRequest(input.idempotencyKey);
    if (replay) {
      // Same rule as `consume`: a key names ONE request, and a different one
      // wearing it is a conflict rather than a silent no-op.
      if (!sameUsageRequest(replay, wanted)) {
        throw new AppError('CONFLICT', 'That idempotency key was used for a different movement.');
      }
      return;
    }

    await this.#prisma
      .$transaction(async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>`
        UPDATE "usage_counter"
           SET "usedValue" = GREATEST(0, "usedValue" - ${amount}),
               "updatedAt" = now()
         WHERE "workspaceId" = ${input.workspaceId}::uuid
           AND "featureKey"  = ${input.featureKey}
           AND "periodStart" = ${window.start}
        RETURNING "id"`;

        const counterId = rows[0]?.id;
        // No counter means there is nothing recorded to give back. That is not
        // an error — a delete of something that never consumed a slot is fine —
        // but there is also no event to write, because `UsageEvent.counterId`
        // must point at a real counter.
        if (!counterId) return;

        await tx.usageEvent.create({
          data: {
            workspaceId: input.workspaceId,
            featureKey: input.featureKey,
            idempotencyKey: input.idempotencyKey,
            // Negative: this row REVERSES consumption, and the sign is what
            // says so in an append-only record.
            amount: -amount,
            counterId,
          },
        });
      })
      .catch(async (error: unknown) => {
        /*
         * THE SAME COLLISION PATH `consume` HAS, and it did not have one at
         * all: two refunds racing the pre-check both wrote, one lost the unique
         * index, and the loser surfaced a raw database violation for a movement
         * that HAD been recorded. A retried disconnection reporting a 500 for
         * work that succeeded is the same defect as accepting a different
         * request — the opposite direction, the same missing check.
         *
         * So the winning row is read and compared by the same rule. The same
         * movement is a no-op; a DIFFERENT movement wearing this key is a
         * conflict, however it got here.
         */
        if (!isDuplicateIdempotencyKey(error)) throw error;
        const winner = await this.#recordedRequest(input.idempotencyKey);
        if (!winner) throw error;
        if (!sameUsageRequest(winner, wanted)) {
          throw new AppError('CONFLICT', 'That idempotency key was used for a different movement.');
        }
      });
  }

  /**
   * THE ONE RULE: an idempotency key names ONE request, and the STORED event
   * decides which.
   *
   * A-9 said this already, and the pre-check enforced it — but only when the
   * pre-check SAW the event. Two requests that both looked before either wrote
   * took a different path: one won the unique index, the other caught the
   * violation and was told it had replayed successfully, WITHOUT anything ever
   * comparing the two. Two genuinely different requests sharing a key
   * concurrently therefore produced one recording and two callers believing
   * their own had been made. The sequential path refused that and the
   * concurrent path accepted it, which is the worst combination: the rule
   * appeared to hold every time it was tested.
   *
   * So both paths ask the same question of the same row. `null` means the event
   * is not there — for the pre-check that is the ordinary first attempt; for
   * the collision path it cannot happen, and the caller re-throws rather than
   * inventing an answer.
   */
  async #recordedRequest(idempotencyKey: string): Promise<UsageEventIdentity | null> {
    return this.#prisma.usageEvent.findUnique({
      where: { idempotencyKey },
      select: { workspaceId: true, featureKey: true, amount: true },
    });
  }

  /**
   * Consume one slot of a TOTAL resource quota, against what actually exists.
   *
   * THREE STATEMENTS, ONE LOCK, NO READ-THEN-WRITE.
   *
   * The first creates the counter row if it is not there and LOCKS it either
   * way — `ON CONFLICT … DO UPDATE SET "usedValue" = "usage_counter"."usedValue"`
   * writes the value back to itself, which is a no-op to the data and a row
   * lock to every other transaction. That is deliberate: a plain read would not
   * serialise two creates, and serialising them is the whole reason the live
   * count can be trusted between being taken and being used.
   *
   * The second asks the caller how many of the thing exist RIGHT NOW, on this
   * transaction. Behind the lock, and before the new one is created, so it is
   * the population the new resource is about to join.
   *
   * The third admits on the GREATER of the counter and that population. A
   * resource already represented in the counter is also in the live count, so
   * taking the greater of the two counts it once — never twice — and repeating
   * the whole operation converges on the same number.
   */
  async #consumeAgainstLive(
    tx: UsageTx,
    input: {
      readonly workspaceId: string;
      readonly featureKey: string;
      readonly limitValue: number | null;
      readonly amount: number;
      readonly window: QuotaWindow;
      readonly baselineCount: (db: TenantScopedClient) => Promise<number>;
    },
  ): Promise<{ id: string; usedValue: number }> {
    await tx.$executeRaw`
      INSERT INTO "usage_counter"
        ("id", "workspaceId", "featureKey", "periodStart", "periodEnd", "usedValue", "updatedAt")
      VALUES
        (gen_random_uuid(), ${input.workspaceId}::uuid, ${input.featureKey},
         ${input.window.start}, ${input.window.end}, 0, now())
      ON CONFLICT ("workspaceId", "featureKey", "periodStart")
      DO UPDATE SET "usedValue" = "usage_counter"."usedValue"`;

    const live = await input.baselineCount(tx as unknown as TenantScopedClient);
    if (!Number.isInteger(live) || live < 0) {
      throw new AppError('INTERNAL', 'A live resource count must be a whole number of things.');
    }

    const rows =
      input.limitValue === null
        ? await tx.$queryRaw<{ usedValue: number; id: string }[]>`
            UPDATE "usage_counter"
               SET "usedValue" = GREATEST("usedValue", ${live}) + ${input.amount},
                   "updatedAt" = now()
             WHERE "workspaceId" = ${input.workspaceId}::uuid
               AND "featureKey"  = ${input.featureKey}
               AND "periodStart" = ${input.window.start}
            RETURNING "usedValue", "id"`
        : await tx.$queryRaw<{ usedValue: number; id: string }[]>`
            UPDATE "usage_counter"
               SET "usedValue" = GREATEST("usedValue", ${live}) + ${input.amount},
                   "updatedAt" = now()
             WHERE "workspaceId" = ${input.workspaceId}::uuid
               AND "featureKey"  = ${input.featureKey}
               AND "periodStart" = ${input.window.start}
               AND GREATEST("usedValue", ${live}) + ${input.amount} <= ${input.limitValue}
            RETURNING "usedValue", "id"`;

    const row = rows[0];
    if (row) return row;

    /*
     * REFUSED. The number reported is the EFFECTIVE usage — what exists, not
     * what the counter happened to have recorded — because that is the figure
     * the customer's own screen shows and the one that explains the refusal.
     */
    const counter = await tx.usageCounter.findUnique({
      where: {
        workspaceId_featureKey_periodStart: {
          workspaceId: input.workspaceId,
          featureKey: input.featureKey,
          periodStart: input.window.start,
        },
      },
      select: { usedValue: true },
    });
    throw new QuotaExceededError(
      input.featureKey,
      input.limitValue ?? 0,
      Math.max(counter?.usedValue ?? 0, live),
    );
  }

  /** Every counter for a workspace in the current windows — the usage view. */
  async currentCounters(
    workspaceId: string,
  ): Promise<ReadonlyArray<{ featureKey: string; used: number; periodEnd: Date }>> {
    const now = this.#clock.now();
    const rows = await this.#prisma.usageCounter.findMany({
      where: { workspaceId, periodEnd: { gt: now } },
      orderBy: { featureKey: 'asc' },
      select: { featureKey: true, usedValue: true, periodEnd: true },
    });
    return rows.map((r) => ({
      featureKey: r.featureKey,
      used: r.usedValue,
      periodEnd: r.periodEnd,
    }));
  }
}

/**
 * Is this the unique violation on `usage_event.idempotencyKey`?
 *
 * Matched STRUCTURALLY, never on a message. Prisma reports a unique violation
 * as `P2002`, but where it names the offending constraint depends on the
 * driver: the pg adapter nests it under
 * `meta.driverAdapterError.cause.constraint.index`, while the classic engine
 * puts the column list in `meta.target`. Both are checked, so upgrading one
 * does not silently turn a handled duplicate back into a 500.
 *
 * Any other error is rethrown. Swallowing them would turn a genuine write
 * failure into a silently successful no-op, which is the worse bug.
 */
function isDuplicateIdempotencyKey(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    code?: unknown;
    meta?: {
      target?: unknown;
      driverAdapterError?: { cause?: { constraint?: { index?: unknown } } };
    };
  };
  if (candidate.code !== 'P2002') return false;

  const named: string[] = [];
  const target = candidate.meta?.target;
  if (Array.isArray(target)) named.push(...target.map(String));
  else if (target !== undefined && target !== null) named.push(String(target));

  const index = candidate.meta?.driverAdapterError?.cause?.constraint?.index;
  if (index !== undefined && index !== null) named.push(String(index));

  return named.some((field) => field.includes('idempotencyKey'));
}
