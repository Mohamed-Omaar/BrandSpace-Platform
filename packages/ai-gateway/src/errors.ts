import { AppError } from '@brandspace/shared';

/**
 * The uniform provider error taxonomy — docs/AI-GATEWAY.md §3.
 *
 * WHY THIS EXISTS AT ALL. Retryability, fallback eligibility and the message a
 * customer sees are decided from THIS classification and never from a
 * provider's own error strings. Providers rename their errors, change their
 * status codes and reword their messages; if the gateway's behaviour were
 * derived from any of that, a provider's release note would silently change
 * whether BrandSpace retries a request or charges for it.
 *
 * Adding a provider therefore means writing one `classifyError` and nothing
 * else: no branch anywhere in the pipeline mentions a provider by name.
 */
export const AI_FAILURE_CLASSES = [
  'AUTH_ERROR',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'INVALID_REQUEST',
  'CONTENT_FILTERED',
  'CONTEXT_TOO_LONG',
  'MODEL_UNAVAILABLE',
  'PROVIDER_UNAVAILABLE',
  'TIMEOUT',
  'NETWORK_ERROR',
  'UNKNOWN',
] as const;

export type AiFailureClass = (typeof AI_FAILURE_CLASSES)[number];

/**
 * Which classes are worth trying again ON THE SAME MODEL.
 *
 * A transient condition — the provider was briefly unavailable, we were rate
 * limited, the connection dropped — may well succeed on a second attempt. An
 * `INVALID_REQUEST` will not, and retrying it wastes the customer's deadline
 * to arrive at the same answer.
 */
const RETRYABLE: ReadonlySet<AiFailureClass> = new Set([
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'TIMEOUT',
  'NETWORK_ERROR',
]);

/**
 * Which classes are worth trying on a DIFFERENT model — docs/AI-GATEWAY.md §5.3.
 *
 * The distinction from retryable is deliberate and is not a detail:
 *
 *   - `MODEL_UNAVAILABLE` is not retryable (the same model will still be
 *     unavailable) but IS fallback-eligible (another one may not be).
 *   - `INVALID_REQUEST`, `CONTENT_FILTERED` and `CONTEXT_TOO_LONG` are neither.
 *     A different model would fail the same way — or worse, would NOT, which
 *     would mean quietly routing around a moderation decision or a malformed
 *     request instead of surfacing it.
 *   - `AUTH_ERROR` and `QUOTA_EXCEEDED` are the provider's account-level
 *     problems. Falling back hides an outage the operator needs to see, so
 *     they are excluded and surface immediately.
 */
const FALLBACK_ELIGIBLE: ReadonlySet<AiFailureClass> = new Set([
  'RATE_LIMITED',
  'MODEL_UNAVAILABLE',
  'PROVIDER_UNAVAILABLE',
  'TIMEOUT',
  'NETWORK_ERROR',
]);

export function isRetryable(failureClass: AiFailureClass): boolean {
  return RETRYABLE.has(failureClass);
}

export function isFallbackEligible(failureClass: AiFailureClass): boolean {
  return FALLBACK_ELIGIBLE.has(failureClass);
}

/**
 * A provider failure, already classified.
 *
 * Carries the class rather than a provider message, and its `message` is the
 * one a CUSTOMER may see: never a raw provider error, which can contain a URL,
 * an account id, or — with some providers — an echo of the request that would
 * put prompt content into a log the prompt was never meant to reach.
 */
export class AiProviderError extends Error {
  readonly failureClass: AiFailureClass;
  /** Provider-side detail, for operators. Never returned to a customer. */
  readonly operatorDetail: string | undefined;

  constructor(failureClass: AiFailureClass, message: string, operatorDetail?: string) {
    super(message);
    this.name = 'AiProviderError';
    this.failureClass = failureClass;
    this.operatorDetail = operatorDetail;
  }
}

/** The customer-facing message for a class. Deliberately actionable, never raw. */
export function customerMessageFor(failureClass: AiFailureClass): string {
  switch (failureClass) {
    case 'RATE_LIMITED':
    case 'PROVIDER_UNAVAILABLE':
    case 'MODEL_UNAVAILABLE':
      return 'The AI service is busy right now. Please try again in a moment.';
    case 'TIMEOUT':
      return 'That took longer than expected and was stopped. Please try again.';
    case 'CONTENT_FILTERED':
      return 'That request was blocked by the content policy.';
    case 'CONTEXT_TOO_LONG':
      return 'There is too much text for this task. Shorten it and try again.';
    case 'INVALID_REQUEST':
      return 'That request could not be processed as written.';
    // AUTH_ERROR and QUOTA_EXCEEDED are OUR configuration problems, not the
    // customer's. Saying "invalid API key" would be both confusing and a
    // disclosure; the operator sees the real class in the request record.
    case 'AUTH_ERROR':
    case 'QUOTA_EXCEEDED':
    case 'NETWORK_ERROR':
    case 'UNKNOWN':
      return 'The AI service is unavailable right now. Please try again shortly.';
  }
}

/** A gateway refusal that is the CALLER's to fix, mapped to a stable code. */
export function gatewayError(
  code: 'VALIDATION_FAILED' | 'CONFLICT' | 'NOT_FOUND' | 'FORBIDDEN',
  message: string,
): AppError {
  return new AppError(code, message);
}
