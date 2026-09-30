import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { defaultPayload } from '@brandspace/config';
import { closeQueues } from '@brandspace/jobs';
import { instantForIntent } from '@brandspace/content';
import {
  AutomationEngine,
  advanceDueWatermark,
  dayKeyOf,
  parseAutomationPolicy,
  produceReviewWaiting,
  type AutomationActor,
  type AutomationPolicy,
} from '@brandspace/automation';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';
import {
  BATCH,
  DAY,
  HOUR,
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

/**
 * PHASE 2B-3 PR 3 — THE TIMED PRODUCERS UNDER CONCURRENCY, RESTART AND CATCH-UP.
 *
 * Real `MaintenanceScheduler` instances, real PostgreSQL, real transactions —
 * no in-memory fakes and no leader election. Two schedulers sweeping at once
 * must produce each occurrence once; an interrupted visit must leave nothing
 * behind and lose nothing; the cursor only moves forward; a rule switched back
 * on hears nothing from while it was off; and a long outage is caught up in
 * bounded visits without one rule starving another.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let policy: AutomationPolicy;

const TODAY = dayKeyOf(new Date());
/** Noon UTC today, for the producers whose occurrences are calendar days. */
const NOON = new Date(`${TODAY}T12:00:00.000Z`);
const dateOf = (offset: number) =>
  new Date(new Date(`${TODAY}T00:00:00.000Z`).getTime() + offset * DAY);

const inWorkspace = <T>(workspaceId: string, fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(workspaceId, fn as never, { prisma: app }) as Promise<T>;

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  policy = parseAutomationPolicy(defaultPayload('automations'));
});

afterAll(async () => {
  await disableCreatedRules(platform);
  await closeQueues();
  await app.$disconnect();
  await platform.$disconnect();
});

async function review(workspaceId: string, brandId: string, askedAt: Date): Promise<string> {
  const item = await platform.contentItem.create({
    data: {
      workspaceId,
      brandId,
      title: `Waiting ${randomUUID().slice(0, 6)}`,
      contentType: 'POST',
      primaryLocale: 'EN',
      status: 'IN_REVIEW',
      createdByUserId: fixtures.a.userId,
    } as never,
    select: { id: true },
  });
  const row = await platform.approval.create({
    data: {
      workspaceId,
      brandId,
      contentItemId: item.id,
      requestedByUserId: fixtures.a.userId,
      status: 'PENDING',
      createdAt: askedAt,
    },
    select: { id: true },
  });
  return row.id;
}

async function campaignStartingToday(workspaceId: string, brandId: string): Promise<string> {
  const row = await platform.campaign.create({
    data: {
      workspaceId,
      brandId,
      name: `Launch ${randomUUID().slice(0, 6)}`,
      objective: 'AWARENESS',
      status: 'ACTIVE',
      startDate: dateOf(0),
      endDate: dateOf(10),
    },
    select: { id: true },
  });
  return row.id;
}

async function expiringFact(workspaceId: string, brandId: string, userId: string) {
  const common = {
    workspaceId,
    brandId,
    area: 'IDENTITY' as const,
    memory: 'CANONICAL' as const,
    origin: 'HUMAN' as const,
    status: 'ACTIVE' as const,
    title: { en: 'Offer', ar: 'العرض' },
    body: { en: 'An offer', ar: 'عرض' },
    validUntil: dateOf(6),
  };
  const item = await platform.brandKnowledgeItem.create({
    data: {
      ...common,
      itemKey: `identity.offer-${randomUUID().slice(0, 8)}`,
      createdByUserId: userId,
      version: 1,
    },
    select: { id: true },
  });
  await platform.brandKnowledgeVersion.create({
    data: {
      ...common,
      knowledgeItemId: item.id,
      version: 1,
      changedByUserId: userId,
      changeKind: 'created',
      recordedAt: new Date(NOON.getTime() - 60 * DAY),
    },
  });
  return item.id;
}

