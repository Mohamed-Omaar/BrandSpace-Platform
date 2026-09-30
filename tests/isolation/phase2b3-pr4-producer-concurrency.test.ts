import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { closeQueues } from '@brandspace/jobs';
import { instantForIntent } from '@brandspace/content';
import {
  produceTopPost,
  produceWeeklyEngagementDropped,
  weeklyEngagementWindows,
  type DueProducerContext,
} from '@brandspace/automation';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';
import {
  BATCH,
  disableCreatedRules,
  dueNow,
  eventsFor,
  newBrand,
  schedulerAt,
  sweepAt,
  timedRule,
} from './timed-automation-fixtures';
import {
  DAY,
  publishedPost,
  reading,
  restoreEventThresholds,
  setEventThresholds,
  tenantOf,
  type Tenant,
} from './analytics-event-fixtures';

/**
 * PHASE 2B-3 PR 4 — THE ANALYTICS PRODUCERS UNDER RESTART, OUTAGE AND TWO
 * TENANTS AT ONCE, with the real scheduler and real PostgreSQL.
 *
 * Each trigger's own suite already proves two schedulers at once produce one
 * event; this one proves an interrupted visit leaves nothing behind and loses
 * nothing, an outage is not replayed, and two workspaces swept together each
 * produce only from their own brand.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let a: Tenant;
let b: Tenant;

const T = new Date(new Date().toISOString().slice(0, 10) + 'T12:00:00.000Z');
const HOUR = 3_600_000;
const ARMED = new Date(T.getTime() - 40 * DAY);
const E = weeklyEngagementWindows(T, 3).settledEnd;
const at = (k: number) => new Date(E.getTime() - k * DAY);
const dayAfter = (days: number) => new Date(T.getTime() + days * DAY);
const THRESHOLDS = {
  weeklyEngagementDrop: { minBaseline: 100 },
  topPost: { populationDays: 30, minImpressions: 100, minPopulation: 10 },
};

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

const inTenant = <R>(tenant: Tenant, fn: (db: TenantScopedClient) => Promise<R>) =>
  withWorkspace(tenant.workspaceId, fn as never, { prisma: app }) as Promise<R>;

/** Normal on day T, dropped from day T + 1 (see the weekly-drop suite). */
async function swing(tenant: Tenant, brandId: string) {
  const subject = `acct-${randomUUID().slice(0, 8)}`;
  for (let k = 1; k <= 14; k += 1) {
    await reading(platform, tenant, {
      brandId,
      subject,
      metricKey: 'engagements',
      day: at(k),
      value: k === 7 ? 1000 : 100,
    });
  }
}

async function tenPosts(tenant: Tenant, brandId: string) {
  const ids: string[] = [];
  for (let i = 1; i <= 10; i += 1) {
    ids.push(
      await publishedPost(platform, tenant, {
        brandId,
        publishedAt: new Date(T.getTime() - 5 * DAY),
        engagements: i * 10,
        impressions: 1000,
      }),
    );
  }
  return ids;
}

async function refreshed(tenant: Tenant, brandId: string, when: Date) {
  const id = randomUUID();
  await platform.automationEvent.create({
    data: {
      workspaceId: tenant.workspaceId,
      brandId,
      triggerType: 'ANALYTICS_REFRESHED',
      refType: 'AnalyticsIngestionRun',
      refId: id,
      dedupeKey: `ANALYTICS_REFRESHED:${id}`,
      createdAt: when,
      dispatchedAt: when,
      deliveredAt: when,
    },
  });
}

async function rule(
  tenant: Tenant,
  brandId: string,
  triggerType: 'WEEKLY_ENGAGEMENT_DROPPED' | 'POST_TOP_10_PERCENT',
) {
  return timedRule(platform, {
    workspaceId: tenant.workspaceId,
    brandId,
    triggerType,
    armedAt: ARMED,
    createdByUserId: tenant.userId,
  });
}

/** One visit run by hand inside the tenant's transaction, then the process "dies". */
async function interruptedVisit(
  tenant: Tenant,
  ruleId: string,
  when: Date,
  produce: (context: DueProducerContext) => Promise<{ produced: number }>,
): Promise<number> {
  class Crash extends Error {}
  let produced = -1;
  await expect(
    inTenant(tenant, async (db) => {
      const live = await db.automationRule.findFirstOrThrow({
        where: { id: ruleId },
        select: {
          id: true,
          brandId: true,
          armedAt: true,
          dueWatermark: true,
          thresholdBreached: true,
          thresholdCycle: true,
          thresholdEvaluatedAt: true,
        },
      });
      const visit = await produce({
        db,
        workspaceId: tenant.workspaceId,
        rule: live,
        now: when,
        timezone: 'UTC',
        calendar: { localMidnight: (day, zone) => instantForIntent(`${day}T00:00`, zone) },
        analytics: { events: THRESHOLDS, refreshWindowDays: 3, shared: new Map() },
      });
      produced = visit.produced;
      throw new Crash('the process died before the commit');
    }),
  ).rejects.toBeInstanceOf(Crash);
  return produced;
}

