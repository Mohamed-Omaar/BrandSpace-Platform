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
 * PHASE 2B-3 PR 3 — FACT_EXPIRING, AGAINST REAL POSTGRESQL.
 *
 * A usable Brand Brain fact (ACTIVE or STALE, not expired — owner decision F)
 * enters its last seven local days at the later of local 00:00 on
 * `validUntil − 6` and the moment its current date was set. Each entry after
 * the rule was armed fires once per rule; a changed date is a new occurrence.
 *
 * The sweep clock is noon UTC today. The delivery re-check reads "today" when
 * the worker runs, so a fact a delivery relies on expires one to five days out:
 * in its window whichever side of midnight the delivery lands.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
const TODAY = dayKeyOf(new Date());
const S = new Date(`${TODAY}T12:00:00.000Z`);
const MIDNIGHT = new Date(`${TODAY}T00:00:00.000Z`);
const inDays = (offset: number) => shiftDayKey(TODAY, offset);
const dateOf = (dayKey: string) => new Date(`${dayKey}T00:00:00.000Z`);

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

type Status = 'DRAFT' | 'PROPOSED' | 'ACTIVE' | 'STALE' | 'ARCHIVED';

interface VersionSpec {
  readonly validUntil: string | null;
  readonly recordedAt: Date;
}

/**
 * A fact and its append-only history. The fact carries the LAST version's
 * values, exactly as Brand Brain's service leaves it.
 */
async function fact(
  workspaceId: string,
  brandId: string,
  history: readonly VersionSpec[],
  status: Status = 'ACTIVE',
): Promise<string> {
  const current = history[history.length - 1]!;
  const common = {
    workspaceId,
    brandId,
    area: 'IDENTITY' as const,
    memory: 'CANONICAL' as const,
    origin: 'HUMAN' as const,
    title: { en: 'Offer', ar: 'العرض' },
    body: { en: 'A seasonal offer', ar: 'عرض موسمي' },
  };
  const item = await platform.brandKnowledgeItem.create({
    data: {
      ...common,
      status,
      itemKey: `identity.offer-${randomUUID().slice(0, 8)}`,
      createdByUserId: fixtures.a.userId,
      version: history.length,
      validUntil: current.validUntil ? dateOf(current.validUntil) : null,
    },
    select: { id: true },
  });
  for (const [index, version] of history.entries()) {
    await platform.brandKnowledgeVersion.create({
      data: {
        ...common,
        status,
        knowledgeItemId: item.id,
        version: index + 1,
        validUntil: version.validUntil ? dateOf(version.validUntil) : null,
        changedByUserId: fixtures.a.userId,
        changeKind: index === 0 ? 'created' : 'edited',
        recordedAt: version.recordedAt,
      },
    });
  }
  return item.id;
}

/** Append a version and move the fact to it, as an edit does. */
async function edit(
  itemId: string,
  change: { readonly validUntil?: string | null; readonly status?: Status },
  recordedAt: Date,
): Promise<void> {
  const item = await platform.brandKnowledgeItem.findUniqueOrThrow({ where: { id: itemId } });
  const validUntil =
    change.validUntil === undefined
      ? item.validUntil
      : change.validUntil
        ? dateOf(change.validUntil)
        : null;
  const status = change.status ?? item.status;
  await platform.brandKnowledgeItem.update({
    where: { id: itemId },
    data: { validUntil, status, version: item.version + 1 },
  });
  await platform.brandKnowledgeVersion.create({
    data: {
      workspaceId: item.workspaceId,
      brandId: item.brandId,
      knowledgeItemId: item.id,
      version: item.version + 1,
      area: item.area,
      memory: item.memory,
      origin: item.origin,
      status,
      title: item.title as never,
      body: item.body as never,
      validUntil,
      changedByUserId: fixtures.a.userId,
      changeKind: 'edited',
      recordedAt,
    },
  });
}

const LONG_AGO = new Date(S.getTime() - 60 * DAY);

async function setup(armedAt: Date = new Date(S.getTime() - DAY)) {
  const brandId = await newBrand(platform, fixtures.a.workspaceId);
  const ruleId = await timedRule(platform, {
    workspaceId: fixtures.a.workspaceId,
    brandId,
    triggerType: 'FACT_EXPIRING',
    armedAt,
    createdByUserId: fixtures.a.userId,
  });
  return { brandId, ruleId };
}

