import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { highestPooledRates, pooledCampaignRates } from '@brandspace/analytics';
import { campaignResultsPeriod, daysUntilCampaignEnds } from '@brandspace/content';

/**
 * B11 (Phase 2B-2b) — CAMPAIGN RESULTS, as rules. The database half is
 * `tests/isolation/campaign-results.test.ts`.
 */

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const day = (key: string) => new Date(`${key}T00:00:00.000Z`);

describe('the results period is the campaign’s own dates, in the workspace zone', () => {
  const now = new Date('2026-10-10T12:00:00.000Z');

  it('runs from local midnight on the start day to local midnight after the end day', () => {
    expect(
      campaignResultsPeriod({
        startDate: day('2026-09-01'),
        endDate: day('2026-09-30'),
        timezone: 'Asia/Riyadh',
        now,
      }),
    ).toEqual({
      start: new Date('2026-08-31T21:00:00.000Z'),
      end: new Date('2026-09-30T21:00:00.000Z'),
    });
  });

  it('stops at now while the campaign is still running, or has no end', () => {
    expect(
      campaignResultsPeriod({
        startDate: day('2026-10-01'),
        endDate: day('2026-10-31'),
        timezone: 'UTC',
        now,
      })?.end,
    ).toEqual(now);
    expect(
      campaignResultsPeriod({ startDate: day('2026-10-01'), endDate: null, timezone: 'UTC', now })
        ?.end,
    ).toEqual(now);
  });

  it('is null — "No results yet" — without a start date, or before it arrives (D6)', () => {
    expect(campaignResultsPeriod({ startDate: null, endDate: null, timezone: 'UTC', now })).toBe(
      null,
    );
    expect(
      campaignResultsPeriod({ startDate: day('2026-10-11'), endDate: null, timezone: 'UTC', now }),
    ).toBe(null);
  });
});

describe('"ends in N days" counts calendar days in the workspace zone', () => {
  it('counts whole days, 0 on the last day, nothing once it has ended', () => {
    const now = new Date('2026-10-10T12:00:00.000Z');
    const ends = (key: string | null, timezone = 'UTC') =>
      daysUntilCampaignEnds({ endDate: key ? day(key) : null, timezone, now });
    expect(ends('2026-10-15')).toBe(5);
    expect(ends('2026-10-10')).toBe(0);
    expect(ends('2026-10-09')).toBe(null);
    expect(ends(null)).toBe(null);
  });

  it('uses the workspace’s day, not UTC’s', () => {
    // 22:30 UTC on the 10th is already the 11th in Riyadh.
    const now = new Date('2026-10-10T22:30:00.000Z');
    expect(
      daysUntilCampaignEnds({ endDate: day('2026-10-15'), timezone: 'Asia/Riyadh', now }),
    ).toBe(4);
  });
});

describe('Best campaign: POOLED, and unavailable is never zero (D-341)', () => {
  it('pools totals across posts rather than averaging per-post rates', () => {
    // Per-post rates 50% and 1% would average to 25.5%; pooled it is 51/1100.
    const rates = pooledCampaignRates([
      { contentItemId: 'p1', campaignId: 'c', engagements: 50n, impressions: 100n },
      { contentItemId: 'p2', campaignId: 'c', engagements: 1n, impressions: 1000n },
    ]);
    expect(rates.get('c')).toMatchObject({ engagements: 51n, impressions: 1100n, posts: 2 });
    expect(rates.get('c')?.rateMilli).toBe(46n);
  });

  it('leaves a post without a rate out of BOTH the numerator and the denominator', () => {
    const rates = pooledCampaignRates([
      { contentItemId: 'p1', campaignId: 'c', engagements: 10n, impressions: 100n },
      { contentItemId: 'p2', campaignId: 'c', engagements: null, impressions: 100_000n },
      { contentItemId: 'p3', campaignId: 'c', engagements: 999n, impressions: null },
      { contentItemId: 'p4', campaignId: 'c', engagements: 7n, impressions: 0n },
    ]);
    expect(rates.get('c')).toMatchObject({ engagements: 10n, impressions: 100n, posts: 1 });
  });

  it('a campaign with no post that has a rate is absent, not 0%', () => {
    const rates = pooledCampaignRates([
      { contentItemId: 'p1', campaignId: 'c', engagements: null, impressions: 10n },
    ]);
    expect(rates.has('c')).toBe(false);
    expect(highestPooledRates(rates)).toEqual([]);
  });

  it('compares exact fractions, and returns every campaign sharing the top rate', () => {
    const rates = pooledCampaignRates([
      // 1/3 and 2/6 are equal; 333/1000 rounds to the same per mille but is lower.
      { contentItemId: 'p1', campaignId: 'a', engagements: 1n, impressions: 3n },
      { contentItemId: 'p2', campaignId: 'b', engagements: 2n, impressions: 6n },
      { contentItemId: 'p3', campaignId: 'c', engagements: 333n, impressions: 1000n },
    ]);
    expect(rates.get('a')?.rateMilli).toBe(rates.get('c')?.rateMilli);
    expect(
      highestPooledRates(rates)
        .map((rate) => rate.campaignId)
        .sort(),
    ).toEqual(['a', 'b']);
  });
});

describe('the write paths', () => {
  it('update() writes conditionally on the version it read', () => {
    const service = read('packages/content/src/campaigns.ts');
    expect(service).toContain('version: existing.version,');
    expect(service).toContain('if (written.count !== 1) throw campaignVersionConflict();');
  });

  it('"Start now" goes through update(), with reason start_now — no second start path', () => {
    const service = read('packages/content/src/campaigns.ts');
    const start = service.indexOf('async startNow(');
    const body = service.slice(start, service.indexOf('\n  }\n', start));
    expect(body).toContain('return this.update({');
    expect(body).toContain("status: 'ACTIVE',");
    expect(body).toContain("reason: 'start_now',");
    expect(body).not.toContain('campaign.update(');
  });

  it('the Campaigns list order is total, so a tie has one answer', () => {
    expect(read('packages/content/src/campaigns.ts')).toContain(
      "orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],",
    );
  });
});
