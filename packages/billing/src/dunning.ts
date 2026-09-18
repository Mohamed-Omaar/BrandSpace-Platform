/**
 * What happens after a payment fails — as a schedule, not as a mood.
 *
 * THE POLICY IS CONFIGURATION (§27). Retry offsets, the grace period and how
 * long a suspended workspace is kept before cancellation all come from the
 * activated `commerce` document. This file turns that policy plus the attempt
 * history into the next decision, and contains no number of its own.
 *
 * NOTHING IS DELETED, EVER. The escalation ends at SUSPENDED — access is
 * withdrawn, the data stays. Retention and export are §38, and a dunning policy
 * cannot destroy a customer's work no matter how it is configured.
 */

import type { DunningPolicy } from './commerce';

export type DunningOutcome =
  /** Try again; `at` is when. */
  | { readonly kind: 'retry'; readonly attemptNumber: number; readonly at: Date }
  /** Retries are exhausted but the grace period still protects access. */
  | { readonly kind: 'grace'; readonly untilAt: Date }
  /** Grace is over. Access is withdrawn; data is kept. */
  | { readonly kind: 'suspend'; readonly cancelAfterAt: Date };

export interface DunningInput {
  readonly policy: DunningPolicy;
  /** When the invoice first failed. All offsets are measured from here. */
  readonly firstFailedAt: Date;
  /** How many attempts have already been made, including the first failure. */
  readonly attemptsMade: number;
  readonly now: Date;
}

const DAY_MS = 86_400_000;

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * DAY_MS);
}

/**
 * Decide what to do next for a failing invoice.
 *
 * MEASURED FROM THE FIRST FAILURE, not from the last attempt. A worker that ran
 * late, or twice, must not be able to extend a customer's grace period by
 * restarting the clock — the schedule is a function of the failure, so running
 * it again produces the same answer.
 */
export function nextDunningStep(input: DunningInput): DunningOutcome {
  const offsets = input.policy.retryOffsetDays;
  const graceEnd = addDays(input.firstFailedAt, input.policy.graceDays);

  if (input.attemptsMade <= offsets.length) {
    const offset = offsets[input.attemptsMade - 1] ?? offsets[offsets.length - 1] ?? 0;
    return {
      kind: 'retry',
      attemptNumber: input.attemptsMade + 1,
      at: addDays(input.firstFailedAt, offset),
    };
  }

  if (input.now < graceEnd) {
    return { kind: 'grace', untilAt: graceEnd };
  }

  return {
    kind: 'suspend',
    cancelAfterAt: addDays(graceEnd, input.policy.cancelAfterSuspendedDays),
  };
}

/**
 * A stable, provider-independent reason for a failure.
 *
 * WHY THE RAW MESSAGE IS NOT KEPT. A provider decline message can carry the
 * cardholder name, the last four digits or a bank's own free text, and it would
 * then live in our logs, our audit trail and the customer's screen. The codes
 * below are the vocabulary the product speaks; anything unrecognised becomes
 * `payment_failed` rather than being passed through.
 */
export const DUNNING_FAILURE_CODES = [
  'card_declined',
  'insufficient_funds',
  'expired_card',
  'authentication_required',
  'processing_error',
  'payment_failed',
] as const;

export type DunningFailureCode = (typeof DUNNING_FAILURE_CODES)[number];

export function normaliseFailureCode(raw: string | null): DunningFailureCode {
  if (!raw) return 'payment_failed';
  const candidate = raw.trim().toLowerCase();
  return (DUNNING_FAILURE_CODES as readonly string[]).includes(candidate)
    ? (candidate as DunningFailureCode)
    : 'payment_failed';
}
