import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import {
  brandTopPostPopulation,
  brandWeeklyEngagement,
  topShareOf,
  weeklyEngagementWindows,
} from '@brandspace/automation';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';
import {
  DAY,
  engagementsOver,
  publishJob,
  publishedPost,
  reading,
  tenantOf,
  utcDay,
  type Tenant,
} from './analytics-event-fixtures';

/**
 * PHASE 2B-3 PR 4 — THE ANALYTICS EVENTS' ONE READ PER BRAND, AGAINST REAL
 * POSTGRESQL, THROUGH THE TENANT'S OWN RLS CLIENT.
 *
 * What counts is exactly report §30: DAY readings of POST subjects, the
 * `engagements` (and, for the ranking, `impressions`) metric, the brand's own
 * rows, the settled UTC weeks; a population of posts FIRST published in the
 * window, live, with enough impressions.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let a: Tenant;
let b: Tenant;
const NOW = new Date('2026-10-20T12:00:00.000Z');

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  a = tenantOf(fixtures, 'a');
  b = tenantOf(fixtures, 'b');
}, 90_000);

afterAll(async () => {
  await app.$disconnect();
  await platform.$disconnect();
});

const inTenant = <T>(tenant: Tenant, fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(tenant.workspaceId, fn as never, { prisma: app }) as Promise<T>;

async function newBrand(tenant: Tenant): Promise<string> {
  const row = await platform.brand.create({
    data: {
      workspaceId: tenant.workspaceId,
      slug: `pr4-${randomUUID().slice(0, 10)}`,
      name: 'PR 4 brand',
      status: 'ACTIVE',
    },
    select: { id: true },
  });
  return row.id;
}

describe('a brand’s weekly engagements', () => {
  const windows = weeklyEngagementWindows(NOW, 3);

  it('sums DAY engagements of POST subjects in each settled week, and nothing else', async () => {
    const brandId = await newBrand(a);
    await engagementsOver(platform, a, {
      brandId,
      start: windows.prior.start,
      days: 7,
      total: 700,
    });
    await engagementsOver(platform, a, {
      brandId,
      start: windows.current.start,
      days: 7,
      total: 350,
    });
    const noise = { brandId, subject: `noise-${randomUUID()}` };
    const inside = windows.current.start;
    // None of these counts: another granularity, an account subject, another
    // metric, the day the week ends (exclusive), unsettled days.
    await reading(platform, a, {
      ...noise,
      metricKey: 'engagements',
      day: inside,
      value: 10_000,
      granularity: 'HOUR',
    });
    await reading(platform, a, {
      ...noise,
      metricKey: 'engagements',
      day: inside,
      value: 10_000,
      granularity: 'WEEK',
    });
    await reading(platform, a, {
      ...noise,
      metricKey: 'engagements',
      day: inside,
      value: 10_000,
      subjectType: 'ACCOUNT',
    });
    await reading(platform, a, { ...noise, metricKey: 'likes', day: inside, value: 10_000 });
    await reading(platform, a, {
      ...noise,
      metricKey: 'engagements',
      day: windows.current.end,
      value: 10_000,
    });
    await reading(platform, a, {
      ...noise,
      metricKey: 'engagements',
      day: utcDay(NOW, 0),
      value: 10_000,
    });

    const totals = await inTenant(a, (db) =>
      brandWeeklyEngagement(db, { workspaceId: a.workspaceId, brandId, windows }),
    );
    expect(totals).toEqual({ prior: 700n, current: 350n });
  });

  it('another brand’s and another workspace’s readings never count', async () => {
    const brandId = await newBrand(a);
    const otherBrand = await newBrand(a);
    const foreignBrand = await newBrand(b);
    await engagementsOver(platform, a, {
      brandId: otherBrand,
      start: windows.prior.start,
      days: 7,
      total: 500,
    });
    await engagementsOver(platform, b, {
      brandId: foreignBrand,
      start: windows.prior.start,
      days: 7,
      total: 500,
    });
    const totals = await inTenant(a, (db) =>
      brandWeeklyEngagement(db, { workspaceId: a.workspaceId, brandId, windows }),
    );
    expect(totals).toEqual({ prior: 0n, current: 0n });
    // And through A's client, B's brand has nothing at all to read.
    const foreign = await inTenant(a, (db) =>
      brandWeeklyEngagement(db, { workspaceId: b.workspaceId, brandId: foreignBrand, windows }),
    );
    expect(foreign).toEqual({ prior: 0n, current: 0n });
  });
});

describe('a brand’s top-post population', () => {
  const since = new Date(NOW.getTime() - 30 * DAY);
  const population = (brandId: string, minImpressions = 100, minPopulation = 1) =>
    inTenant(a, (db) =>
      brandTopPostPopulation(db, {
        workspaceId: a.workspaceId,
        brandId,
        since,
        minImpressions,
        minPopulation,
      }),
    );

  it('posts first published in the window, live, with enough impressions; sums every DAY reading', async () => {
    const brandId = await newBrand(a);
    const inWindow = new Date(NOW.getTime() - 5 * DAY);
    const kept = await publishedPost(platform, a, {
      brandId,
      publishedAt: inWindow,
      engagements: 30,
      impressions: 300,
    });
    // A second reading on another day is pooled into the same post.
    await reading(platform, a, {
      brandId,
      subject: `extra-${randomUUID()}`,
      contentItemId: kept,
      metricKey: 'impressions',
      day: utcDay(inWindow, 1),
      value: 200,
    });
    // Excluded: too few impressions; published before the window; first
    // published before the window and again inside it; archived; deleted.
    await publishedPost(platform, a, {
      brandId,
      publishedAt: inWindow,
      engagements: 50,
      impressions: 99,
    });
    await publishedPost(platform, a, {
      brandId,
      publishedAt: new Date(since.getTime() - DAY),
      engagements: 90,
      impressions: 100,
    });
    const republished = await publishedPost(platform, a, {
      brandId,
      publishedAt: new Date(since.getTime() - DAY),
      engagements: 90,
      impressions: 100,
    });
    await publishJob(platform, a, { brandId, contentItemId: republished, publishedAt: inWindow });
    await publishedPost(platform, a, {
      brandId,
      publishedAt: inWindow,
      engagements: 90,
      impressions: 100,
      status: 'ARCHIVED',
    });
    await publishedPost(platform, a, {
      brandId,
      publishedAt: inWindow,
      engagements: 90,
      impressions: 100,
      deleted: true,
    });

    const ranked = await population(brandId);
    expect(ranked).toEqual([
      { id: kept, engagements: 30n, impressions: 500n, firstPublishedAt: inWindow },
    ]);
  });

  it('fewer ranked posts than the minimum population judges nothing', async () => {
    const brandId = await newBrand(a);
    const inWindow = new Date(NOW.getTime() - 3 * DAY);
    for (let i = 0; i < 3; i += 1) {
      await publishedPost(platform, a, {
        brandId,
        publishedAt: inWindow,
        engagements: i + 1,
        impressions: 100,
      });
    }
    expect(await population(brandId, 100, 4)).toBeNull();
    const three = await population(brandId, 100, 3);
    expect(three).toHaveLength(3);
    expect(topShareOf(three!)).toHaveLength(1);
  });

  it('another brand’s posts never enter the population', async () => {
    const brandId = await newBrand(a);
    const other = await newBrand(a);
    await publishedPost(platform, a, {
      brandId: other,
      publishedAt: new Date(NOW.getTime() - DAY),
      engagements: 5,
      impressions: 100,
    });
    expect(await population(brandId)).toBeNull();
  });
});
