import { AppError } from '@brandspace/shared';
import type { PublishFailureClass } from '@brandspace/database';

/**
 * The publishing error taxonomy, and what each class MEANS for behaviour.
 *
 * WHY A TABLE AND NOT A STRING MATCH. Retry, the re-auth prompt and the
 * sentence the customer reads all branch on the class, and a message string is
 * not a contract — a provider changing its wording would silently change our
 * retry behaviour. The class is stored on the job and on every attempt, so the
 * decision is re-readable months later.
 *
 * `retryable: false` IS A REFUSAL, NOT A PREFERENCE. `content_rejected` retried
 * is the same caption rejected again, five times, with the customer watching.
 */
export interface FailureBehaviour {
  /** May the job be tried again automatically? */
  readonly retryable: boolean;
  /** Does this mean the CONNECTION is broken rather than the post? */
  readonly needsReconnect: boolean;
  /**
   * Is the outcome UNKNOWN rather than failed? An indeterminate result is never
   * retried blindly — it is verified first (docs/SOCIAL-INTEGRATIONS.md §7.2).
   * This is the single most important rule for not double-posting.
   */
  readonly indeterminate: boolean;
  /** May a human retry it by hand once they have fixed something? */
  readonly manualRetryUseful: boolean;
}

export const FAILURE_BEHAVIOUR: Record<PublishFailureClass, FailureBehaviour> = {
  /** The token expired. Refresh once, then try again — that is the whole fix. */
  AUTH_EXPIRED: {
    retryable: true,
    needsReconnect: false,
    indeterminate: false,
    manualRetryUseful: true,
  },
  /** The customer revoked us at the provider. Nothing we retry can help. */
  AUTH_REVOKED: {
    retryable: false,
    needsReconnect: true,
    indeterminate: false,
    manualRetryUseful: false,
  },
  /** We were granted less than we asked for. Reconnecting is the only fix. */
  INSUFFICIENT_SCOPE: {
    retryable: false,
    needsReconnect: true,
    indeterminate: false,
    manualRetryUseful: false,
  },
  /** Backoff is exactly the right answer. */
  RATE_LIMITED: {
    retryable: true,
    needsReconnect: false,
    indeterminate: false,
    manualRetryUseful: true,
  },
  /** The platform said no to this content. The customer must change it. */
  CONTENT_REJECTED: {
    retryable: false,
    needsReconnect: false,
    indeterminate: false,
    manualRetryUseful: true,
  },
  MEDIA_INVALID: {
    retryable: false,
    needsReconnect: false,
    indeterminate: false,
    manualRetryUseful: true,
  },
  /**
   * The platform believes we already posted this. Treated as a SUCCESS when the
   * external post can be found, and never as a reason to send again
   * (docs/SOCIAL-INTEGRATIONS.md §7.3).
   */
  DUPLICATE_CONTENT: {
    retryable: false,
    needsReconnect: false,
    indeterminate: true,
    manualRetryUseful: false,
  },
  /** The page or channel is gone, renamed or no longer ours. */
  TARGET_UNAVAILABLE: {
    retryable: false,
    needsReconnect: true,
    indeterminate: false,
    manualRetryUseful: false,
  },
  /** Their outage, not our content. Retry, after verifying. */
  PLATFORM_UNAVAILABLE: {
    retryable: true,
    needsReconnect: false,
    indeterminate: true,
    manualRetryUseful: true,
  },
  /** The request left and the answer did not come back. VERIFY, never resend. */
  TIMEOUT: {
    retryable: true,
    needsReconnect: false,
    indeterminate: true,
    manualRetryUseful: true,
  },
  /** Ours: approval was withdrawn between scheduling and dispatch. */
  APPROVAL_REVOKED: {
    retryable: false,
    needsReconnect: false,
    indeterminate: false,
    manualRetryUseful: true,
  },
  /** Ours: the connection is not usable. */
  NOT_CONNECTED: {
    retryable: false,
    needsReconnect: true,
    indeterminate: false,
    manualRetryUseful: false,
  },
  /** Ours: the provider cannot do what was asked. Retrying asks again. */
  UNSUPPORTED: {
    retryable: false,
    needsReconnect: false,
    indeterminate: false,
    manualRetryUseful: false,
  },
  /**
   * We could not classify it. NOT retryable and NOT indeterminate: an unknown
   * failure that we resend is how a duplicate post happens, and an unknown
   * failure we mark indeterminate is a verification call we cannot interpret.
   * It surfaces to a human, which is the honest outcome.
   */
  UNKNOWN: {
    retryable: false,
    needsReconnect: false,
    indeterminate: false,
    manualRetryUseful: true,
  },
};

/** Machine-readable codes the dashboard maps to localized sentences. */
export const socialConnectionNotFound = (): AppError =>
  new AppError('NOT_FOUND', 'Connection not found.');

export const publishJobNotFound = (): AppError =>
  new AppError('NOT_FOUND', 'Publish job not found.');

export const oauthStateInvalid = (): AppError =>
  // DELIBERATELY UNIFORM. Expired, already used, forged and belonging to
  // another workspace all produce this one sentence: distinguishing them would
  // tell an attacker which of their guesses was closest.
  new AppError('VALIDATION_FAILED', 'This connection request is no longer valid.');

export const providerNotEnabled = (): AppError =>
  new AppError('VALIDATION_FAILED', 'That platform is not available for connection.');

export const connectionLimitReached = (): AppError =>
  new AppError('QUOTA_EXCEEDED', 'This workspace has reached its connected-account limit.');

export const connectionNotPublishable = (): AppError =>
  new AppError('VALIDATION_FAILED', 'That account is not connected and ready to publish.');

export const publishJobNotCancellable = (): AppError =>
  new AppError('CONFLICT', 'This post has already been sent and can no longer be cancelled.');

export const publishJobNotRetryable = (): AppError =>
  new AppError('CONFLICT', 'This post cannot be retried in its current state.');

export const unsupportedByProvider = (): AppError =>
  new AppError('VALIDATION_FAILED', 'That platform does not support this action.');
