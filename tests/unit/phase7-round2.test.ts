import { describe, expect, it } from 'vitest';
import {
  localMomentFor,
  occurrenceKey,
  metricIsBreaching,
  runBucketFor,
  thresholdOccurrenceKey,
  thresholdTransition,
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
// R3-2 — the edge that makes a threshold rule fire ONCE, across sweeps
// ---------------------------------------------------------------------------

describe('R3-2: a threshold rule fires on the CROSSING, decided from durable memory', () => {
  /*
   * WHAT REPLACED WHAT, AND WHY IT IS NOT A WEAKER TEST.
   *
   * This block used to check `thresholdCrossed(current window, previous adjacent
   * window)`. That predicate looked like edge detection and was not: a metric
   * that climbs past the line and STAYS there keeps answering "crossed" on sweep
   * after sweep, and de-duplicating on the newest observation's id hid the repeat
   * only until the next reading landed. The predicate is gone, so its tests are
   * gone with it — and what is here instead covers strictly more: the side test,
   * the state machine over the remembered side, and the identity that makes a
   * second event legitimate only after a genuine re-arm.
   */

  describe('which side the metric is on', () => {
    it('reads each direction, with the boundary on neither side', () => {
      const at = (value: bigint | null, direction: 'above' | 'below' = 'above') =>
        metricIsBreaching({ direction, threshold: 100, value });
      expect(at(120n)).toBe(true);
      expect(at(80n)).toBe(false);
      expect(at(80n, 'below')).toBe(true);
      expect(at(120n, 'below')).toBe(false);
      // A reading exactly ON the line is past neither, so "above 100" and
      // "below 100" can never both be true of it.
      expect(at(100n)).toBe(false);
      expect(at(100n, 'below')).toBe(false);
    });

    it('MISSING IS NOT A SIDE, so an unmeasured window changes nothing', () => {
      expect(metricIsBreaching({ direction: 'above', threshold: 100, value: null })).toBeNull();
      expect(metricIsBreaching({ direction: 'below', threshold: 100, value: null })).toBeNull();
    });
  });

  describe('the state machine over the remembered side', () => {
    const at = (previous: boolean | null, current: boolean | null) =>
      thresholdTransition({ previous, current }).kind;

    it('A — below then above fires exactly once', () => {
      expect(at(false, true)).toBe('fire');
    });

    it('B — still above adds nothing, however many sweeps see it', () => {
      expect(at(true, true)).toBe('steady');
    });

    it('C — above then below RE-ARMS, and fires nothing on the way back', () => {
      expect(at(true, false)).toBe('rearm');
    });

    it('D — below then above again fires once more', () => {
      expect(at(false, true)).toBe('fire');
    });

    it('E — the same sequence reads identically for direction=below', () => {
      // The direction is resolved into the side by `metricIsBreaching`, so the
      // machine is direction-agnostic by construction: "breaching" means whatever
      // the rule asked for. Stated as a test so a future direction-aware branch
      // has to break this.
      const below = (value: bigint) =>
        metricIsBreaching({ direction: 'below', threshold: 100, value });
      expect(at(below(120n), below(80n))).toBe('fire');
      expect(at(below(80n), below(70n))).toBe('steady');
      expect(at(below(80n), below(120n))).toBe('rearm');
    });

    it('F — an unmeasured sweep leaves the memory exactly as it found it', () => {
      expect(at(true, null)).toBe('unmeasured');
      expect(at(false, null)).toBe('unmeasured');
      expect(at(null, null)).toBe('unmeasured');
    });

    it('THE FIRST EVALUATION ESTABLISHES THE SIDE AND FIRES NOTHING', () => {
      /*
       * A rule created while the metric is ALREADY past the line has not seen
       * anything cross since somebody asked for it. Alerting immediately on a
       * number that has been sitting there for months is the fastest way to teach
       * a customer to switch the feature off.
       */
      expect(thresholdTransition({ previous: null, current: true })).toEqual({
        kind: 'establish',
        breached: true,
      });
      expect(thresholdTransition({ previous: null, current: false })).toEqual({
        kind: 'establish',
        breached: false,
      });
    });
  });

  describe('the identity of a threshold event', () => {
    it('is the rule and its ARMING, not the observation that happened to be newest', () => {
      /*
       * THE DEFECT THIS ENCODES. Keying on the latest observation id means a new
       * reading while the metric stays past the line produces a NEW key — and
       * therefore a second event about the same crossing. The arming cycle
       * changes only when the rule re-arms, which is exactly when a second event
       * is legitimate.
       */
      expect(thresholdOccurrenceKey('rule-1', 0)).toBe('rule-1:0');
      expect(thresholdOccurrenceKey('rule-1', 0)).toBe(thresholdOccurrenceKey('rule-1', 0));
      expect(thresholdOccurrenceKey('rule-1', 1)).not.toBe(thresholdOccurrenceKey('rule-1', 0));
      // And it is per rule: two rules on the same metric are two subscriptions.
      expect(thresholdOccurrenceKey('rule-2', 0)).not.toBe(thresholdOccurrenceKey('rule-1', 0));
    });
  });
});