describe('entering the window', () => {
  it('when the window reaches it: a fact whose last day is six days out fires at today’s midnight', async () => {
    const { brandId, ruleId } = await setup();
    const id = await fact(fixtures.a.workspaceId, brandId, [
      { validUntil: inDays(6), recordedAt: LONG_AGO },
    ]);
    await sweepAt(S);
    const events = await eventsFor(platform, ruleId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      triggerType: 'FACT_EXPIRING',
      refType: 'BrandKnowledgeItem',
      refId: id,
      ruleId,
      brandId,
      dedupeKey: `FACT_EXPIRING:${ruleId}:${id}:${inDays(6)}`,
    });

    await dueNow(platform, ruleId);
    await sweepAt(new Date(S.getTime() + HOUR));
    expect(await eventsFor(platform, ruleId)).toHaveLength(1);
  });

  it('seven days out is not yet in the window', async () => {
    const { brandId, ruleId } = await setup();
    await fact(fixtures.a.workspaceId, brandId, [{ validUntil: inDays(7), recordedAt: LONG_AGO }]);
    await sweepAt(S);
    expect(await eventsFor(platform, ruleId)).toHaveLength(0);
  });

  it('when an edit moves it into the window after arming, at the moment of the edit', async () => {
    const { brandId, ruleId } = await setup();
    const id = await fact(fixtures.a.workspaceId, brandId, [
      { validUntil: inDays(30), recordedAt: LONG_AGO },
      { validUntil: inDays(3), recordedAt: new Date(S.getTime() - 2 * HOUR) },
    ]);
    await sweepAt(S);
    expect((await eventsFor(platform, ruleId)).map((event) => event.refId)).toEqual([id]);
  });

  it('an edit that kept the date does not count: the date was set before arming', async () => {
    const { brandId, ruleId } = await setup();
    await fact(fixtures.a.workspaceId, brandId, [
      { validUntil: inDays(3), recordedAt: LONG_AGO },
      { validUntil: inDays(3), recordedAt: new Date(S.getTime() - 2 * HOUR) },
    ]);
    await sweepAt(S);
    expect(await eventsFor(platform, ruleId)).toHaveLength(0);
  });

  it('a date put back to an earlier value is set by the later change', async () => {
    const { brandId, ruleId } = await setup();
    const id = await fact(fixtures.a.workspaceId, brandId, [
      { validUntil: inDays(3), recordedAt: LONG_AGO },
      { validUntil: null, recordedAt: new Date(S.getTime() - 3 * DAY) },
      { validUntil: inDays(3), recordedAt: new Date(S.getTime() - 2 * HOUR) },
    ]);
    await sweepAt(S);
    expect((await eventsFor(platform, ruleId)).map((event) => event.refId)).toEqual([id]);
  });
});

describe('no backfill, and late is still true', () => {
  it('a fact already in the window when the rule was armed never fires', async () => {
    const { brandId, ruleId } = await setup(new Date(S.getTime() - HOUR));
    // In the window since three days ago.
    await fact(fixtures.a.workspaceId, brandId, [{ validUntil: inDays(3), recordedAt: LONG_AGO }]);
    await sweepAt(S);
    expect(await eventsFor(platform, ruleId)).toHaveLength(0);
  });

  it('an unarmed rule produces nothing', async () => {
    const { brandId, ruleId } = await setup();
    await platform.automationRule.update({ where: { id: ruleId }, data: { armedAt: null } });
    await fact(fixtures.a.workspaceId, brandId, [{ validUntil: inDays(6), recordedAt: LONG_AGO }]);
    await sweepAt(S);
    expect(await eventsFor(platform, ruleId)).toHaveLength(0);
  });

  it('after an outage it fires late, as decided: entered four days ago, first swept today', async () => {
    const { brandId, ruleId } = await setup(new Date(S.getTime() - 6 * DAY));
    await fact(fixtures.a.workspaceId, brandId, [{ validUntil: inDays(2), recordedAt: LONG_AGO }]);
    await sweepAt(S);
    expect(await eventsFor(platform, ruleId)).toHaveLength(1);
  });
});

describe('which facts', () => {
  it('ACTIVE and STALE fire; DRAFT, PROPOSED and ARCHIVED never do (decision F)', async () => {
    const { brandId, ruleId } = await setup();
    const ws = fixtures.a.workspaceId;
    const history = [{ validUntil: inDays(6), recordedAt: LONG_AGO }];
    const fire = [
      await fact(ws, brandId, history, 'ACTIVE'),
      await fact(ws, brandId, history, 'STALE'),
    ];
    await fact(ws, brandId, history, 'DRAFT');
    await fact(ws, brandId, history, 'PROPOSED');
    await fact(ws, brandId, history, 'ARCHIVED');
    // Already expired, and no end date at all.
    await fact(ws, brandId, [{ validUntil: inDays(-1), recordedAt: LONG_AGO }]);
    await fact(ws, brandId, [{ validUntil: null, recordedAt: LONG_AGO }]);
    await sweepAt(S);
    const fired = (await eventsFor(platform, ruleId)).map((event) => event.refId);
    expect([...fired].sort()).toEqual([...fire].sort());
  });
});

