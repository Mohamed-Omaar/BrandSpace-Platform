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

/**
 * WHEN THIS TIMED RULE IS NEXT WORTH LOOKING AT (R4-2).
 *
 * WHY A RULE IS PARKED AT ALL. The producer used to take an arbitrary `batch`
 * of every enabled timed rule, with no ordering and no durable marker — and an
 * evaluated rule, unlike a delivered outbox row, stays eligible for the exact
 * same query on the next minute. So past `batch` rules the database was free to
 * return the same subset for ever, and for `SCHEDULED_TIME` a rule that is never
 * looked at in its own hour misses the occurrence permanently, by design.
 *
 * Parking every visited rule turns the enumeration into a QUEUE: a rule reaches
 * the front by waiting, and leaves it by being visited.
 *
 * ALWAYS EARLY, NEVER LATE — the half-hour below is the whole safety argument.
 * A local hour is not a fixed distance in real time: a daylight-saving shift
 * moves it by an hour in either direction, and the local moment this reads was
 * measured before the park rather than after it. Waking EARLY costs one
 * re-evaluation that finds nothing and parks again. Waking LATE costs the
 * customer their occurrence. Since an occurrence spans a full hour and the bias
 * is half of one, a ±1h shift still lands inside the window.
 *
 * AND NEVER FURTHER AHEAD THAN THE CAP, whatever the arithmetic says. A rule
 * parked for a day is a rule whose park cannot be corrected for a day — by a
 * workspace that moved zone, or by anything else this function read once. The
 * cap makes the worst case bounded and small instead of bounded and long.
 */
export function nextTimedEvaluationAt(input: {
  readonly config: unknown;
  readonly moment: LocalMoment;
  readonly now: Date;
  readonly maxAheadSeconds: number;
}): Date {
  const park = (seconds: number): Date =>
    new Date(input.now.getTime() + Math.min(Math.max(seconds, 0), input.maxAheadSeconds) * 1_000);

  const parsed = scheduledTimeConfigSchema.safeParse(input.config ?? {});
  /*
   * A RULE WHOSE CONFIGURATION WILL NOT PARSE IS STILL PARKED. It can never be
   * due — `timedRuleIsDue` refuses it too — but leaving it unparked would let
   * it sit at the front of the queue for ever, which is the starvation this
   * function exists to end, arriving by a different door.
   */
  if (!parsed.success) return park(input.maxAheadSeconds);

  const { daysOfWeek, hourLocal } = parsed.data;
  // EMPTY MEANS EVERY DAY, exactly as `timedRuleIsDue` reads it.
  const days = daysOfWeek.length > 0 ? daysOfWeek : [0, 1, 2, 3, 4, 5, 6];

  let aheadHours = Number.POSITIVE_INFINITY;
  for (const day of days) {
    let delta = ((day - input.moment.dayOfWeek + 7) % 7) * 24 + (hourLocal - input.moment.hour);
    /*
     * `<= 0` IS THE CURRENT OCCURRENCE, NOT THE NEXT ONE. A rule evaluated
     * inside its own hour has just produced its event; the next one it needs to
     * be awake for is a week away, or tomorrow, and the cap decides how much of
     * that it is actually allowed to sleep through.
     */
    if (delta <= 0) delta += 7 * 24;
    aheadHours = Math.min(aheadHours, delta);
  }

  return park(aheadHours * 3_600 - 1_800);
}

/** The `METRIC_THRESHOLD_CROSSED` trigger configuration. */
export const metricThresholdConfigSchema = z.object({
  metricKey: z.string().min(1).max(60),
  direction: z.enum(['above', 'below']),
  threshold: z.number().int(),
  windowDays: z.number().int().min(1).max(90).default(7),
});

/**
 * IS THE METRIC PAST THE LINE, RIGHT NOW?
 *
 * A PURE SIDE TEST, and deliberately nothing more. It answers "which side" and
 * says nothing about whether anything crossed, because a crossing is a
 * TRANSITION and a transition cannot be read off one reading.
 *
 * `null` IS NOT A SIDE. Missing is never zero (the rule the whole analytics
 * package keeps): a brand with no readings has not fallen below anything, and a
 * window that could not be measured must leave the rule's memory exactly as it
 * found it rather than recording a side nobody observed.
 */
export function metricIsBreaching(input: {
  readonly direction: 'above' | 'below';
  readonly threshold: number;
  readonly value: bigint | null;
}): boolean | null {
  if (input.value === null) return null;
  const limit = BigInt(input.threshold);
  // THE BOUNDARY IS NOT PAST THE LINE, on either side, so "above 100" and
  // "below 100" can never both be true of the same reading.
  return input.direction === 'above' ? input.value > limit : input.value < limit;
}

/** What one evaluation does to a threshold rule's memory. */
export type ThresholdTransition =
  /** Nothing measurable happened; the memory is untouched. */
  | { readonly kind: 'unmeasured' }
  /** First ever evaluation: record the side, fire nothing. */
  | { readonly kind: 'establish'; readonly breached: boolean }
  /** The metric crossed onto the triggered side. FIRE, once. */
  | { readonly kind: 'fire' }
  /** It returned to the other side. Re-arm, so the next crossing fires again. */
  | { readonly kind: 'rearm' }
  /** It stayed where it was. */
  | { readonly kind: 'steady' };

/**
 * THE EDGE, DECIDED FROM DURABLE MEMORY RATHER THAN FROM TWO ADJACENT WINDOWS.
 *
 * WHY THE PREVIOUS WINDOW WAS NOT ENOUGH (R3-2). "Current window past the line
 * AND previous window not" looks like edge detection. It is not: a metric that
 * climbs past the line and STAYS there eventually has both windows past it, and
 * before that it has a stretch where the comparison keeps answering yes on every
 * sweep. De-duplicating on the newest observation's id hides the repeat only
 * until the next reading arrives — and then the customer is told a second time
 * about the same crossing, which is exactly the alert nobody trusts twice.
 *
 * SO THE RULE REMEMBERS WHICH SIDE IT IS ON, and this function is the whole
 * state machine over that one remembered bit.
 *
 * `previous === null` MEANS NEVER EVALUATED, and it establishes rather than
 * fires. A rule created while the metric is already past the line has not seen
 * anything cross since somebody asked for it — and alerting immediately on a
 * number that has been sitting there for months is how a customer learns to
 * switch the feature off.
 */
export function thresholdTransition(input: {
  readonly previous: boolean | null;
  readonly current: boolean | null;
}): ThresholdTransition {
  if (input.current === null) return { kind: 'unmeasured' };
  if (input.previous === null) return { kind: 'establish', breached: input.current };
  if (input.current === input.previous) return { kind: 'steady' };
  return input.current ? { kind: 'fire' } : { kind: 'rearm' };
}

/**
 * The identity of a threshold event: the rule, and the ARMING it belongs to.
 *
 * NOT THE OBSERVATION. An observation id changes every time a new reading lands,
 * so it de-duplicates a repeat only until the metric is measured again. The
 * arming cycle changes exactly when the rule re-arms, which is exactly when a
 * second event is legitimate.
 */
export function thresholdOccurrenceKey(ruleId: string, cycle: number): string {
  return `${ruleId}:${cycle}`;
}
