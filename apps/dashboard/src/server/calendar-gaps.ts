/**
 * THE CALENDAR'S ONE QUIET SUGGESTION (Phase 6 final, D-277 §32, D-290).
 *
 * "Tuesday has been empty for 5 weeks." — said only when it is true, and only
 * when it means something.
 *
 * PURE, AND NOT `server-only`: the unit suite imports it directly. The page
 * hands it the LOCAL date keys (`YYYY-MM-DD`, in the workspace's zone) of the
 * calendar slots in the window; nothing here reads a clock or a database.
 *
 * WHEN A GAP IS A GAP. A brand that posts three days a week has four empty
 * weekdays every week, and naming one of them is noise, not intelligence. So
 * the rule is deliberately conservative:
 *   - the window is the GAP_WEEKS full weeks before the current one, so a week
 *     still being planned never counts as empty;
 *   - there must be at least MIN_SLOTS slots in the window — a quiet calendar
 *     is not a pattern;
 *   - at most MAX_GAP_DAYS weekdays may be empty; beyond that the brand simply
 *     does not post daily, and nothing is said.
 * No best time, no guess about why, no recommendation of what to post: the
 * fact, and a way to take it to the Copilot.
 */
export const GAP_WEEKS = 5;
export const MIN_SLOTS = 5;
export const MAX_GAP_DAYS = 2;

const DAY_MS = 86_400_000;

function keyToUtc(key: string): number {
  const [year, month, day] = key.split('-').map(Number);
  return Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1);
}

function utcToKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The window: `[start, end)` as local date keys — the GAP_WEEKS whole weeks
 * that end where the current week (starting on `weekStartsOn`, 0 = Sunday)
 * begins.
 */
export function gapWindow(
  todayKey: string,
  weekStartsOn: number,
): { readonly start: string; readonly end: string } {
  const today = keyToUtc(todayKey);
  const weekday = new Date(today).getUTCDay();
  const intoWeek = (weekday - weekStartsOn + 7) % 7;
  const end = today - intoWeek * DAY_MS;
  return { start: utcToKey(end - GAP_WEEKS * 7 * DAY_MS), end: utcToKey(end) };
}

/**
 * The weekdays (0 = Sunday) that had no slot in any week of the window, or an
 * empty list when the calendar is too quiet — or too sparse — for that to be
 * worth saying.
 */
export function emptyWeekdays(
  slotDayKeys: readonly string[],
  window: { readonly start: string; readonly end: string },
): number[] {
  const inWindow = slotDayKeys.filter((key) => key >= window.start && key < window.end);
  if (inWindow.length < MIN_SLOTS) return [];
  const used = new Set(inWindow.map((key) => new Date(keyToUtc(key)).getUTCDay()));
  const empty = [0, 1, 2, 3, 4, 5, 6].filter((day) => !used.has(day));
  return empty.length > 0 && empty.length <= MAX_GAP_DAYS ? empty : [];
}

/** A weekday's name in a locale (0 = Sunday), without touching a clock. */
export function weekdayName(weekday: number, locale: string): string {
  // 2023-01-01 was a Sunday.
  return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2023, 0, 1 + weekday)),
  );
}