describe('bounded work: 25 a visit, and nothing dropped', () => {
  it('thirty facts moved into the window: 25 on the first visit, the other 5 on the next', async () => {
    const { brandId, ruleId } = await setup();
    for (let i = 0; i < 30; i += 1) {
      await fact(fixtures.a.workspaceId, brandId, [
        { validUntil: inDays(40), recordedAt: LONG_AGO },
        { validUntil: inDays(4), recordedAt: new Date(S.getTime() - 3 * HOUR + i * 60_000) },
      ]);
    }
    await sweepAt(S);
    expect(await eventsFor(platform, ruleId)).toHaveLength(25);
    await sweepAt(new Date(S.getTime() + 30_000));
    expect(await eventsFor(platform, ruleId)).toHaveLength(30);
  });
});

describe('a changed date, and the delivery re-check', () => {
  it('a new date is a new occurrence; the old one no longer holds at delivery', async () => {
    const { brandId, ruleId } = await setup();
    const id = await fact(fixtures.a.workspaceId, brandId, [
      { validUntil: inDays(30), recordedAt: LONG_AGO },
      { validUntil: inDays(3), recordedAt: new Date(S.getTime() - 2 * HOUR) },
    ]);
    await sweepAt(S);
    await edit(id, { validUntil: inDays(4) }, new Date(S.getTime() + HOUR));
    await dueNow(platform, ruleId);
    await sweepAt(new Date(S.getTime() + 2 * HOUR));
    const events = await eventsFor(platform, ruleId);
    expect(events.map((event) => event.dedupeKey)).toEqual([
      `FACT_EXPIRING:${ruleId}:${id}:${inDays(3)}`,
      `FACT_EXPIRING:${ruleId}:${id}:${inDays(4)}`,
    ]);

    await deliver(events[0]!);
    await deliver(events[1]!);
    expect((await runsFor(platform, ruleId)).map((run) => [run.status, run.failureCode])).toEqual([
      ['SKIPPED', OCCURRENCE_STALE],
      ['SUCCEEDED', null],
    ]);
  });

  it('archived before delivery: SKIPPED occurrence_stale, and nothing is sent', async () => {
    const { brandId, ruleId } = await setup();
    const id = await fact(fixtures.a.workspaceId, brandId, [
      { validUntil: inDays(30), recordedAt: LONG_AGO },
      { validUntil: inDays(3), recordedAt: new Date(S.getTime() - 2 * HOUR) },
    ]);
    await sweepAt(S);
    const [event] = await eventsFor(platform, ruleId);
    await edit(id, { status: 'ARCHIVED' }, new Date());
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

  it('still usable and still expiring that day: the rule runs', async () => {
    const { brandId, ruleId } = await setup();
    await fact(fixtures.a.workspaceId, brandId, [
      { validUntil: inDays(30), recordedAt: LONG_AGO },
      { validUntil: inDays(3), recordedAt: new Date(S.getTime() - 2 * HOUR) },
    ]);
    await sweepAt(S);
    const [event] = await eventsFor(platform, ruleId);
    await deliver(event!);
    expect(await runsFor(platform, ruleId)).toMatchObject([
      { status: 'SUCCEEDED', failureCode: null },
    ]);
  });
});

describe('isolation', () => {
  it('another brand’s or another workspace’s fact never reaches this rule', async () => {
    const { ruleId } = await setup();
    const history = [{ validUntil: inDays(6), recordedAt: LONG_AGO }];
    await fact(fixtures.a.workspaceId, await newBrand(platform, fixtures.a.workspaceId), history);
    await fact(fixtures.b.workspaceId, await newBrand(platform, fixtures.b.workspaceId), history);
    await sweepAt(S);
    expect(await eventsFor(platform, ruleId)).toHaveLength(0);
  });

  it('a switched-off rule produces nothing', async () => {
    const { brandId, ruleId } = await setup();
    await platform.automationRule.update({ where: { id: ruleId }, data: { enabled: false } });
    await fact(fixtures.a.workspaceId, brandId, [{ validUntil: inDays(6), recordedAt: LONG_AGO }]);
    await sweepAt(S);
    expect(await eventsFor(platform, ruleId)).toHaveLength(0);
  });
});

describe('the workspace’s own zone', () => {
  it('in Asia/Riyadh the window reaches a fact at 21:00 UTC the evening before', async () => {
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
        triggerType: 'FACT_EXPIRING',
        armedAt: new Date(S.getTime() - 2 * DAY),
        createdByUserId: fixtures.b.userId,
      });
      await fact(workspaceId, brandId, [{ validUntil: inDays(6), recordedAt: LONG_AGO }]);
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
