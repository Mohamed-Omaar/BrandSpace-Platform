import type { PrismaClient } from '@brandspace/database';
import { MILLI_PER_CREDIT } from '@brandspace/entitlements';

/**
 * Proving that the financial state has not drifted — docs/BILLING-AND-CREDITS.md
 * §9, docs/DATABASE.md §7.1.
 *
 * WHY THIS EXISTS AT ALL. Every materialised financial number in the platform is
 * derived from an immutable record: the wallet balance from the ledger, the
 * wallet's held amount from the open reservations, each bucket's remainder from
 * the charges settled against it, a purchased grant from the payment that bought
 * it. Each of those pairs is written inside one transaction, so each is correct
 * BY CONSTRUCTION — and "correct by construction" is a claim about code that has
 * been read, not about rows that exist. This is the pass that asks the rows.
 *
 * IT REPAIRS NOTHING, DELIBERATELY. A drift in a balance is not a value to be
 * rounded back into place: it means one of the invariants above did not hold,
 * and the only safe response is for a person to find out why with the evidence
 * still intact. CLAUDE.md §2.4 makes the ledger the source of truth; silently
 * rewriting the wallet to match it would destroy the difference that is the
 * whole finding. So this reports, and the caller audits.
 *
 * IT IMPLEMENTS NO CREDIT LOGIC. It sums columns and compares them. There is
 * deliberately no allocation, no expiry, no rollover and no grant here: a second
 * implementation of the ledger's arithmetic inside `@brandspace/billing` would
 * be a second answer, and then a disagreement between the two would prove
 * nothing about the data (D-196).
 *
 * WHY IT LIVES IN `billing` RATHER THAN `entitlements`. Four of the five
 * invariants are the ledger's own, but the fifth crosses the domains — a
 * completed pack purchase against the grant it produced — and `billing` is the
 * package permitted to see both (`eslint.config.mjs`); `entitlements` may not
 * import `billing`.
 *
 * IT IS BOUNDED AND SAFE TO RUN REPEATEDLY. One pass reads at most `limit`
 * wallets in a stable order, starting after the id the caller last saw, and
 * says whether it reached the end. Nothing it does depends on when it last ran,
 * so two instances running it at once produce two identical reports rather than
 * a race.
 */

/** What kind of disagreement was found. Each names the two things compared. */
export type FinancialDriftKind =
  /** The stored balance against a replay of the immutable ledger. */
  | 'wallet_vs_ledger'
  /** The stored balance against the sum of what the buckets say is left. */
  | 'wallet_vs_buckets'
  /** The stored held amount against the sum of what the buckets say is held. */
  | 'reserved_vs_buckets'
  /** The stored held amount against the reservations that are actually open. */
  | 'reserved_vs_reservations'
  /** A completed purchase whose named grant is missing or belongs elsewhere. */
  | 'purchase_grant_missing'
  /** A completed purchase whose grant is not the size that was bought. */
  | 'purchase_grant_amount';

export interface FinancialDrift {
  readonly workspaceId: string;
  readonly kind: FinancialDriftKind;
  /** The authoritative value — the record, not the materialisation. */
  readonly expectedMilliCredits: string;
  /** What the materialised row actually says. */
  readonly foundMilliCredits: string;
  /** The purchase or grant a row-level finding is about, where there is one. */
  readonly subjectId: string | null;
}

export interface ReconciliationResult {
  readonly walletsChecked: number;
  readonly purchasesChecked: number;
  readonly drifts: readonly FinancialDrift[];
  /**
   * True when this pass reached the end of the wallets. The caller wraps its
   * cursor back to the start, so every workspace is visited in a bounded number
   * of passes rather than the first `limit` of them for ever.
   */
  readonly exhausted: boolean;
  /** The last workspace id examined. Pass it back as `after` to continue. */
  readonly cursor: string | null;
}

export interface FinancialReconcilerOptions {
  readonly prisma: PrismaClient;
}

/** Wallets read per pass when the caller states no bound. */
const DEFAULT_LIMIT = 200;

export class FinancialReconciler {
  readonly #prisma: PrismaClient;

  constructor(options: FinancialReconcilerOptions) {
    this.#prisma = options.prisma;
  }

