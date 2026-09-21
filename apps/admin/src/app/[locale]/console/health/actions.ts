'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { createLogger, internalErrorFields, toPublicErrorCode } from '@brandspace/shared';
import { withSpan } from '@brandspace/observability';
import {
  getBillingReconciler,
  getCommercePolicy,
  getPlanCatalogue,
  getPlatformPrisma,
  requirePlatformActor,
} from '../../../../server/platform-context';

const log = createLogger({ context: { component: 'admin.billing-inbox' } });

/**
 * Finishing a billing event that stopped — the operational half of
 * docs/BILLING-AND-CREDITS.md §5.1.
 *
 * WHAT WAS MISSING. `BillingReconciler.replay()` has existed since Phase 9, is
 * audited, refuses to replay anything already settled, and had NO CALLER: the
 * documentation said in as many words that "the Control Center screen for it is
 * not built yet". A dead-lettered event is a payment the customer made that we
 * did not act on, and until now nothing could list one or finish one.
 *
 * WHICH AUTHORITY IT TAKES, AND WHY IT IS THE UNION OF TWO.
 *
 * A replay can activate a subscription and can grant purchased credits, so it
 * is at least as powerful as assigning a plan and as adjusting credits. Rather
 * than inventing a new permission key — an RBAC decision that belongs to the
 * owner, and is recorded as one in docs/DECISIONS.md — it requires BOTH of the
 * existing keys that cover what it can do. That is strictly narrower than
 * either alone, so no role gains anything it did not already hold, and no
 * existing key is widened.
 *
 * THE OPERATOR CANNOT SUPPLY AN EVENT. The form carries an id and nothing else.
 * The event that is re-applied is the normalized one we stored when its
 * signature was verified, so there is no path here to invent a payment, amend
 * an amount, or replay something that never arrived.
 */
export async function replayBillingEventAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const billingEventId = String(formData.get('billingEventId') ?? '');
  let destination = `/${locale}/console/health`;

  try {
    // BOTH, in one call each, so a role holding only one is refused by the
    // first check it fails rather than by the settlement.
    await requirePlatformActor('platform.plan.assign');
    const actor = await requirePlatformActor('platform.credit.adjust');

    const [policy, catalogue] = await Promise.all([getCommercePolicy(), getPlanCatalogue()]);

    const providerKey = String(formData.get('providerKey') ?? '');
    const result = await withSpan('billing.event.replay', {}, async () =>
      getBillingReconciler().replay(getPlatformPrisma(), {
        billingEventId,
        providerKey,
        actorId: actor.platformUserId,
        policy,
        plans: catalogue.plans,
        planVersionId: catalogue.versionId,
      }),
    );

    destination = `/${locale}/console/health?${new URLSearchParams(
      result.replayed
        ? { ok: 'EVENT_REPLAYED', outcome: result.result.outcome }
        : // The refusal reason is a closed vocabulary from the reconciler —
          // "not_replayable", "claimed_by_another_delivery" — never an error
          // message and never anything from the provider.
          { error: 'REPLAY_REFUSED', reason: result.reason },
    ).toString()}`;
  } catch (error: unknown) {
    const correlationId = randomUUID();
    log.error('billing event replay failed', {
      correlationId,
      billingEventId,
      ...internalErrorFields(error),
    });
    destination = `/${locale}/console/health?${new URLSearchParams({
      error: toPublicErrorCode(error),
      ref: correlationId,
    }).toString()}`;
  }

  revalidatePath(`/${locale}/console/health`);
  redirect(destination);
}
