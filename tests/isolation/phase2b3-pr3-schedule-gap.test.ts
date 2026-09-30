import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeQueues } from '@brandspace/jobs';
import { OCCURRENCE_STALE, dayKeyOf, shiftDayKey } from '@brandspace/automation';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';
import {
  DAY,
  HOUR,
  deliver,
  disableCreatedRules,
  dueNow,
  eventsFor,
  newBrand,
  runsFor,
  sweepAt,
  timedRule,
} from './timed-automation-fixtures';

/**
 * PHASE 2B-3 PR 3 — SCHEDULE_GAP, AGAINST REAL POSTGRESQL.
 *
 * The brand's calendar going empty for the next three local days fires once
 * per empty stretch, from the real scheduler sweep, on the D-177 edge memory:
 * the first look after arming only establishes the state, filled → empty
 * fires, empty → filled re-arms. Only the state now matters (decision A).
 *
 * The sweep clock is noon UTC today. The delivery re-check reads the window
 * as it is when the worker runs, so the slots a test relies on sit two days
 * out: inside the window whichever side of midnight the delivery lands.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
const TODAY = dayKeyOf(new Date());
const T = new Date(`${TODAY}T12:00:00.000Z`);
/** Noon UTC on the day `offset` days from today. */
const noon = (offset: number) => new Date(`${shiftDayKey(TODAY, offset)}T12:00:00.000Z`);

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
});

afterAll(async () => {
  await disableCreatedRules(platform);
  await closeQueues();
  await app.$disconnect();
  await platform.$disconnect();
});

type SlotStatus = 'PLANNED' | 'SCHEDULED' | 'PUBLISHING' | 'PUBLISHED' | 'CANCELLED';

/** A post on the brand's calendar at `at`. */
async function slot(
  workspaceId: string,
  brandId: string,
  at: Date,
  status: SlotStatus = 'PLANNED',
): Promise<string> {
  const item = await platform.contentItem.create({
    data: {
      workspaceId,
      brandId,
      title: `Planned ${randomUUID().slice(0, 6)}`,
      contentType: 'POST',
      primaryLocale: 'EN',
      status: 'DRAFT',
      createdByUserId: fixtures.a.userId,
    } as never,
    select: { id: true },
  });
  const row = await platform.calendarSlot.create({
    data: {
      workspaceId,
      brandId,
      contentItemId: item.id,
      scheduledAtUtc: at,
      scheduledLocalTime: at.toISOString().slice(0, 16),
      timezone: 'UTC',
      status,
      ...(status === 'CANCELLED' ? { cancelledAt: new Date() } : {}),
    },
    select: { id: true },
  });
  return row.id;
}

async function cancel(slotId: string): Promise<void> {
  await platform.calendarSlot.update({
    where: { id: slotId },
    data: { status: 'CANCELLED', cancelledAt: new Date() },
  });
}

async function setup(armedAt: Date = new Date(T.getTime() - DAY)) {
  const brandId = await newBrand(platform, fixtures.a.workspaceId);
  const ruleId = await timedRule(platform, {
    workspaceId: fixtures.a.workspaceId,
    brandId,
    triggerType: 'SCHEDULE_GAP',
    armedAt,
    createdByUserId: fixtures.a.userId,
  });
  return { brandId, ruleId };
}

async function state(ruleId: string) {
  return platform.automationRule.findUniqueOrThrow({
    where: { id: ruleId },
    select: { thresholdBreached: true, thresholdCycle: true, thresholdEvaluatedAt: true },
  });
}

/** Sweep again as a later, separate visit. */
async function again(ruleId: string, offsetMs = 60_000): Promise<void> {
  await dueNow(platform, ruleId);
  await sweepAt(new Date(T.getTime() + offsetMs));
}

