import type { PrismaClient } from '@prisma/client';
import { withWorkspace } from '@brandspace/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BEST_TIME_MIN_POSTS,
  bestTimes,
  readPublishedFigures,
} from '../../apps/dashboard/src/server/best-time';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';
import { publishedPost, tenantOf } from './analytics-event-fixtures';

/**
 * BATCH 7 PR C, popover item 3 — THE BEST-TIME QUERY, AGAINST REAL POSTGRESQL.
 *
 *   - real provider figures (`sourceKind = PROVIDER`) count;
 *   - the development connectors' figures (`MOCK`) never do, however many;
 *   - another workspace's posts are never read, through RLS and the
 *     workspace predicate alike.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
const NOW = new Date();
const ZONE = 'UTC';
const itemIds: string[] = [];

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  // Twelve LinkedIn posts in workspace A: four each at 09:00, 13:00 and 18:00 UTC.
  for (const daysAgo of [2, 3, 4, 5]) {
    for (const [hour, engagements] of [
      [9, 100],
      [13, 50],
      [18, 300],
    ] as const) {
      const at = new Date(NOW.getTime() - daysAgo * 86_400_000);
      at.setUTCHours(hour, 0, 0, 0);
      itemIds.push(
        await publishedPost(platform, tenantOf(fixtures, 'a'), {
          brandId: fixtures.a.brandId,
          publishedAt: at,
          engagements,
          impressions: engagements * 10,
        }),
      );
    }
  }
}, 120_000);

afterAll(async () => {
  await app.$disconnect();
  await platform.$disconnect();
});

function figuresAs(side: 'a' | 'b', workspaceId: string, brandId: string) {
  return withWorkspace(
    fixtures[side].workspaceId,
    (db) => readPublishedFigures(db, { workspaceId, brandId, channels: ['LINKEDIN'], now: NOW }),
    { prisma: app },
  );
}

describe('best time — the query', () => {
  it('reads the brand’s real figures, one per post and channel', async () => {
    const figures = await figuresAs('a', fixtures.a.workspaceId, fixtures.a.brandId);
    expect(figures).toHaveLength(BEST_TIME_MIN_POSTS);
    const shown = bestTimes({
      channels: ['LINKEDIN'],
      posts: figures,
      timeZone: ZONE,
      now: NOW,
      minLeadMinutes: 15,
      maxDaysAhead: 90,
    });
    expect(shown?.slots.map((slot) => [slot.time, slot.top])).toEqual([
      ['09:00', false],
      ['13:00', false],
      ['18:00', true],
    ]);
  });

  it('never reads another workspace’s posts', async () => {
    // B asking for A's brand by id: RLS returns nothing.
    expect(await figuresAs('b', fixtures.a.workspaceId, fixtures.a.brandId)).toEqual([]);
    // B asking for its own: it has none.
    expect(await figuresAs('b', fixtures.b.workspaceId, fixtures.b.brandId)).toEqual([]);
  });

  it('never counts the development connectors’ figures', async () => {
    await platform.metricObservation.updateMany({
      where: { contentItemId: { in: itemIds } },
      data: { sourceKind: 'MOCK' },
    });
    try {
      const figures = await figuresAs('a', fixtures.a.workspaceId, fixtures.a.brandId);
      expect(figures).toEqual([]);
      expect(
        bestTimes({
          channels: ['LINKEDIN'],
          posts: figures,
          timeZone: ZONE,
          now: NOW,
          minLeadMinutes: 15,
          maxDaysAhead: 90,
        }),
      ).toBeNull();
    } finally {
      await platform.metricObservation.updateMany({
        where: { contentItemId: { in: itemIds } },
        data: { sourceKind: 'PROVIDER' },
      });
    }
  });
});
