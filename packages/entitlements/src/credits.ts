// The client TYPE comes from @brandspace/database, the only package permitted
// to import @prisma/client directly (docs/ARCHITECTURE.md §4.1).
import type { PrismaClient } from '@brandspace/database';
import { AppError, type Clock, systemClock } from '@brandspace/shared';
// The unit is defined once, beside the policy arithmetic that depends on it.
import { MILLI_PER_CREDIT } from './credit-policy';

/**
 * The AI credit wallet and ledger — docs/DATABASE.md §7, CLAUDE.md §2.4.
 *
 * FOUR PROPERTIES, each enforced by a mechanism rather than by care:
 *
 *   1. The balance is derived, never edited. Every change writes an immutable
 *      `CreditTransaction` and updates the wallet inside the SAME transaction,
 *      so a replay of the ledger reproduces the balance exactly.
 *   2. No negative balance. `SELECT … FOR UPDATE` serialises concurrent
 *      adjustments, and a CHECK constraint refuses the write regardless.
 *   3. No double adjustment on retry. `idempotencyKey` is unique; a repeat
 *      returns the ORIGINAL transaction rather than applying a second one.
 *   4. No rewriting history. UPDATE and DELETE are revoked from both database
 *      roles and refused by a trigger.
 *
 * Milli-credits internally, whole credits displayed (D-14). Rounding a cheap
 * task to a whole credit is a pricing decision nobody has made, and changing
 * the unit after launch means migrating the ledger.
 */

export const CREDIT_ADJUST_PERMISSION = 'platform.credit.adjust';

export interface CreditActor {
  readonly platformUserId: string;
  readonly roleKey: string;
  readonly mfaVerified: boolean;
  readonly permissionKeys: readonly string[];
}

export interface WalletSnapshot {
  readonly workspaceId: string;
  readonly balanceMilliCredits: bigint;
  readonly reservedMilliCredits: bigint;
  readonly lifetimeGrantedMilliCredits: bigint;
  readonly lifetimeConsumedMilliCredits: bigint;
  /** Whole credits, rounded DOWN — never show more than is spendable. */
  readonly balanceCredits: number;
}

export interface LedgerEntry {
  readonly id: string;
  readonly type: string;
  readonly amountMilliCredits: bigint;
  readonly balanceAfterMilliCredits: bigint;
  readonly reason: string;
  readonly occurredAt: Date;
  readonly actorType: string;
}

export interface CreditServiceOptions {
  readonly prisma: PrismaClient;
  readonly clock?: Clock;
}

export class CreditService {
  readonly #prisma: PrismaClient;
  readonly #clock: Clock;

  constructor(options: CreditServiceOptions) {
    this.#prisma = options.prisma;
    this.#clock = options.clock ?? systemClock;
  }

  /** The wallet, creating it on first read if a workspace predates the model. */
  async wallet(workspaceId: string): Promise<WalletSnapshot> {
    let row = await this.#prisma.creditWallet.findUnique({ where: { workspaceId } });
    if (!row) {
      // Concurrent first reads race; the unique index makes one of them win and
      // the other re-read rather than fail.
      try {
        row = await this.#prisma.creditWallet.create({ data: { workspaceId } });
      } catch {
        row = await this.#prisma.creditWallet.findUnique({ where: { workspaceId } });
      }
    }
    if (!row) throw new AppError('NOT_FOUND', 'Workspace not found.');

    return {
      workspaceId,
      balanceMilliCredits: row.balanceMilliCredits,
      reservedMilliCredits: row.reservedMilliCredits,
      lifetimeGrantedMilliCredits: row.lifetimeGrantedMilliCredits,
      lifetimeConsumedMilliCredits: row.lifetimeConsumedMilliCredits,
      balanceCredits: Number(row.balanceMilliCredits / MILLI_PER_CREDIT),
    };
  }

