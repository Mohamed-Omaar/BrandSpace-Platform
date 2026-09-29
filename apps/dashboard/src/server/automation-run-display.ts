import { CONDITION_VALUE_UNAVAILABLE } from '@brandspace/automation';

/**
 * HOW ONE RUN READS IN "RUN HISTORY" — its badge and its reason line.
 *
 * Every run keeps the presentation it always had: the badge is its status and
 * the reason line is the generic "Reason: {code}" (a member's own skip has no
 * reason line). ONE CASE READS DIFFERENTLY (Phase 2B-3 PR 1, D-408): a run
 * SKIPPED because a value its rule names is no longer available was never
 * evaluated, so "Conditions did not hold" would be untrue and the raw code says
 * nothing to a person. It gets its own badge and a localized reason telling the
 * person what to do.
 *
 * Returns message keys and the code, never copy: the screen translates.
 */
export type RunReason =
  | { readonly kind: 'none' }
  | { readonly kind: 'generic'; readonly code: string }
  | { readonly kind: 'message'; readonly key: 'automations.failure.condition_value_unavailable' };

export interface RunPresentation {
  readonly statusKey: string;
  readonly reason: RunReason;
}

export function runPresentation(run: {
  readonly status: string;
  readonly failureCode: string | null;
}): RunPresentation {
  if (run.status === 'SKIPPED' && run.failureCode === CONDITION_VALUE_UNAVAILABLE) {
    return {
      statusKey: 'automations.status.valueUnavailable',
      reason: { kind: 'message', key: 'automations.failure.condition_value_unavailable' },
    };
  }
  return {
    statusKey: `automations.status.${run.status}`,
    reason:
      run.failureCode && run.failureCode !== 'skipped_by_member'
        ? { kind: 'generic', code: run.failureCode }
        : { kind: 'none' },
  };
}
