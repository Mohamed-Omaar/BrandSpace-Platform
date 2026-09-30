import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POST_TIME,
  calendarCapacityLockKey,
  defaultPublishingTime,
} from '@brandspace/content';

/**
 * PHASE 2B-3, PR 2 — the pure halves of "schedule in the next free slot": the
 * one default-time function and the advisory-lock key (owner decision D7).
 */

describe('defaultPublishingTime (OD-8)', () => {
  it('the brand’s own default time comes first', () => {
    expect(defaultPublishingTime({ brandDefaultTime: '18:30', suggestedTimes: ['07:00'] })).toBe(
      '18:30',
    );
  });

  it('then the first suggested time for the country', () => {
    expect(
      defaultPublishingTime({ brandDefaultTime: null, suggestedTimes: ['07:00', '12:00'] }),
    ).toBe('07:00');
  });

  it('then 09:00', () => {
    expect(defaultPublishingTime({ brandDefaultTime: null, suggestedTimes: [] })).toBe(
      DEFAULT_POST_TIME,
    );
    expect(DEFAULT_POST_TIME).toBe('09:00');
  });
});

describe('calendarCapacityLockKey (D7)', () => {
  const a = '5c1f7a52-0d7e-4b61-9f3a-2f8d6b1e4c90';
  const b = '0e9b3c47-8a2d-4f15-b6c4-7d1a9e2f3b58';

  it('is the documented derivation: int64, big-endian, of SHA-256 over the namespace and id', () => {
    const expected = createHash('sha256')
      .update(`brandspace:calendar-capacity:v1:${a}`)
      .digest()
      .readBigInt64BE(0);
    expect(calendarCapacityLockKey(a)).toBe(expected);
  });

  it('is deterministic, fits a signed 64-bit key, and differs between workspaces', () => {
    expect(calendarCapacityLockKey(a)).toBe(calendarCapacityLockKey(a));
    for (const key of [calendarCapacityLockKey(a), calendarCapacityLockKey(b)]) {
      expect(key).toBeGreaterThanOrEqual(-(2n ** 63n));
      expect(key).toBeLessThan(2n ** 63n);
    }
    expect(calendarCapacityLockKey(a)).not.toBe(calendarCapacityLockKey(b));
  });
});
