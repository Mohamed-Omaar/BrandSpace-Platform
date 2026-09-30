import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DUE_EVENT_DEFINITIONS,
  OCCURRENCE_STALE,
  TIMED_PRODUCER_LIMITS,
  dayKeyInEventKey,
  dayKeyOf,
  edgeTransitionSinceArming,
  localDayKey,
  nextVisitAt,
  producerCeiling,
  producerFloor,
  selectDue,
  shiftDayKey,
} from '@brandspace/automation';

/**
 * PHASE 2B-3 PR 3 — THE TIMED PRODUCERS' ARITHMETIC.
 *
 * Every boundary the producers depend on, as a pure function: the floor that
 * keeps a rule from reaching back past its arming, the lagging ceiling, the
 * per-visit cap and its ties, the day keys, and the edge state that forgets
 * what it remembered before the current arming.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const at = (iso: string) => new Date(iso);

describe('the event definitions and the owner-decided bounds', () => {
  it('the four event meanings live in the registry, as the owner decided', () => {
    expect(DUE_EVENT_DEFINITIONS).toEqual({
      reviewWaitHours: 24,
      scheduleGapDays: 3,
      factExpiryWindowDays: 7,
    });
  });

  it('decision A: 25 per visit, a 24-hour campaign lateness bound, a 120-second lag', () => {
    expect(TIMED_PRODUCER_LIMITS).toEqual({
      maxOccurrencesPerVisit: 25,
      campaignBoundaryMaxLatenessHours: 24,
      watermarkLagSeconds: 120,
    });
  });
});

describe('the floor — no backfill past the current arming (D-417)', () => {
  it('an unarmed rule has no floor, so it produces nothing', () => {
    expect(producerFloor({ armedAt: null, dueWatermark: at('2026-10-01T00:00:00Z') })).toBeNull();
  });

  it('a new rule starts from its arming', () => {
    const armedAt = at('2026-10-01T09:00:00Z');
    expect(producerFloor({ armedAt, dueWatermark: null })).toEqual(armedAt);
  });

  it('the cursor, once past the arming, is the floor', () => {
    const cursor = at('2026-10-02T09:00:00Z');
    expect(producerFloor({ armedAt: at('2026-10-01T09:00:00Z'), dueWatermark: cursor })).toEqual(
      cursor,
    );
  });

  it('a cursor older than a re-arming never reaches back past it', () => {
    const armedAt = at('2026-10-05T09:00:00Z');
    expect(producerFloor({ armedAt, dueWatermark: at('2026-10-02T09:00:00Z') })).toEqual(armedAt);
  });
});

describe('the ceiling lags now by the configured margin', () => {
  it('120 seconds behind', () => {
    expect(producerCeiling(at('2026-10-01T12:00:00Z'))).toEqual(at('2026-10-01T11:58:00Z'));
  });
});

describe('selectDue — what one visit emits, and where the cursor moves', () => {
  const floor = at('2026-10-01T00:00:00Z');
  const ceiling = at('2026-10-02T00:00:00Z');
  const due = (iso: string, id: string) => ({ due: at(iso), id });

  it('the floor is exclusive and the ceiling inclusive', () => {
    const result = selectDue({
      candidates: [
        due('2026-10-01T00:00:00Z', 'on-floor'),
        due('2026-10-01T06:00:00Z', 'inside'),
        due('2026-10-02T00:00:00Z', 'on-ceiling'),
        due('2026-10-02T00:00:01Z', 'after'),
      ],
      floor,
      ceiling,
    });
    expect(result.emit.map((c) => c.id)).toEqual(['inside', 'on-ceiling']);
    expect(result.watermark).toEqual(ceiling);
    expect(result.more).toBe(false);
  });

  it('oldest first, the id breaking ties', () => {
    const result = selectDue({
      candidates: [
        due('2026-10-01T08:00:00Z', 'b'),
        due('2026-10-01T06:00:00Z', 'z'),
        due('2026-10-01T08:00:00Z', 'a'),
      ],
      floor,
      ceiling,
    });
    expect(result.emit.map((c) => c.id)).toEqual(['z', 'a', 'b']);
  });

  it('at most 25 a visit; the cursor stops at the last one taken, and the rule is due again', () => {
    const candidates = Array.from({ length: 30 }, (_, i) =>
      due(
        new Date(floor.getTime() + (i + 1) * 60_000).toISOString(),
        `c${String(i).padStart(2, '0')}`,
      ),
    );
    const first = selectDue({ candidates, floor, ceiling });
    expect(first.emit).toHaveLength(25);
    expect(first.more).toBe(true);
    expect(first.watermark).toEqual(candidates[24]?.due);

    // The next visit continues exactly there — nothing emitted twice, nothing lost.
    const second = selectDue({ candidates, floor: first.watermark, ceiling });
    expect(second.emit.map((c) => c.id)).toEqual(candidates.slice(25).map((c) => c.id));
    expect(second.more).toBe(false);
    expect(second.watermark).toEqual(ceiling);
  });

  it('a tie across the cap is taken whole, so an exclusive floor cannot drop its second half', () => {
    const same = '2026-10-01T10:00:00Z';
    const candidates = [
      ...Array.from({ length: 24 }, (_, i) =>
        due(new Date(floor.getTime() + (i + 1) * 1_000).toISOString(), `early${i}`),
      ),
      due(same, 'tie-a'),
      due(same, 'tie-b'),
      due(same, 'tie-c'),
      due('2026-10-01T11:00:00Z', 'later'),
    ];
    const result = selectDue({ candidates, floor, ceiling });
    expect(result.emit.map((c) => c.id).slice(-3)).toEqual(['tie-a', 'tie-b', 'tie-c']);
    expect(result.watermark).toEqual(at(same));
    expect(result.more).toBe(true);
  });

  it('nothing due leaves the cursor at the ceiling (never behind the floor)', () => {
    expect(selectDue({ candidates: [], floor, ceiling }).watermark).toEqual(ceiling);
    // A ceiling behind the floor (a rule armed in the last two minutes) keeps the floor.
    const late = at('2026-10-03T00:00:00Z');
    expect(selectDue({ candidates: [], floor: late, ceiling }).watermark).toEqual(late);
  });
});

describe('nextVisitAt — the park', () => {
  const now = at('2026-10-01T12:00:00Z');

  it('a visit stopped by the cap is due again at once', () => {
    expect(nextVisitAt({ now, next: null, more: true, maxAheadSeconds: 3_600 })).toEqual(now);
  });

  it('the next thing awaited, capped at an hour, never in the past', () => {
    expect(
      nextVisitAt({ now, next: at('2026-10-01T12:20:00Z'), more: false, maxAheadSeconds: 3_600 }),
    ).toEqual(at('2026-10-01T12:20:00Z'));
    expect(
      nextVisitAt({ now, next: at('2026-10-01T18:00:00Z'), more: false, maxAheadSeconds: 3_600 }),
    ).toEqual(at('2026-10-01T13:00:00Z'));
    expect(
      nextVisitAt({ now, next: at('2026-09-30T00:00:00Z'), more: false, maxAheadSeconds: 3_600 }),
    ).toEqual(now);
    expect(nextVisitAt({ now, next: null, more: false, maxAheadSeconds: 3_600 })).toEqual(
      at('2026-10-01T13:00:00Z'),
    );
  });
});

describe('day keys — calendar arithmetic, not hours', () => {
  it('moves across months, years and a leap day', () => {
    expect(shiftDayKey('2026-01-31', 1)).toBe('2026-02-01');
    expect(shiftDayKey('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDayKey('2028-02-28', 1)).toBe('2028-02-29');
    expect(shiftDayKey('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDayKey('2026-10-10', -6)).toBe('2026-10-04');
  });

  it('a DATE column value names its own day', () => {
    expect(dayKeyOf(new Date('2026-10-10T00:00:00.000Z'))).toBe('2026-10-10');
  });

  it('today is the workspace’s own day, not UTC’s', () => {
    const instant = at('2026-10-01T22:30:00Z');
    expect(localDayKey(instant, 'UTC')).toBe('2026-10-01');
    expect(localDayKey(instant, 'Asia/Riyadh')).toBe('2026-10-02');
    expect(localDayKey(instant, 'America/Los_Angeles')).toBe('2026-10-01');
  });

  it('across a daylight-saving change the day key is still the local one', () => {
    // 2026-03-08: US spring forward at 02:00 local; 2026-11-01: fall back.
    expect(localDayKey(at('2026-03-08T07:59:00Z'), 'America/New_York')).toBe('2026-03-08');
    expect(localDayKey(at('2026-11-01T04:30:00Z'), 'America/New_York')).toBe('2026-11-01');
    expect(localDayKey(at('2026-11-01T03:59:00Z'), 'America/New_York')).toBe('2026-10-31');
  });
});

describe('edge state, forgetting what was remembered before the current arming', () => {
  const armedAt = at('2026-10-05T00:00:00Z');

  it('memory from before the arming counts as none: establish, never fire', () => {
    expect(
      edgeTransitionSinceArming({
        armedAt,
        evaluatedAt: at('2026-10-01T00:00:00Z'),
        previous: false,
        current: true,
      }),
    ).toEqual({ kind: 'establish', breached: true });
  });

  it('no memory at all establishes too', () => {
    expect(
      edgeTransitionSinceArming({ armedAt, evaluatedAt: null, previous: null, current: true }),
    ).toEqual({ kind: 'establish', breached: true });
  });

  it('memory since the arming drives the ordinary edge', () => {
    const since = at('2026-10-05T01:00:00Z');
    expect(
      edgeTransitionSinceArming({ armedAt, evaluatedAt: since, previous: false, current: true }),
    ).toEqual({ kind: 'fire' });
    expect(
      edgeTransitionSinceArming({ armedAt, evaluatedAt: since, previous: true, current: true }),
    ).toEqual({ kind: 'steady' });
    expect(
      edgeTransitionSinceArming({ armedAt, evaluatedAt: since, previous: true, current: false }),
    ).toEqual({ kind: 'rearm' });
  });
});

describe('the date an event key was produced for', () => {
  it('reads the trailing YYYY-MM-DD, or nothing', () => {
    expect(dayKeyInEventKey('CAMPAIGN_STARTED:r:c:2026-10-10')).toBe('2026-10-10');
    expect(dayKeyInEventKey('FACT_EXPIRING:r:i:2026-10-16')).toBe('2026-10-16');
    expect(dayKeyInEventKey('REVIEW_WAITING_24H:r:a')).toBeNull();
    expect(dayKeyInEventKey(null)).toBeNull();
  });
});

describe('the engine re-checks the occurrence before any condition or action', () => {
  it('skips with occurrence_stale, between the daily ceiling and the conditions', () => {
    expect(OCCURRENCE_STALE).toBe('occurrence_stale');
    const engine = readFileSync(path.join(root, 'packages/automation/src/engine.ts'), 'utf8');
    const ceiling = engine.indexOf("failureCode: 'daily_ceiling_reached'");
    const recheck = engine.indexOf('occurrenceStillHolds(this.#db');
    const conditions = engine.indexOf('conditionValuesResolve(this.#db');
    expect(ceiling).toBeGreaterThan(0);
    expect(recheck).toBeGreaterThan(ceiling);
    expect(conditions).toBeGreaterThan(recheck);
    expect(engine).toContain('{ failureCode: OCCURRENCE_STALE }');
  });

  it('the worker supplies local midnight from the one zoned-time resolver', () => {
    const worker = readFileSync(
      path.join(root, 'apps/worker/src/processors/automation.ts'),
      'utf8',
    );
    expect(worker).toContain('instantForIntent(`${dayKey}T00:00`, timezone)');
  });
});
