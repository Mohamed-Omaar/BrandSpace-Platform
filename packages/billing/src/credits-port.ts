/**
 * The bridge from a settled purchase to the credit ledger.
 *
 * ONE FUNCTION WIDE, ON PURPOSE. Billing must be able to say "these credits were
 * paid for, grant them once"; it must not be able to reserve, settle, expire,
 * adjust or read the wallet. The ledger stays Phase 3's (§1 — do not duplicate
 * it), and this is the whole of the surface between them.
 *
 * PREPAID ONLY (D-196). The single entry point grants credits that have already
 * been paid for. There is no method here that could extend credit, and that is
 * the architectural form of "no postpaid overage".
 */

import type { TenantScopedClient } from '@brandspace/database';
import type { CreditLedgerService, LedgerTx } from '@brandspace/entitlements';
import type { CreditGrantPort } from './reconcile';

/**
 * Adapt the ledger service to the port.
 *
 * THE CAST IS THE POINT OF THIS FILE, so it exists exactly once and is explained
 * once. `TenantScopedClient` and `LedgerTx` are the same Prisma transaction
 * client described by two different `Omit`s: the first hides `$transaction`
 * (you are already inside one), the second hides `$use`. Neither path calls
 * either. Converting here keeps every other call site honest about which client
 * it holds.
 *
 * AND THE PREMISE IS NOW TRUE, which it was not. "You are already inside one"
 * described an intention rather than a fact: the reconciler was handed a
 * top-level client through a second cast at the route, so `grantWithin`'s three
 * writes autocommitted separately and could leave a credit transaction with no
 * bucket. `BillingReconciler` opens the settlement transaction, so this cast
 * now converts one transaction client into another rather than converting a
 * promise into a hope.
 */
export function creditLedgerPort(ledger: CreditLedgerService): CreditGrantPort {
  return {
    async grantPackCredits(db: TenantScopedClient, input): Promise<string> {
      return ledger.grantWithin(db as unknown as LedgerTx, {
        workspaceId: input.workspaceId,
        source: 'PACK_PURCHASE',
        credits: input.credits,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        expiresAt: input.expiresAt,
        actor: { actorType: 'SYSTEM', actorId: null },
      });
    },
  };
}