  async run(
    input: { readonly limit?: number; readonly after?: string | null } = {},
  ): Promise<ReconciliationResult> {
    const limit = Math.max(1, input.limit ?? DEFAULT_LIMIT);
    const after = input.after ?? null;

    /*
     * ORDERED BY ID, STARTING AFTER THE LAST ONE SEEN. A bounded `take` with no
     * order is a scan whose contents the database may choose differently every
     * pass, which would leave some wallets never examined — a reconciliation
     * with a blind spot is worse than none, because it reports "no drift" about
     * rows it did not read.
     */
    const wallets = await this.#prisma.creditWallet.findMany({
      where: after === null ? {} : { workspaceId: { gt: after } },
      select: {
        workspaceId: true,
        balanceMilliCredits: true,
        reservedMilliCredits: true,
      },
      orderBy: { workspaceId: 'asc' },
      take: limit,
    });

    if (wallets.length === 0) {
      return {
        walletsChecked: 0,
        purchasesChecked: 0,
        drifts: [],
        exhausted: true,
        cursor: null,
      };
    }

    const ids = wallets.map((wallet) => wallet.workspaceId);
    const drifts: FinancialDrift[] = [];

    // Three grouped reads for the whole batch rather than three per wallet.
    const [ledger, buckets, open] = await Promise.all([
      this.#prisma.creditTransaction.groupBy({
        by: ['workspaceId'],
        where: { workspaceId: { in: ids } },
        _sum: { amountMilliCredits: true },
      }),
      this.#prisma.creditGrant.groupBy({
        by: ['workspaceId'],
        where: { workspaceId: { in: ids } },
        _sum: { remainingMilliCredits: true, reservedMilliCredits: true },
      }),
      this.#prisma.creditReservation.groupBy({
        by: ['workspaceId'],
        where: { workspaceId: { in: ids }, status: 'OPEN' },
        _sum: { estimateMilliCredits: true },
      }),
    ]);

    const replayed = new Map(
      ledger.map((row) => [row.workspaceId, row._sum.amountMilliCredits ?? 0n]),
    );
    const remaining = new Map(
      buckets.map((row) => [row.workspaceId, row._sum.remainingMilliCredits ?? 0n]),
    );
    const heldByBucket = new Map(
      buckets.map((row) => [row.workspaceId, row._sum.reservedMilliCredits ?? 0n]),
    );
    const heldByReservation = new Map(
      open.map((row) => [row.workspaceId, row._sum.estimateMilliCredits ?? 0n]),
    );

    for (const wallet of wallets) {
      const compare = (
        kind: FinancialDriftKind,
        expected: bigint,
        found: bigint,
        subjectId: string | null = null,
      ): void => {
        if (expected === found) return;
        drifts.push({
          workspaceId: wallet.workspaceId,
          kind,
          expectedMilliCredits: expected.toString(),
          foundMilliCredits: found.toString(),
          subjectId,
        });
      };

      compare(
        'wallet_vs_ledger',
        replayed.get(wallet.workspaceId) ?? 0n,
        wallet.balanceMilliCredits,
      );
      compare(
        'wallet_vs_buckets',
        remaining.get(wallet.workspaceId) ?? 0n,
        wallet.balanceMilliCredits,
      );
      compare(
        'reserved_vs_buckets',
        heldByBucket.get(wallet.workspaceId) ?? 0n,
        wallet.reservedMilliCredits,
      );
      compare(
        'reserved_vs_reservations',
        heldByReservation.get(wallet.workspaceId) ?? 0n,
        wallet.reservedMilliCredits,
      );
    }

    /*
     * THE PAID-ONCE-GRANTED-ONCE CHECK.
     *
     * A CHECK constraint already refuses a COMPLETED purchase that names no
     * grant (§23), so what is left for a reconciliation is what a constraint
     * cannot express: that the grant it names EXISTS, belongs to the same
     * workspace, and is the size that was bought. A dangling id and a grant of
     * the wrong amount are both "the customer paid and did not get what they
     * paid for", and neither is visible anywhere else.
     */
    const purchases = await this.#prisma.creditPackPurchase.findMany({
      where: { workspaceId: { in: ids }, status: 'COMPLETED' },
      select: { id: true, workspaceId: true, credits: true, creditGrantId: true },
      orderBy: { id: 'asc' },
    });

    const grantIds = purchases
      .map((purchase) => purchase.creditGrantId)
      .filter((id): id is string => id !== null);
    const grants =
      grantIds.length === 0
        ? []
        : await this.#prisma.creditGrant.findMany({
            where: { id: { in: grantIds } },
            select: { id: true, workspaceId: true, amountMilliCredits: true },
          });
    const grantsById = new Map(grants.map((grant) => [grant.id, grant]));

    for (const purchase of purchases) {
      const bought = BigInt(purchase.credits) * MILLI_PER_CREDIT;
      const grant = purchase.creditGrantId ? grantsById.get(purchase.creditGrantId) : undefined;
      // A grant belonging to another workspace is reported as missing rather
      // than as an amount mismatch: this purchase produced nothing here, and
      // naming the other tenant in a drift record would be the leak.
      if (!grant || grant.workspaceId !== purchase.workspaceId) {
        drifts.push({
          workspaceId: purchase.workspaceId,
          kind: 'purchase_grant_missing',
          expectedMilliCredits: bought.toString(),
          foundMilliCredits: '0',
          subjectId: purchase.id,
        });
        continue;
      }
      if (grant.amountMilliCredits !== bought) {
        drifts.push({
          workspaceId: purchase.workspaceId,
          kind: 'purchase_grant_amount',
          expectedMilliCredits: bought.toString(),
          foundMilliCredits: grant.amountMilliCredits.toString(),
          subjectId: purchase.id,
        });
      }
    }

    return {
      walletsChecked: wallets.length,
      purchasesChecked: purchases.length,
      drifts,
      exhausted: wallets.length < limit,
      cursor: wallets[wallets.length - 1]?.workspaceId ?? null,
    };
  }
}
