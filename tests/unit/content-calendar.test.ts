import { describe, expect, it } from 'vitest';
import {
  contentPolicySchema,
  formatLocalTime,
  instantForIntent,
  isKnownTimeZone,
  monthRangeUtc,
  offsetMinutesAt,
  parseLocalTime,
  resolveZonedTime,
} from '@brandspace/content';
import { CONFIG_DOMAINS, parseConfigPayload } from '@brandspace/config';

/**
 * The arithmetic the Content Calendar rests on.
 *
 * AC-14.2 and AC-14.3 are, underneath, one question: does a wall-clock in a
 * named zone survive a round trip and a daylight-saving boundary? These are the
 * cases where the naive answer — a single stored timestamp — is wrong, written
 * out so a future change that breaks one of them fails here rather than on
 * somebody's calendar.
 *
 * THE EXPECTED VALUES ARE DERIVED IN THE COMMENTS, not copied from a run. A
 * test whose expectations came out of the implementation asserts nothing.
 */

describe('a wall-clock is parsed as a shape AND as a date', () => {
  it('accepts the one shape the database also enforces', () => {
    expect(parseLocalTime('2026-03-12T09:00')).toEqual({
      year: 2026,
      month: 3,
      day: 12,
      hour: 9,
      minute: 0,
    });
  });

  it('refuses a date that parses but does not exist', () => {
    // The shape is perfect; 31 February is not a day. `Date.UTC` NORMALISES
    // rather than refusing, which is exactly why this check has to be explicit.
    expect(parseLocalTime('2026-02-31T09:00')).toBeNull();
    expect(parseLocalTime('2026-13-01T09:00')).toBeNull();
    expect(parseLocalTime('2025-02-29T09:00')).toBeNull();
  });

  it('accepts a real leap day', () => {
    expect(parseLocalTime('2028-02-29T09:00')).not.toBeNull();
  });

  it('refuses anything carrying an offset, seconds, or prose', () => {
    // An offset would be a second, contradictory answer to the question the
    // `timezone` column already answers.
    for (const bad of [
      '2026-03-12T09:00+03:00',
      '2026-03-12T09:00:00',
      '2026-03-12 09:00',
      '12 March 2026, 9am',
      '',
    ]) {
      expect(parseLocalTime(bad), bad).toBeNull();
    }
  });
});

describe('zones this runtime does not know are refused, not guessed', () => {
  it('knows the real ones and refuses the invented one', () => {
    expect(isKnownTimeZone('Asia/Riyadh')).toBe(true);
    expect(isKnownTimeZone('America/New_York')).toBe(true);
    expect(isKnownTimeZone('UTC')).toBe(true);
    expect(isKnownTimeZone('Mars/Olympus')).toBe(false);
    expect(resolveZonedTime('2026-03-12T09:00', 'Mars/Olympus')).toBeNull();
  });
});

describe('a zone with no daylight saving is the simple case, and must stay simple', () => {
  it('Riyadh is UTC+3 in January and in July', () => {
    // Saudi Arabia has observed +03 with no transitions since 1990.
    const january = instantForIntent('2026-01-15T09:00', 'Asia/Riyadh');
    const july = instantForIntent('2026-07-15T09:00', 'Asia/Riyadh');
    expect(january?.toISOString()).toBe('2026-01-15T06:00:00.000Z');
    expect(july?.toISOString()).toBe('2026-07-15T06:00:00.000Z');
    expect(offsetMinutesAt(january as Date, 'Asia/Riyadh')).toBe(180);
  });
});

