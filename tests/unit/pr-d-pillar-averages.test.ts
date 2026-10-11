import { describe, expect, it } from 'vitest';
import { pillarAverages } from '../../apps/dashboard/src/server/performance-view';

/**
 * PR D (Strategy 7) — "How it's going": average engagements per post, per
 * pillar, from the posts' own readings only.
 */
describe('pillar averages', () => {
  it('averages each pillar over its posts, largest first', () => {
    expect(
      pillarAverages([
        { pillar: 'Education', value: 30 },
        { pillar: 'Education', value: 10 },
        { pillar: 'Behind the scenes', value: 25 },
      ]),
    ).toEqual([
      { pillar: 'Behind the scenes', average: 25, posts: 1 },
      { pillar: 'Education', average: 20, posts: 2 },
    ]);
  });

  it('leaves out posts without a pillar, and draws nothing without posts', () => {
    expect(
      pillarAverages([
        { pillar: null, value: 99 },
        { pillar: '  ', value: 5 },
      ]),
    ).toEqual([]);
    expect(pillarAverages([])).toEqual([]);
  });

  it('breaks a tie by name, so the order is stable', () => {
    expect(
      pillarAverages([
        { pillar: 'B', value: 4 },
        { pillar: 'A', value: 4 },
      ]).map((row) => row.pillar),
    ).toEqual(['A', 'B']);
  });
});
