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

/**
 * S4 — the ONE motion scale, for JavaScript animations and their timers.
 *
 * CSS durations multiply by `--bs-motion-scale` in tokens.css; a Web
 * Animations API duration or a `setTimeout` that waits for a CSS transition
 * must use the same factor, or the two drift apart once the Look & feel page
 * changes the motion level or speed. It is 1 by default, so nothing changes
 * until then. Reduced motion is still asked first (`prefersReducedMotion`).
 */
export function motionScale(): number {
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') return 1;
  // `--bs-motion-scale` is a calc() that a custom property never resolves, so
  // the factor is read from its two parts. Anything unreadable means 1.
  const style = getComputedStyle(document.documentElement);
  const level = parseFloat(style.getPropertyValue('--bs-motion-level'));
  const speed = parseFloat(style.getPropertyValue('--bs-motion-speed'));
  const factor = level * speed;
  return Number.isFinite(factor) && factor > 0 ? factor : 1;
}

/** A `motionMs` value, scaled by the motion scale. */
export function scaledMs(ms: number): number {
  return ms * motionScale();
}

/** `--bs-ease-out`, for the Web Animations API. */
export const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)';
