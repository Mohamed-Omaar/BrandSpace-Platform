// The client TYPE comes from @brandspace/database, the only package permitted
// to import @prisma/client directly (docs/ARCHITECTURE.md §4.1).
import type { PrismaClient } from '@brandspace/database';
import { AppError, type Clock, systemClock } from '@brandspace/shared';
import {
  allocateFifo,
  allocationTotal,
  expiryFor,
  lowBalanceCrossing,
  narrowAllocation,
  rolloverAmount,
  INERT_CREDIT_POLICY,
  MILLI_PER_CREDIT,
  type Allocation,
  type CreditGrantSourceKey,
  type CreditPolicy,
  type RolloverPolicy,
} from './credit-policy';

/**
 * Credit grants, reservations and settlement — CLAUDE.md §2.4,
 * docs/BILLING-AND-CREDITS.md §9–§11.
 *
 * THE PROTOCOL is `reserve → confirm → settle`, with `release` for everything
 * that does not complete:
 *
 *   reserve   hold an ESTIMATE. Nothing is spent. The wallet's reserved total
 *             and each chosen bucket's reserved total both rise, so a second
 *             concurrent reserve cannot allocate the same credits.
 *   settle    charge the ACTUAL, which may be less than the estimate and can
 *             never be more. The difference is released in the same
 *             transaction — there is no state where a customer is holding
 *             credits nobody is going to spend.
 *   release   give the whole hold back. A failed request costs nothing
 *             (CLAUDE.md §2.4), so this is the failure path, and it is also
 *             what the sweeper calls on a reservation nobody came back for.
 *
 * FIVE PROPERTIES, each enforced by a mechanism rather than by care:
 *
 *   1. Balance is derived. Every movement writes an immutable
 *      `CreditTransaction`; the wallet and the buckets are projections updated
 *      inside the SAME transaction, and `reconcile()` replays to prove it.
 *   2. No negative balance. `SELECT … FOR UPDATE` serialises every wallet
 *      mutation; `CHECK (balanceMilliCredits >= 0)` and
 *      `CHECK (reservedMilliCredits <= remainingMilliCredits)` refuse the write
 *      regardless of what this code believes.
 *   3. No double charge on retry. Every entry point takes an idempotency key,
 *      unique in the database. A repeat returns the ORIGINAL outcome.
 *   4. No charge for failure. Release is total and writes zero `USAGE_CHARGE`.
 *   5. FIFO by nearest expiry. The allocation is decided ONCE, at reserve time,
 *      and frozen on the reservation, so settlement cannot silently charge a
 *      different bucket than the one the customer was quoted against.
 *
 * NOT IN THIS PHASE. Nothing here calls an AI provider, prices a task, or knows
 * what a model costs. These are the provider-independent primitives Phase 4
 * will drive; `purpose` is an opaque task key and never request content.
 */

export interface CreditLedgerActor {
  readonly actorType: 'SYSTEM' | 'PLATFORM_USER' | 'USER';
  readonly actorId: string | null;
}

export const SYSTEM_ACTOR: CreditLedgerActor = { actorType: 'SYSTEM', actorId: null };

export interface GrantInput {
  readonly workspaceId: string;
  readonly source: CreditGrantSourceKey;
  /** Whole credits. Must be positive — a negative grant is an adjustment. */
  readonly credits: number;
  readonly reason: string;
  readonly idempotencyKey: string;
  /** Overrides the policy's expiry for this bucket. `undefined` uses policy. */
  readonly expiresAt?: Date | null;
  readonly actor?: CreditLedgerActor;
}

export interface ReserveInput {
  readonly workspaceId: string;
  readonly estimateMilliCredits: bigint;
  /** A task key. Never request content. */
  readonly purpose: string;
  readonly idempotencyKey: string;
  readonly ttlSeconds?: number;
}

export interface ReservationView {
  readonly id: string;
  readonly workspaceId: string;
  readonly estimateMilliCredits: bigint;
  readonly settledMilliCredits: bigint | null;
  readonly status: 'OPEN' | 'SETTLED' | 'RELEASED' | 'EXPIRED';
  readonly purpose: string;
  readonly expiresAt: Date;
  readonly allocations: readonly Allocation[];
}

export interface GrantView {
  readonly id: string;
  readonly source: string;
  readonly amountMilliCredits: bigint;
  readonly remainingMilliCredits: bigint;
  readonly reservedMilliCredits: bigint;
  readonly expiresAt: Date | null;
  readonly grantedAt: Date;
  readonly reason: string;
}

/**
 * The outcome of one abandoned-reservation sweep — F-62.
 *
 * `swept` alone cannot distinguish "there is no leak left" from "the sweep hit
 * its bound and there is more to do", and that difference is the whole point of
 * a metric that must stay at zero.
 */
export interface SweepResult {
  /** Reservations actually released this pass. */
  readonly swept: number;
  /**
   * Reservations that could not be released — a correctness alert about the
   * ledger, not a reason for the sweep to stop.
   */
  readonly failed: readonly string[];
  /** Rows tried, successes and failures together. */
  readonly attempted: number;
  /**
   * True when the sweep ran out of candidates it had not already tried; false
   * when it stopped at `limit` or `maxAttempts` with work remaining.
   */
  readonly exhausted: boolean;
}

/**
 * Rows fetched per batch inside a sweep. Small on purpose: a batch of failures
 * is re-fetched with those ids excluded, and a large batch would make that
 * exclusion list grow faster than the sweep makes progress.
 */
const SWEEP_BATCH_SIZE = 50;

/**
 * What one cycle boundary did — A-6.
 *
 * `unforfeitable` and `alreadyApplied` are the two facts the previous return
 * shape could not express, and both were silently wrong rather than merely
 * absent: excess credits that could not be taken because they were reserved
 * looked like credits the customer was entitled to keep, and a repeated tick
 * looked like a fresh boundary that happened to forfeit nothing.
 */
