import type { CalendarDay, PostRecord } from '@brandspace/ui';

/**
 * §8.2 (Phase 2B-2b) — WHERE A DRAGGED POST SHOWS WHILE THE SERVER ANSWERS.
 *
 * "The move is saved at once": on a committed drop the post is drawn on its
 * new day straight away, and the server's answer either confirms it (the next
 * render carries the same day, and the override has nothing left to do) or
 * refuses it (the caller deletes the override and the post is back where it
 * was). Display only — nothing here is sent anywhere or saved.
 *
 * `moves` maps a slot id to the day it is being drawn on; `timeOf` gives each
 * post's time, so the post takes its place in the new day's order. Pure, so it
 * is tested as a rule (`tests/unit/calendar-drag.test.ts`).
 */
export function withMoves(
  days: readonly CalendarDay[],
  moves: ReadonlyMap<string, string>,
  timeOf: (postId: string) => string,
): readonly CalendarDay[] {
  if (moves.size === 0) return days;
  const lifted = new Map<string, PostRecord>();
  for (const day of days) {
    for (const post of day.posts) {
      const target = moves.get(post.id);
      if (target !== undefined && target !== day.key) lifted.set(post.id, post);
    }
  }
  if (lifted.size === 0) return days;
  return days.map((day) => {
    const kept = day.posts.filter((post) => !lifted.has(post.id));
    const arriving = [...lifted.values()].filter((post) => moves.get(post.id) === day.key);
    if (kept.length === day.posts.length && arriving.length === 0) return day;
    const posts = [...kept, ...arriving].sort((a, b) => timeOf(a.id).localeCompare(timeOf(b.id)));
    return { ...day, posts };
  });
}

/**
 * The overrides still worth keeping once the server's slots arrive: a move the
 * page now shows by itself — or a post no longer in this month — needs none.
 */
export function pendingMoves(
  moves: ReadonlyMap<string, string>,
  slotDate: (slotId: string) => string | undefined,
): ReadonlyMap<string, string> {
  let changed = false;
  const next = new Map(moves);
  for (const [slotId, day] of moves) {
    const date = slotDate(slotId);
    if (date === undefined || date === day) {
      next.delete(slotId);
      changed = true;
    }
  }
  return changed ? next : moves;
}
