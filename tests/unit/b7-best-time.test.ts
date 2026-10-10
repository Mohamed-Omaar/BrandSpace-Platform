import { describe, expect, it } from 'vitest';
import {
  BEST_TIME_MIN_HOURS,
  BEST_TIME_MIN_POSTS,
  BEST_TIME_MIN_POSTS_PER_HOUR,
  BEST_TIME_WINDOW_DAYS,
  bestTimes,
  dayPartOf,
  type PublishedPostFigure,
} from '../../apps/dashboard/src/server/best-time';

/**
 * BATCH 7 PR C, popover item 3 — "BEST TIME AUTOMATICALLY" AND THE "WHEN YOUR
 * AUDIENCE IS ACTIVE" CHIPS ARE DRAWN ONLY FROM ENOUGH REAL DATA.
 *
 * The minimum, per channel of the post: 12 posts published in the last 90
 * days with real engagement figures, across at least 3 posting hours that
 * each carry at least 2 of them. Below it — on any one channel — the answer is
 * null and the popover draws neither the choice nor the chips.
 */

const ZONE = 'Africa/Cairo'; // UTC+3 in October 2026
const NOW = new Date('2026-10-10T08:00:00Z'); // 11:00 in Cairo

/** A post published `daysAgo` days back at `hour` Cairo time. */
function post(
  provider: PublishedPostFigure['provider'],
  daysAgo: number,
  hour: number,
  engagements: number,
): PublishedPostFigure {
  const at = new Date(NOW.getTime() - daysAgo * 86_400_000);
  at.setUTCHours(hour - 3, 0, 0, 0);
  return {
    provider,
    contentItemId: `${provider}-${daysAgo}-${hour}`,
    publishedAt: at,
    engagements,
  };
}

/** Twelve Instagram posts: four each at 09:00, 13:00 and 18:00; 18:00 does best. */
function enoughInstagram(): PublishedPostFigure[] {
  return [1, 2, 3, 4].flatMap((d) => [
    post('INSTAGRAM', d, 9, 100),
    post('INSTAGRAM', d, 13, 50),
    post('INSTAGRAM', d, 18, 300),
  ]);
}

const base = { timeZone: ZONE, now: NOW, minLeadMinutes: 15, maxDaysAhead: 90 };

describe('best time — the minimum data', () => {
  it('states its thresholds', () => {
    expect([
      BEST_TIME_MIN_POSTS,
      BEST_TIME_WINDOW_DAYS,
      BEST_TIME_MIN_HOURS,
      BEST_TIME_MIN_POSTS_PER_HOUR,
    ]).toEqual([12, 90, 3, 2]);
  });

  it('is hidden with no data at all', () => {
    expect(bestTimes({ ...base, channels: ['INSTAGRAM'], posts: [] })).toBeNull();
  });

  it('is hidden one post short', () => {
    const posts = enoughInstagram().slice(1);
    expect(posts).toHaveLength(BEST_TIME_MIN_POSTS - 1);
    expect(bestTimes({ ...base, channels: ['INSTAGRAM'], posts })).toBeNull();
  });

  it('is hidden when the posts sit in too few backed hours', () => {
    const posts = [1, 2, 3, 4, 5, 6].flatMap((d) => [
      post('INSTAGRAM', d, 9, 100),
      post('INSTAGRAM', d, 18, 300),
    ]);
    expect(posts).toHaveLength(12);
    expect(bestTimes({ ...base, channels: ['INSTAGRAM'], posts })).toBeNull();
  });

  it('ignores posts older than the window', () => {
    const posts = enoughInstagram().map((figure) => ({
      ...figure,
      publishedAt: new Date(figure.publishedAt.getTime() - BEST_TIME_WINDOW_DAYS * 86_400_000),
    }));
    expect(bestTimes({ ...base, channels: ['INSTAGRAM'], posts })).toBeNull();
  });

  it('is hidden when ANY channel of the post is short, even if another has plenty', () => {
    const posts = [...enoughInstagram(), post('LINKEDIN', 1, 9, 10)];
    expect(bestTimes({ ...base, channels: ['INSTAGRAM', 'LINKEDIN'], posts })).toBeNull();
  });

  it('is hidden for a post with no publishable channel', () => {
    expect(bestTimes({ ...base, channels: [], posts: enoughInstagram() })).toBeNull();
  });
});

describe('best time — shown with enough data (fixture)', () => {
  it('gives three chips in clock order, the best marked, and its next usable time', () => {
    const shown = bestTimes({ ...base, channels: ['INSTAGRAM'], posts: enoughInstagram() });
    expect(shown).toEqual({
      slots: [
        { time: '09:00', part: 'morning', top: false },
        { time: '13:00', part: 'lunch', top: false },
        { time: '18:00', part: 'evening', top: true },
      ],
      // 11:00 now in Cairo: 18:00 today is still ahead.
      bestLocalTime: '2026-10-10T18:00',
    });
  });

  it('moves the best time to tomorrow when today’s has passed the lead', () => {
    const late = new Date('2026-10-10T14:50:00Z'); // 17:50 in Cairo, 15 min lead → 18:05
    expect(
      bestTimes({ ...base, now: late, channels: ['INSTAGRAM'], posts: enoughInstagram() })
        ?.bestLocalTime,
    ).toBe('2026-10-11T18:00');
  });

  it('weighs each channel by its own average, so a big channel does not drown a small one', () => {
    // LinkedIn is ten times smaller and does best at 09:00; Instagram at 18:00.
    const linkedin = [1, 2, 3, 4].flatMap((d) => [
      post('LINKEDIN', d, 9, 90),
      post('LINKEDIN', d, 13, 10),
      post('LINKEDIN', d, 18, 5),
    ]);
    const shown = bestTimes({
      ...base,
      channels: ['INSTAGRAM', 'LINKEDIN'],
      posts: [...enoughInstagram(), ...linkedin],
    });
    expect(shown?.slots.map((slot) => slot.time)).toEqual(['09:00', '13:00', '18:00']);
    // Normalised: 09:00 averages (0.67 + 2.5) / 2, 18:00 (2 + 0.14) / 2.
    expect(shown?.slots.find((slot) => slot.top)?.time).toBe('09:00');
  });
});

describe('best time — the chip words', () => {
  it('names the part of the day', () => {
    expect([6, 9, 12, 14, 15, 18, 21, 22, 2].map(dayPartOf)).toEqual([
      'morning',
      'morning',
      'lunch',
      'lunch',
      'afternoon',
      'evening',
      'evening',
      'night',
      'night',
    ]);
  });
});
