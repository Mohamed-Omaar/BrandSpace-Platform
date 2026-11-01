import type { PrismaClient } from '@brandspace/database';
import { AppError } from '@brandspace/shared';

/**
 * WHEN THE FREE TRIAL ENDS, THE WORKSPACE IS READ-ONLY (D-584; check-up
 * 2026-10-28, M-5).
 *
 * The owner's rule: the customer can still view and export everything, and
 * nothing is deleted; but nothing new is made or sent — no new post, no
 * publishing, no AI — until a plan is chosen or the platform owner extends the
 * trial from the Control Center.
 *
 * "ENDED" IS READ FROM THE SUBSCRIPTION, TWO WAYS. The cycle sweep turns an
 * unconverted trial EXPIRED at its boundary; between the instant `trialEndsAt`
 * passes and the sweep's next pass the row still says TRIALING, so a trial
 * whose end date is behind us counts as ended too. Any other status — a paid
 * plan, past due, a workspace with no subscription row — is not this rule's
 * business and is left exactly as it was.
 *
 * ENFORCED AT THE FEW PLACES EVERY PATH GOES THROUGH: the credit reservation
 * (every AI spend), the content item insert (every new post, whatever made it),
 * the calendar placement (scheduling and "publish now") and the materialisation
 * of publish jobs (so a post scheduled before the trial ended is held, not
 * sent). Reading, exporting and editing what exists are not touched.
 */

type SubscriptionReader = Pick<PrismaClient, 'workspaceSubscription'>;

export const TRIAL_ENDED_REASON = 'TRIAL_ENDED';

export interface TrialEndState {
  readonly status: string;
  readonly trialEndsAt: Date | null;
}

/** Pure: does this subscription state mean the trial is over and unconverted? */
export function trialHasEndedFor(state: TrialEndState | null, now: Date): boolean {
  if (!state) return false;
  if (state.status === 'EXPIRED') return true;
  return (
    state.status === 'TRIALING' &&
    state.trialEndsAt !== null &&
    state.trialEndsAt.getTime() <= now.getTime()
  );
}

export async function trialHasEnded(
  db: SubscriptionReader,
  workspaceId: string,
  now: Date,
): Promise<boolean> {
  const row = await db.workspaceSubscription.findUnique({
    where: { workspaceId },
    select: { status: true, trialEndsAt: true },
  });
  return trialHasEndedFor(row, now);
}

/** The one refusal, so every surface says the same thing and the client can map it. */
export function trialEndedError(): AppError {
  return new AppError(
    'ENTITLEMENT_REQUIRED',
    'The free trial has ended: this workspace is read-only until a plan is chosen.',
    { reason: TRIAL_ENDED_REASON },
  );
}

/** Refuse a write that makes or sends something new once the trial has ended. */
export async function assertWorkspaceMayCreate(
  db: SubscriptionReader,
  workspaceId: string,
  now: Date,
): Promise<void> {
  if (await trialHasEnded(db, workspaceId, now)) throw trialEndedError();
}
