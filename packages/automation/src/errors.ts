import { AppError } from '@brandspace/shared';

/** Automation failures, mapped to the platform's stable codes. */

export function automationRuleNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Automation not found.');
}

export function automationRunNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Automation run not found.');
}

export function ruleLimitReached(limit: number): AppError {
  return new AppError('QUOTA_EXCEEDED', 'This workspace has as many automations as it may have.', {
    limit,
  });
}

export function brandRuleLimitReached(limit: number): AppError {
  return new AppError('QUOTA_EXCEEDED', 'This brand has as many automations as it may have.', {
    limit,
  });
}

export function tooManyConditions(limit: number): AppError {
  return new AppError('VALIDATION_FAILED', 'That rule has too many conditions.', { limit });
}

export function unknownTriggerOrAction(): AppError {
  return new AppError('VALIDATION_FAILED', 'That automation is not available.');
}

/**
 * THE CREATOR NO LONGER HOLDS WHAT THE RULE NEEDS.
 *
 * Raised at CREATION. At RUN time the same situation is not an error at all — it
 * is a run recorded as `BLOCKED_BY_AUTHORIZATION`, because nobody is there to be
 * told, and a rule that silently stopped working with no record would be worse
 * than one that fails loudly into a history somebody can read.
 */
export function creatorLacksAuthority(): AppError {
  return new AppError('FORBIDDEN', 'You cannot create an automation that does that.');
}

/** The same one-error-for-every-reason rule the Copilot's confirmation uses. */
export function automationConfirmationRejected(): AppError {
  return new AppError('CONFLICT', 'That confirmation is no longer valid.');
}