  async ledger(workspaceId: string, take = 50): Promise<LedgerEntry[]> {
    const rows = await this.#prisma.creditTransaction.findMany({
      where: { workspaceId },
      orderBy: { occurredAt: 'desc' },
      take,
    });
    return rows.map((t) => ({
      id: t.id,
      type: t.type,
      amountMilliCredits: t.amountMilliCredits,
      balanceAfterMilliCredits: t.balanceAfterMilliCredits,
      reason: t.reason,
      occurredAt: t.occurredAt,
      actorType: t.actorType,
    }));
  }

  /**
   * Adjust a workspace's balance by a signed amount of WHOLE credits.
   *
   * `idempotencyKey` is required, not optional: a caller that cannot name the
   * logical action cannot safely retry it, and a retried credit grant is a
   * money bug. Repeating a key returns the original transaction unchanged.
   */
  async adjust(
    actor: CreditActor,
    workspaceId: string,
    credits: number,
    reason: string,
    idempotencyKey: string,
  ): Promise<WalletSnapshot> {
    await this.#authorize(actor, 'credits.adjust', CREDIT_ADJUST_PERMISSION);

    if (!Number.isInteger(credits) || credits === 0) {
      throw new AppError(
        'VALIDATION_FAILED',
        'An adjustment is a non-zero whole number of credits.',
      );
    }
    if (reason.trim().length < 8) {
      throw new AppError(
        'VALIDATION_FAILED',
        'A credit adjustment requires a written reason of at least 8 characters.',
      );
    }
    if (!idempotencyKey.trim()) {
      throw new AppError('VALIDATION_FAILED', 'An idempotency key is required.');
    }

    const delta = BigInt(credits) * MILLI_PER_CREDIT;

    await this.#prisma.$transaction(async (tx) => {
      // Idempotency FIRST, inside the transaction: a retry must not even take
      // the row lock, let alone apply a second delta.
      const existing = await tx.creditTransaction.findUnique({ where: { idempotencyKey } });
      if (existing) return;

      // The row lock. Under READ COMMITTED, a second transaction blocks here
      // and then re-reads the committed balance, so two concurrent adjustments
      // serialise instead of both reading the same starting value.
      const locked = await tx.$queryRaw<
        {
          id: string;
          balanceMilliCredits: bigint;
          lifetimeGrantedMilliCredits: bigint;
          lifetimeConsumedMilliCredits: bigint;
        }[]
      >`SELECT "id", "balanceMilliCredits", "lifetimeGrantedMilliCredits", "lifetimeConsumedMilliCredits"
          FROM "credit_wallet"
         WHERE "workspaceId" = ${workspaceId}::uuid
           FOR UPDATE`;
      const wallet = locked[0];
      if (!wallet) throw new AppError('NOT_FOUND', 'Workspace not found.');

      const next = wallet.balanceMilliCredits + delta;
      if (next < 0n) {
        // Refused before the CHECK constraint fires, so the operator gets a
        // sentence rather than a database error code.
        throw new AppError(
          'CONFLICT',
          'That adjustment would take the balance below zero. A balance is never negative.',
        );
      }

      // Built separately: `exactOptionalPropertyTypes` refuses an explicit
      // `undefined` for a Prisma field, and only one lifetime total moves.
      const lifetime =
        delta > 0n
          ? { lifetimeGrantedMilliCredits: wallet.lifetimeGrantedMilliCredits + delta }
          : { lifetimeConsumedMilliCredits: wallet.lifetimeConsumedMilliCredits - delta };

      await tx.creditWallet.update({
        where: { id: wallet.id },
        data: {
          balanceMilliCredits: next,
          ...lifetime,
          version: { increment: 1 },
        },
      });

      await tx.creditTransaction.create({
        data: {
          workspaceId,
          walletId: wallet.id,
          type: 'ADMIN_ADJUSTMENT',
          amountMilliCredits: delta,
          balanceAfterMilliCredits: next,
          reason: reason.trim(),
          idempotencyKey,
          actorType: 'PLATFORM_USER',
          actorId: actor.platformUserId,
          occurredAt: this.#clock.now(),
        },
      });

      await tx.auditEvent.create({
        data: {
          workspaceId,
          actorType: 'PLATFORM_USER',
          actorId: actor.platformUserId,
          action: 'platform.credits.adjusted',
          resourceType: 'credit_wallet',
          resourceId: wallet.id,
          severity: 'NOTICE',
          outcome: 'SUCCESS',
          reason: reason.trim(),
          after: { credits, balanceAfterMilliCredits: next.toString() },
        },
      });
    });

    return this.wallet(workspaceId);
  }

  /**
   * Replay the ledger and compare with the stored balance.
   *
   * The reconciliation docs/DATABASE.md §7.1 requires. Returns the drift, which
   * must be zero; a non-zero result is a critical alert, not a rounding detail.
   */
  async reconcile(
    workspaceId: string,
  ): Promise<{ readonly stored: bigint; readonly replayed: bigint; readonly drift: bigint }> {
    const [wallet, transactions] = await Promise.all([
      this.#prisma.creditWallet.findUnique({ where: { workspaceId } }),
      this.#prisma.creditTransaction.findMany({
        where: { workspaceId },
        orderBy: { occurredAt: 'asc' },
      }),
    ]);
    if (!wallet) throw new AppError('NOT_FOUND', 'Workspace not found.');

    const replayed = transactions.reduce((sum, t) => sum + t.amountMilliCredits, 0n);
    return {
      stored: wallet.balanceMilliCredits,
      replayed,
      drift: wallet.balanceMilliCredits - replayed,
    };
  }

  async #authorize(actor: CreditActor, operation: string, permission: string): Promise<void> {
    const denial = creditDenialReason(actor, operation, permission);
    if (denial === null) return;

    if (actor?.platformUserId) {
      try {
        await this.#prisma.auditEvent.create({
          data: {
            workspaceId: null,
            actorType: 'PLATFORM_USER',
            actorId: actor.platformUserId,
            action: 'platform.credits.access.denied',
            resourceType: 'credit_wallet',
            severity: 'WARNING',
            outcome: 'DENIED',
            reason: denial,
          },
        });
      } catch {
        // A denial that cannot be recorded is still a denial.
      }
    }
    throw new AppError('FORBIDDEN', denial);
  }
}

export function creditDenialReason(
  actor: CreditActor | null | undefined,
  operation: string,
  permission: string,
): string | null {
  if (!actor?.platformUserId) return `${operation} requires a platform actor.`;
  if (!actor.mfaVerified) return `${operation} requires verified MFA (D-27).`;
  if (!actor.permissionKeys?.includes(permission)) return `${operation} requires ${permission}.`;
  return null;
}