describe('the edge', () => {
  it('the first look after arming establishes the state and fires nothing', async () => {
    const { ruleId } = await setup();
    const before = await state(ruleId);
    await sweepAt(T);
    expect(await eventsFor(platform, ruleId)).toHaveLength(0);
    const after = await state(ruleId);
    expect(after.thresholdBreached).toBe(true);
    expect(after.thresholdCycle).toBe(before.thresholdCycle + 1);
    expect(after.thresholdEvaluatedAt).not.toBeNull();
  });

  it('filled → empty fires once; still empty fires nothing more', async () => {
    const { brandId, ruleId } = await setup();
    const planned = await slot(fixtures.a.workspaceId, brandId, noon(2));
    await sweepAt(T);
    expect(await eventsFor(platform, ruleId)).toHaveLength(0);
    const { thresholdCycle: cycle } = await state(ruleId);

    await cancel(planned);
    await again(ruleId);
    const events = await eventsFor(platform, ruleId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      triggerType: 'SCHEDULE_GAP',
      refType: null,
      refId: null,
      ruleId,
      brandId,
      dedupeKey: `SCHEDULE_GAP:${ruleId}:${cycle}`,
    });

    await again(ruleId, 120_000);
    expect(await eventsFor(platform, ruleId)).toHaveLength(1);
  });

  it('empty → filled re-arms, so the next gap is a new event', async () => {
    const { brandId, ruleId } = await setup();
    const first = await slot(fixtures.a.workspaceId, brandId, noon(2));
    await sweepAt(T);
    await cancel(first);
    await again(ruleId);
    const second = await slot(fixtures.a.workspaceId, brandId, noon(3), 'SCHEDULED');
    await again(ruleId, 120_000);
    await cancel(second);
    await again(ruleId, 180_000);

    const keys = (await eventsFor(platform, ruleId)).map((event) => event.dedupeKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });
});

