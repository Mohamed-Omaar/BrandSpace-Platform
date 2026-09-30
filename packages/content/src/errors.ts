import { AppError } from '@brandspace/shared';

/**
 * Content Studio failures, mapped to the stable codes the platform already uses
 * (CLAUDE.md §5).
 *
 * THE NOT-FOUND SHAPE IS LOAD-BEARING, exactly as it is in Brand Brain. An item
 * in another workspace, an item that never existed, and an item the caller may
 * not read all produce the SAME error with the SAME message — a distinguishable
 * "forbidden" would confirm the row exists (CLAUDE.md §2.1).
 */

export function contentItemNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Content not found.');
}

export function contentVariantNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Content variant not found.');
}

/** A platform key the operator does not offer. Names no internals. */
export function unsupportedPlatform(): AppError {
  return new AppError('VALIDATION_FAILED', 'That publishing channel is not available.');
}

export function unsupportedDialect(): AppError {
  return new AppError('VALIDATION_FAILED', 'That Arabic dialect is not available.');
}

/** The brand has as many live drafts as the activated policy allows. */
/** Phase 2B-3 PR 2 — lets a "make a draft copy" automation say which limit stopped it. */
export const DRAFT_LIMIT_REACHED_REASON = 'draft_limit_reached';

export function draftLimitReached(): AppError {
  return new AppError('QUOTA_EXCEEDED', 'This brand has reached its limit of saved drafts.', {
    reason: DRAFT_LIMIT_REACHED_REASON,
  });
}

/**
 * Phase 2B-3 PR 2 — the post being copied is filed under a campaign that no
 * longer exists (deleted or archived). The copy is not made rather than made
 * without its campaign: a campaign is never silently dropped. NOT_FOUND, as
 * the duplicate path has always answered it.
 */
export const SOURCE_CAMPAIGN_UNAVAILABLE_REASON = 'source_campaign_unavailable';

export function sourceCampaignUnavailable(): AppError {
  return new AppError('NOT_FOUND', 'Content not found.', {
    reason: SOURCE_CAMPAIGN_UNAVAILABLE_REASON,
  });
}

/**
 * The item is in a state this phase does not transition out of.
 *
 * Phase 5B-2 moves DRAFT → IN_REVIEW → SCHEDULED → ARCHIVED and no further:
 * publishing is Phase 6's and approval is the Approvals module's (5B-3).
 * Refusing here is how this phase avoids pre-empting either.
 */
export function transitionNotAllowed(): AppError {
  return new AppError('CONFLICT', 'This content cannot move to that state yet.');
}

/**
 * B-2 — a post that is publishing or has been published is a RECORD of what
 * went out, and its words and media no longer change. A new version is a
 * duplicate, which is a new draft.
 */
export function contentNotEditable(): AppError {
  return new AppError(
    'CONFLICT',
    'Published content cannot be edited. Duplicate it to make a new version.',
  );
}

/** The customer's brief is longer than the activated ceiling. */
export function briefTooLong(): AppError {
  return new AppError('VALIDATION_FAILED', 'That brief is too long.');
}

/* ------------------------------------------------------------------------ */
/* The Content Calendar                                                      */
/* ------------------------------------------------------------------------ */

/** A slot in another workspace, one that never existed, or one out of scope. */
export function calendarSlotNotFound(): AppError {
  return new AppError('NOT_FOUND', 'That calendar entry was not found.');
}

/**
 * A wall-clock that is not `YYYY-MM-DDTHH:mm`, a date that does not exist, or a
 * timezone this runtime does not know.
 *
 * ONE ERROR FOR ALL THREE on purpose: which of them it was is a detail about
 * the request, and the customer's remedy — choose a real date and time — is the
 * same in every case.
 */
export function invalidScheduleTime(): AppError {
  return new AppError('VALIDATION_FAILED', 'Choose a valid date and time.');
}

/**
 * Earlier than the configured minimum notice, or already past — including
 * earlier TODAY (F2): the date and the time are compared together. The reason
 * lets a screen say so instead of the generic "that was rejected".
 */
export const SCHEDULE_IN_PAST_REASON = 'schedule_in_past';

export function scheduleTooSoon(): AppError {
  return new AppError('VALIDATION_FAILED', 'Choose a time further ahead.', {
    reason: SCHEDULE_IN_PAST_REASON,
  });
}

/** Beyond the configured planning horizon. */
export function scheduleTooFarAhead(): AppError {
  return new AppError('VALIDATION_FAILED', 'That date is too far ahead to plan.');
}

/** One day's plan is full, per the activated policy. */
/** Phase 2B-3 PR 2 — lets "the next free slot" tell a full day from a spent plan. */
export const DAY_IS_FULL_REASON = 'day_is_full';

export function dayIsFull(): AppError {
  return new AppError('QUOTA_EXCEEDED', 'That day already has as many posts as it can hold.', {
    reason: DAY_IS_FULL_REASON,
  });
}

/**
 * AC-14.5 — the plan's monthly scheduled-post quota is spent.
 *
 * `QUOTA_EXCEEDED` is the code the dashboard already turns into an upgrade
 * prompt, so the criterion's "rejected with an upgrade prompt" is satisfied by
 * the existing path rather than by a second one.
 */
/** Phase 2B-3 PR 2 — the plan's scheduled-post ceiling, told apart from a full day. */
export const SCHEDULE_QUOTA_EXCEEDED_REASON = 'schedule_quota_exceeded';

