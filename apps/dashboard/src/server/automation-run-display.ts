import {
  ACTION_OUTCOME_STATUS,
  CONDITION_VALUE_UNAVAILABLE,
  findAction,
  NOTIFY_TEMPLATE_NOT_ALLOWED,
  isActionOutcomeCode,
  type ActionOutcomeCode,
} from '@brandspace/automation';

/**
 * HOW ONE RUN READS IN "RUN HISTORY" — its badge and its reason line.
 *
 * NO NORMAL USER SEES A RAW CODE (Phase 2B-3 PR 2, owner decision D5-B). Every
 * code a run can end with is translated, through this one function:
 *
 *   - a run SKIPPED because a value its rule names is no longer available keeps
 *     its own badge and reason (PR 1, D-408);
 *   - a NOTIFY rule naming a template automations may not send keeps its
 *     reason under the FAILED badge (Fix PR 1 · F5, D-412);
 *   - a G13 action that did not act says why: an action-level SKIPPED gets the
 *     "Skipped" badge, never "Conditions did not hold"; a BLOCKED one keeps its
 *     BLOCKED badge;
 *   - the five existing codes a PR 2 rule can reach — the creator no longer a
 *     member, without the permission, without the brand; the workspace pending
 *     deletion; the daily limit — each have their words;
 *   - a request nobody approved in time (EXPIRED) says so (PR 5);
 *   - ANY OTHER CODE reads "Something went wrong running this automation."
 *
 * A condition that did not hold still reads "Conditions did not hold" with no
 * reason line, and a member's own skip still has none.
 *
 * Returns message keys, never copy: the screen translates.
 */
export type RunReason =
  { readonly kind: 'none' } | { readonly kind: 'message'; readonly key: RunReasonKey };

export type RunReasonKey =
  | 'automations.failure.condition_value_unavailable'
  | 'automations.failure.notify_template_not_allowed'
  | `automations.failure.${ActionOutcomeCode}`
  | `automations.failure.${ExistingReachableCode}`
  | 'automations.failure.confirmation_window_closed'
  | 'automations.failure.fallback';

/** The existing codes a PR 2 rule can normally reach (§13 of the PR 2 report). */
export const EXISTING_REACHABLE_CODES = [
  'creator_no_longer_a_member',
  'creator_lost_permission',
  'creator_lost_brand_scope',
  'workspace_pending_deletion',
  'daily_ceiling_reached',
  // Phase 2B-3 PR 5 (owner decision D2) — the rule was switched off or deleted
  // before its request was approved.
  'rule_disabled',
  // Phase 2B-3 PR 6 — DRAFT_IDEAS is the first action that declares an
  // entitlement, so a plan that does not include it is now a reachable reason.
  'not_entitled',
] as const;
type ExistingReachableCode = (typeof EXISTING_REACHABLE_CODES)[number];

function isExistingReachableCode(code: string): code is ExistingReachableCode {
  return (EXISTING_REACHABLE_CODES as readonly string[]).includes(code);
}

/**
 * Phase 2B-3 PR 5 — a request nobody approved in time. The expiry sweep writes
 * it, and only under EXPIRED; anywhere else it reads as the fallback.
 */
export const CONFIRMATION_WINDOW_CLOSED = 'confirmation_window_closed';

export interface RunPresentation {
  readonly statusKey: string;
  readonly reason: RunReason;
}

