/**
 * §8.0 (Phase 2B-2b) — THE ONE QUESTION EVERY JS ANIMATION ASKS FIRST.
 *
 * CSS motion is switched off for reduced motion once, in `tokens.css`. The Web
 * Animations API and a count-up never see that rule, so each asks here before
 * it starts; when the answer is yes, the end state is applied at once.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** `--bs-ease-out`, for the Web Animations API. */
export const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)';
