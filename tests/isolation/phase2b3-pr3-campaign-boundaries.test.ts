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
 * PHASE 2B-3 PR 3 — CAMPAIGN_STARTED AND CAMPAIGN_ENDED, AGAINST REAL POSTGRESQL.
 *
 * A campaign starts at local 00:00 of its start date and ends at local 00:00 of
 * the day after its end date, in the workspace's zone. Each boundary fires once
 * per rule, from the real scheduler sweep, only for boundaries after the rule
 * was armed, and not at all when the sweep reaches it more than 24 hours late
 * (owner decision A). Eligible campaigns are planned, active, paused or
 * completed, not archived or deleted, with the date set (owner decision E).
 *
 * The fixture workspaces are in UTC, so a boundary is 00:00Z of its day; the
 * sweep clock is injected, three hours into today.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;

const TODAY = dayKeyOf(new Date());
const MIDNIGHT = new Date(`${TODAY}T00:00:00.000Z`);
/** Three hours after today's boundary: fresh, and well past the lag. */
const S = new Date(MIDNIGHT.getTime() + 3 * HOUR);
/** Armed well before any boundary a test uses. */
const ARMED = new Date(MIDNIGHT.getTime() - 5 * DAY);

const day = (offset: number) => new Date(`${shiftDayKey(TODAY, offset)}T00:00:00.000Z`);

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

type Status = 'DRAFT' | 'PLANNED' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'ARCHIVED';

async function campaign(
  workspaceId: string,
  brandId: string,
  input: {
    readonly startDate?: Date | null;
    readonly endDate?: Date | null;
    readonly status?: Status;
    readonly deleted?: boolean;
  },
): Promise<string> {
  const row = await platform.campaign.create({
    data: {
      workspaceId,
      brandId,
      name: `Campaign ${randomUUID().slice(0, 6)}`,
      objective: 'AWARENESS',
      status: input.status ?? 'ACTIVE',
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      deletedAt: input.deleted || input.status === 'ARCHIVED' ? new Date() : null,
    },
    select: { id: true },
  });
  return row.id;
}

async function setup(
  triggerType: 'CAMPAIGN_STARTED' | 'CAMPAIGN_ENDED',
  armedAt: Date = ARMED,
  conditions?: unknown,
) {
  const brandId = await newBrand(platform, fixtures.a.workspaceId);
  const ruleId = await timedRule(platform, {
    workspaceId: fixtures.a.workspaceId,
    brandId,
    triggerType,
    armedAt,
    createdByUserId: fixtures.a.userId,
    conditions,
  });
  return { brandId, ruleId };
}

