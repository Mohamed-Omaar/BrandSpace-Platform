import type { AiModality } from './adapter';
import { isFallbackEligible, isRetryable, type AiFailureClass } from './errors';

/**
 * PR 1 (Images, owner decisions 2026-11-04) — HOW LONG ONE PROVIDER ATTEMPT
 * MAY TAKE, AND WHETHER A FAILED ONE IS TRIED AGAIN.
 *
 * Staging: an image request failed after 90.95 s with TIMEOUT although its
 * route allowed 180 s. Each attempt was capped by the provider's own
 * `timeoutMs` (30 s), and a TIMEOUT was retried twice: 30 + 30 + 30 s. An
 * image takes longer than 30 s, and the provider most likely went on making
 * and billing every image we stopped waiting for.
 *
 *   - An attempt's limit is the task rule's `parameters.attemptTimeoutMs`
 *     when the operator set one; otherwise 180 s for an image task and the
 *     provider's `timeoutMs` for everything else, as before. The route's
 *     `timeoutMs` still bounds the whole request.
 *   - An image TIMEOUT is never tried again, on the same model or the next.
 *     Text keeps its retries and fallbacks.
 */
export const IMAGE_ATTEMPT_TIMEOUT_MS = 180_000;

export interface AttemptRoute {
  readonly modality: AiModality;
  readonly parameters: { readonly attemptTimeoutMs?: number | null };
}

export function attemptTimeoutMsFor(route: AttemptRoute, providerTimeoutMs: number): number {
  const configured = route.parameters.attemptTimeoutMs;
  if (typeof configured === 'number' && configured > 0) return configured;
  return route.modality === 'image' ? IMAGE_ATTEMPT_TIMEOUT_MS : providerTimeoutMs;
}

/** An image the provider may already be making (and billing) is not asked for twice. */
function imageTimeout(failureClass: AiFailureClass, modality: AiModality): boolean {
  return failureClass === 'TIMEOUT' && modality === 'image';
}

export function retriesAfter(failureClass: AiFailureClass, modality: AiModality): boolean {
  return isRetryable(failureClass) && !imageTimeout(failureClass, modality);
}

export function fallsBackAfter(failureClass: AiFailureClass, modality: AiModality): boolean {
  return isFallbackEligible(failureClass) && !imageTimeout(failureClass, modality);
}