export interface CycleResetResult {
  /** Balance carried into the new cycle, excluding the new allowance. */
  readonly rolledOver: bigint;
  /** Credits written off for exceeding the plan's rollover cap. */
  readonly forfeited: bigint;
  /**
   * Excess that could NOT be forfeited because it is reserved against requests
   * still in flight. Non-zero means the cap was not fully applied, and the
   * caller — or an operator reading the metric — needs to know that.
   */
  readonly unforfeitable: bigint;
  /** The new allowance, if the plan carries one. */
  readonly granted: bigint;
  /** Lapsed credits written off before the rollover cap was computed. */
  readonly expired: bigint;
  /** True when this cycle had already been applied and nothing was changed. */
  readonly alreadyApplied: boolean;
}

export interface CreditLedgerOptions {
  readonly prisma: PrismaClient;
  readonly clock?: Clock;
  /** The `credits` configuration domain. Inert when the owner has set nothing. */
  readonly policy?: CreditPolicy;
}

/** Raised when a reserve cannot be covered. Carries no internal detail. */
export class InsufficientCreditsError extends AppError {
  readonly availableMilliCredits: bigint;
  readonly requestedMilliCredits: bigint;

  constructor(available: bigint, requested: bigint) {
    super(
      'INSUFFICIENT_CREDITS',
      'This action needs more AI credits than the workspace has available.',
    );
    this.availableMilliCredits = available;
    this.requestedMilliCredits = requested;
  }
}

/**
 * The client a `$transaction` callback receives.
 *
 * Prisma hands the callback a PrismaClient with the connection-lifecycle
 * methods removed — you cannot open a transaction inside a transaction, and the
 * type says so. Named here because several private helpers take it.
 */
type LedgerTx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$use' | '$extends'>;

/**
 * A reservation as Prisma returns it. Named rather than inlined because
 * `#lockReservation` has to say it can return null, and `Awaited<ReturnType<…>>`
 * at that position reads worse than the alias.
 */
type ReservationRow = NonNullable<
  Awaited<ReturnType<PrismaClient['creditReservation']['findUnique']>>
>;

interface LockedWallet {
  id: string;
  balanceMilliCredits: bigint;
  reservedMilliCredits: bigint;
  lifetimeGrantedMilliCredits: bigint;
  lifetimeConsumedMilliCredits: bigint;
  lowBalanceNotifiedPercent: number | null;
}

export class CreditLedgerService {
  readonly #prisma: PrismaClient;
  readonly #clock: Clock;
  readonly #policy: CreditPolicy;

  constructor(options: CreditLedgerOptions) {
    this.#prisma = options.prisma;
    this.#clock = options.clock ?? systemClock;
    this.#policy = options.policy ?? INERT_CREDIT_POLICY;
  }

  get policy(): CreditPolicy {
    return this.#policy;
  }

  // -------------------------------------------------------------------------
  // Grants
  // -------------------------------------------------------------------------

  /**
   * Add a bucket of credits.
   *
   * Writes the ledger row and the bucket in one transaction. The bucket's
   * `sourceTransactionId` is unique, so even if the idempotency check were
   * somehow bypassed the database still refuses a second bucket for the same
   * ledger row.
   */
  async grant(input: GrantInput): Promise<GrantView> {
    if (!Number.isInteger(input.credits) || input.credits <= 0) {
      throw new AppError('VALIDATION_FAILED', 'A grant is a positive whole number of credits.');
    }
    if (input.reason.trim().length < 4) {
      throw new AppError('VALIDATION_FAILED', 'A grant requires a written reason.');
    }
    if (!input.idempotencyKey.trim()) {
      throw new AppError('VALIDATION_FAILED', 'An idempotency key is required.');
    }

    const amount = BigInt(input.credits) * MILLI_PER_CREDIT;
    const actor = input.actor ?? SYSTEM_ACTOR;
    const now = this.#clock.now();
    const expiresAt =
      input.expiresAt !== undefined ? input.expiresAt : expiryFor(input.source, now, this.#policy);

    const grantId = await this.#prisma.$transaction(async (tx) =>
      this.#grantWithin(tx, input, { amount, actor, now, expiresAt }),
    );

    const row = await this.#prisma.creditGrant.findUniqueOrThrow({ where: { id: grantId } });
    return toGrantView(row);
  }

  /**
   * `grant`, inside a transaction the caller already owns.
   *
   * The cycle reset needs the new allowance to commit with the forfeiture that
   * precedes it (A-6); calling the public method there would open a second
   * transaction and reintroduce the gap this exists to close.
   */
  async #grant(tx: LedgerTx, input: GrantInput): Promise<string> {
    const amount = BigInt(input.credits) * MILLI_PER_CREDIT;
    const actor = input.actor ?? SYSTEM_ACTOR;
    const now = this.#clock.now();
    const expiresAt =
      input.expiresAt !== undefined ? input.expiresAt : expiryFor(input.source, now, this.#policy);
    return this.#grantWithin(tx, input, { amount, actor, now, expiresAt });
  }