describe('what fires, and when', () => {
  it('a campaign starting today fires once at its start, naming the campaign and the day', async () => {
    const { brandId, ruleId } = await setup('CAMPAIGN_STARTED');
    const id = await campaign(fixtures.a.workspaceId, brandId, {
      startDate: day(0),
      endDate: day(10),
    });

    await sweepAt(S);
    const events = await eventsFor(platform, ruleId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      triggerType: 'CAMPAIGN_STARTED',
      refType: 'Campaign',
      refId: id,
      ruleId,
      brandId,
      dedupeKey: `CAMPAIGN_STARTED:${ruleId}:${id}:${TODAY}`,
    });

    await dueNow(platform, ruleId);
    await sweepAt(new Date(S.getTime() + HOUR));
    expect(await eventsFor(platform, ruleId)).toHaveLength(1);
  });

  it('a campaign ends at 00:00 of the day AFTER its end date, not on it', async () => {
    const { brandId, ruleId } = await setup('CAMPAIGN_ENDED');
    const endedYesterday = await campaign(fixtures.a.workspaceId, brandId, {
      startDate: day(-10),
      endDate: day(-1),
    });
    // Its last day is today: it has not ended yet.
    await campaign(fixtures.a.workspaceId, brandId, { startDate: day(-10), endDate: day(0) });

    await sweepAt(S);
    const events = await eventsFor(platform, ruleId);
    expect(events.map((event) => event.refId)).toEqual([endedYesterday]);
    expect(events[0]?.dedupeKey).toBe(
      `CAMPAIGN_ENDED:${ruleId}:${endedYesterday}:${shiftDayKey(TODAY, -1)}`,
    );
  });

  it('before its boundary plus the sweep lag nothing; after it, it fires', async () => {
    const { brandId, ruleId } = await setup('CAMPAIGN_STARTED');
    await campaign(fixtures.a.workspaceId, brandId, { startDate: day(0) });

    await sweepAt(new Date(MIDNIGHT.getTime() + 60_000));
    expect(await eventsFor(platform, ruleId)).toHaveLength(0);

    await dueNow(platform, ruleId);
    await sweepAt(new Date(MIDNIGHT.getTime() + 121_000));
    expect(await eventsFor(platform, ruleId)).toHaveLength(1);
  });

  it('only planned, active, paused and completed campaigns with the date set (decision E)', async () => {
    const { brandId, ruleId } = await setup('CAMPAIGN_STARTED');
    const ws = fixtures.a.workspaceId;
    const fire = [
      await campaign(ws, brandId, { startDate: day(0), status: 'PLANNED' }),
      await campaign(ws, brandId, { startDate: day(0), status: 'ACTIVE' }),
      await campaign(ws, brandId, { startDate: day(0), status: 'PAUSED' }),
      await campaign(ws, brandId, { startDate: day(0), status: 'COMPLETED' }),
    ];
    await campaign(ws, brandId, { startDate: day(0), status: 'DRAFT' });
    await campaign(ws, brandId, { startDate: day(0), status: 'ARCHIVED' });
    await campaign(ws, brandId, { startDate: day(0), status: 'ACTIVE', deleted: true });
    await campaign(ws, brandId, { startDate: null, endDate: day(3), status: 'ACTIVE' });

    await sweepAt(S);
    const fired = (await eventsFor(platform, ruleId)).map((event) => event.refId);
    expect([...fired].sort()).toEqual([...fire].sort());
  });

  it('every campaign starting the same day fires in one visit — a day is never split', async () => {
    const { brandId, ruleId } = await setup('CAMPAIGN_STARTED');
    await platform.campaign.createMany({
      data: Array.from({ length: 30 }, (_, i) => ({
        workspaceId: fixtures.a.workspaceId,
        brandId,
        name: `Same day ${i}`,
        objective: 'AWARENESS' as const,
        status: 'ACTIVE' as const,
        startDate: day(0),
      })),
    });
    await sweepAt(S);
    expect(await eventsFor(platform, ruleId)).toHaveLength(30);
  });
});

