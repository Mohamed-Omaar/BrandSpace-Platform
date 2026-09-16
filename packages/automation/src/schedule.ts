import { z } from 'zod';

/**
 * WHEN A TIMED RULE IS DUE — the producer half of `SCHEDULED_TIME` (A1).
 *
 * THE TRIGGER EXISTED WITH NOTHING TO FIRE IT. A customer could say "every
 * weekday at 09:00", the engine knew how to bucket such a run, the worker knew
 * how to deliver one, and no clock anywhere in the platform ever looked at a
 * rule. This is that clock.
 *
 * EVERY DECISION IS MADE IN THE WORKSPACE'S OWN ZONE, through `Intl`, and never
 * by adding milliseconds to a UTC instant. A workspace in Riyadh that asked for
 * 09:00 means 09:00 there; deriving it from UTC offsets by arithmetic is wrong
 * twice a year for every zone that observes daylight saving, and wrong on
 * exactly the mornings somebody would notice. `en-CA` is used for the same
 * reason the calendar uses it: it formats as `YYYY-MM-DD`, which sorts.
 *
 * PURE FUNCTIONS, NO DATABASE, NO `Date.now()` — the instant is always passed
 * in. That is what lets the sweep be tested at 08:59, 09:00 and 09:59 on a
 * Sunday in February without waiting for one.
 */

/** The `SCHEDULED_TIME` trigger configuration, as the registry parses it. */
export const scheduledTimeConfigSchema = z.object({
  /** 0 = Sunday. EMPTY MEANS EVERY DAY, which is what the UI's default says. */
  daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  hourLocal: z.number().int().min(0).max(23),
});

export interface LocalMoment {
  /** `YYYY-MM-DD` in the workspace's zone. */
  readonly date: string;
  /** 0–23 in the workspace's zone. */
  readonly hour: number;
  /** 0 = Sunday, matching the trigger configuration. */
  readonly dayOfWeek: number;
}

/** Where the wall clock stands, in one workspace, at one instant. */
export function localMomentFor(instant: Date, timezone: string): LocalMoment {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(instant);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  /*
   * `hour12: false` YIELDS "24" FOR MIDNIGHT IN SOME ICU VERSIONS, and a bucket
   * of `T24` would never match the `T00` the same midnight produces elsewhere.
   * Normalising here rather than at each call site is the difference between one
   * correct answer and three call sites that each nearly have one.
   */
  const hour = Number(get('hour')) % 24;
  const weekdays: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour,
    dayOfWeek: weekdays[get('weekday')] ?? 0,
  };
}

/**
 * The occurrence string a timed run is bucketed by: `YYYY-MM-DDTHH`, local.
 *
 * THE SAME SHAPE `runBucketFor` PRODUCES, deliberately — the producer and the
 * engine must agree on what "the nine o'clock run on the 17th" is called, or the
 * carried occurrence and the recomputed one would be two different runs of one
 * schedule.
 */
export function occurrenceKey(date: string, hour: number): string {
  return `${date}T${String(hour).padStart(2, '0')}`;
}

/**
 * Is this rule due at this local moment?
 *
 * DUE MEANS "THIS IS ITS HOUR", not "its hour has passed". A sweep that fired
 * every rule whose hour was behind the current one would, after an outage, fire
 * a whole day of missed occurrences at once — and "catch up on eight hours of
 * automations" is how a customer wakes up to eight posts. A missed hour is
 * missed; the next one is not.
 *
 * AN EMPTY `daysOfWeek` IS EVERY DAY, which is what an empty multi-select means
 * to the person who left it alone.
 */
export function timedRuleIsDue(input: {
  readonly config: unknown;
  readonly moment: LocalMoment;
}): { due: false } | { due: true; occurrence: string } {
  const parsed = scheduledTimeConfigSchema.safeParse(input.config ?? {});
  if (!parsed.success) return { due: false };
  const { daysOfWeek, hourLocal } = parsed.data;
  if (hourLocal !== input.moment.hour) return { due: false };
  if (daysOfWeek.length > 0 && !daysOfWeek.includes(input.moment.dayOfWeek)) return { due: false };
  return { due: true, occurrence: occurrenceKey(input.moment.date, input.moment.hour) };
}

/** The `METRIC_THRESHOLD_CROSSED` trigger configuration. */
export const metricThresholdConfigSchema = z.object({
  metricKey: z.string().min(1).max(60),
  direction: z.enum(['above', 'below']),
  threshold: z.number().int(),
  windowDays: z.number().int().min(1).max(90).default(7),
});

/**
 * Has the metric CROSSED the threshold — as opposed to merely being past it?
 *
 * EDGE-TRIGGERED, AND THAT IS THE WHOLE POINT. A rule that fired every time the
 * current window was above the number would fire on every sweep, for as long as
 * the number stayed there — which for a growing brand is for ever. "Crossed"
 * means the window that ends now is past the threshold AND the window that
 * ended one period earlier was not.
 *
 * `null` for either side means "not enough data", and not enough data is NOT a
 * crossing: a brand with no observations before today has not just fallen below
 * anything, and treating a gap as a zero is the mistake the whole analytics
 * package refuses to make.
 */
export function thresholdCrossed(input: {
  readonly direction: 'above' | 'below';
  readonly threshold: number;
  readonly current: bigint | null;
  readonly previous: bigint | null;
}): boolean {
  if (input.current === null || input.previous === null) return false;
  const limit = BigInt(input.threshold);
  return input.direction === 'above'
    ? input.current > limit && input.previous <= limit
    : input.current < limit && input.previous >= limit;
}
