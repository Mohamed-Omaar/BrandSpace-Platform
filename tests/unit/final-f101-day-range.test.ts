import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { localDayRangeUtc } from '@brandspace/content';

/**
 * F-101 (FINAL REVIEW) — THE CALENDAR'S PER-DAY CAP COUNTS THE LOCAL DAY'S
 * REAL LENGTH.
 *
 * The range was the day's local midnight plus a fixed 24 hours, so on a day a
 * daylight-saving change makes 23 or 25 hours long it reached an hour into the
 * next day or stopped an hour short of this one's end. It is now midnight to
 * the next local midnight.
 */

const HOUR = 3_600_000;
const hours = (range: { start: Date; end: Date } | null) =>
  range ? (range.end.getTime() - range.start.getTime()) / HOUR : null;

describe('F-101 · one local day as a UTC range', () => {
  it('an ordinary day is 24 hours, from local midnight', () => {
    const range = localDayRangeUtc('2026-10-14', 'America/New_York');
    expect(range?.start.toISOString()).toBe('2026-10-14T04:00:00.000Z');
    expect(range?.end.toISOString()).toBe('2026-10-15T04:00:00.000Z');
    expect(hours(range)).toBe(24);
  });

  it('the spring-forward day is 23 hours and ends at the next local midnight', () => {
    // US clocks go 02:00 → 03:00 on 2026-03-08.
    const range = localDayRangeUtc('2026-03-08', 'America/New_York');
    expect(range?.start.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(range?.end.toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(hours(range)).toBe(23);
  });

  it('the fall-back day is 25 hours, so its last hour is not counted on the next day', () => {
    // US clocks go 02:00 → 01:00 on 2026-11-01.
    const range = localDayRangeUtc('2026-11-01', 'America/New_York');
    expect(range?.start.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(range?.end.toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(hours(range)).toBe(25);
    // 23:30 local on 2026-11-01 (04:30Z on the 2nd) belongs to the 1st.
    const lateSlot = new Date('2026-11-02T04:30:00.000Z');
    expect(lateSlot >= range!.start && lateSlot < range!.end).toBe(true);
  });

  it('consecutive days meet exactly, with no gap and no overlap', () => {
    for (const [day, next] of [
      ['2026-03-07', '2026-03-08'],
      ['2026-03-08', '2026-03-09'],
      ['2026-10-31', '2026-11-01'],
      ['2026-11-01', '2026-11-02'],
    ] as const) {
      expect(localDayRangeUtc(day, 'America/New_York')?.end.getTime()).toBe(
        localDayRangeUtc(next, 'America/New_York')?.start.getTime(),
      );
    }
  });

  it('a zone without daylight saving keeps 24-hour days', () => {
    expect(hours(localDayRangeUtc('2026-03-08', 'Asia/Riyadh'))).toBe(24);
    expect(hours(localDayRangeUtc('2026-11-01', 'Asia/Riyadh'))).toBe(24);
  });

  it('an unusable zone gives no range rather than a wrong one', () => {
    expect(localDayRangeUtc('2026-10-14', 'Not/AZone')).toBeNull();
  });

  it('the calendar counts its cap over this range, not "+ 24 hours"', () => {
    const source = readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../packages/content/src/calendar.ts',
      ),
      'utf8',
    );
    const body = source.slice(source.indexOf('#dayRange(instant: Date)'));
    const method = body.slice(0, body.indexOf('\n  }\n'));
    expect(method).toContain('localDayRangeUtc(day, this.#timezone)');
    expect(method).toContain('return { dayStart: range.start, dayEnd: range.end };');
  });
});
