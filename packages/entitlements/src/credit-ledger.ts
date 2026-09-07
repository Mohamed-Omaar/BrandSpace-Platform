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

    const grantId = await this.#prisma.$transaction(async (tx) => {
      // Idempotency first, before the lock: a retry must not queue behind other
      // writers only to do nothing.
      const existing = await tx.creditTransaction.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true },
      });
      if (existing) {
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
    });

    const row = await this.#prisma.creditGrant.findUniqueOrThrow({ where: { id: grantId } });
    return toGrantView(row);
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
      const reservation = await tx.creditReservation.findUnique({
        where: { id: reservationId },
      });
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
      const reservation = await tx.creditReservation.findUnique({
        where: { id: reservationId },
      });
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
   * that must stay at zero. Returns how many were swept so a caller can alert
   * on a non-zero count rather than discovering the leak from a balance.
   */
  async sweepAbandonedReservations(
    limit = 200,
  ): Promise<{ readonly swept: number; readonly failed: readonly string[] }> {
    const now = this.#clock.now();
    const abandoned = await this.#prisma.creditReservation.findMany({
      where: { status: 'OPEN', expiresAt: { lt: now } },
      select: { id: true },
      take: limit,
    });

    let swept = 0;
    const failed: string[] = [];

    for (const reservation of abandoned) {
      try {
        await this.release(
          reservation.id,
          'Swept: the reservation passed its deadline without being settled.',
          'EXPIRED',
        );
        swept += 1;
      } catch {
        // ONE unreleasable reservation must not stop the sweep.
        //
        // A row whose bucket does not record the hold it claims cannot be
        // released — the decrement would take `reserved` below zero and a CHECK
        // constraint refuses it, which is the constraint doing its job. But a
        // sweeper that dies on the first such row stops releasing every VALID
        // reservation behind it, and reservation leaks are a metric that must
        // stay at zero (docs/BILLING-AND-CREDITS.md §10.3).
        //
        // So the bad row is reported by id and the sweep continues. A non-empty
        // `failed` list is a correctness alert about the ledger, distinct from
        // `swept` being lower than expected.
        failed.push(reservation.id);
      }
    }
    return { swept, failed };
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
    const now = this.#clock.now();

    return this.#prisma.$transaction(async (tx) => {
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
    });
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
   */
  async runCycleReset(input: {
    readonly workspaceId: string;
    readonly monthlyCredits: number;
    readonly rolloverPolicy: RolloverPolicy;
    readonly rolloverCapMultiplier: number;
    readonly cycleKey: string;
    readonly nextResetAt: Date | null;
  }): Promise<{
    readonly rolledOver: bigint;
    readonly forfeited: bigint;
    readonly granted: bigint;
  }> {
    const now = this.#clock.now();
    const allowance = BigInt(input.monthlyCredits) * MILLI_PER_CREDIT;

    await this.expireLapsedGrants(input.workspaceId);

    const forfeited = await this.#prisma.$transaction(async (tx) => {
      const wallet = await this.#lockWallet(tx, input.workspaceId);
      const carried = wallet.balanceMilliCredits;
      const keep = rolloverAmount(
        input.rolloverPolicy,
        input.rolloverCapMultiplier,
        allowance,
        carried,
      );
      const lose = carried - keep;
      if (lose <= 0n) return 0n;

      // Take the forfeit off the buckets FIFO, so what survives is the
      // soonest-expiring credit the customer keeps — the same ordering as
      // spending, for the same reason.
      const buckets = await tx.creditGrant.findMany({
        where: { workspaceId: input.workspaceId, remainingMilliCredits: { gt: 0 } },
      });
      const { allocations } = allocateFifo(
        buckets.map((b) => ({
          id: b.id,
          spendableMilliCredits: b.remainingMilliCredits - b.reservedMilliCredits,
          expiresAt: b.expiresAt,
          grantedAt: b.grantedAt,
        })),
        lose,
      );

      let running = wallet.balanceMilliCredits;
      let total = 0n;
      for (const allocation of allocations) {
        running -= allocation.milliCredits;
        total += allocation.milliCredits;
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

      await tx.creditWallet.update({
        where: { id: wallet.id },
        data: { balanceMilliCredits: running, version: { increment: 1 } },
      });
      return total;
    });

    let granted = 0n;
    if (input.monthlyCredits > 0) {
      await this.grant({
        workspaceId: input.workspaceId,
        source: 'PLAN_GRANT',
        credits: input.monthlyCredits,
        reason: 'Monthly plan allowance.',
        idempotencyKey: `plan-grant:${input.cycleKey}`,
      });
      granted = allowance;
    }

    await this.#prisma.creditWallet.update({
      where: { workspaceId: input.workspaceId },
      data: { lastResetAt: now, nextResetAt: input.nextResetAt },
    });

    const walletAfter = await this.#prisma.creditWallet.findUniqueOrThrow({
      where: { workspaceId: input.workspaceId },
    });
    return {
      rolledOver: walletAfter.balanceMilliCredits - granted,
      forfeited,
      granted,
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
