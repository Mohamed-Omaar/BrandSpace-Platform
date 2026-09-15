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
 * Phase 5B-2 moves DRAFT → IN_REVIEW → ARCHIVED and no further: scheduling is
 * the Social Calendar's (scope item 5) and approval is Approvals' (item 6).
 * Refusing here is how this phase avoids pre-empting either.
 */
export function transitionNotAllowed(): AppError {
  return new AppError('CONFLICT', 'This content cannot move to that state yet.');
}

/** The customer's brief is longer than the activated ceiling. */
export function briefTooLong(): AppError {
  return new AppError('VALIDATION_FAILED', 'That brief is too long.');
}
