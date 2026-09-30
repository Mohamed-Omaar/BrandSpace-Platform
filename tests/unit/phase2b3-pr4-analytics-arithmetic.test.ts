import { describe, expect, it } from 'vitest';
import {
  DUE_EVENT_DEFINITIONS,
  readOnce,
  topShareOf,
  weeklyDropVerdict,
  weeklyEngagementWindows,
  type SharedReads,
} from '@brandspace/automation';

/**
 * PHASE 2B-3 PR 4 — THE ANALYTICS EVENTS' ARITHMETIC (report §30), as pure
 * functions: the settled UTC weeks, the integer 20% threshold, and the nearest-
 * rank top 10% with ties.
 */

const at = (iso: string) => new Date(iso);

describe('the settled UTC weeks', () => {
  it('end refreshWindowDays before today’s UTC midnight; each is seven UTC days', () => {
    const windows = weeklyEngagementWindows(at('2026-10-20T15:30:00Z'), 3);
    expect(windows.settledEnd).toEqual(at('2026-10-17T00:00:00Z'));
    expect(windows.current).toEqual({
      start: at('2026-10-10T00:00:00Z'),
      end: at('2026-10-17T00:00:00Z'),
    });
    expect(windows.prior).toEqual({
      start: at('2026-10-03T00:00:00Z'),
      end: at('2026-10-10T00:00:00Z'),
    });
  });

  it('do not move with the time of day, and move by one day at UTC midnight', () => {
    const early = weeklyEngagementWindows(at('2026-10-20T00:00:00Z'), 3);
    const late = weeklyEngagementWindows(at('2026-10-20T23:59:59Z'), 3);
    expect(late).toEqual(early);
    expect(weeklyEngagementWindows(at('2026-10-21T00:00:00Z'), 3).settledEnd).toEqual(
      at('2026-10-18T00:00:00Z'),
    );
  });

  it('are UTC weeks: a daylight-saving change elsewhere does not shorten one', () => {
    const windows = weeklyEngagementWindows(at('2026-11-05T12:00:00Z'), 3);
    expect(windows.current.end.getTime() - windows.current.start.getTime()).toBe(7 * 86_400_000);
  });
});

describe('the 20% drop, in integers', () => {
  it('the percentage is the registry’s', () => {
    expect(DUE_EVENT_DEFINITIONS.weeklyDropPercent).toBe(20);
  });

  it('exactly 20% down is a drop; a hair less is not', () => {
    expect(weeklyDropVerdict({ prior: 1000n, current: 800n, minBaseline: 1 })).toBe(true);
    expect(weeklyDropVerdict({ prior: 1000n, current: 801n, minBaseline: 1 })).toBe(false);
    expect(weeklyDropVerdict({ prior: 1000n, current: 0n, minBaseline: 1 })).toBe(true);
    expect(weeklyDropVerdict({ prior: 1000n, current: 5000n, minBaseline: 1 })).toBe(false);
  });

  it('a prior week below the baseline is not judged at all', () => {
    expect(weeklyDropVerdict({ prior: 49n, current: 0n, minBaseline: 50 })).toBeNull();
    expect(weeklyDropVerdict({ prior: 50n, current: 40n, minBaseline: 50 })).toBe(true);
  });

  it('holds for values far beyond a float’s exact range', () => {
    const prior = 10n ** 18n;
    expect(weeklyDropVerdict({ prior, current: (prior * 8n) / 10n, minBaseline: 1 })).toBe(true);
    expect(weeklyDropVerdict({ prior, current: (prior * 8n) / 10n + 1n, minBaseline: 1 })).toBe(
      false,
    );
  });
});

describe('the top 10%, nearest rank, ties included', () => {
  const post = (id: string, engagements: number, impressions: number) => ({
    id,
    engagements: BigInt(engagements),
    impressions: BigInt(impressions),
  });

  it('k = ceil(10% × n): ten posts give one, eleven give two', () => {
    const ten = Array.from({ length: 10 }, (_, i) => post(`p${i}`, i + 1, 100));
    expect(topShareOf(ten).map((p) => p.id)).toEqual(['p9']);
    const eleven = Array.from({ length: 11 }, (_, i) => post(`p${i}`, i + 1, 100));
    expect(topShareOf(eleven).map((p) => p.id)).toEqual(['p10', 'p9']);
  });

  it('compares rates, not raw engagements', () => {
    const posts = [
      post('big', 900, 10_000), // 9%
      post('small', 30, 100), // 30%
      ...Array.from({ length: 8 }, (_, i) => post(`x${i}`, 1, 100)),
    ];
    expect(topShareOf(posts).map((p) => p.id)).toEqual(['small']);
  });

  it('every post tied with the cut-off is in', () => {
    const posts = [
      post('a', 5, 100),
      post('b', 10, 200), // the same 5% as a
      ...Array.from({ length: 8 }, (_, i) => post(`x${i}`, 1, 100)),
    ];
    expect(topShareOf(posts).map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('a single post is its own top 10%; none gives none', () => {
    expect(topShareOf([post('only', 1, 10)]).map((p) => p.id)).toEqual(['only']);
    expect(topShareOf([])).toEqual([]);
  });
});

describe('one read per brand per sweep', () => {
  it('the same key is read once and shared', async () => {
    const shared: SharedReads = new Map();
    let reads = 0;
    const read = async () => {
      reads += 1;
      return 42;
    };
    const [a, b] = await Promise.all([readOnce(shared, 'k', read), readOnce(shared, 'k', read)]);
    expect([a, b, reads]).toEqual([42, 42, 1]);
  });

  it('a failed read is not remembered; without a shared map every call reads', async () => {
    const shared: SharedReads = new Map();
    await expect(readOnce(shared, 'k', () => Promise.reject(new Error('down')))).rejects.toThrow();
    await Promise.resolve();
    expect(await readOnce(shared, 'k', async () => 7)).toBe(7);
    let reads = 0;
    await readOnce(undefined, 'k', async () => (reads += 1));
    await readOnce(undefined, 'k', async () => (reads += 1));
    expect(reads).toBe(2);
  });
});