describe('late and early: the 24-hour bound, and no backfill', () => {
  it('a boundary more than 24 hours old when the sweep reaches it is skipped, and never later', async () => {
    const { brandId, ruleId } = await setup('CAMPAIGN_STARTED');
    await campaign(fixtures.a.workspaceId, brandId, { startDate: day(-2) });

    await sweepAt(S);
    expect(await eventsFor(platform, ruleId)).toHaveLength(0);
    const rule = await platform.automationRule.findUniqueOrThrow({
      where: { id: ruleId },
      select: { dueWatermark: true },
    });
    // The cursor moved past it.
    expect(rule.dueWatermark!.getTime()).toBeGreaterThan(day(-2).getTime());

    await dueNow(platform, ruleId);
    await sweepAt(new Date(S.getTime() + HOUR));
    expect(await eventsFor(platform, ruleId)).toHaveLength(0);
  });

  it('a boundary 23 hours old still fires', async () => {
    const { brandId, ruleId } = await setup('CAMPAIGN_STARTED');
    await campaign(fixtures.a.workspaceId, brandId, { startDate: day(0) });
    await sweepAt(new Date(MIDNIGHT.getTime() + 23 * HOUR));
    expect(await eventsFor(platform, ruleId)).toHaveLength(1);
  });

  it('more late boundaries than one read holds: skipped in bulk, and the next day still fires', async () => {
    const { brandId, ruleId } = await setup('CAMPAIGN_STARTED');
    await platform.campaign.createMany({
      data: Array.from({ length: 110 }, (_, i) => ({
        workspaceId: fixtures.a.workspaceId,
        brandId,
        name: `Late ${i}`,
        objective: 'AWARENESS' as const,
        status: 'ACTIVE' as const,
        startDate: day(-3),
      })),
    });
    const today = await campaign(fixtures.a.workspaceId, brandId, { startDate: day(0) });

    await sweepAt(S);
    await sweepAt(new Date(S.getTime() + 30_000));
    const events = await eventsFor(platform, ruleId);
    expect(events.map((event) => event.refId)).toEqual([today]);
  });

  it('a boundary before the rule was armed never fires', async () => {
    const { brandId, ruleId } = await setup(
      'CAMPAIGN_STARTED',
      new Date(MIDNIGHT.getTime() + HOUR),
    );
    await campaign(fixtures.a.workspaceId, brandId, { startDate: day(0) });
    await sweepAt(S);
    expect(await eventsFor(platform, ruleId)).toHaveLength(0);
  });

  it('an unarmed rule produces nothing', async () => {
    const { brandId, ruleId } = await setup('CAMPAIGN_STARTED');
    await platform.automationRule.update({ where: { id: ruleId }, data: { armedAt: null } });
    await campaign(fixtures.a.workspaceId, brandId, { startDate: day(0) });
    await sweepAt(S);
    expect(await eventsFor(platform, ruleId)).toHaveLength(0);
  });
});

describe('a moved date', () => {
  it('is a new occurrence with its own key; the old one no longer holds at delivery', async () => {
    const { brandId, ruleId } = await setup('CAMPAIGN_STARTED');
    const id = await campaign(fixtures.a.workspaceId, brandId, { startDate: day(0) });
    await sweepAt(S);
    const [first] = await eventsFor(platform, ruleId);

    await platform.campaign.update({ where: { id }, data: { startDate: day(1) } });
    await dueNow(platform, ruleId);
    await sweepAt(new Date(S.getTime() + DAY));
    const events = await eventsFor(platform, ruleId);
    expect(events.map((event) => event.dedupeKey)).toEqual([
      `CAMPAIGN_STARTED:${ruleId}:${id}:${TODAY}`,
      `CAMPAIGN_STARTED:${ruleId}:${id}:${shiftDayKey(TODAY, 1)}`,
    ]);

    await deliver(first!);
    await deliver(events[1]!);
    const runs = await runsFor(platform, ruleId);
    expect(runs.map((run) => [run.status, run.failureCode])).toEqual([
      ['SKIPPED', OCCURRENCE_STALE],
      ['SUCCEEDED', null],
    ]);
  });
});