export function scheduleQuotaExceeded(): AppError {
  return new AppError(
    'QUOTA_EXCEEDED',
    'This plan has reached its scheduled posts for this month.',
    { reason: SCHEDULE_QUOTA_EXCEEDED_REASON },
  );
}

/**
 * AC-14.6 — approval is required and this item does not have it.
 *
 * Says what is needed, and nothing about who may give it: the approver's
 * identity is not this module's to disclose.
 */
export function approvalRequiredBeforeScheduling(): AppError {
  return new AppError('CONFLICT', 'This content needs approval before it can be scheduled.');
}

/**
 * B-4 — a slot that is publishing, or already published, cannot be moved: the
 * jobs have been handed to the channel, and moving the plan would make the
 * calendar disagree with what went out.
 */
export function slotNotReschedulable(): AppError {
  return new AppError('CONFLICT', 'This post is already going out and cannot be moved.');
}

/**
 * §8.2 (Phase 2B-2b) — UNDO FOUND THE POST SOMEWHERE ELSE. Undo moves a post
 * back only while it is still where the move put it; if anything has moved it
 * since — or the same Undo already ran — nothing changes. `reason` is the
 * stable code the screen translates.
 */
export const SLOT_MOVED_SINCE_REASON = 'slot_moved_since';

export function slotMovedSince(): AppError {
  return new AppError('CONFLICT', 'This post has moved since. Nothing was changed.', {
    reason: SLOT_MOVED_SINCE_REASON,
  });
}

/**
 * Q9 (D-332) — every account for one of the post's channels was revoked or
 * disabled, so nothing could be sent there. `reason` is a stable code the
 * screens translate; the channel keys are the post's own.
 */
export const CHANNEL_DISCONNECTED_REASON = 'CHANNEL_DISCONNECTED';

export function channelDisconnected(platformKeys: readonly string[]): AppError {
  return new AppError(
    'CONFLICT',
    'An account for one of these channels was disconnected. Connect it again, or remove the channel.',
    { reason: CHANNEL_DISCONNECTED_REASON, channels: platformKeys.join(',') },
  );
}

/** The item already has a live slot. Reschedule it rather than adding a second. */
export function alreadyScheduled(): AppError {
  return new AppError('CONFLICT', 'This content is already on the calendar.');
}

/** An item with no variants has nothing to publish, so it cannot be planned. */
export function nothingToSchedule(): AppError {
  return new AppError('VALIDATION_FAILED', 'Write at least one caption before scheduling.');
}

/* --------------------------------------------------------------------------
 * Phase 5B-3 — Approvals.
 * ------------------------------------------------------------------------ */

/**
 * A review request that does not exist, belongs to another workspace, or names
 * a brand outside the caller's scope. ONE SHAPE for all three (CLAUDE.md §2.1).
 */
export function approvalNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Review request not found.');
}

/** The item is not in a state a review can be requested from. */
export function notSubmittable(): AppError {
  return new AppError('CONFLICT', 'This content cannot be sent for review from its current state.');
}

/** A second open review for the same item. The partial unique index agrees. */
export function alreadyInReview(): AppError {
  return new AppError('CONFLICT', 'This content is already waiting for review.');
}

/** The cycle was already decided, or withdrawn, and a verdict cannot land twice. */
export function approvalAlreadyDecided(): AppError {
  return new AppError('CONFLICT', 'That review has already been decided.');
}

/**
 * D-122 — the actor authored (or requested review of) the content they are
 * trying to approve, and this brand's policy does not permit self-approval.
 *
 * NAMES THE RULE, NOT THE PERSON. Saying who else may approve would disclose
 * membership to a caller who has just been refused.
 */
export function selfApprovalNotPermitted(): AppError {
  return new AppError(
    'FORBIDDEN',
    'You cannot approve content you submitted. Ask another reviewer.',
  );
}

/**
 * The actor may not judge this brand's content.
 *
 * FORBIDDEN rather than NOT_FOUND, deliberately and narrowly: the caller has
 * already been shown the item — they hold `content.read` and the brand is in
 * their scope — so refusing with a 404 here would hide a capability boundary
 * rather than a row's existence, and teach the reader their data had vanished.
 * Where the SUBJECT itself is out of reach the not-found shape still applies.
 */
export function approvalNotPermitted(): AppError {
  return new AppError('FORBIDDEN', 'You do not have permission to decide this review.');
}

/** The item has been through more review cycles than the policy allows. */
export function reviewCycleLimitReached(): AppError {
  return new AppError(
    'CONFLICT',
    'This content has been through too many review cycles. Start a new draft.',
  );
}

/** A note longer than the activated policy permits. */
/**
 * B5 — asking for changes without saying which. The author would be sent back
 * to a draft with nothing to act on, so the reason is required; approving and
 * rejecting still need none.
 */
export const DECISION_NOTE_REQUIRED_REASON = 'note_required';

export function decisionNoteRequired(): AppError {
  return new AppError('VALIDATION_FAILED', 'Say what should change.', {
    reason: DECISION_NOTE_REQUIRED_REASON,
  });
}

export function noteTooLong(): AppError {
  return new AppError('VALIDATION_FAILED', 'That note is too long.');
}

/**
 * The person a review was assigned to cannot decide it — not an active member,
 * outside the brand, or without review authority for it.
 *
 * NOT_FOUND-SHAPED. Confirming that a given uuid is a member of this workspace,
 * or is scoped to this brand, answers a question the requester has not been
 * granted (CLAUDE.md §2.1).
 */
export function assigneeNotEligible(): AppError {
  return new AppError('NOT_FOUND', 'That reviewer is not available for this content.');
}