  async #grantWithin(
    tx: LedgerTx,
    input: GrantInput,
    ctx: {
      readonly amount: bigint;
      readonly actor: CreditLedgerActor;
      readonly now: Date;
      readonly expiresAt: Date | null;
    },
  ): Promise<string> {
    const { amount, actor, now, expiresAt } = ctx;
    {
      // Idempotency first, before the lock: a retry must not queue behind other
      // writers only to do nothing.
      const existing = await tx.creditTransaction.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: {
          id: true,
          workspaceId: true,
          type: true,
          amountMilliCredits: true,
        },
      });
      if (existing) {
        /*
         * A REPLAY MUST BE THE SAME REQUEST — A-9.
         *
         * This used to return the stored bucket for ANY request bearing the
         * key. Two consequences, both real:
         *
         *   - CROSS-WORKSPACE. `grant({workspace: B, credits: 5000, key})`
         *     after `grant({workspace: A, credits: 100, key})` returned A's
         *     bucket. B's caller was told 5000 credits were granted; nothing
         *     had been. A tenant handed a view of another tenant's row is a
         *     leak regardless of how it was reached.
         *   - MISMATCHED AMOUNT OR SOURCE. A retry that differs from the
         *     original is not a retry; it is a second, different instruction
         *     that silently did nothing.
         *
         * Idempotency means "this exact request, at most once" — never "any
         * request wearing this key". The immutable fields are checked before
         * the stored outcome is handed back.
         */
        if (
          existing.workspaceId !== input.workspaceId ||
          existing.type !== LEDGER_TYPE_FOR_SOURCE[input.source] ||
          existing.amountMilliCredits !== amount
        ) {
          throw new AppError(
            'CONFLICT',
            'That idempotency key was used for a different credit movement.',
          );
        }

        const bucket = await tx.creditGrant.findUnique({
          where: { sourceTransactionId: existing.id },
          select: { id: true },
        });
        if (bucket) return bucket.id;
        throw new AppError(
          'CONFLICT',
          'That idempotency key already names a different kind of credit movement.',
        );
      }

      const wallet = await this.#lockWallet(tx, input.workspaceId);
      const next = wallet.balanceMilliCredits + amount;

      const transaction = await tx.creditTransaction.create({
        data: {
          workspaceId: input.workspaceId,
          walletId: wallet.id,
          type: LEDGER_TYPE_FOR_SOURCE[input.source],
          amountMilliCredits: amount,
          balanceAfterMilliCredits: next,
          reason: input.reason.trim(),
          idempotencyKey: input.idempotencyKey,
          actorType: actor.actorType,
          actorId: actor.actorId,
          occurredAt: now,
          expiresAt,
        },
        select: { id: true },
      });

      const bucket = await tx.creditGrant.create({
        data: {
          workspaceId: input.workspaceId,
          walletId: wallet.id,
          source: input.source,
          amountMilliCredits: amount,
          remainingMilliCredits: amount,
          reservedMilliCredits: 0n,
          expiresAt,
          sourceTransactionId: transaction.id,
          reason: input.reason.trim(),
          grantedAt: now,
        },
        select: { id: true },
      });

      await tx.creditWallet.update({
        where: { id: wallet.id },
        data: {
          balanceMilliCredits: next,
          lifetimeGrantedMilliCredits: wallet.lifetimeGrantedMilliCredits + amount,
          version: { increment: 1 },
          // A wallet that has just been topped up is no longer "low", so the
          // notice state resets and the next fall through a threshold speaks.
          lowBalanceNotifiedPercent: null,
          lowBalanceNotifiedAt: null,
        },
      });

      return bucket.id;
    }
  }

  // -------------------------------------------------------------------------
  // reserve -> settle / release
  // -------------------------------------------------------------------------

  /**
   * Hold an estimate against the wallet.
   *
   * Refuses rather than partially reserving: an AI action that can only half
   * run is not something to start. The refusal carries the available and
   * requested amounts so the dashboard can offer a top-up, and nothing else.
   */
  async reserve(input: ReserveInput): Promise<ReservationView> {
    if (input.estimateMilliCredits <= 0n) {
      throw new AppError('VALIDATION_FAILED', 'A reservation must be for a positive estimate.');
    }
    if (!input.idempotencyKey.trim()) {
      throw new AppError('VALIDATION_FAILED', 'An idempotency key is required.');
    }

    const now = this.#clock.now();
    const ttl = input.ttlSeconds ?? this.#policy.reservationTimeoutSeconds;
    const expiresAt = new Date(now.getTime() + ttl * 1000);

    const reservationId = await this.#prisma.$transaction(async (tx) => {
      // A retry returns the ORIGINAL reservation rather than holding the
      // estimate a second time.
      const existing = await tx.creditReservation.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true, workspaceId: true },
      });
      if (existing) {
        if (existing.workspaceId !== input.workspaceId) {
          // Same key, different tenant. Refuse rather than leak that the key is
          // taken by returning someone else's reservation.
          throw new AppError('CONFLICT', 'That idempotency key is already in use.');
        }
        return existing.id;
      }

      const wallet = await this.#lockWallet(tx, input.workspaceId);
      const available = wallet.balanceMilliCredits - wallet.reservedMilliCredits;
      if (available < input.estimateMilliCredits) {
        // D-11: a hard stop. No postpaid overage, no invoice line, no partial
        // run — a clear refusal and a top-up path.
        throw new InsufficientCreditsError(available, input.estimateMilliCredits);
      }

      const buckets = await tx.creditGrant.findMany({
        where: {
          workspaceId: input.workspaceId,
          remainingMilliCredits: { gt: 0 },
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
      });

      const { allocations, shortfallMilliCredits } = allocateFifo(
        buckets.map((b) => ({
          id: b.id,
          spendableMilliCredits: b.remainingMilliCredits - b.reservedMilliCredits,
          expiresAt: b.expiresAt,
          grantedAt: b.grantedAt,
        })),
        input.estimateMilliCredits,
      );

      if (shortfallMilliCredits > 0n) {
        // The wallet total said yes but the buckets said no. That means unspent
        // credits sit in buckets that have already expired, so they are not
        // spendable — the honest answer is the same refusal.
        throw new InsufficientCreditsError(
          input.estimateMilliCredits - shortfallMilliCredits,
          input.estimateMilliCredits,
        );
      }

      const reservation = await tx.creditReservation.create({
        data: {
          workspaceId: input.workspaceId,
          walletId: wallet.id,
          idempotencyKey: input.idempotencyKey,
          estimateMilliCredits: input.estimateMilliCredits,
          status: 'OPEN',
          allocations: allocations.map((a) => ({
            grantId: a.grantId,
            milliCredits: a.milliCredits.toString(),
          })),
          purpose: input.purpose,
          expiresAt,
          createdAt: now,
        },
        select: { id: true },
      });

      for (const allocation of allocations) {
        await tx.creditGrant.update({
          where: { id: allocation.grantId },
          data: { reservedMilliCredits: { increment: allocation.milliCredits } },
        });
      }

      await tx.creditWallet.update({
        where: { id: wallet.id },
        data: {
          reservedMilliCredits: wallet.reservedMilliCredits + input.estimateMilliCredits,
          version: { increment: 1 },
        },
      });

      // The hold itself is a ledger movement of zero: the balance has not
      // changed, and writing a signed row here would break replay. The
      // RESERVATION row records that the hold happened, for the audit trail.
      await tx.creditTransaction.create({
        data: {
          workspaceId: input.workspaceId,
          walletId: wallet.id,
          type: 'RESERVATION',
          amountMilliCredits: 0n,
          balanceAfterMilliCredits: wallet.balanceMilliCredits,
          reason: `Reserved ${input.estimateMilliCredits} milli-credits for ${input.purpose}.`,
          idempotencyKey: `${input.idempotencyKey}:reserve`,
          actorType: 'SYSTEM',
          actorId: null,
          occurredAt: now,
          reservationId: reservation.id,
        },
      });

      return reservation.id;
    });

    return this.reservation(reservationId);
  }

  /**
   * Charge the actual cost and release the rest.
   *
   * `actualMilliCredits` may be zero — a request that succeeded but consumed
   * nothing — and may never exceed the estimate; the database refuses that
   * directly, so an over-charge cannot survive a bug here.
   */
  async settle(
    reservationId: string,
    actualMilliCredits: bigint,
    reason: string,
  ): Promise<ReservationView> {
    if (actualMilliCredits < 0n) {
      throw new AppError('VALIDATION_FAILED', 'A settlement cannot be negative.');
    }

    const now = this.#clock.now();

    await this.#prisma.$transaction(async (tx) => {
      /*
       * LOCK THE RESERVATION FIRST — A-8.
       *
       * This used to be an unlocked `findUnique`, and the status check below
       * ran against it. Under READ COMMITTED two concurrent settles both read
       * OPEN, both passed the check, and both proceeded: they serialised on the
       * WALLET lock further down, but by then the loser was already committed
       * to writing. It decremented every bucket's hold a second time and wrote
       * a `USAGE_CHARGE` row whose idempotency key the winner had already used
       * — so the loser surfaced either a CHECK violation or a P2002, as a 500,
       * for an operation that had in fact succeeded.
       *
       * The constraints were right: they are what stopped the double charge.
       * What was wrong is that a retry is a normal event and must be a no-op,
       * not an error. Taking the row lock here makes the status check mean what
       * it says — the loser waits, re-reads a terminal status, and returns.
       */
      const reservation = await this.#lockReservation(tx, reservationId);
      if (!reservation) throw new AppError('NOT_FOUND', 'Reservation not found.');

      // Settling twice is the duplicate-charge bug this whole protocol exists
      // to prevent, so a terminal reservation is a no-op, not an error: the
      // caller retried, and the original outcome stands.
      if (reservation.status !== 'OPEN') return;

      if (actualMilliCredits > reservation.estimateMilliCredits) {
        throw new AppError('CONFLICT', 'A settlement cannot exceed the amount that was reserved.');
      }

      const wallet = await this.#lockWallet(tx, reservation.workspaceId);
      const frozen = parseAllocations(reservation.allocations);
      const charged = narrowAllocation(frozen, actualMilliCredits);
      const chargedTotal = allocationTotal(charged);

      let running = wallet.balanceMilliCredits;
      const chargeByGrant = new Map(charged.map((a) => [a.grantId, a.milliCredits]));

      // ONE update per bucket, moving `remaining` and `reserved` TOGETHER.
      //
      // They cannot be two updates. The invariant is `reserved <= remaining`,
      // enforced by a CHECK constraint, and charging a bucket lowers `remaining`
      // while the hold is still counted — so a bucket whose whole remainder is
      // both held and spent transiently violates it and the write is refused.
      // That is not a constraint to relax: it is the constraint doing its job,
      // and the fix is to make the two movements atomic, which they always
      // logically were.
      for (const allocation of frozen) {
        const charge = chargeByGrant.get(allocation.grantId) ?? 0n;
        await tx.creditGrant.update({
          where: { id: allocation.grantId },
          data: {
            // The hold is released in full — including the part just charged,
            // which is no longer reserved because it is now spent.
            reservedMilliCredits: { decrement: allocation.milliCredits },
            ...(charge > 0n ? { remainingMilliCredits: { decrement: charge } } : {}),
          },
        });

        if (charge <= 0n) continue;
        running -= charge;
        await tx.creditTransaction.create({
          data: {
            workspaceId: reservation.workspaceId,
            walletId: wallet.id,
            type: 'USAGE_CHARGE',
            amountMilliCredits: -charge,
            balanceAfterMilliCredits: running,
            reason,
            idempotencyKey: `${reservation.idempotencyKey}:settle:${allocation.grantId}`,
            actorType: 'SYSTEM',
            actorId: null,
            occurredAt: now,
            sourceGrantId: allocation.grantId,
            reservationId: reservation.id,
          },
        });
      }

      await tx.creditReservation.update({
        where: { id: reservation.id },
        data: {
          status: 'SETTLED',
          settledMilliCredits: chargedTotal,
          settledAt: now,
        },
      });

      await tx.creditWallet.update({
        where: { id: wallet.id },
        data: {
          balanceMilliCredits: running,
          reservedMilliCredits: wallet.reservedMilliCredits - reservation.estimateMilliCredits,
          lifetimeConsumedMilliCredits: wallet.lifetimeConsumedMilliCredits + chargedTotal,
          version: { increment: 1 },
        },
      });
    });

    return this.reservation(reservationId);
  }

  /**
   * Give the whole hold back. The failure path, and the sweeper's.
   *
   * Zero `USAGE_CHARGE` rows are written, which is the mechanism behind "a
   * failed provider request never results in a credit deduction".
   */
  async release(
    reservationId: string,
    reason: string,
    status: 'RELEASED' | 'EXPIRED' = 'RELEASED',
  ): Promise<ReservationView> {
    const now = this.#clock.now();

    await this.#prisma.$transaction(async (tx) => {
      // Locked before the status is read, for the reason settle documents:
      // concurrent release-and-release, and release racing a settle, are both
      // retries and must be no-ops rather than constraint violations.
      const reservation = await this.#lockReservation(tx, reservationId);
      if (!reservation) throw new AppError('NOT_FOUND', 'Reservation not found.');
      if (reservation.status !== 'OPEN') return;

      const wallet = await this.#lockWallet(tx, reservation.workspaceId);
      const frozen = parseAllocations(reservation.allocations);

      for (const allocation of frozen) {
        await tx.creditGrant.update({
          where: { id: allocation.grantId },
          data: { reservedMilliCredits: { decrement: allocation.milliCredits } },
        });
      }

      await tx.creditReservation.update({
        where: { id: reservation.id },
        data: { status, releasedAt: now, releaseReason: reason },
      });

      await tx.creditWallet.update({
        where: { id: wallet.id },
        data: {
          reservedMilliCredits: wallet.reservedMilliCredits - reservation.estimateMilliCredits,
          version: { increment: 1 },
        },
      });

      await tx.creditTransaction.create({
        data: {
          workspaceId: reservation.workspaceId,
          walletId: wallet.id,
          type: 'RESERVATION_RELEASE',
          amountMilliCredits: 0n,
          balanceAfterMilliCredits: wallet.balanceMilliCredits,
          reason,
          idempotencyKey: `${reservation.idempotencyKey}:release`,
          actorType: 'SYSTEM',
          actorId: null,
          occurredAt: now,
          reservationId: reservation.id,
        },
      });
    });

    return this.reservation(reservationId);
  }

  /**
   * Release every reservation nobody came back for.
   *
   * docs/BILLING-AND-CREDITS.md §10.3: reservation leaks are a monitored metric
   * that must stay at zero.
   *
   * F-62 — WHY THIS IS A LOOP AND NOT ONE QUERY.
   *
   * The previous version read ONE window of `take: limit` rows, in no defined
   * order, and attempted each. A reservation whose bucket does not record the
   * hold it claims can never be released: the decrement would take `reserved`
   * below zero and a CHECK constraint refuses it, correctly. Such a row is
   * reported and left OPEN — so it came back in the next window, and the next.
   *
   * Once as many as `limit` of them existed, the window filled with rows that
   * could never succeed and the sweep released NOTHING, permanently, while
   * every valid reservation behind them leaked. That is not hypothetical: a
   * long-lived database reached 259 abandoned reservations of which the first
   * 200 were all unreleasable, and a sweep pass swept zero.
   *
   * THREE CHANGES.
   *
   * 1. DETERMINISTIC ORDER. `[expiresAt asc, id asc]` — oldest leak first,
   *    with `id` making the order total so paging cannot skip or repeat a row.
   *    Unordered meant which rows a sweep touched was arbitrary, so a row could
   *    be starved even below the limit.
   *
   * 2. `limit` BOUNDS RELEASES, NOT ROWS EXAMINED. Rows that fail are excluded
   *    and the next batch is fetched, so failures cost a little work each
   *    rather than the whole sweep. A released row leaves the candidate set by
   *    changing status; a failed one stays, which is exactly why it must be
   *    excluded explicitly.
   *
   * 3. PROGRESS IS REPORTED. `exhausted` says whether the sweep reached the end
   *    of the abandoned set or stopped early at `limit` or `maxAttempts` —
   *    the difference between "there is no leak" and "there is more to do", which
   *    a bare count cannot express. `attempted` separates work done from work
   *    that succeeded.
   *
   * `maxAttempts` bounds total work so one sweep cannot run unboundedly against
   * a ledger full of unreleasable rows; the caller runs again.
   */
  async sweepAbandonedReservations(
    limit = 200,
    options: { readonly maxAttempts?: number } = {},
  ): Promise<SweepResult> {
    const now = this.#clock.now();
    /*
     * An EXPLICIT bound is honoured verbatim — a caller asking for at most five
     * attempts means five. The DEFAULT gets a floor of one batch, because
     * `limit * 4` for a small limit is a bound that gives up before it has
     * looked at anything: `sweepAbandonedReservations(1)` would have attempted
     * four rows and stopped, which against a ledger holding unreleasable rows
     * is the starvation this method exists to prevent, merely at a smaller
     * scale.
     */
    const maxAttempts = options.maxAttempts ?? Math.max(limit * 4, SWEEP_BATCH_SIZE);

    const failed: string[] = [];
    let swept = 0;
    let attempted = 0;
    let exhausted = false;

    while (swept < limit && attempted < maxAttempts) {
      const batch = await this.#prisma.creditReservation.findMany({
        where: {
          status: 'OPEN',
          expiresAt: { lt: now },
          // Everything already tried this sweep. Failures stay OPEN and would
          // otherwise be handed back for ever — this exclusion IS the progress.
          ...(failed.length > 0 ? { id: { notIn: failed } } : {}),
        },
        select: { id: true },
        orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
        take: Math.min(SWEEP_BATCH_SIZE, maxAttempts - attempted),
      });

      if (batch.length === 0) {
        // Nothing left that this sweep has not already tried: the abandoned
        // set is drained apart from the rows in `failed`.
        exhausted = true;
        break;
      }

      for (const reservation of batch) {
        if (swept >= limit || attempted >= maxAttempts) break;
        attempted += 1;
        try {
          await this.release(
            reservation.id,
            'Swept: the reservation passed its deadline without being settled.',
            'EXPIRED',
          );
          swept += 1;
        } catch {
          // A non-empty `failed` list is a correctness alert about the ledger,
          // distinct from `swept` being lower than expected. It is never a
          // reason to stop.
          failed.push(reservation.id);
        }
      }
    }

    return { swept, failed, attempted, exhausted };
  }

  // -------------------------------------------------------------------------
  // Expiry and cycle reset
  // -------------------------------------------------------------------------

  /**
   * Write off buckets that have lapsed.
   *
   * The unspent remainder of an expired bucket leaves the balance as an
   * `EXPIRY` row, so replay still reproduces the balance exactly. Reserved
   * credits inside a lapsed bucket are left alone: a request is in flight
   * against them, and settling it must not fail because a sweep ran first.
   */
  async expireLapsedGrants(workspaceId: string): Promise<bigint> {
    return this.#prisma.$transaction(async (tx) => this.#expireLapsedGrants(tx, workspaceId));
  }

  /**
   * The body of `expireLapsedGrants`, taking a transaction.
   *
   * Separated so the cycle reset can run expiry, forfeiture and the new grant
   * as ONE unit (A-6). It was four independent transactions, and a crash
   * between any two left a workspace half-reset.
   */
  async #expireLapsedGrants(tx: LedgerTx, workspaceId: string): Promise<bigint> {
    const now = this.#clock.now();

    {
      const wallet = await this.#lockWallet(tx, workspaceId);
      const lapsed = await tx.creditGrant.findMany({
        where: {
          workspaceId,
          expiresAt: { lt: now },
          remainingMilliCredits: { gt: 0 },
        },
        orderBy: { expiresAt: 'asc' },
      });

      let running = wallet.balanceMilliCredits;
      let total = 0n;

      for (const bucket of lapsed) {
        const writeOff = bucket.remainingMilliCredits - bucket.reservedMilliCredits;
        if (writeOff <= 0n) continue;

        running -= writeOff;
        total += writeOff;

        await tx.creditGrant.update({
          where: { id: bucket.id },
          data: { remainingMilliCredits: { decrement: writeOff } },
        });
        await tx.creditTransaction.create({
          data: {
            workspaceId,
            walletId: wallet.id,
            type: 'EXPIRY',
            amountMilliCredits: -writeOff,
            balanceAfterMilliCredits: running,
            reason: `Credits from ${bucket.grantedAt.toISOString()} expired.`,
            idempotencyKey: `expiry:${bucket.id}:${bucket.expiresAt?.toISOString() ?? 'none'}`,
            actorType: 'SYSTEM',
            actorId: null,
            occurredAt: now,
            sourceGrantId: bucket.id,
          },
        });
      }

      if (total > 0n) {
        await tx.creditWallet.update({
          where: { id: wallet.id },
          data: { balanceMilliCredits: running, version: { increment: 1 } },
        });
      }
      return total;
    }
  }

  /**
   * Apply the cycle boundary: expire, roll over what policy allows, grant anew.
   *
   * The order matters and is not arbitrary. Expiry runs FIRST so lapsed credits
   * are not rolled over; the surviving balance is then capped by the plan's
   * rollover policy (D-12: up to one monthly allowance) with the excess written
   * off; and only then is the new allowance granted. Doing it in any other
   * order either resurrects expired credits or discards ones the customer was
   * entitled to keep.
   *
   * ONE TRANSACTION, AND IDEMPOTENT ON THE CYCLE — A-6.
   *
   * This used to be four independent database operations: expiry, forfeiture,
   * the grant, then the timestamps. A crash between any two left the workspace
   * half-reset, and the halves were not equally recoverable. Re-running was
   * worse than doing nothing: the grant is keyed `plan-grant:<cycle>` and would
   * no-op correctly, but the forfeiture was keyed per BUCKET
   * (`reset:<cycle>:<grantId>`), and a second pass runs FIFO against the
   * buckets that survived the first — different ids, different keys, so the
   * customer was forfeited a SECOND time for one cycle boundary.
   *
   * The whole boundary is now one transaction, guarded by a single marker row
   * keyed on the cycle. A repeat returns the recorded outcome instead of
   * charging again, which is what makes a retried or duplicated scheduler tick
   * safe.
   *
   * RESERVED CREDITS ARE NOT FORFEITABLE, AND THE CAP HAS TO KNOW THAT.
   *
   * `carried` is the whole balance, reserved credits included — money held
   * against requests that are still in flight. The forfeiture then came off
   * `remaining − reserved` per bucket, so when the excess exceeded what was
   * actually spendable, `allocateFifo` returned a SHORTFALL that nobody read.
   * The customer silently kept credits above the cap, and once the in-flight
   * requests released, those credits came back as spendable balance.
   *
   * Now the shortfall is computed, reported, and the amount actually taken is
   * clamped to what is spendable. Credits cannot be seized from under a
   * request that is mid-flight — settling it must not fail because the reset
   * ran first — so the honest outcome is to forfeit what can be forfeited and
   * say how much could not.
   */
  async runCycleReset(input: {
    readonly workspaceId: string;
    readonly monthlyCredits: number;
    readonly rolloverPolicy: RolloverPolicy;
    readonly rolloverCapMultiplier: number;
    readonly cycleKey: string;
    readonly nextResetAt: Date | null;
  }): Promise<CycleResetResult> {
    const now = this.#clock.now();
    const allowance = BigInt(input.monthlyCredits) * MILLI_PER_CREDIT;
    const completionKey = `reset-complete:${input.cycleKey}`;

    const outcome = await this.#prisma.$transaction(async (tx) => {
      /*
       * THE CYCLE MARKER, read first and written last, inside the same
       * transaction. Its presence means this boundary already ran to
       * completion; its absence means it did not, whatever partial state a
       * previous crash may have left, because that state was rolled back.
       */
      const already = await tx.creditTransaction.findUnique({
        where: { idempotencyKey: completionKey },
        select: { workspaceId: true },
      });
      if (already) {
        if (already.workspaceId !== input.workspaceId) {
          throw new AppError('CONFLICT', 'That cycle key was used for a different workspace.');
        }
        return null;
      }

      const expired = await this.#expireLapsedGrants(tx, input.workspaceId);

      const wallet = await this.#lockWallet(tx, input.workspaceId);
      const carried = wallet.balanceMilliCredits;
      const keep = rolloverAmount(
        input.rolloverPolicy,
        input.rolloverCapMultiplier,
        allowance,
        carried,
      );

      let forfeited = 0n;
      let unforfeitable = 0n;
      let running = wallet.balanceMilliCredits;

      const lose = carried - keep;
      if (lose > 0n) {
        const buckets = await tx.creditGrant.findMany({
          where: { workspaceId: input.workspaceId, remainingMilliCredits: { gt: 0 } },
        });
        // Take the forfeit off the buckets FIFO, so what survives is the
        // soonest-expiring credit the customer keeps — the same ordering as
        // spending, for the same reason.
        const { allocations, shortfallMilliCredits } = allocateFifo(
          buckets.map((b) => ({
            id: b.id,
            spendableMilliCredits: b.remainingMilliCredits - b.reservedMilliCredits,
            expiresAt: b.expiresAt,
            grantedAt: b.grantedAt,
          })),
          lose,
        );
        /*
         * The part of the excess that is reserved and therefore cannot be
         * taken. Previously discarded — which is exactly how the customer kept
         * credits above the cap without anything recording that they had.
         */
        unforfeitable = shortfallMilliCredits;

        for (const allocation of allocations) {
          running -= allocation.milliCredits;
          forfeited += allocation.milliCredits;
          await tx.creditGrant.update({
            where: { id: allocation.grantId },
            data: { remainingMilliCredits: { decrement: allocation.milliCredits } },
          });
          await tx.creditTransaction.create({
            data: {
              workspaceId: input.workspaceId,
              walletId: wallet.id,
              type: 'RESET',
              amountMilliCredits: -allocation.milliCredits,
              balanceAfterMilliCredits: running,
              reason: 'Above the plan rollover cap at the cycle boundary.',
              idempotencyKey: `reset:${input.cycleKey}:${allocation.grantId}`,
              actorType: 'SYSTEM',
              actorId: null,
              occurredAt: now,
              sourceGrantId: allocation.grantId,
            },
          });
        }
      }

      let granted = 0n;
      if (input.monthlyCredits > 0) {
        // The new allowance, in the SAME transaction. `#grant` is the body of
        // the public `grant`, which would otherwise open a second one.
        await this.#grant(tx, {
          workspaceId: input.workspaceId,
          source: 'PLAN_GRANT',
          credits: input.monthlyCredits,
          reason: 'Monthly plan allowance.',
          idempotencyKey: `plan-grant:${input.cycleKey}`,
        });
        granted = allowance;
        running += allowance;
      }

      await tx.creditWallet.update({
        where: { id: wallet.id },
        data: {
          balanceMilliCredits: running,
          lastResetAt: now,
          nextResetAt: input.nextResetAt,
          version: { increment: 1 },
          // A wallet that has just received its allowance is no longer low.
          ...(granted > 0n ? { lowBalanceNotifiedPercent: null, lowBalanceNotifiedAt: null } : {}),
        },
      });

      // The marker, last: written only if everything above committed.
      await tx.creditTransaction.create({
        data: {
          workspaceId: input.workspaceId,
          walletId: wallet.id,
          type: 'RESET',
          amountMilliCredits: 0n,
          balanceAfterMilliCredits: running,
          reason: `Cycle boundary ${input.cycleKey} applied.`,
          idempotencyKey: completionKey,
          actorType: 'SYSTEM',
          actorId: null,
          occurredAt: now,
        },
      });

      return {
        rolledOver: running - granted,
        forfeited,
        unforfeitable,
        granted,
        expired,
        alreadyApplied: false,
      } satisfies CycleResetResult;
    });

    if (outcome) return outcome;

    // A repeat of a cycle that already completed. Report the CURRENT state
    // rather than re-deriving one, and say plainly that nothing was applied.
    const walletAfter = await this.#prisma.creditWallet.findUniqueOrThrow({
      where: { workspaceId: input.workspaceId },
    });
    return {
      rolledOver: walletAfter.balanceMilliCredits - allowance,
      forfeited: 0n,
      unforfeitable: 0n,
      granted: 0n,
      expired: 0n,
      alreadyApplied: true,
    };
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async reservation(id: string): Promise<ReservationView> {
    const row = await this.#prisma.creditReservation.findUnique({ where: { id } });
    if (!row) throw new AppError('NOT_FOUND', 'Reservation not found.');
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      estimateMilliCredits: row.estimateMilliCredits,
      settledMilliCredits: row.settledMilliCredits,
      status: row.status,
      purpose: row.purpose,
      expiresAt: row.expiresAt,
      allocations: parseAllocations(row.allocations),
    };
  }

  /** Live buckets, in the order they will be spent. */
  async grants(workspaceId: string): Promise<GrantView[]> {
    const rows = await this.#prisma.creditGrant.findMany({
      where: { workspaceId, remainingMilliCredits: { gt: 0 } },
      orderBy: [{ expiresAt: 'asc' }, { grantedAt: 'asc' }],
    });
    return rows.map(toGrantView);
  }

  /**
   * The threshold this wallet has just crossed, recorded so it speaks once.
   *
   * Returns the percentage to warn about, or null. Called after a settlement;
   * the notification itself is the caller's concern.
   */
  async noteLowBalance(
    workspaceId: string,
    monthlyAllowanceCredits: number,
  ): Promise<number | null> {
    const wallet = await this.#prisma.creditWallet.findUnique({ where: { workspaceId } });
    if (!wallet) return null;

    const crossing = lowBalanceCrossing(
      wallet.balanceMilliCredits - wallet.reservedMilliCredits,
      BigInt(monthlyAllowanceCredits) * MILLI_PER_CREDIT,
      this.#policy.lowBalanceThresholdPercents,
      wallet.lowBalanceNotifiedPercent,
    );
    if (crossing === null) return null;

    await this.#prisma.creditWallet.update({
      where: { workspaceId },
      data: {
        lowBalanceNotifiedPercent: crossing,
        lowBalanceNotifiedAt: this.#clock.now(),
      },
    });
    return crossing;
  }

  // -------------------------------------------------------------------------

  /**
   * Take the wallet row lock, creating the wallet if this workspace has none.
   *
   * `FOR UPDATE` is what serialises every balance mutation. Under READ
   * COMMITTED a second transaction blocks here and then re-reads the committed
   * row, so two concurrent spends cannot both act on the same starting balance.
   */
  /**
   * Take a row lock on a reservation, then read it through Prisma.
   *
   * Two statements on purpose. `SELECT … FOR UPDATE` is what serialises
   * concurrent settle/release of the same reservation; the `findUnique` that
   * follows runs inside the same transaction with the lock already held, so it
   * returns a consistent, fully typed row — including the JSON `allocations`
   * column, which a raw select would hand back untyped.
   *
   * Returns null for a reservation that does not exist, so the caller can
   * answer NOT_FOUND rather than deciding from an empty array.
   */
  async #lockReservation(
    tx: Pick<PrismaClient, '$queryRaw' | 'creditReservation'>,
    reservationId: string,
  ): Promise<ReservationRow | null> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id"
        FROM "credit_reservation"
       WHERE "id" = ${reservationId}::uuid
         FOR UPDATE`;
    if (locked.length === 0) return null;
    return tx.creditReservation.findUnique({ where: { id: reservationId } });
  }

  async #lockWallet(
    tx: Pick<PrismaClient, '$queryRaw' | '$executeRaw' | 'creditWallet'>,
    workspaceId: string,
  ): Promise<LockedWallet> {
    const locked = await tx.$queryRaw<LockedWallet[]>`
      SELECT "id",
             "balanceMilliCredits",
             "reservedMilliCredits",
             "lifetimeGrantedMilliCredits",
             "lifetimeConsumedMilliCredits",
             "lowBalanceNotifiedPercent"
        FROM "credit_wallet"
       WHERE "workspaceId" = ${workspaceId}::uuid
         FOR UPDATE`;

    const wallet = locked[0];
    if (wallet) return wallet;

    // A workspace that predates the wallet model, or one whose first credit
    // movement is this one.
    //
    // `ON CONFLICT DO NOTHING` rather than a `create` in a try/catch: a failed
    // statement ABORTS the surrounding PostgreSQL transaction, so catching the
    // unique violation would leave every later statement failing with "current
    // transaction is aborted". Two concurrent first movements therefore both
    // proceed, and the re-read below gives each the row that exists.
    await tx.$executeRaw`
      INSERT INTO "credit_wallet" ("id", "workspaceId", "updatedAt")
      VALUES (gen_random_uuid(), ${workspaceId}::uuid, now())
      ON CONFLICT ("workspaceId") DO NOTHING`;
    const created = await tx.$queryRaw<LockedWallet[]>`
      SELECT "id",
             "balanceMilliCredits",
             "reservedMilliCredits",
             "lifetimeGrantedMilliCredits",
             "lifetimeConsumedMilliCredits",
             "lowBalanceNotifiedPercent"
        FROM "credit_wallet"
       WHERE "workspaceId" = ${workspaceId}::uuid
         FOR UPDATE`;
    const row = created[0];
    if (!row) throw new AppError('NOT_FOUND', 'Workspace not found.');
    return row;
  }
}

/** Grant source -> the ledger type that records it. */
const LEDGER_TYPE_FOR_SOURCE: Record<
  CreditGrantSourceKey,
  | 'PLAN_GRANT'
  | 'TRIAL_GRANT'
  | 'PROMOTIONAL_GRANT'
  | 'ADDON_PURCHASE'
  | 'ADMIN_ADJUSTMENT'
  | 'RESET'
> = {
  PLAN_GRANT: 'PLAN_GRANT',
  TRIAL_GRANT: 'TRIAL_GRANT',
  PROMOTIONAL_GRANT: 'PROMOTIONAL_GRANT',
  PACK_PURCHASE: 'ADDON_PURCHASE',
  ADMIN_ADJUSTMENT: 'ADMIN_ADJUSTMENT',
  ROLLOVER: 'RESET',
};

function parseAllocations(raw: unknown): readonly Allocation[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const grantId = record['grantId'];
    const milli = record['milliCredits'];
    if (typeof grantId !== 'string') return [];
    // Stored as a string: JSON has no BigInt, and rounding a credit amount
    // through a double is exactly the kind of silent money bug this avoids.
    return [{ grantId, milliCredits: BigInt(String(milli ?? '0')) }];
  });
}

function toGrantView(row: {
  id: string;
  source: string;
  amountMilliCredits: bigint;
  remainingMilliCredits: bigint;
  reservedMilliCredits: bigint;
  expiresAt: Date | null;
  grantedAt: Date;
  reason: string;
}): GrantView {
  return {
    id: row.id,
    source: row.source,
    amountMilliCredits: row.amountMilliCredits,
    remainingMilliCredits: row.remainingMilliCredits,
    reservedMilliCredits: row.reservedMilliCredits,
    expiresAt: row.expiresAt,
    grantedAt: row.grantedAt,
    reason: row.reason,
  };
}
