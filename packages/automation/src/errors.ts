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
 * THE ACTION CANNOT BE REACHED FROM THAT TRIGGER.
 *
 * Three actions operate on a content item; four triggers carry a reference that
 * is not one — an Insight, a MetricObservation, an ingestion run, or nothing at
 * all. Pairing them used to be authorable, and the engine then passed the
 * trigger's id through as a content item id.
 *
 * REFUSED AT AUTHORING, where a person is there to be told. At run time the same
 * pair is a `BLOCKED_BY_POLICY` run, because by then nobody is watching.
 */
export function triggerActionIncompatible(): AppError {
  return new AppError('VALIDATION_FAILED', 'That action cannot run from that trigger.');
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

/**
 * A condition names a field this trigger never produces.
 *
 * NAMED IN THE ERROR, because unlike a tenancy refusal this one is not a secret:
 * the field is the customer's own choice on their own rule, and a message that
 * said only "invalid" would leave them changing things at random. Telling them
 * WHICH field is the difference between a rule they can fix and one they delete.
 */
export function conditionFieldNotProduced(field: string): AppError {
  return new AppError('VALIDATION_FAILED', 'That condition cannot be evaluated for this trigger.', {
    field,
  });
}

/**
 * A condition asks a question this field cannot answer (R4-1).
 *
 * `brand.id greater_than`, `publish.provider is_true`, `metric.value in […]` —
 * each one parses, each one is stored, and each one compares FALSE for ever
 * because `evaluateCondition` refuses a mixed comparison by design. The screen
 * no longer offers them; this is why going around the screen does not work
 * either.
 *
 * NAMED, for the same reason the field error is: it is the customer's own
 * choice on their own rule, not a tenancy secret.
 */
export function conditionOperatorNotAllowed(field: string, operator: string): AppError {
  return new AppError('VALIDATION_FAILED', 'That comparison cannot be made on this field.', {
    field,
    operator,
  });
}

/**
 * The value is not of the kind this field's facts are.
 *
 * A number field compared against text, a list operator given a single string,
 * an empty list, a closed enum given a member that does not exist — all of them
 * store a rule that looks configured and can never match.
 */
export function conditionValueInvalid(field: string, operator: string): AppError {
  return new AppError('VALIDATION_FAILED', 'That value cannot be compared against this field.', {
    field,
    operator,
  });
}
