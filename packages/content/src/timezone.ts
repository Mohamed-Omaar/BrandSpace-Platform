/**
 * Wall-clock time in a named zone, and the instant it means.
 *
 * WHY THIS FILE EXISTS RATHER THAN A `new Date(string)` SOMEWHERE.
 *
 * AC-14.2 and AC-14.3 ask for something a single timestamp cannot express: the
 * slot must display "at the correct local time for viewers in different
 * timezones, AND across a DST boundary". Those are two different requirements
 * and only the second is hard.
 *
 *   - A customer in Riyadh schedules a post for 09:00 on 12 March.
 *   - Stored as an instant alone, that is 06:00Z. Read back in a zone that
 *     observes daylight saving, or after the workspace's own zone changes its
 *     offset, 06:00Z is no longer 09:00 to anyone.
 *   - So the INTENT is stored — `2026-03-12T09:00` plus `Asia/Riyadh` — and the
 *     instant is DERIVED from it. The instant is what every range query reads;
 *     the intent is what the customer actually asked for, and it is the only
 *     one of the two that survives an offset change with its meaning intact.
 *
 * NO LIBRARY, AND THAT IS A CHOICE. `Intl.DateTimeFormat` carries the IANA zone
 * database the platform already ships, including its historical and future
 * transitions; a date library would add a second copy of that data to keep in
 * step with the first. Everything below is arithmetic on what `Intl` reports.
 */

/** The wall-clock shape the database CHECK constraint also enforces. */
export const LOCAL_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

/** Is this a zone this runtime actually knows? */
export function isKnownTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function parseLocalTime(localTime: string): LocalParts | null {
  const match = LOCAL_TIME_PATTERN.exec(localTime);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const parts: LocalParts = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
  };
  // A shape that parses is not a date that exists: `2026-02-31T09:00` matches
  // the pattern perfectly. Round-tripping through UTC is the cheapest way to
  // find out, because `Date.UTC` normalises rather than refusing.
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const back = new Date(asUtc);
  if (
    back.getUTCFullYear() !== parts.year ||
    back.getUTCMonth() + 1 !== parts.month ||
    back.getUTCDate() !== parts.day
  ) {
    return null;
  }
  return parts;
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = FORMATTERS.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      // `hourCycle: 'h23'` so midnight is 00 and not 24. `hour12: false` alone
      // yields "24" in several locales, which then parses as the next day.
      hourCycle: 'h23',
    });
    FORMATTERS.set(timezone, formatter);
  }
  return formatter;
}

/** The wall-clock an instant shows as, in a zone. */
export function partsInZone(instant: Date, timezone: string): LocalParts {
  const parts = formatterFor(timezone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
  };
}