describe('an interrupted visit', () => {
  it('weekly drop: the fire and the memory roll back together, and the next sweep fires', async () => {
    const brandId = await newBrand(platform, a.workspaceId);
    await swing(a, brandId);
    const ruleId = await rule(a, brandId, 'WEEKLY_ENGAGEMENT_DROPPED');
    await dueNow(platform, ruleId);
    await sweepAt(T); // establishes "normal"
    const before = await platform.automationRule.findUniqueOrThrow({ where: { id: ruleId } });

    expect(await interruptedVisit(a, ruleId, dayAfter(1), produceWeeklyEngagementDropped)).toBe(1);
    expect(await eventsFor(platform, ruleId)).toHaveLength(0);
    const after = await platform.automationRule.findUniqueOrThrow({ where: { id: ruleId } });
    expect({
      breached: after.thresholdBreached,
      cycle: after.thresholdCycle,
      watermark: after.dueWatermark,
    }).toEqual({
      breached: before.thresholdBreached,
      cycle: before.thresholdCycle,
      watermark: before.dueWatermark,
    });

    await dueNow(platform, ruleId);
    await sweepAt(dayAfter(1));
    expect(await eventsFor(platform, ruleId)).toHaveLength(1);
  });

  it('top post: the events and the cursor roll back together, and the next sweep produces them', async () => {
    const brandId = await newBrand(platform, a.workspaceId);
    await tenPosts(a, brandId);
    await refreshed(a, brandId, new Date(T.getTime() - HOUR));
    const ruleId = await rule(a, brandId, 'POST_TOP_10_PERCENT');

    expect(await interruptedVisit(a, ruleId, T, produceTopPost)).toBe(1);
    expect(await eventsFor(platform, ruleId)).toHaveLength(0);
    const after = await platform.automationRule.findUniqueOrThrow({ where: { id: ruleId } });
    expect(after.dueWatermark).toBeNull();

    await dueNow(platform, ruleId);
    await sweepAt(T);
    expect(await eventsFor(platform, ruleId)).toHaveLength(1);
  });
});

describe('after an outage', () => {
  it('weekly drop: ten unswept days are one judgement of the week as it stands', async () => {
    const brandId = await newBrand(platform, a.workspaceId);
    await swing(a, brandId);
    const ruleId = await rule(a, brandId, 'WEEKLY_ENGAGEMENT_DROPPED');
    await dueNow(platform, ruleId);
    await sweepAt(T); // establishes
    // Nothing runs for ten days; then one sweep.
    await dueNow(platform, ruleId);
    await sweepAt(dayAfter(10));
    // The week as it stands: nothing current, the last four readings prior —
    // one drop, not one per missed day.
    expect(await eventsFor(platform, ruleId)).toHaveLength(1);
    await dueNow(platform, ruleId);
    await sweepAt(new Date(dayAfter(10).getTime() + HOUR));
    expect(await eventsFor(platform, ruleId)).toHaveLength(1);
  });

  it('top post: several refreshes during the outage rank the brand once', async () => {
    const brandId = await newBrand(platform, a.workspaceId);
    await tenPosts(a, brandId);
    for (const hours of [30, 20, 10, 2]) {
      await refreshed(a, brandId, new Date(T.getTime() - hours * HOUR));
    }
    const ruleId = await rule(a, brandId, 'POST_TOP_10_PERCENT');
    await dueNow(platform, ruleId);
    await sweepAt(T);
    expect(await eventsFor(platform, ruleId)).toHaveLength(1);
    const cursor = await platform.automationRule.findUniqueOrThrow({
      where: { id: ruleId },
      select: { dueWatermark: true },
    });
    // The cursor jumped to the newest refresh: the older ones are never re-ranked.
    expect(cursor.dueWatermark).toEqual(new Date(T.getTime() - 2 * HOUR));
  });
});

describe('two workspaces swept together', () => {
  it('each rule produces only from its own brand, for both analytics triggers', async () => {
    const brandA = await newBrand(platform, a.workspaceId);
    const brandB = await newBrand(platform, b.workspaceId);
    await swing(a, brandA);
    await swing(b, brandB);
    const topA = await tenPosts(a, brandA);
    const topB = await tenPosts(b, brandB);
    await refreshed(a, brandA, new Date(T.getTime() - HOUR));
    await refreshed(b, brandB, new Date(T.getTime() - HOUR));
    const rules = {
      weeklyA: await rule(a, brandA, 'WEEKLY_ENGAGEMENT_DROPPED'),
      weeklyB: await rule(b, brandB, 'WEEKLY_ENGAGEMENT_DROPPED'),
      topA: await rule(a, brandA, 'POST_TOP_10_PERCENT'),
      topB: await rule(b, brandB, 'POST_TOP_10_PERCENT'),
    };
    for (const id of Object.values(rules)) await dueNow(platform, id);
    await Promise.all([
      schedulerAt(T).sweepAutomations(BATCH),
      schedulerAt(T).sweepAutomations(BATCH),
    ]);
    for (const id of Object.values(rules)) await dueNow(platform, id);
    await Promise.all([
      schedulerAt(dayAfter(1)).sweepAutomations(BATCH),
      schedulerAt(dayAfter(1)).sweepAutomations(BATCH),
    ]);

    for (const [key, workspaceId, brandId] of [
      ['weeklyA', a.workspaceId, brandA],
      ['weeklyB', b.workspaceId, brandB],
      ['topA', a.workspaceId, brandA],
      ['topB', b.workspaceId, brandB],
    ] as const) {
      const events = await eventsFor(platform, rules[key]);
      expect(events, key).toHaveLength(1);
      expect(events[0]).toMatchObject({ workspaceId, brandId });
    }
    expect((await eventsFor(platform, rules.topA))[0]?.refId).toBe(topA[9]);
    expect((await eventsFor(platform, rules.topB))[0]?.refId).toBe(topB[9]);
  }, 90_000);
});
