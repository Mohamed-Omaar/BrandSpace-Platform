/**
 * C8 / MO9 (Phase 2B-2b, D8) — HOW LONG A TOAST STAYS.
 *
 * A reading time, not a fixed delay: 2.5 s plus 55 ms for every character,
 * never under 4 s and never over 9 s. Hovering holds it; leaving resumes with
 * 2.2 s to go. Dismiss and the next navigation close it at once. Pure, so the
 * arithmetic is tested as arithmetic.
 */
export const TOAST_BASE_MS = 2_500;
export const TOAST_PER_CHARACTER_MS = 55;
export const TOAST_MIN_MS = 4_000;
export const TOAST_MAX_MS = 9_000;
export const TOAST_RESUME_MS = 2_200;

/** Characters as code points, so a surrogate pair (an emoji) is one, not two. */
function characters(text: string): number {
  return Array.from(text.trim()).length;
}

export function toastDuration(text: string): number {
  const reading = TOAST_BASE_MS + TOAST_PER_CHARACTER_MS * characters(text);
  return Math.min(TOAST_MAX_MS, Math.max(TOAST_MIN_MS, reading));
}