/** One rule of each timed trigger on a fresh brand, each with one occurrence due at NOON. */
async function everyTrigger(workspaceId: string, userId: string) {
  const brandId = await newBrand(platform, workspaceId);
  const armedAt = new Date(NOON.getTime() - 2 * DAY);
  const rule = (triggerType: Parameters<typeof timedRule>[1]['triggerType']) =>
    timedRule(platform, { workspaceId, brandId, triggerType, armedAt, createdByUserId: userId });
  const rules = {
    review: await rule('REVIEW_WAITING_24H'),
    started: await rule('CAMPAIGN_STARTED'),
    gap: await rule('SCHEDULE_GAP'),
    fact: await rule('FACT_EXPIRING'),
  };
  await review(workspaceId, brandId, new Date(NOON.getTime() - 25 * HOUR));
  await campaignStartingToday(workspaceId, brandId);
  await expiringFact(workspaceId, brandId, userId);
  // The gap is a state: remembered "filled" since the arming, empty now.
  await platform.automationRule.update({
    where: { id: rules.gap },
    data: {
      thresholdBreached: false,
      thresholdCycle: 7,
      thresholdEvaluatedAt: new Date(armedAt.getTime() + HOUR),
    },
  });
  return { brandId, rules };
}

describe('two schedulers at once', () => {
  it('every occurrence of every timed trigger is produced exactly once', async () => {
    const { rules } = await everyTrigger(fixtures.a.workspaceId, fixtures.a.userId);

    const [first, second] = await Promise.all([
      schedulerAt(NOON).sweepAutomations(BATCH),
      schedulerAt(NOON).sweepAutomations(BATCH),
    ]);
    expect(first.produced + second.produced).toBeGreaterThanOrEqual(4);

    for (const ruleId of Object.values(rules)) {
      expect(await eventsFor(platform, ruleId), ruleId).toHaveLength(1);
    }
    expect((await eventsFor(platform, rules.gap))[0]?.dedupeKey).toBe(
      `SCHEDULE_GAP:${rules.gap}:7`,
    );

    // And a third pass, and a fourth, add nothing.
    for (const ruleId of Object.values(rules)) await dueNow(platform, ruleId);
    await Promise.all([
      schedulerAt(new Date(NOON.getTime() + 60_000)).sweepAutomations(BATCH),
      schedulerAt(new Date(NOON.getTime() + 60_000)).sweepAutomations(BATCH),
    ]);
    for (const ruleId of Object.values(rules)) {
      expect(await eventsFor(platform, ruleId), ruleId).toHaveLength(1);
    }
  });

  it('each workspace’s rules produce only from their own brand, while both are swept together', async () => {
    const a = await everyTrigger(fixtures.a.workspaceId, fixtures.a.userId);
    const b = await everyTrigger(fixtures.b.workspaceId, fixtures.b.userId);
    await Promise.all([
      schedulerAt(NOON).sweepAutomations(BATCH),
      schedulerAt(NOON).sweepAutomations(BATCH),
    ]);
    for (const [side, workspaceId] of [
      [a, fixtures.a.workspaceId],
      [b, fixtures.b.workspaceId],
    ] as const) {
      for (const ruleId of Object.values(side.rules)) {
        const events = await eventsFor(platform, ruleId);
        expect(events, ruleId).toHaveLength(1);
        expect(events[0]).toMatchObject({ workspaceId, brandId: side.brandId, ruleId });
      }
    }
  });
});