describe('delivery re-checks the campaign', () => {
  it('still on that day and eligible: the rule runs', async () => {
    const { brandId, ruleId } = await setup('CAMPAIGN_STARTED');
    await campaign(fixtures.a.workspaceId, brandId, { startDate: day(0) });
    await sweepAt(S);
    const [event] = await eventsFor(platform, ruleId);
    await deliver(event!);
    expect(await runsFor(platform, ruleId)).toMatchObject([
      { status: 'SUCCEEDED', failureCode: null },
    ]);
  });

  it('archived before delivery: SKIPPED occurrence_stale, and nothing is sent', async () => {
    const { brandId, ruleId } = await setup('CAMPAIGN_ENDED');
    const id = await campaign(fixtures.a.workspaceId, brandId, {
      startDate: day(-5),
      endDate: day(-1),
    });
    await sweepAt(S);
    const [event] = await eventsFor(platform, ruleId);
    await platform.campaign.update({
      where: { id },
      data: { status: 'ARCHIVED', deletedAt: new Date() },
    });
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

  it('moved back to draft before delivery: SKIPPED occurrence_stale', async () => {
    const { brandId, ruleId } = await setup('CAMPAIGN_STARTED');
    const id = await campaign(fixtures.a.workspaceId, brandId, { startDate: day(0) });
    await sweepAt(S);
    const [event] = await eventsFor(platform, ruleId);
    await platform.campaign.update({ where: { id }, data: { status: 'DRAFT' } });
    await deliver(event!);
    expect(await runsFor(platform, ruleId)).toMatchObject([
      { status: 'SKIPPED', failureCode: OCCURRENCE_STALE },
    ]);
  });
});

describe('the campaign condition', () => {
  it('campaign.id picks which campaign’s start runs the action', async () => {
    const brandId = await newBrand(platform, fixtures.a.workspaceId);
    const chosen = await campaign(fixtures.a.workspaceId, brandId, { startDate: day(0) });
    const other = await campaign(fixtures.a.workspaceId, brandId, { startDate: day(0) });
    const ruleId = await timedRule(platform, {
      workspaceId: fixtures.a.workspaceId,
      brandId,
      triggerType: 'CAMPAIGN_STARTED',
      armedAt: ARMED,
      createdByUserId: fixtures.a.userId,
      conditions: [{ field: 'campaign.id', operator: 'equals', value: chosen }],
    });
    await sweepAt(S);
    const events = await eventsFor(platform, ruleId);
    expect(events).toHaveLength(2);
    for (const event of events) await deliver(event);
    const runs = await runsFor(platform, ruleId);
    const byRef = new Map(runs.map((run) => [run.triggerRefId, run.status]));
    expect(byRef.get(chosen)).toBe('SUCCEEDED');
    expect(byRef.get(other)).toBe('SKIPPED');
  });
});

describe('isolation', () => {
  it('another brand’s or another workspace’s campaign never reaches this rule', async () => {
    const { ruleId } = await setup('CAMPAIGN_STARTED');
    const otherBrand = await newBrand(platform, fixtures.a.workspaceId);
    await campaign(fixtures.a.workspaceId, otherBrand, { startDate: day(0) });
    const foreignBrand = await newBrand(platform, fixtures.b.workspaceId);
    await campaign(fixtures.b.workspaceId, foreignBrand, { startDate: day(0) });
    await sweepAt(S);
    expect(await eventsFor(platform, ruleId)).toHaveLength(0);
  });

  it('a switched-off rule produces nothing', async () => {
    const { brandId, ruleId } = await setup('CAMPAIGN_STARTED');
    await platform.automationRule.update({ where: { id: ruleId }, data: { enabled: false } });
    await campaign(fixtures.a.workspaceId, brandId, { startDate: day(0) });
    await sweepAt(S);
    expect(await eventsFor(platform, ruleId)).toHaveLength(0);
  });
});

describe('the workspace’s own zone', () => {
  it('in Asia/Riyadh a campaign starts at 21:00 UTC the evening before', async () => {
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
        triggerType: 'CAMPAIGN_STARTED',
        armedAt: ARMED,
        createdByUserId: fixtures.b.userId,
      });
      await campaign(workspaceId, brandId, { startDate: day(0) });
      const localMidnight = new Date(MIDNIGHT.getTime() - 3 * HOUR);

      await sweepAt(new Date(localMidnight.getTime() - 5 * 60_000));
      expect(await eventsFor(platform, ruleId)).toHaveLength(0);

      await dueNow(platform, ruleId);
      await sweepAt(new Date(localMidnight.getTime() + 5 * 60_000));
      expect(await eventsFor(platform, ruleId)).toHaveLength(1);
    } finally {
      await platform.workspace.update({ where: { id: workspaceId }, data: { timezone: 'UTC' } });
    }
  });
});