/** An instant rendered as `YYYY-MM-DDTHH:mm` in a zone. */
export function formatLocalTime(instant: Date, timezone: string): string {
  const parts = partsInZone(instant, timezone);
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

/** The zone's offset from UTC at an instant, in minutes east of Greenwich. */
export function offsetMinutesAt(instant: Date, timezone: string): number {
  const parts = partsInZone(instant, timezone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  // The instant's own seconds and milliseconds are not in `parts`, so they are
  // removed from both sides rather than added to one.
  const truncated = Math.floor(instant.getTime() / 60_000) * 60_000;
  return (asUtc - truncated) / 60_000;
}

export type ZonedResolution =
  /** The wall-clock exists exactly once. The ordinary case. */
  | { readonly kind: 'exact'; readonly instant: Date }
  /**
   * The wall-clock happens TWICE — the hour a zone repeats when it falls back.
   * The EARLIER of the two is chosen, and the caller is told, because "01:30 on
   * the day the clocks go back" is a real thing a customer can select and
   * silently picking one of the two is how a post goes out an hour late.
   */
  | { readonly kind: 'ambiguous'; readonly instant: Date; readonly alternative: Date }
  /**
   * The wall-clock does NOT EXIST — the hour a zone skips when it springs
   * forward. The instant returned is the one the clock jumps TO, which is what
   * every calendar application does and the only choice that keeps the post in
   * the right order relative to its neighbours.
   */
  | { readonly kind: 'skipped'; readonly instant: Date };

/**
 * Resolve a wall-clock in a zone to the instant it means.
 *
 * THE ALGORITHM, because "just use Intl" hides the interesting part. There is no
 * inverse of `formatToParts`, so the instant is SOLVED for:
 *
 *   1. Guess that the wall-clock is UTC.
 *   2. Ask the zone what that guess renders as, and subtract the difference.
 *      One pass is right whenever the offset does not change between the guess
 *      and the answer.
 *   3. Do it again. The second pass is what handles a guess that landed on the
 *      far side of a transition, which is most of the DST cases.
 *   4. Verify by rendering the candidate back. If it does not match, the
 *      wall-clock is in a gap and does not exist.
 *
 * Steps 3 and 4 are the whole reason this is not two lines.
 */
export function resolveZonedTime(localTime: string, timezone: string): ZonedResolution | null {
  const parts = parseLocalTime(localTime);
  if (!parts || !isKnownTimeZone(timezone)) return null;

  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);

  let candidate = new Date(target);
  for (let pass = 0; pass < 2; pass += 1) {
    candidate = new Date(target - offsetMinutesAt(candidate, timezone) * 60_000);
  }

  if (formatLocalTime(candidate, timezone) !== localTime) {
    /*
     * A GAP. The clock jumped over this wall-clock, so NO instant renders as it
     * and the solver above cannot converge — it oscillates around the
     * transition.
     *
     * The convention every calendar application follows is to move the
     * appointment forward by the size of the jump, so 02:30 on a spring-forward
     * morning becomes 03:30 rather than 01:30. Resolving the wall-clock against
     * the offset in force BEFORE the transition produces exactly that: the
     * arithmetic lands past the boundary, and the zone then renders it with the
     * new offset.
     *
     * The alternative — landing before the gap — would move the post EARLIER
     * than the customer asked for, and reorder it against its neighbours.
     */
    const offsetBefore = offsetMinutesAt(new Date(candidate.getTime() - 3 * 3_600_000), timezone);
    return { kind: 'skipped', instant: new Date(target - offsetBefore * 60_000) };
  }

  /*
   * AMBIGUITY. When a zone falls back, two instants an hour apart render as the
   * same wall-clock. The solver above converges on one of them; the other is
   * found by asking whether the offset an hour either side still produces the
   * same rendering.
   */
  for (const shiftMinutes of [-60, -30, 60, 30]) {
    const other = new Date(candidate.getTime() + shiftMinutes * 60_000);
    if (formatLocalTime(other, timezone) === localTime) {
      const [earlier, later] =
        other.getTime() < candidate.getTime() ? [other, candidate] : [candidate, other];
      // The EARLIER occurrence, which is what every mainstream implementation
      // chooses and what a customer means by "the first time it is 01:30".
      return { kind: 'ambiguous', instant: earlier, alternative: later };
    }
  }

  return { kind: 'exact', instant: candidate };
}

/**
 * Recompute a slot's instant from the intent it was created with.
 *
 * THE POINT OF STORING BOTH. A zone whose rules change — and they do, by
 * government decree, several times a year somewhere — leaves every stored
 * instant meaning a different wall-clock than the one chosen. Re-deriving from
 * the intent restores it. Returns `null` when the intent is unusable, so a
 * caller fixes it rather than quietly scheduling the wrong time.
 */
export function instantForIntent(localTime: string, timezone: string): Date | null {
  return resolveZonedTime(localTime, timezone)?.instant ?? null;
}

/** The UTC day range covering a local month, for a calendar query. */
export function monthRangeUtc(
  year: number,
  month: number,
  timezone: string,
): { start: Date; end: Date } | null {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  const start = instantForIntent(`${pad(year, 4)}-${pad(month)}-01T00:00`, timezone);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const end = instantForIntent(`${pad(nextYear, 4)}-${pad(nextMonth)}-01T00:00`, timezone);
  return start && end ? { start, end } : null;
}

/**
 * F2 — THE DAY AFTER a calendar day, as `YYYY-MM-DD`. Date arithmetic on the
 * key itself, never "+24 hours" on an instant, so a daylight-saving change in
 * the workspace's zone cannot land it on the same day or skip one.
 */
export function nextDayKey(dayKey: string): string {
  const [year, month, day] = dayKey.split('-').map(Number);
  const next = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + 1));
  return next.toISOString().slice(0, 10);
}

/**
 * F2 — the time a new post is proposed for when nobody has chosen one. A
 * default the person sees and can change before anything is scheduled, not a
 * rule anything enforces.
 */
export const DEFAULT_POST_TIME = '09:00';

/**
 * F2 — WHERE A PROPOSED TIME ON TODAY OR EARLIER MOVES TO: tomorrow at the
 * default time. A day after today is kept as it is (`null` — nothing to move).
 */
export function bestTimeFor(input: {
  readonly todayKey: string;
  readonly dayKey: string;
}): { readonly date: string; readonly time: string } | null {
  if (input.dayKey > input.todayKey) return null;
  return { date: nextDayKey(input.todayKey), time: DEFAULT_POST_TIME };
}