describe('the same wall-clock is a DIFFERENT instant either side of a transition', () => {
  it('New York 09:00 is 14:00Z in winter and 13:00Z in summer', () => {
    /*
     * THE WHOLE REASON THE INTENT IS STORED. EST is UTC-5 and EDT is UTC-4, so
     * "09:00" means two different instants depending on the date — and a single
     * stored timestamp cannot express "09:00 whenever that is".
     */
    expect(instantForIntent('2026-01-15T09:00', 'America/New_York')?.toISOString()).toBe(
      '2026-01-15T14:00:00.000Z',
    );
    expect(instantForIntent('2026-07-15T09:00', 'America/New_York')?.toISOString()).toBe(
      '2026-07-15T13:00:00.000Z',
    );
  });

  it('and both render back as the wall-clock that was chosen', () => {
    for (const date of ['2026-01-15', '2026-07-15']) {
      const instant = instantForIntent(`${date}T09:00`, 'America/New_York');
      expect(formatLocalTime(instant as Date, 'America/New_York')).toBe(`${date}T09:00`);
    }
  });
});

describe('the hour that does not exist — spring forward', () => {
  it('New York skips 02:00–02:59 on 8 March 2026, and 02:30 is reported as skipped', () => {
    const resolved = resolveZonedTime('2026-03-08T02:30', 'America/New_York');
    expect(resolved?.kind).toBe('skipped');
  });

  it('a skipped time moves FORWARD to the jump target, never backward', () => {
    /*
     * The clock goes 01:59 EST → 03:00 EDT. An appointment at 02:30 must become
     * 03:30, which is what every calendar application does. Landing at 01:30
     * would move the post EARLIER than asked and reorder it against its
     * neighbours — the failure this assertion exists to catch.
     */
    const resolved = resolveZonedTime('2026-03-08T02:30', 'America/New_York');
    expect(formatLocalTime(resolved?.instant as Date, 'America/New_York')).toBe('2026-03-08T03:30');
    // 03:30 EDT (UTC-4) is 07:30Z.
    expect(resolved?.instant.toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });

  it('the hour either side of the gap is ordinary', () => {
    expect(resolveZonedTime('2026-03-08T01:30', 'America/New_York')?.kind).toBe('exact');
    expect(resolveZonedTime('2026-03-08T03:30', 'America/New_York')?.kind).toBe('exact');
  });

  it('London skips 01:00–01:59 on 29 March 2026, and 02:30 is NOT in the gap', () => {
    // The UK jumps 01:00 GMT → 02:00 BST, so 02:30 exists and 01:30 does not.
    // Getting this backwards is the classic error, so both are asserted.
    expect(resolveZonedTime('2026-03-29T01:30', 'Europe/London')?.kind).toBe('skipped');
    expect(resolveZonedTime('2026-03-29T02:30', 'Europe/London')?.kind).toBe('exact');
  });
});

describe('the hour that happens twice — fall back', () => {
  it('New York repeats 01:00–01:59 on 1 November 2026, and the EARLIER is chosen', () => {
    const resolved = resolveZonedTime('2026-11-01T01:30', 'America/New_York');
    expect(resolved?.kind).toBe('ambiguous');
    // 01:30 EDT (UTC-4) = 05:30Z comes first; 01:30 EST (UTC-5) = 06:30Z is the
    // repeat. The earlier is what a person means by "the first time it is 01:30".
    expect(resolved?.instant.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    if (resolved?.kind === 'ambiguous') {
      expect(resolved.alternative.toISOString()).toBe('2026-11-01T06:30:00.000Z');
      expect(resolved.instant.getTime()).toBeLessThan(resolved.alternative.getTime());
    }
  });

  it('both candidates really do render as the same wall-clock', () => {
    const resolved = resolveZonedTime('2026-11-01T01:30', 'America/New_York');
    if (resolved?.kind !== 'ambiguous') throw new Error('expected an ambiguous time');
    expect(formatLocalTime(resolved.instant, 'America/New_York')).toBe('2026-11-01T01:30');
    expect(formatLocalTime(resolved.alternative, 'America/New_York')).toBe('2026-11-01T01:30');
  });

  it('London repeats 01:00–01:59 on 25 October 2026', () => {
    expect(resolveZonedTime('2026-10-25T01:30', 'Europe/London')?.kind).toBe('ambiguous');
  });
});

describe('a month means the WORKSPACE’s month', () => {
  it('a local month in Riyadh starts three hours before the UTC month does', () => {
    /*
     * THE BUG THIS PREVENTS. Riyadh is UTC+3, so 00:00 on 1 March local is
     * 21:00 on 28 February in UTC. A month view that queried a UTC range would
     * put the first three hours of every month on the previous page, and a
     * customer would open the month their post is in and not find it.
     */
    const range = monthRangeUtc(2026, 3, 'Asia/Riyadh');
    expect(range?.start.toISOString()).toBe('2026-02-28T21:00:00.000Z');
    expect(range?.end.toISOString()).toBe('2026-03-31T21:00:00.000Z');
  });

  it('December rolls into the next year rather than into month 13', () => {
    const range = monthRangeUtc(2026, 12, 'UTC');
    expect(range?.start.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(range?.end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('a month in a DST zone spans the transition without losing an hour', () => {
    // March 2026 in New York contains the spring-forward. The range must still
    // start at local midnight on the 1st and end at local midnight on 1 April.
    const range = monthRangeUtc(2026, 3, 'America/New_York');
    expect(formatLocalTime(range?.start as Date, 'America/New_York')).toBe('2026-03-01T00:00');
    expect(formatLocalTime(range?.end as Date, 'America/New_York')).toBe('2026-04-01T00:00');
  });
});

describe('a round trip is lossless for every zone the platform ships with', () => {
  it('formats and re-resolves to the same wall-clock', () => {
    const zones = ['Asia/Riyadh', 'Asia/Dubai', 'Africa/Cairo', 'Europe/London', 'UTC'];
    for (const zone of zones) {
      for (const localTime of ['2026-01-15T09:00', '2026-06-15T17:45', '2026-12-31T23:59']) {
        const resolved = resolveZonedTime(localTime, zone);
        if (resolved?.kind === 'skipped') continue; // asserted on its own above
        expect(formatLocalTime(resolved?.instant as Date, zone), `${zone} ${localTime}`).toBe(
          localTime,
        );
      }
    }
  });
});

describe('the calendar policy the service runs on is the one an operator saves', () => {
  it('the config schema and the service schema agree, defaults included', () => {
    /*
     * TWO SCHEMAS ON PURPOSE — one validates what an OPERATOR may save, the
     * other what a SERVICE may run on — and this is the test that keeps them
     * from becoming two answers. Without it, the separation is a liability
     * rather than a boundary.
     */
    const activated = parseConfigPayload('content', {});
    const parsed = contentPolicySchema.parse(activated);
    expect(parsed.calendar).toEqual(activated.calendar);
  });

  it('nothing in the calendar block is hard-coded in the service', () => {
    // Every value the calendar behaves on comes from the activated document.
    const activated = parseConfigPayload('content', {
      calendar: {
        weekStartsOn: 1,
        maxDaysAhead: 30,
        minLeadMinutes: 60,
        maxSlotsPerDay: 3,
        requireApprovalBeforeScheduling: true,
      },
    });
    const parsed = contentPolicySchema.parse(activated);
    expect(parsed.calendar).toEqual({
      weekStartsOn: 1,
      maxDaysAhead: 30,
      minLeadMinutes: 60,
      maxSlotsPerDay: 3,
      requireApprovalBeforeScheduling: true,
    });
  });

  it('the approval gate ships OFF, because nothing can grant approval yet', () => {
    /*
     * AC-14.6's gate is built and tested; the Approvals workflow that would
     * satisfy it is Phase 5B-3. A default of `true` would make the calendar
     * unusable while appearing to enforce a policy nobody can meet — so the
     * default is honest, and this records that it is a decision rather than an
     * oversight.
     */
    expect(parseConfigPayload('content', {}).calendar.requireApprovalBeforeScheduling).toBe(false);
  });

  it('`content` is a domain the tenant projection may carry', () => {
    // The calendar's policy reaches the dashboard through the same projection
    // the Studio's does; a domain missing from the registry would resolve to
    // defaults for ever without anything failing.
    expect(Object.keys(CONFIG_DOMAINS)).toContain('content');
  });
});
