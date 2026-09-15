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
export function draftLimitReached(): AppError {
  return new AppError('QUOTA_EXCEEDED', 'This brand has reached its limit of saved drafts.');
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

/** Earlier than the configured minimum notice, or already past. */
export function scheduleTooSoon(): AppError {
  return new AppError('VALIDATION_FAILED', 'Choose a time further ahead.');
}

/** Beyond the configured planning horizon. */
export function scheduleTooFarAhead(): AppError {
  return new AppError('VALIDATION_FAILED', 'That date is too far ahead to plan.');
}

/** One day's plan is full, per the activated policy. */
export function dayIsFull(): AppError {
  return new AppError('QUOTA_EXCEEDED', 'That day already has as many posts as it can hold.');
}

/**
 * AC-14.5 — the plan's monthly scheduled-post quota is spent.
 *
 * `QUOTA_EXCEEDED` is the code the dashboard already turns into an upgrade
 * prompt, so the criterion's "rejected with an upgrade prompt" is satisfied by
 * the existing path rather than by a second one.
 */
export function scheduleQuotaExceeded(): AppError {
  return new AppError(
    'QUOTA_EXCEEDED',
    'This plan has reached its scheduled posts for this month.',
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

/** The item already has a live slot. Reschedule it rather than adding a second. */
export function alreadyScheduled(): AppError {
  return new AppError('CONFLICT', 'This content is already on the calendar.');
}

/** An item with no variants has nothing to publish, so it cannot be planned. */
export function nothingToSchedule(): AppError {
  return new AppError('VALIDATION_FAILED', 'Write at least one caption before scheduling.');
}
