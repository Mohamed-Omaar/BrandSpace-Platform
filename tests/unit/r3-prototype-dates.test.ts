import { describe, expect, it } from 'vitest';
import {
  clockLabel,
  dayLabel,
  localWhenLabel,
  rangeDay,
  rangeLabel,
  whenLabel,
} from '../../apps/dashboard/src/server/prototype-dates';
import {
  bestPostingHours,
  channelChart,
  pillarTotals,
  shortCount,
} from '../../apps/dashboard/src/server/performance-view';

/*
 * REVIEW OF #67, ROUND 3 — C2 (one date style) and B8 (the Performance
 * screen's arithmetic). Every instant here is fixed: nothing reads the clock.
 */
const OCT_16_0700_UTC = new Date('2026-10-16T07:00:00Z');

describe('the prototype’s date style (C2)', () => {
  it('writes a moment as "Oct 16 · 10:00", 24-hour, in the zone it is given', () => {
    expect(whenLabel(OCT_16_0700_UTC, 'en', 'Africa/Cairo')).toBe('Oct 16 · 10:00');
    expect(whenLabel(OCT_16_0700_UTC, 'en', 'UTC')).toBe('Oct 16 · 07:00');
    expect(clockLabel(new Date('2026-10-16T21:05:00Z'), 'en', 'UTC')).toBe('21:05');
  });

  it('writes Arabic with Arabic month names and Western digits, day first', () => {
    expect(whenLabel(OCT_16_0700_UTC, 'ar', 'Africa/Cairo')).toBe('16 أكتوبر · 10:00');
  });

  it('adds the year only for another year', () => {
    const now = new Date('2026-10-05T12:00:00Z');
    expect(dayLabel(OCT_16_0700_UTC, 'en', 'UTC', now)).toBe('Oct 16');
    expect(dayLabel(new Date('2025-12-30T12:00:00Z'), 'en', 'UTC', now)).toBe('Dec 30, 2025');
  });

  it('reads a stored wall-clock intent as written, with no zone applied', () => {
    expect(localWhenLabel('2026-10-16T10:00', 'en')).toBe('Oct 16 · 10:00');
    expect(localWhenLabel('not a time', 'en')).toBeNull();
  });

  it('writes a span as "5 Oct – 1 Nov", day first', () => {
    const start = new Date('2026-10-05T00:00:00Z');
    const end = new Date('2026-11-01T00:00:00Z');
    expect(rangeLabel(start, end, 'en', 'UTC')).toBe('5 Oct – 1 Nov');
    expect(rangeDay(start, 'ar', 'UTC')).toBe('5 أكتوبر');
  });
});

describe('the Performance screen’s arithmetic (B8)', () => {
  it('draws one line per channel on one shared scale, with a gap for a missing day', () => {
    const chart = channelChart([
      {
        key: 'instagram',
        points: [
          { label: 'a', value: 800 },
          { label: 'b', value: null },
          { label: 'c', value: 900 },
        ],
      },
      {
        key: 'tiktok',
        points: [
          { label: 'a', value: 500 },
          { label: 'b', value: 520 },
        ],
      },
    ]);
    expect(chart).not.toBeNull();
    const instagram = chart?.lines.find((line) => line.key === 'instagram');
    // The missing day splits the line: two separate segments, never a zero.
    expect(instagram?.paths).toHaveLength(2);
    expect(instagram?.end?.label).toBe('900');
    expect(chart?.grid[0]?.label).toBe('0');
  });

  it('draws nothing when no channel has a reading', () => {
    expect(channelChart([{ key: 'instagram', points: [{ label: 'a', value: null }] }])).toBeNull();
    expect(channelChart([])).toBeNull();
  });

  it('ranks posting hours by their posts’ average engagement, in the workspace’s zone', () => {
    const best = bestPostingHours(
      [
        { publishedAt: new Date('2026-10-01T06:00:00Z'), value: 120 }, // 09:00 Cairo
        { publishedAt: new Date('2026-10-02T06:00:00Z'), value: 80 }, // 09:00 Cairo
        { publishedAt: new Date('2026-10-03T16:00:00Z'), value: 140 }, // 19:00 Cairo
        { publishedAt: null, value: 999 },
      ],
      'Africa/Cairo',
    );
    expect(best).toEqual([
      { hour: 19, average: 140, posts: 1 },
      { hour: 9, average: 100, posts: 2 },
    ]);
  });

  it('sums engagements per pillar, leaving out posts with none', () => {
    expect(
      pillarTotals([
        { pillar: 'Morning coffee', value: 40 },
        { pillar: 'Behind the bar', value: 70 },
        { pillar: 'Morning coffee', value: 50 },
        { pillar: null, value: 500 },
        { pillar: '  ', value: 500 },
      ]),
    ).toEqual([
      { pillar: 'Morning coffee', total: 90 },
      { pillar: 'Behind the bar', total: 70 },
    ]);
  });

  it('shortens counts as the prototype’s axis does', () => {
    expect(shortCount(950)).toBe('950');
    expect(shortCount(3_400)).toBe('3.4k');
    expect(shortCount(2_500_000)).toBe('2.5m');
  });
});
