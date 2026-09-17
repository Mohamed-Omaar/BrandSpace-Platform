import { AppError } from '@brandspace/shared';

/**
 * Analytics failures, mapped to the stable codes the platform already uses
 * (CLAUDE.md §5).
 *
 * THE NOT-FOUND SHAPE IS LOAD-BEARING, exactly as it is in Brand Brain and the
 * Content Studio. A brand in another workspace, a brand that never existed, and
 * a brand the caller is not scoped to all produce the SAME error with the SAME
 * message — a distinguishable "forbidden" would confirm the row exists
 * (CLAUDE.md §2.1).
 */

export function analyticsSubjectNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Analytics not found.');
}

export function insightNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Insight not found.');
}

/** The requested range is wider than the activated export ceiling. */
export function exportWindowTooWide(maxDays: number): AppError {
  return new AppError('VALIDATION_FAILED', 'That date range is wider than exports allow.', {
    maxDays,
  });
}

/** The requested range would produce more rows than the activated ceiling. */
export function exportTooLarge(maxRows: number): AppError {
  return new AppError('VALIDATION_FAILED', 'That export is larger than the current limit.', {
    maxRows,
  });
}

export function explainWindowTooWide(maxDays: number): AppError {
  return new AppError('VALIDATION_FAILED', 'That date range is wider than explanations allow.', {
    maxDays,
  });
}

/** A metric key that is not in the canonical vocabulary. */
export function unknownMetric(): AppError {
  return new AppError('VALIDATION_FAILED', 'That metric is not available.');
}

/**
 * NOT ENOUGH EVIDENCE TO EXPLAIN ANYTHING.
 *
 * A REFUSAL, NOT A FAILURE, and deliberately free: no gateway call is made, no
 * reservation is taken and no credits move. A model asked to explain three
 * numbers will write a confident paragraph about three numbers, and a customer
 * cannot tell that from insight — so the honest answer is that there is not
 * enough data yet, and it costs nothing to give.
 */
export function insufficientEvidence(required: number, found: number): AppError {
  return new AppError('VALIDATION_FAILED', 'There is not enough performance data yet.', {
    required,
    found,
  });
}

/**
 * The model produced prose that cited evidence it was never given, or a number
 * that appears nowhere in its evidence.
 *
 * TREATED AS A GENERATION FAILURE rather than trimmed and shipped. A partially
 * grounded explanation is the most dangerous shape this feature can take: it
 * reads exactly like a fully grounded one.
 */
export function ungroundedExplanation(): AppError {
  return new AppError('INTERNAL', 'The explanation could not be produced.');
}

/** A generation failed at the provider. The customer-safe message, or a default. */
export function explanationFailed(customerMessage: string | null): AppError {
  return new AppError(
    'INTERNAL',
    customerMessage ?? 'The explanation could not be produced. Nothing was charged.',
  );
}

/**
 * No analytics source is registered for a provider in this environment.
 *
 * In PRODUCTION this is what a missing real adapter looks like, and it is
 * deliberately loud: a deployment with only mock sources must not come up
 * looking healthy and draw charts out of arithmetic.
 */
export function analyticsSourceUnavailable(): AppError {
  return new AppError('INTERNAL', 'Analytics are not available for this platform yet.');
}
