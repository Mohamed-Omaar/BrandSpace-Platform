import { CONDITION_VALUE_UNAVAILABLE, NOTIFY_TEMPLATE_NOT_ALLOWED } from '@brandspace/automation';

/**
 * HOW ONE RUN READS IN "RUN HISTORY" — its badge and its reason line.
 *
 * Every run keeps the presentation it always had: the badge is its status and
 * the reason line is the generic "Reason: {code}" (a member's own skip has no
 * reason line). TWO CASES READ DIFFERENTLY. The first (Phase 2B-3 PR 1, D-408): a run
 * SKIPPED because a value its rule names is no longer available was never
 * evaluated, so "Conditions did not hold" would be untrue and the raw code says
 * nothing to a person. It gets its own badge and a localized reason telling the
 * person what to do. The second (Fix PR 1 · F5, D-412) is below.
 *
 * Returns message keys and the code, never copy: the screen translates.
 */
export type RunReason =
  | { readonly kind: 'none' }
  | { readonly kind: 'generic'; readonly code: string }
  | {
      readonly kind: 'message';
      readonly key:
        | 'automations.failure.condition_value_unavailable'
        | 'automations.failure.notify_template_not_allowed';
    };

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
  /*
   * FIX PR 1 · F5 (D-412): a NOTIFY rule naming a template automations may not
   * send. The run did fail — the badge stays "Failed" — and the reason says
   * what to do, in the reader's language, instead of the raw code.
   */
  if (run.status === 'FAILED' && run.failureCode === NOTIFY_TEMPLATE_NOT_ALLOWED) {
    return {
      statusKey: 'automations.status.FAILED',
      reason: { kind: 'message', key: 'automations.failure.notify_template_not_allowed' },
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
