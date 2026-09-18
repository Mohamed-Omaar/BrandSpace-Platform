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
