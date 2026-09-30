import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeQueues } from '@brandspace/jobs';
import { OCCURRENCE_STALE, weeklyEngagementWindows } from '@brandspace/automation';
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
  reading,
  restoreEventThresholds,
  setEventThresholds,
  tenantOf,
  type Tenant,
} from './analytics-event-fixtures';

/**
 * PHASE 2B-3 PR 4 — WEEKLY_ENGAGEMENT_DROPPED, AGAINST REAL POSTGRESQL.
 *
 * The brand's last settled UTC week at least 20% below the week before, judged
 * once per settled day by the real scheduler sweep, edge-triggered on the rule's
 * memory: the first judgement after arming establishes; normal → dropped fires
 * once; still dropped is steady; recovery re-arms. A prior week below the
 * configured baseline is not judged.
 *
 * THE READINGS ARE LAID OUT BY SETTLED DAY. With E = the settled end on day T
 * (T − refreshWindowDays, UTC), `at(k)` is the UTC day k days before E. One
 * large day at k = 7 sits in the CURRENT week on day T (normal: a rise) and in
 * the PRIOR week on day T + 1 (a drop), so moving the sweep clock by one day
 * moves the brand from normal to dropped without touching a row.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let a: Tenant;
let b: Tenant;

// Noon UTC today: the delivery gate compares `armedAt` with real outbox times.
const T = new Date(new Date().toISOString().slice(0, 10) + 'T12:00:00.000Z');
const REFRESH_DAYS = 3; // analytics' default settling window
const E = weeklyEngagementWindows(T, REFRESH_DAYS).settledEnd;
const at = (k: number) => new Date(E.getTime() - k * DAY);
const dayAfter = (days: number) => new Date(T.getTime() + days * DAY);
const ARMED = new Date(T.getTime() - 40 * DAY);

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  a = tenantOf(fixtures, 'a');
  b = tenantOf(fixtures, 'b');
  await setEventThresholds(platform, { weeklyEngagementDrop: { minBaseline: 100 } });
}, 90_000);

afterAll(async () => {
  await disableCreatedRules(platform);
  await restoreEventThresholds(platform);
  await closeQueues();
  await app.$disconnect();
  await platform.$disconnect();
});

/** The brand's engagements: `values[k]` on day at(k). */
async function series(tenant: Tenant, brandId: string, values: Record<number, number>) {
  const subject = `acct-${randomUUID().slice(0, 8)}`;
  for (const [k, value] of Object.entries(values)) {
    await reading(platform, tenant, {
      brandId,
      subject,
      metricKey: 'engagements',
      day: at(Number(k)),
      value,
    });
  }
}

/** 100 a day for k = 1..14, and 1000 on k = 7: normal on T, dropped on T + 1. */
const SWING: Record<number, number> = Object.fromEntries(
  Array.from({ length: 14 }, (_, i) => [i + 1, i + 1 === 7 ? 1000 : 100]),
);

async function setup(tenant: Tenant = a) {
  const brandId = await newBrand(platform, tenant.workspaceId);
  const ruleId = await timedRule(platform, {
    workspaceId: tenant.workspaceId,
    brandId,
    triggerType: 'WEEKLY_ENGAGEMENT_DROPPED',
    armedAt: ARMED,
    createdByUserId: tenant.userId,
  });
  return { brandId, ruleId };
}

async function state(ruleId: string) {
  return platform.automationRule.findUniqueOrThrow({
    where: { id: ruleId },
    select: {
      thresholdBreached: true,
      thresholdCycle: true,
      thresholdEvaluatedAt: true,
      dueWatermark: true,
    },
  });
}

async function sweepOn(ruleId: string, when: Date) {
  await dueNow(platform, ruleId);
  await sweepAt(when);
}