export function runPresentation(run: {
  readonly status: string;
  readonly failureCode: string | null;
}): RunPresentation {
  const status = `automations.status.${run.status}`;
  const code = run.failureCode;

  if (code === null || code === 'skipped_by_member') {
    return { statusKey: status, reason: { kind: 'none' } };
  }
  if (run.status === 'SKIPPED' && code === CONDITION_VALUE_UNAVAILABLE) {
    return {
      statusKey: 'automations.status.valueUnavailable',
      reason: { kind: 'message', key: 'automations.failure.condition_value_unavailable' },
    };
  }
  if (run.status === 'FAILED' && code === NOTIFY_TEMPLATE_NOT_ALLOWED) {
    return {
      statusKey: 'automations.status.FAILED',
      reason: { kind: 'message', key: 'automations.failure.notify_template_not_allowed' },
    };
  }
  /*
   * A G13 ACTION THAT DID NOT ACT. The code decides the badge only together
   * with the status it is recorded under, so a code that somehow arrived with
   * another status reads as the fallback rather than as something it is not.
   */
  if (isActionOutcomeCode(code) && ACTION_OUTCOME_STATUS[code] === run.status) {
    return {
      statusKey: run.status === 'SKIPPED' ? 'automations.status.actionSkipped' : status,
      reason: { kind: 'message', key: `automations.failure.${code}` },
    };
  }
  if (run.status === 'EXPIRED' && code === CONFIRMATION_WINDOW_CLOSED) {
    return {
      statusKey: status,
      reason: { kind: 'message', key: 'automations.failure.confirmation_window_closed' },
    };
  }
  if (isExistingReachableCode(code)) {
    return { statusKey: status, reason: { kind: 'message', key: `automations.failure.${code}` } };
  }
  return { statusKey: status, reason: { kind: 'message', key: 'automations.failure.fallback' } };
}

/**
 * PHASE 2B-3 PR 5 — WHO A WAITING REQUEST IS WAITING FOR, when the reader
 * cannot decide it. Keyed by the ONE permission the request's action requires
 * (the same `allOf[0]` the engine checks on approval and notifies by), so the
 * words name the right kind of member: a publish or a retry waits for someone
 * who may publish, a pause for someone who may manage campaigns. An action
 * whose permission has no words here shows no hint rather than a wrong one.
 */
export type WaitingHintKey =
  'automations.confirmNeedsPermission' | 'automations.confirmNeedsCampaignPermission';

const WAITING_HINT_BY_PERMISSION: Readonly<Record<string, WaitingHintKey>> = {
  'publishing.manage': 'automations.confirmNeedsPermission',
  'campaigns.manage': 'automations.confirmNeedsCampaignPermission',
};

export function waitingHint(actionType: string): WaitingHintKey | null {
  const permission = findAction(actionType)?.permissions.allOf[0];
  return permission ? (WAITING_HINT_BY_PERMISSION[permission] ?? null) : null;
}

/**
 * PHASE 2B-3 PR 5 — WHAT A REQUEST WOULD DO, in one line (approved copy): the
 * post a publish or a retry concerns, the campaign a pause names.
 *
 * `proposal` holds only what the READER can see: a campaign that was deleted or
 * lies outside their brands arrives as null, and the line says "not available"
 * without saying which — it never names a campaign the reader cannot see.
 */
export type RequestLine =
  | {
      readonly key: 'automations.needsYou.pause';
      readonly token: '{campaign}';
      readonly value: string;
    }
  | {
      readonly key: 'automations.needsYou.retry' | 'automations.previewContent';
      readonly token: '{content}';
      readonly value: string;
    }
  | {
      readonly key: 'automations.needsYou.pauseUnavailable' | 'automations.previewUnknown';
    };

export function requestLine(
  actionType: string,
  proposal: { readonly content: string | null; readonly campaign: string | null } | undefined,
): RequestLine {
  if (actionType === 'PAUSE_CAMPAIGN') {
    return proposal?.campaign
      ? { key: 'automations.needsYou.pause', token: '{campaign}', value: proposal.campaign }
      : { key: 'automations.needsYou.pauseUnavailable' };
  }
  if (!proposal?.content) return { key: 'automations.previewUnknown' };
  return {
    key:
      actionType === 'RETRY_PUBLISH' ? 'automations.needsYou.retry' : 'automations.previewContent',
    token: '{content}',
    value: proposal.content,
  };
}