describe('no backfill, and a re-arming never reuses a spent key', () => {
  it('memory from before the current arming counts as none', async () => {
    const { ruleId } = await setup();
    // Remembered "filled", but before the arming: the gap now only establishes.
    await platform.automationRule.update({
      where: { id: ruleId },
      data: {
        thresholdBreached: false,
        thresholdEvaluatedAt: new Date(T.getTime() - 2 * DAY),
      },
    });
    await sweepAt(T);
    expect(await eventsFor(platform, ruleId)).toHaveLength(0);
    expect((await state(ruleId)).thresholdBreached).toBe(true);
  });

  it('fired, switched off, filled, switched back on, emptied: fires again under a new key', async () => {
    const { brandId, ruleId } = await setup();
    const first = await slot(fixtures.a.workspaceId, brandId, noon(2));
    await sweepAt(T);
    await cancel(first);
    await again(ruleId);
    expect(await eventsFor(platform, ruleId)).toHaveLength(1);

    // Re-armed (as enabling does) while the calendar has something again.
    await platform.automationRule.update({
      where: { id: ruleId },
      data: { armedAt: new Date(T.getTime() + 90_000) },
    });
    const second = await slot(fixtures.a.workspaceId, brandId, noon(3));
    await again(ruleId, 120_000);
    await cancel(second);
    await again(ruleId, 180_000);

    const keys = (await eventsFor(platform, ruleId)).map((event) => event.dedupeKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it('an unarmed rule produces nothing and remembers nothing', async () => {
    const { ruleId } = await setup();
    await platform.automationRule.update({ where: { id: ruleId }, data: { armedAt: null } });
    await sweepAt(T);
    expect(await eventsFor(platform, ruleId)).toHaveLength(0);
    expect((await state(ruleId)).thresholdEvaluatedAt).toBeNull();
  });
});

describe('what fills the window', () => {
  it('only a planned or scheduled slot of this brand, from tomorrow for three local days', async () => {
    const { brandId, ruleId } = await setup();
    const ws = fixtures.a.workspaceId;
    const filler = await slot(ws, brandId, noon(3));
    await sweepAt(T);
    expect((await state(ruleId)).thresholdBreached).toBe(false);

    // None of these fills it: later today, the fourth day, the wrong status,
    // another brand.
    await slot(ws, brandId, new Date(`${TODAY}T23:59:00.000Z`));
    await slot(ws, brandId, new Date(`${shiftDayKey(TODAY, 4)}T00:00:00.000Z`));
    await slot(ws, brandId, noon(1), 'PUBLISHING');
    await slot(ws, brandId, noon(1), 'PUBLISHED');
    await slot(ws, brandId, noon(1), 'CANCELLED');
    await slot(ws, await newBrand(platform, ws), noon(1));
    await cancel(filler);
    await again(ruleId);
    expect(await eventsFor(platform, ruleId)).toHaveLength(1);
  });
});

describe('delivery re-checks the gap', () => {
  it('still empty: the rule runs', async () => {
    const { brandId, ruleId } = await setup();
    const planned = await slot(fixtures.a.workspaceId, brandId, noon(2));
    await sweepAt(T);
    await cancel(planned);
    await again(ruleId);
    const [event] = await eventsFor(platform, ruleId);
    await deliver(event!);
    expect(await runsFor(platform, ruleId)).toMatchObject([
      { status: 'SUCCEEDED', failureCode: null },
    ]);
  });

  it('filled before delivery: SKIPPED occurrence_stale, and nothing is sent', async () => {
    const { brandId, ruleId } = await setup();
    const planned = await slot(fixtures.a.workspaceId, brandId, noon(2));
    await sweepAt(T);
    await cancel(planned);
    await again(ruleId);
    const [event] = await eventsFor(platform, ruleId);
    await slot(fixtures.a.workspaceId, brandId, noon(3));
    const noticesBefore = await platform.notification.count({
      where: { workspaceId: fixtures.a.workspaceId, templateKey: 'automation.notice' },
    });
    await deliver(event!);
    expect(await runsFor(platform, ruleId)).toMatchObject([
      { status: 'SKIPPED', failureCode: OCCURRENCE_STALE },
    ]);
    expect(
      await platform.notification.count({
        where: { workspaceId: fixtures.a.workspaceId, templateKey: 'automation.notice' },
      }),
    ).toBe(noticesBefore);
  });
});

describe('isolation', () => {
  it('another workspace’s calendar never fills or empties this brand’s', async () => {
    const { brandId, ruleId } = await setup();
    const planned = await slot(fixtures.a.workspaceId, brandId, noon(2));
    await sweepAt(T);
    const foreignBrand = await newBrand(platform, fixtures.b.workspaceId);
    await slot(fixtures.b.workspaceId, foreignBrand, noon(2));
    await cancel(planned);
    await again(ruleId);
    expect(await eventsFor(platform, ruleId)).toHaveLength(1);
  });

  it('a switched-off rule produces nothing', async () => {
    const { brandId, ruleId } = await setup();
    const planned = await slot(fixtures.a.workspaceId, brandId, noon(2));
    await sweepAt(T);
    await platform.automationRule.update({ where: { id: ruleId }, data: { enabled: false } });
    await cancel(planned);
    await again(ruleId);
    expect(await eventsFor(platform, ruleId)).toHaveLength(0);
  });
});

describe('the workspace’s own zone', () => {
  it('in Asia/Riyadh the window starts at 21:00 UTC', async () => {
    const workspaceId = fixtures.b.workspaceId;
    await platform.workspace.update({
      where: { id: workspaceId },
      data: { timezone: 'Asia/Riyadh' },
    });
    try {
      const brandId = await newBrand(platform, workspaceId);
      const ruleId = await timedRule(platform, {
        workspaceId,
        brandId,
        triggerType: 'SCHEDULE_GAP',
        armedAt: new Date(T.getTime() - DAY),
        createdByUserId: fixtures.b.userId,
      });
      // At 12:00 UTC it is 15:00 in Riyadh: tomorrow starts at 21:00 UTC today.
      const now = new Date(`${TODAY}T12:00:00.000Z`);
      const inside = await slot(workspaceId, brandId, new Date(`${TODAY}T21:30:00.000Z`));
      await sweepAt(now);
      expect((await state(ruleId)).thresholdBreached).toBe(false);

      // The same slot moved to 20:30 UTC — still "today" in Riyadh — leaves a gap.
      await platform.calendarSlot.update({
        where: { id: inside },
        data: { scheduledAtUtc: new Date(`${TODAY}T20:30:00.000Z`) },
      });
      await dueNow(platform, ruleId);
      await sweepAt(new Date(now.getTime() + HOUR));
      expect(await eventsFor(platform, ruleId)).toHaveLength(1);
    } finally {
      await platform.workspace.update({ where: { id: workspaceId }, data: { timezone: 'UTC' } });
    }
  });
});