describe('the edge, day by day', () => {
  it('establishes, fires on the drop, stays steady, re-arms on recovery, fires again', async () => {
    const { brandId, ruleId } = await setup();
    await series(a, brandId, SWING);
    const before = await state(ruleId);

    // Day T: a rise. The first judgement only establishes.
    await sweepOn(ruleId, T);
    expect(await eventsFor(platform, ruleId)).toHaveLength(0);
    const established = await state(ruleId);
    expect(established).toMatchObject({
      thresholdBreached: false,
      thresholdCycle: before.thresholdCycle + 1,
      dueWatermark: E,
    });

    // Day T + 1: the big day moved into the prior week — a drop. Fires once.
    await sweepOn(ruleId, dayAfter(1));
    const fired = await eventsFor(platform, ruleId);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      triggerType: 'WEEKLY_ENGAGEMENT_DROPPED',
      refType: null,
      refId: null,
      ruleId,
      brandId,
      dedupeKey: `WEEKLY_ENGAGEMENT_DROPPED:${ruleId}:${established.thresholdCycle}`,
    });

    // The same day again, and a second scheduler: nothing more.
    await sweepOn(ruleId, new Date(dayAfter(1).getTime() + 3_600_000));
    // Day T + 2: still dropped — steady.
    await sweepOn(ruleId, dayAfter(2));
    expect(await eventsFor(platform, ruleId)).toHaveLength(1);

    // Recovery: two strong days settle into the current week.
    await series(a, brandId, { [-1]: 2000, [-2]: 2000 });
    await sweepOn(ruleId, dayAfter(3));
    const recovered = await state(ruleId);
    expect(recovered.thresholdBreached).toBe(false);
    expect(recovered.thresholdCycle).toBe(established.thresholdCycle + 1);
    expect(await eventsFor(platform, ruleId)).toHaveLength(1);

    // A second drop is a new episode, under a new key: nothing settles for a
    // while, so the week after the strong days falls away.
    await sweepOn(ruleId, dayAfter(10));
    const keys = (await eventsFor(platform, ruleId)).map((event) => event.dedupeKey);
    expect(keys).toEqual([
      `WEEKLY_ENGAGEMENT_DROPPED:${ruleId}:${established.thresholdCycle}`,
      `WEEKLY_ENGAGEMENT_DROPPED:${ruleId}:${recovered.thresholdCycle}`,
    ]);
    // Seven full sweeps of the real scheduler: a budget of its own.
  }, 90_000);

  it('a settled day is judged once: a second visit the same day reads nothing new', async () => {
    const { brandId, ruleId } = await setup();
    await series(a, brandId, SWING);
    await sweepOn(ruleId, T);
    const first = await state(ruleId);
    // Change the settled week under it: the day is already judged.
    await series(a, brandId, { 3: 5000 });
    await sweepOn(ruleId, new Date(T.getTime() + 2 * 3_600_000));
    expect(await state(ruleId)).toEqual(first);
  });
});

describe('what is not judged', () => {
  it('a prior week below the baseline: nothing decided, the memory untouched', async () => {
    const { brandId, ruleId } = await setup();
    // A 90% fall, but the prior week holds only 70 engagements.
    await series(a, brandId, Object.fromEntries(Array.from({ length: 7 }, (_, i) => [i + 8, 10])));
    await sweepOn(ruleId, T);
    await sweepOn(ruleId, dayAfter(1));
    expect(await eventsFor(platform, ruleId)).toHaveLength(0);
    expect((await state(ruleId)).thresholdBreached).toBeNull();
  });

  it('unconfigured: the event is not evaluated at all', async () => {
    const { brandId, ruleId } = await setup();
    await series(a, brandId, SWING);
    await setEventThresholds(platform, {});
    try {
      await sweepOn(ruleId, T);
      await sweepOn(ruleId, dayAfter(1));
      expect(await eventsFor(platform, ruleId)).toHaveLength(0);
      expect(await state(ruleId)).toMatchObject({
        thresholdEvaluatedAt: null,
        dueWatermark: null,
      });
    } finally {
      await setEventThresholds(platform, { weeklyEngagementDrop: { minBaseline: 100 } });
    }
  });

  it('memory from before the current arming counts as none: the first judgement after re-arming establishes', async () => {
    const { brandId, ruleId } = await setup();
    await series(a, brandId, SWING);
    await sweepOn(ruleId, T); // established normal
    await platform.automationRule.update({
      where: { id: ruleId },
      data: { armedAt: new Date(T.getTime() + 3_600_000) },
    });
    await sweepOn(ruleId, dayAfter(1)); // a drop, but only established after re-arming
    expect(await eventsFor(platform, ruleId)).toHaveLength(0);
    expect((await state(ruleId)).thresholdBreached).toBe(true);
  });
});

