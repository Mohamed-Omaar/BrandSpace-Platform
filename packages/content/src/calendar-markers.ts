import type { ContentPolicy } from './policy';

/**
 * G6 / Q7 (prototype v94 Phase 2B-1, D-329) — WHAT A COUNTRY AND AN INDUSTRY
 * ADD TO THE CALENDAR. Pure, so the unit suite pins each rule.
 *
 *   - HOLIDAYS come from the workspace's COUNTRY, OBSERVANCES from the brand's
 *     INDUSTRY (its catalogue key; free-text "something else" has none). Both
 *     lists are operator configuration and ship empty (CLAUDE.md §2.2).
 *   - SUGGESTED TIMES: a MEASURED best time for the brand, when one exists,
 *     always wins; otherwise the times configured for the country, labelled
 *     "Suggested time" — never "best time"; otherwise nothing, and the
 *     calendar keeps its ordinary default.
 */

type Calendar = ContentPolicy['calendar'];

export interface CalendarMarker {
  readonly date: string;
  readonly kind: 'holiday' | 'observance';
  readonly name: { readonly en: string; readonly ar: string };
}

export function calendarMarkers(
  calendar: Calendar,
  input: {
    readonly country: string | null;
    readonly industryKey: string | null;
    /** Inclusive `YYYY-MM-DD` bounds of the days on screen. */
    readonly from: string;
    readonly to: string;
  },
): readonly CalendarMarker[] {
  const inRange = (date: string) => date >= input.from && date <= input.to;
  const country = input.country?.trim().toUpperCase() ?? null;
  const holidays = country
    ? (calendar.holidays ?? [])
        .filter((row) => row.country.toUpperCase() === country && inRange(row.date))
        .map((row) => ({ date: row.date, kind: 'holiday' as const, name: row.name }))
    : [];
  const observances = input.industryKey
    ? (calendar.observances ?? [])
        .filter((row) => row.industry === input.industryKey && inRange(row.date))
        .map((row) => ({ date: row.date, kind: 'observance' as const, name: row.name }))
    : [];
  return [...holidays, ...observances].sort((a, b) => a.date.localeCompare(b.date));
}

export type SuggestedTimeSource = 'measured' | 'configured' | 'none';

export function suggestedPostingTimes(
  calendar: Calendar,
  input: {
    /**
     * Best times MEASURED from this brand's own results. No measured source
     * exists yet, so every caller passes `[]` today; when one does, it wins.
     */
    readonly measured: readonly string[];
    readonly country: string | null;
  },
): { readonly times: readonly string[]; readonly source: SuggestedTimeSource } {
  if (input.measured.length > 0) return { times: [...input.measured], source: 'measured' };
  const country = input.country?.trim().toUpperCase() ?? null;
  const configured = country
    ? (calendar.suggestedTimes ?? []).find((row) => row.country.toUpperCase() === country)
    : undefined;
  if (configured && configured.times.length > 0) {
    return { times: [...configured.times].sort(), source: 'configured' };
  }
  return { times: [], source: 'none' };
}
