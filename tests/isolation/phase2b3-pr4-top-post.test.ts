import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeQueues } from '@brandspace/jobs';
import { OCCURRENCE_STALE } from '@brandspace/automation';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';
import {
  BATCH,
  deliver,
  disableCreatedRules,
  dueNow,
  eventsFor,
  newBrand,
  runsFor,
  schedulerAt,
  sweepAt,
  timedRule,
} from './timed-automation-fixtures';
import {
  DAY,
  publishedPost,
  restoreEventThresholds,
  setEventThresholds,
  tenantOf,
  type Tenant,
} from './analytics-event-fixtures';

/**
 * PHASE 2B-3 PR 4 — POST_TOP_10_PERCENT, AGAINST REAL POSTGRESQL.
 *
 * After the brand's analytics refresh, the real scheduler ranks the brand's
 * posts first published in the last N days (with enough impressions, and only
 * when there are enough of them) by pooled engagement rate; the top 10% —
 * nearest rank, ties included — fire once per rule and post, and only posts
 * first published at or after the rule's arming. The operator thresholds
 * here: N = 30 days, 100 impressions, a population of 10.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let a: Tenant;
let b: Tenant;

const T = new Date();
const HOUR = 3_600_000;
const ARMED = new Date(T.getTime() - 20 * DAY);
const THRESHOLDS = { topPost: { populationDays: 30, minImpressions: 100, minPopulation: 10 } };

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  a = tenantOf(fixtures, 'a');
  b = tenantOf(fixtures, 'b');
  await setEventThresholds(platform, THRESHOLDS);
}, 90_000);

afterAll(async () => {
  await disableCreatedRules(platform);
  await restoreEventThresholds(platform);
  await closeQueues();
  await app.$disconnect();
  await platform.$disconnect();
});

/** The brand's analytics refreshed at `at` — the outbox row ingestion writes. */
async function refreshed(tenant: Tenant, brandId: string, at: Date): Promise<void> {
  const id = randomUUID();
  await platform.automationEvent.create({
    data: {
      workspaceId: tenant.workspaceId,
      brandId,
      triggerType: 'ANALYTICS_REFRESHED',
      refType: 'AnalyticsIngestionRun',
      refId: id,
      dedupeKey: `ANALYTICS_REFRESHED:${id}`,
      createdAt: at,
      // Already delivered: nothing listens to it in these tests.
      dispatchedAt: at,
      deliveredAt: at,
    },
  });
}

/**
 * Ten posts published five days ago with rates 1% … 10%: the top 10% of ten
 * is exactly one, the 10% post. Returns the ids, lowest rate first.
 */
async function tenPosts(
  tenant: Tenant,
  brandId: string,
  publishedAt = new Date(T.getTime() - 5 * DAY),
) {
  const ids: string[] = [];
  for (let i = 1; i <= 10; i += 1) {
    ids.push(
      await publishedPost(platform, tenant, {
        brandId,
        publishedAt,
        engagements: i * 10,
        impressions: 1000,
      }),
    );
  }
  return ids;
}

async function setup(
  input: { armedAt?: Date; actionType?: 'NOTIFY_PERSON' | 'MAKE_DRAFT_COPY' } = {},
) {
  const brandId = await newBrand(platform, a.workspaceId);
  const ruleId = await timedRule(platform, {
    workspaceId: a.workspaceId,
    brandId,
    triggerType: 'POST_TOP_10_PERCENT',
    armedAt: input.armedAt ?? ARMED,
    createdByUserId: a.userId,
    actionType: input.actionType ?? 'NOTIFY_PERSON',
  });
  return { brandId, ruleId };
}

async function sweepOn(ruleId: string, when: Date) {
  await dueNow(platform, ruleId);
  await sweepAt(when);
}

