import { formatLocalTime, instantForIntent, nextDayKey } from './timezone';

/**
 * B11 (Phase 2B-2b) — A CAMPAIGN'S RESULTS ARE READ OVER ITS OWN DATES.
 *
 * `campaign.startDate` / `endDate` are DATE-ONLY columns: a day, not an instant.
 * A day becomes an instant only in a zone, and the zone is the WORKSPACE's — the
 * same one the calendar schedules in. So "the campaign ran 1–14 March" means from
 * 00:00 on 1 March to 00:00 on 15 March in the workspace's zone, never in UTC.
 *
 * NO COMPARISON PERIOD (owner answer D6). And NO RESULTS before the campaign has
 * a start date, or before that start date has arrived: the caller shows
 * "No results yet" for `null` rather than an empty window that reads as zero.
 */

/** A `@db.Date` value as its `YYYY-MM-DD` key. Stored at UTC midnight. */
export function campaignDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Today's `YYYY-MM-DD` in a zone. */
export function todayKeyIn(now: Date, timezone: string): string {
  return formatLocalTime(now, timezone).slice(0, 10);
}

/** A `YYYY-MM-DD` key as the `@db.Date` value Prisma stores for it. */
export function campaignDateFromKey(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

export interface CampaignResultsPeriod {
  readonly start: Date;
  readonly end: Date;
}

export function campaignResultsPeriod(input: {
  readonly startDate: Date | null;
  readonly endDate: Date | null;
  readonly timezone: string;
  readonly now: Date;
}): CampaignResultsPeriod | null {
  if (!input.startDate) return null;
  const start = instantForIntent(`${campaignDayKey(input.startDate)}T00:00`, input.timezone);
  if (!start || start.getTime() > input.now.getTime()) return null;
  // The end date is INCLUSIVE: the window closes at the start of the next day.
  const closes = input.endDate
    ? instantForIntent(`${nextDayKey(campaignDayKey(input.endDate))}T00:00`, input.timezone)
    : null;
  const end = closes && closes.getTime() < input.now.getTime() ? closes : input.now;
  return { start, end };
}

/**
 * "Ends in N days": whole calendar days from today to the end date, in the
 * workspace's zone. 0 means it ends today. Null when there is no end date or it
 * has already passed — a finished campaign does not count down.
 */
export function daysUntilCampaignEnds(input: {
  readonly endDate: Date | null;
  readonly timezone: string;
  readonly now: Date;
}): number | null {
  if (!input.endDate) return null;
  const today = todayKeyIn(input.now, input.timezone);
  const end = campaignDayKey(input.endDate);
  if (end < today) return null;
  return Math.round(
    (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  );
}
