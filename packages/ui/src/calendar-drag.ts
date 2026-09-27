/**
 * §8.2 (Phase 2B-2b) — THE CALENDAR DRAG, AS RULES.
 *
 * Pointer events instead of native HTML drag and drop, so a finger can move a
 * post too. The numbers are §8.2's; the engine that uses them is
 * `use-calendar-drag.ts`. Pure, so each rule is tested as a rule.
 */

/** Mouse: a drag starts after 5 px of movement, so a plain click still opens the post. */
export const MOUSE_DRAG_THRESHOLD_PX = 5;
/** Touch: a long-press of 380 ms lifts the post… */
export const LONG_PRESS_MS = 380;
/** …provided the finger has not moved more than 8 px; moving earlier scrolls the page. */
export const LONG_PRESS_TOLERANCE_PX = 8;
/** Phone: the drop strip offers the next 14 days. */
export const DROP_STRIP_DAYS = 14;

/** Has a pointer travelled further than `limit` from where it went down? */
export function travelled(dx: number, dy: number, limit: number): boolean {
  return Math.hypot(dx, dy) > limit;
}

/**
 * What a day can do with a dropped post:
 *   `ok`   — it takes it;
 *   `past` — it has passed (F2): grey, a red dashed outline, and it is refused;
 *   `none` — it is outside the month shown: it takes nothing and says nothing.
 */
export type DropState = 'ok' | 'past' | 'none';

export function dropStateOf(day: {
  readonly isPast?: boolean | undefined;
  readonly inCurrentPeriod: boolean;
}): DropState {
  if (!day.inCurrentPeriod) return 'none';
  return day.isPast ? 'past' : 'ok';
}

/**
 * What releasing over `target` means for a post that started on `fromDay`:
 * move it, refuse it (a past day — nothing changes, the reason is shown), or
 * put it back (outside any day, outside the month, or the day it came from).
 */
export type DropOutcome = 'move' | 'refuse' | 'cancel';

export function dropOutcome(
  target: { readonly dayKey: string; readonly state: DropState } | null,
  fromDay: string | null,
): DropOutcome {
  if (!target || target.state === 'none') return 'cancel';
  if (target.state === 'past') return 'refuse';
  return target.dayKey === fromDay ? 'cancel' : 'move';
}

/** The next `count` calendar days from `todayKey` (YYYY-MM-DD), today first. */
export function stripDayKeys(todayKey: string, count = DROP_STRIP_DAYS): string[] {
  const [year, month, day] = todayKey.split('-').map(Number);
  if (!year || !month || !day) return [];
  return Array.from({ length: count }, (_, offset) =>
    new Date(Date.UTC(year, month - 1, day + offset)).toISOString().slice(0, 10),
  );
}