describe('delivery re-checks the episode', () => {
  it('still dropped: the rule runs; recovered before delivery: SKIPPED occurrence_stale', async () => {
    const { brandId, ruleId } = await setup();
    await series(a, brandId, SWING);
    await sweepOn(ruleId, T);
    await sweepOn(ruleId, dayAfter(1));
    const [event] = await eventsFor(platform, ruleId);
    await deliver(event!);
    expect(await runsFor(platform, ruleId)).toMatchObject([
      { status: 'SUCCEEDED', failureCode: null },
    ]);

    const { brandId: brand2, ruleId: rule2 } = await setup();
    await series(a, brand2, SWING);
    await sweepOn(rule2, T);
    await sweepOn(rule2, dayAfter(1));
    const [late] = await eventsFor(platform, rule2);
    await series(a, brand2, { [-1]: 2000, [-2]: 2000 });
    await sweepOn(rule2, dayAfter(3)); // recovered: the cycle moved on
    await deliver(late!);
    expect(await runsFor(platform, rule2)).toMatchObject([
      { status: 'SKIPPED', failureCode: OCCURRENCE_STALE },
    ]);
  });
});

describe('isolation and concurrency', () => {
  it('another brand’s or workspace’s drop never reaches this rule', async () => {
    const { ruleId } = await setup();
    await series(a, await newBrand(platform, a.workspaceId), SWING);
    await series(b, await newBrand(platform, b.workspaceId), SWING);
    await sweepOn(ruleId, T);
    await sweepOn(ruleId, dayAfter(1));
    expect(await eventsFor(platform, ruleId)).toHaveLength(0);
    // Nothing to judge: no engagements at all is below any baseline.
    expect((await state(ruleId)).thresholdBreached).toBeNull();
  });

  it('two rules of one brand each fire once; two schedulers at once add nothing', async () => {
    const brandId = await newBrand(platform, a.workspaceId);
    await series(a, brandId, SWING);
    const rules = [
      await timedRule(platform, {
        workspaceId: a.workspaceId,
        brandId,
        triggerType: 'WEEKLY_ENGAGEMENT_DROPPED',
        armedAt: ARMED,
        createdByUserId: a.userId,
      }),
      await timedRule(platform, {
        workspaceId: a.workspaceId,
        brandId,
        triggerType: 'WEEKLY_ENGAGEMENT_DROPPED',
        armedAt: ARMED,
        createdByUserId: a.userId,
      }),
    ];
    for (const ruleId of rules) await dueNow(platform, ruleId);
    await sweepAt(T);
    for (const ruleId of rules) await dueNow(platform, ruleId);
    await Promise.all([
      schedulerAt(dayAfter(1)).sweepAutomations(BATCH),
      schedulerAt(dayAfter(1)).sweepAutomations(BATCH),
    ]);
    for (const ruleId of rules) {
      expect(await eventsFor(platform, ruleId), ruleId).toHaveLength(1);
    }
  });

  it('a switched-off rule produces nothing', async () => {
    const { brandId, ruleId } = await setup();
    await series(a, brandId, SWING);
    await platform.automationRule.update({ where: { id: ruleId }, data: { enabled: false } });
    await sweepAt(T);
    await sweepAt(dayAfter(1));
    expect(await eventsFor(platform, ruleId)).toHaveLength(0);
  });
});
