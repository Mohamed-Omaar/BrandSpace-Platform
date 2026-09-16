import { describe, expect, it } from 'vitest';
import {
  localMomentFor,
  occurrenceKey,
  runBucketFor,
  thresholdCrossed,
  timedRuleIsDue,
} from '@brandspace/automation';
import { stepBrandPermitted } from '@brandspace/copilot';

/**
 * PHASE 7 REMEDIATION, ROUND 2 — the pure halves of the four blockers.
 *
 * The database halves live in `tests/isolation/phase7-round2.test.ts`, against
 * real PostgreSQL. What is here is what can be decided without one: the clock
 * arithmetic that makes a timed rule fire in the customer's own zone, the edge
 * detection that stops a threshold rule firing for ever, and the brand rule that
 * says a step may name exactly one brand.
 */

// ---------------------------------------------------------------------------
// A2 — a step's brand is the SESSION's brand
// ---------------------------------------------------------------------------

describe('A2: a brand-scoped step may name exactly the session brand', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';

  it('allows the session brand when the caller still holds it', () => {
    expect(stepBrandPermitted({ sessionBrandId: A, stepBrandId: A, brandScope: [A] })).toBe(true);
  });

  it('ALLOWS IT UNDER AN EMPTY SCOPE, because empty means unrestricted (D-132)', () => {
    // The one case where a looser reading would have been a real regression:
    // every membership in production carries an empty brandScope today, and a
    // rule that refused them would have turned the Copilot off for everyone.
    expect(stepBrandPermitted({ sessionBrandId: A, stepBrandId: A, brandScope: [] })).toBe(true);
  });

  it('REFUSES ANOTHER OF THE CALLER’S OWN BRANDS — the defect itself', () => {
    /*
     * The founder with two brands. Scope says yes to both; the conversation is
     * about A; the model names B. Every check that existed agreed this was
     * allowed, and the assistant would have acted on the wrong brand while the
     * screen, the history and the audit trail all said A.
     */
    expect(stepBrandPermitted({ sessionBrandId: A, stepBrandId: B, brandScope: [A, B] })).toBe(
      false,
    );
  });

  it('refuses a brand outside the live scope, and a fabricated one, identically', () => {
    expect(stepBrandPermitted({ sessionBrandId: A, stepBrandId: A, brandScope: [B] })).toBe(false);
    expect(stepBrandPermitted({ sessionBrandId: A, stepBrandId: '', brandScope: [A] })).toBe(false);
  });

  it('FAILS CLOSED FOR A GENERAL SESSION, whatever the caller holds', () => {
    expect(stepBrandPermitted({ sessionBrandId: null, stepBrandId: A, brandScope: [A] })).toBe(
      false,
    );
    expect(stepBrandPermitted({ sessionBrandId: null, stepBrandId: A, brandScope: [] })).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// A1 — the clock that fires a timed rule
// ---------------------------------------------------------------------------

describe('A1: a timed rule fires in the workspace’s own zone', () => {
  // 2026-09-17T06:30Z is a Thursday. 09:30 in Riyadh, 23:30 Wednesday in Honolulu.
  const instant = new Date('2026-09-17T06:30:00.000Z');

  it('reads the local date, hour and weekday, not UTC’s', () => {
    expect(localMomentFor(instant, 'UTC')).toEqual({
      date: '2026-09-17',
      hour: 6,
      dayOfWeek: 4,
    });
    expect(localMomentFor(instant, 'Asia/Riyadh')).toEqual({
      date: '2026-09-17',
      hour: 9,
      dayOfWeek: 4,
    });
    // THE DAY IS DIFFERENT TOO, which is the case a UTC-only implementation gets
    // wrong silently: a "Thursday" rule must not fire on a Wednesday evening.
    expect(localMomentFor(instant, 'Pacific/Honolulu')).toEqual({
      date: '2026-09-16',
      hour: 20,
      dayOfWeek: 3,
    });
  });

  it('normalises midnight to hour 0 rather than 24', () => {
    // Some ICU builds format midnight as "24" under hour12:false, and a bucket
    // of `T24` would never meet the `T00` the same midnight produces elsewhere.
    const midnight = new Date('2026-09-17T00:00:00.000Z');
    expect(localMomentFor(midnight, 'UTC').hour).toBe(0);
  });

  it('is due at its hour, on a listed day', () => {
    const moment = localMomentFor(instant, 'Asia/Riyadh');
    const due = timedRuleIsDue({ config: { daysOfWeek: [4], hourLocal: 9 }, moment });
    expect(due).toEqual({ due: true, occurrence: '2026-09-17T09' });
  });

  it('an empty daysOfWeek means EVERY day, which is what the default means', () => {
    const moment = localMomentFor(instant, 'Asia/Riyadh');
    expect(timedRuleIsDue({ config: { daysOfWeek: [], hourLocal: 9 }, moment }).due).toBe(true);
  });

  it('is NOT due at another hour, and NOT due on an unlisted day', () => {
    const moment = localMomentFor(instant, 'Asia/Riyadh');
    expect(timedRuleIsDue({ config: { daysOfWeek: [], hourLocal: 10 }, moment }).due).toBe(false);
    expect(timedRuleIsDue({ config: { daysOfWeek: [1, 2], hourLocal: 9 }, moment }).due).toBe(
      false,
    );
  });

  it('DOES NOT CATCH UP: an hour that has passed is missed, not queued', () => {
    /*
     * A sweep that fired every rule whose hour was behind the current one would,
     * after a two-hour outage, fire two hours of automations at once. "Catch up
     * on the backlog" is how somebody wakes to a morning of posts they did not
     * ask for. A missed hour is missed; the next one is not.
     */
    const moment = localMomentFor(instant, 'Asia/Riyadh'); // 09:30 local
    expect(timedRuleIsDue({ config: { daysOfWeek: [], hourLocal: 7 }, moment }).due).toBe(false);
    expect(timedRuleIsDue({ config: { daysOfWeek: [], hourLocal: 8 }, moment }).due).toBe(false);
  });

  it('refuses a configuration it cannot parse rather than guessing an hour', () => {
    const moment = localMomentFor(instant, 'UTC');
    expect(timedRuleIsDue({ config: { hourLocal: 99 }, moment }).due).toBe(false);
    expect(timedRuleIsDue({ config: {}, moment }).due).toBe(false);
  });

  it('THE PRODUCER’S OCCURRENCE AND THE ENGINE’S BUCKET ARE THE SAME STRING', () => {
    /*
     * The two halves must agree on what "the nine o'clock run on the 17th" is
     * called. If they did not, a carried occurrence and a recomputed one would be
     * two different runs of one schedule — which is exactly the duplicate P7-R5
     * closed from the other side.
     */
    const moment = localMomentFor(instant, 'Asia/Riyadh');
    const due = timedRuleIsDue({ config: { daysOfWeek: [], hourLocal: 9 }, moment });
    expect(due.due && due.occurrence).toBe(
      runBucketFor({ triggerType: 'SCHEDULED_TIME', localDate: moment.date, hourLocal: 9 }),
    );
    expect(occurrenceKey('2026-09-17', 9)).toBe('2026-09-17T09');
  });
});

// ---------------------------------------------------------------------------
// A1 — the edge that makes a threshold rule fire once
// ---------------------------------------------------------------------------

describe('A1: a threshold rule fires on the CROSSING, not on the level', () => {
  it('fires when the window moves past the number', () => {
    expect(
      thresholdCrossed({ direction: 'above', threshold: 100, current: 120n, previous: 90n }),
    ).toBe(true);
    expect(
      thresholdCrossed({ direction: 'below', threshold: 100, current: 80n, previous: 110n }),
    ).toBe(true);
  });

  it('DOES NOT FIRE WHILE IT MERELY STAYS THERE — the defect a level check has', () => {
    // A rule that fired on every pass while the number stayed above would notify
    // a growing brand every minute for ever, and be switched off by the end of
    // the day.
    expect(
      thresholdCrossed({ direction: 'above', threshold: 100, current: 130n, previous: 120n }),
    ).toBe(false);
  });

  it('treats the boundary as not-yet-crossed, consistently on both sides', () => {
    expect(
      thresholdCrossed({ direction: 'above', threshold: 100, current: 100n, previous: 90n }),
    ).toBe(false);
    expect(
      thresholdCrossed({ direction: 'below', threshold: 100, current: 100n, previous: 110n }),
    ).toBe(false);
  });

  it('MISSING IS NEVER ZERO: absent data is not a crossing', () => {
    // The platform rule for every metric. A brand with no readings before today
    // has not "fallen below" anything.
    expect(
      thresholdCrossed({ direction: 'below', threshold: 100, current: 10n, previous: null }),
    ).toBe(false);
    expect(
      thresholdCrossed({ direction: 'above', threshold: 100, current: null, previous: 10n }),
    ).toBe(false);
  });
});