describe('ranking after a refresh', () => {
  it('the top post fires once, naming the post; later refreshes do not repeat it', async () => {
    const { brandId, ruleId } = await setup();
    const ids = await tenPosts(a, brandId);
    await refreshed(a, brandId, new Date(T.getTime() - HOUR));
    await sweepOn(ruleId, T);

    const events = await eventsFor(platform, ruleId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      triggerType: 'POST_TOP_10_PERCENT',
      refType: 'ContentItem',
      refId: ids[9],
      ruleId,
      brandId,
      dedupeKey: `POST_TOP_10_PERCENT:${ruleId}:${ids[9]}`,
    });

    await sweepOn(ruleId, new Date(T.getTime() + HOUR));
    await refreshed(a, brandId, new Date(T.getTime() + HOUR));
    await sweepOn(ruleId, new Date(T.getTime() + 2 * HOUR));
    expect(await eventsFor(platform, ruleId)).toHaveLength(1);
  });

  it('no refresh since the cursor: nothing is ranked', async () => {
    const { brandId, ruleId } = await setup();
    await tenPosts(a, brandId);
    await refreshed(a, brandId, new Date(ARMED.getTime() - HOUR)); // before arming
    await sweepOn(ruleId, T);
    expect(await eventsFor(platform, ruleId)).toHaveLength(0);
  });

  it('a refresh inside the sweep lag waits for the next visit', async () => {
    const { brandId, ruleId } = await setup();
    await tenPosts(a, brandId);
    await refreshed(a, brandId, new Date(T.getTime() - 60_000));
    await sweepOn(ruleId, T);
    expect(await eventsFor(platform, ruleId)).toHaveLength(0);
    await sweepOn(ruleId, new Date(T.getTime() + 2 * 60_000));
    expect(await eventsFor(platform, ruleId)).toHaveLength(1);
  });

  it('every post tied at the cut-off fires', async () => {
    const { brandId, ruleId } = await setup();
    const ids = await tenPosts(a, brandId);
    // A second post at exactly the top rate: 100 / 1000.
    const tied = await publishedPost(platform, a, {
      brandId,
      publishedAt: new Date(T.getTime() - 4 * DAY),
      engagements: 50,
      impressions: 500,
    });
    await refreshed(a, brandId, new Date(T.getTime() - HOUR));
    await sweepOn(ruleId, T);
    // Eleven ranked → k = 2; both 10% posts, and nothing below them.
    expect((await eventsFor(platform, ruleId)).map((e) => e.refId).sort()).toEqual(
      [ids[9], tied].sort(),
    );
  });
});

describe('no backfill, and what is not ranked', () => {
  it('a top post first published before the rule was armed never fires', async () => {
    const { brandId, ruleId } = await setup({ armedAt: new Date(T.getTime() - 2 * DAY) });
    await tenPosts(a, brandId); // five days ago: before the arming
    await refreshed(a, brandId, new Date(T.getTime() - HOUR));
    await sweepOn(ruleId, T);
    expect(await eventsFor(platform, ruleId)).toHaveLength(0);
  });

  it('fewer ranked posts than the minimum population: nothing', async () => {
    const { brandId, ruleId } = await setup();
    const publishedAt = new Date(T.getTime() - 5 * DAY);
    for (let i = 1; i <= 9; i += 1) {
      await publishedPost(platform, a, { brandId, publishedAt, engagements: i, impressions: 1000 });
    }
    // Enough posts, but one has too few impressions to be ranked.
    await publishedPost(platform, a, { brandId, publishedAt, engagements: 90, impressions: 99 });
    await refreshed(a, brandId, new Date(T.getTime() - HOUR));
    await sweepOn(ruleId, T);
    expect(await eventsFor(platform, ruleId)).toHaveLength(0);
  });

  it('unconfigured: nothing is ranked', async () => {
    const { brandId, ruleId } = await setup();
    await tenPosts(a, brandId);
    await refreshed(a, brandId, new Date(T.getTime() - HOUR));
    await setEventThresholds(platform, { topPost: { populationDays: 30, minImpressions: 100 } });
    try {
      await sweepOn(ruleId, T);
      expect(await eventsFor(platform, ruleId)).toHaveLength(0);
    } finally {
      await setEventThresholds(platform, THRESHOLDS);
    }
  });
});

