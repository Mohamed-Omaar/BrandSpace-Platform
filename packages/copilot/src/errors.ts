import { AppError } from '@brandspace/shared';

/**
 * Copilot failures.
 *
 * TWO SHAPES, AND THE DIFFERENCE BETWEEN THEM IS DELIBERATE.
 *
 * Anything about a RESOURCE the caller may not see is a 404 with the same
 * message a genuine miss produces — a plan in another workspace, a plan
 * belonging to another member, a session that never existed. That is the
 * platform rule (CLAUDE.md §2.1), and it matters more here than anywhere else in
 * the product: a model can be talked into naming an id, and a distinguishable
 * "forbidden" would turn the Copilot into an oracle for what exists.
 *
 * Anything about the STATE OF A PLAN the caller can see is a 409 that says what
 * is wrong, because the caller is entitled to know their own plan expired or was
 * already confirmed — and being told "not found" at that point would be a
 * product that loses people's work without explanation.
 */

export function copilotSessionNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Conversation not found.');
}

export function copilotPlanNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Plan not found.');
}

/** The plan is not in a state that admits this operation. */
export function planNotConfirmable(): AppError {
  return new AppError('CONFLICT', 'This plan can no longer be confirmed.');
}

/**
 * THE CONFIRMATION DID NOT MATCH.
 *
 * ONE ERROR FOR ALL FOUR REASONS — a wrong token, a replayed token, an expired
 * window, and a hash belonging to an older version of the plan. Telling them
 * apart would let a caller learn which half of a confirmation they got right,
 * which is exactly the feedback an attacker needs and exactly the feedback a
 * legitimate user does not (they press the button again and get a fresh plan).
 */
export function confirmationRejected(): AppError {
  return new AppError('CONFLICT', 'That confirmation is no longer valid. Review the plan again.');
}

/** The plan changed since it was shown. A NEW confirmation is required. */
export function planChangedSinceConfirmation(): AppError {
  return new AppError('CONFLICT', 'The plan changed. Review and confirm it again.');
}

export function planAlreadyExecuted(): AppError {
  return new AppError('CONFLICT', 'This plan has already run.');
}

export function planNotConfirmed(): AppError {
  return new AppError('CONFLICT', 'This plan has not been confirmed.');
}

/** A tool key the registry does not contain. */
export function unknownTool(): AppError {
  return new AppError('VALIDATION_FAILED', 'That action is not available.');
}

/** The plan asks for more steps than the activated policy allows. */
export function planTooLarge(maxSteps: number): AppError {
  return new AppError('VALIDATION_FAILED', 'That request needs too many steps.', { maxSteps });
}

export function tooManyOpenPlans(maxOpen: number): AppError {
  return new AppError('CONFLICT', 'You have too many plans waiting for confirmation.', { maxOpen });
}

/**
 * THE UNDO WOULD OVERWRITE SOMEBODY ELSE'S WORK.
 *
 * Refused with a reason rather than performed. An undo is a promise to put
 * things back as they were, and putting things back over a later edit is not
 * that promise — it is a second, silent change.
 */
export function undoUnsafe(reasonCode: string): AppError {
  return new AppError('CONFLICT', 'This cannot be undone safely.', { reason: reasonCode });
}

export function undoWindowClosed(): AppError {
  return new AppError('CONFLICT', 'The undo window for this plan has closed.');
}

/**
 * THE EXTERNAL ACTION HAS NOWHERE TO GO in this deployment.
 *
 * Honest rather than silent: a surface that was not wired with the external
 * action port cannot publish, and says so, instead of appearing to succeed.
 */
export function externalActionUnavailable(): AppError {
  return new AppError('INTERNAL', 'That action is not available from here.');
}

export function copilotGenerationFailed(customerMessage: string | null): AppError {
  return new AppError(
    'INTERNAL',
    customerMessage ?? 'The assistant could not answer. Nothing was charged.',
  );
}

/** The request is longer than the activated ceiling. */
export function requestTooLong(maxChars: number): AppError {
  return new AppError('VALIDATION_FAILED', 'That message is too long.', { maxChars });
}