describe('an interrupted visit', () => {
  it('rolls back its events and its cursor together, and the next sweep does it all again', async () => {
    const brandId = await newBrand(platform, fixtures.a.workspaceId);
    const ruleId = await timedRule(platform, {
      workspaceId: fixtures.a.workspaceId,
      brandId,
      triggerType: 'REVIEW_WAITING_24H',
      armedAt: new Date(NOON.getTime() - 2 * DAY),
      createdByUserId: fixtures.a.userId,
    });
    await review(fixtures.a.workspaceId, brandId, new Date(NOON.getTime() - 25 * HOUR));
    await review(fixtures.a.workspaceId, brandId, new Date(NOON.getTime() - 26 * HOUR));

    class Crash extends Error {}
    await expect(
      inWorkspace(fixtures.a.workspaceId, async (db) => {
        const rule = await db.automationRule.findFirstOrThrow({
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
        const visit = await produceReviewWaiting({
          db,
          workspaceId: fixtures.a.workspaceId,
          rule,
          now: NOON,
          timezone: 'UTC',
          calendar: {
            localMidnight: (dayKey, timezone) => instantForIntent(`${dayKey}T00:00`, timezone),
          },
        });
        expect(visit.produced).toBe(2);
        throw new Crash('the process died before the commit');
      }),
    ).rejects.toBeInstanceOf(Crash);

    expect(await eventsFor(platform, ruleId)).toHaveLength(0);
    const after = await platform.automationRule.findUniqueOrThrow({
      where: { id: ruleId },
      select: { dueWatermark: true },
    });
    expect(after.dueWatermark).toBeNull();

    await sweepAt(NOON);
    expect(await eventsFor(platform, ruleId)).toHaveLength(2);
  });
});

describe('the cursor and the delivery', () => {
  it('the cursor only moves forward', async () => {
    const brandId = await newBrand(platform, fixtures.a.workspaceId);
    const ruleId = await timedRule(platform, {
      workspaceId: fixtures.a.workspaceId,
      brandId,
      triggerType: 'REVIEW_WAITING_24H',
      armedAt: new Date(NOON.getTime() - 2 * DAY),
      createdByUserId: fixtures.a.userId,
    });
    const later = new Date(NOON.getTime() - HOUR);
    await inWorkspace(fixtures.a.workspaceId, (db) =>
      advanceDueWatermark(db, fixtures.a.workspaceId, ruleId, later),
    );
    await inWorkspace(fixtures.a.workspaceId, (db) =>
      advanceDueWatermark(db, fixtures.a.workspaceId, ruleId, new Date(later.getTime() - DAY)),
    );
    const rule = await platform.automationRule.findUniqueOrThrow({
      where: { id: ruleId },
      select: { dueWatermark: true },
    });
    expect(rule.dueWatermark).toEqual(later);
  });

  it('the same event dispatched twice runs the rule once', async () => {
    const now = new Date();
    const brandId = await newBrand(platform, fixtures.a.workspaceId);
    const ruleId = await timedRule(platform, {
      workspaceId: fixtures.a.workspaceId,
      brandId,
      triggerType: 'REVIEW_WAITING_24H',
      armedAt: new Date(now.getTime() - 2 * DAY),
      createdByUserId: fixtures.a.userId,
    });
    await review(fixtures.a.workspaceId, brandId, new Date(now.getTime() - 25 * HOUR));
    await sweepAt(now);
    const [event] = await eventsFor(platform, ruleId);
    await Promise.all([deliver(event!), deliver(event!)]);
    await deliver(event!);
    expect(await runsFor(platform, ruleId)).toHaveLength(1);
  });
});

describe('no backfill when a rule is switched back on', () => {
  it('what fell due while it was off is never produced; what falls due after is', async () => {
    const actor: AutomationActor = {
      userId: fixtures.a.userId,
      roleKey: 'workspace_owner',
      permissionKeys: ['workspace.read', 'automation.manage', 'content.submit'],
      brandScope: [],
    };
    const engineAt = (db: TenantScopedClient, now: Date) =>
      new AutomationEngine({
        db,
        workspaceId: fixtures.a.workspaceId,
        policy,
        ports: {},
        clock: { now: () => now },
      });

    const brandId = await newBrand(platform, fixtures.a.workspaceId);
    const ruleId = await timedRule(platform, {
      workspaceId: fixtures.a.workspaceId,
      brandId,
      triggerType: 'REVIEW_WAITING_24H',
      armedAt: new Date(NOON.getTime() - 5 * DAY),
      createdByUserId: fixtures.a.userId,
    });
    const offAt = new Date(NOON.getTime() - 3 * DAY);
    const onAt = new Date(NOON.getTime() - DAY);
    await inWorkspace(fixtures.a.workspaceId, (db) =>
      engineAt(db, offAt).updateRule({ ruleId, enabled: false, actor }),
    );
    // Due while the rule was off.
    await review(fixtures.a.workspaceId, brandId, new Date(offAt.getTime() - 12 * HOUR));
    await inWorkspace(fixtures.a.workspaceId, (db) =>
      engineAt(db, onAt).updateRule({ ruleId, enabled: true, actor }),
    );
    // Due after it was switched back on.
    const after = await review(
      fixtures.a.workspaceId,
      brandId,
      new Date(onAt.getTime() - 12 * HOUR),
    );

    await dueNow(platform, ruleId);
    await sweepAt(NOON);
    expect((await eventsFor(platform, ruleId)).map((event) => event.refId)).toEqual([after]);
  });
});

describe('catching up after an outage', () => {
  it('a long backlog is worked off in visits of 25, and a second rule is never starved', async () => {
    const armedAt = new Date(NOON.getTime() - 12 * DAY);
    const heavyBrand = await newBrand(platform, fixtures.a.workspaceId);
    const heavy = await timedRule(platform, {
      workspaceId: fixtures.a.workspaceId,
      brandId: heavyBrand,
      triggerType: 'REVIEW_WAITING_24H',
      armedAt,
      createdByUserId: fixtures.a.userId,
    });
    const lightBrand = await newBrand(platform, fixtures.a.workspaceId);
    const light = await timedRule(platform, {
      workspaceId: fixtures.a.workspaceId,
      brandId: lightBrand,
      triggerType: 'REVIEW_WAITING_24H',
      armedAt,
      createdByUserId: fixtures.a.userId,
    });
    // Sixty reviews fell due over ten days nobody swept.
    for (let i = 0; i < 60; i += 1) {
      await review(
        fixtures.a.workspaceId,
        heavyBrand,
        new Date(armedAt.getTime() + i * 4 * HOUR - 23 * HOUR),
      );
    }
    await review(fixtures.a.workspaceId, lightBrand, new Date(NOON.getTime() - 30 * HOUR));

    await sweepAt(NOON);
    expect(await eventsFor(platform, heavy)).toHaveLength(25);
    expect(await eventsFor(platform, light)).toHaveLength(1);

    await sweepAt(new Date(NOON.getTime() + 30_000));
    expect(await eventsFor(platform, heavy)).toHaveLength(50);
    await sweepAt(new Date(NOON.getTime() + 60_000));
    expect(await eventsFor(platform, heavy)).toHaveLength(60);

    // Worked off: the rule is parked again, and nothing is produced twice.
    await sweepAt(new Date(NOON.getTime() + 90_000));
    const keys = (await eventsFor(platform, heavy)).map((event) => event.dedupeKey);
    expect(keys).toHaveLength(60);
    expect(new Set(keys).size).toBe(60);
  });

  it('a schedule gap that opened and closed during an outage is one event, from the state now', async () => {
    const brandId = await newBrand(platform, fixtures.a.workspaceId);
    const armedAt = new Date(NOON.getTime() - 10 * DAY);
    const ruleId = await timedRule(platform, {
      workspaceId: fixtures.a.workspaceId,
      brandId,
      triggerType: 'SCHEDULE_GAP',
      armedAt,
      createdByUserId: fixtures.a.userId,
    });
    await platform.automationRule.update({
      where: { id: ruleId },
      data: {
        thresholdBreached: false,
        thresholdCycle: 1,
        thresholdEvaluatedAt: new Date(armedAt.getTime() + HOUR),
      },
    });
    await sweepAt(NOON);
    await dueNow(platform, ruleId);
    await sweepAt(new Date(NOON.getTime() + 30_000));
    expect(await eventsFor(platform, ruleId)).toHaveLength(1);
  });
});