describe('bounded work: 25 a visit, and nothing dropped', () => {
  it('thirty tied top posts: 25 on the first visit, the other 5 on the next', async () => {
    const { brandId, ruleId } = await setup();
    const publishedAt = new Date(T.getTime() - 3 * DAY);
    for (let i = 0; i < 30; i += 1) {
      await publishedPost(platform, a, { brandId, publishedAt, engagements: 10, impressions: 100 });
    }
    await refreshed(a, brandId, new Date(T.getTime() - HOUR));
    await sweepOn(ruleId, T);
    expect(await eventsFor(platform, ruleId)).toHaveLength(25);
    const parked = await platform.automationRule.findUniqueOrThrow({
      where: { id: ruleId },
      select: { nextEvaluationAt: true },
    });
    expect(parked.nextEvaluationAt.getTime()).toBeLessThanOrEqual(T.getTime());
    await sweepAt(new Date(T.getTime() + 30_000));
    const keys = (await eventsFor(platform, ruleId)).map((e) => e.dedupeKey);
    expect(keys).toHaveLength(30);
    expect(new Set(keys).size).toBe(30);
  }, 90_000);
});

describe('delivery re-checks the post', () => {
  it('still live: the rule runs — a draft copy of the top post is made', async () => {
    const { brandId, ruleId } = await setup({ actionType: 'MAKE_DRAFT_COPY' });
    const ids = await tenPosts(a, brandId);
    await refreshed(a, brandId, new Date(T.getTime() - HOUR));
    await sweepOn(ruleId, T);
    const [event] = await eventsFor(platform, ruleId);
    await deliver(event!);
    const runs = await runsFor(platform, ruleId);
    expect(runs).toMatchObject([{ status: 'SUCCEEDED', failureCode: null, triggerRefId: ids[9] }]);
  });

  it('archived before delivery: SKIPPED occurrence_stale', async () => {
    const { brandId, ruleId } = await setup();
    const ids = await tenPosts(a, brandId);
    await refreshed(a, brandId, new Date(T.getTime() - HOUR));
    await sweepOn(ruleId, T);
    const [event] = await eventsFor(platform, ruleId);
    await platform.contentItem.update({ where: { id: ids[9]! }, data: { status: 'ARCHIVED' } });
    await deliver(event!);
    expect(await runsFor(platform, ruleId)).toMatchObject([
      { status: 'SKIPPED', failureCode: OCCURRENCE_STALE },
    ]);
  });
});

describe('isolation and concurrency', () => {
  it('another brand’s or workspace’s posts and refreshes never reach this rule', async () => {
    const { brandId, ruleId } = await setup();
    const other = await newBrand(platform, a.workspaceId);
    await tenPosts(a, other);
    await refreshed(a, other, new Date(T.getTime() - HOUR));
    const foreign = await newBrand(platform, b.workspaceId);
    await tenPosts(b, foreign);
    await refreshed(b, foreign, new Date(T.getTime() - HOUR));
    // This brand refreshed too, but has no posts of its own.
    await refreshed(a, brandId, new Date(T.getTime() - HOUR));
    await sweepOn(ruleId, T);
    expect(await eventsFor(platform, ruleId)).toHaveLength(0);
  });

  it('two schedulers at once: the top post fires once', async () => {
    const { brandId, ruleId } = await setup();
    await tenPosts(a, brandId);
    await refreshed(a, brandId, new Date(T.getTime() - HOUR));
    await dueNow(platform, ruleId);
    await Promise.all([
      schedulerAt(T).sweepAutomations(BATCH),
      schedulerAt(T).sweepAutomations(BATCH),
    ]);
    expect(await eventsFor(platform, ruleId)).toHaveLength(1);
  });
});
