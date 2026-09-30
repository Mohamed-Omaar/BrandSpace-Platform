import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeQueues } from '@brandspace/jobs';
import { OCCURRENCE_STALE, findTrigger, isAuthorablePair } from '@brandspace/automation';
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
 * PHASE 2B-3 PR 3 — REVIEW_WAITING_24H, AGAINST REAL POSTGRESQL.
 *
 * A review cycle still PENDING 24 hours after it was asked for
 * (`approval.createdAt`) fires once per rule, from the real scheduler sweep,
 * and only for what fell due after the rule was armed.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
const T = new Date();

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

/** A post under review in `brandId`, whose review was asked for at `askedAt`. */
async function review(
  workspaceId: string,
  brandId: string,
  askedAt: Date,
  status: 'PENDING' | 'APPROVED' | 'CANCELLED' = 'PENDING',
): Promise<string> {
  const item = await platform.contentItem.create({
    data: {
      workspaceId,
      brandId,
      title: `Waiting ${randomUUID().slice(0, 6)}`,
      contentType: 'POST',
      primaryLocale: 'EN',
      status: status === 'PENDING' ? 'IN_REVIEW' : 'DRAFT',
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
      status,
      createdAt: askedAt,
      ...(status === 'APPROVED' ? { decidedAt: askedAt, decidedByUserId: fixtures.a.userId } : {}),
    },
    select: { id: true },
  });
  return row.id;
}

async function setup(armedAt: Date) {
  const brandId = await newBrand(platform, fixtures.a.workspaceId);
  const ruleId = await timedRule(platform, {
    workspaceId: fixtures.a.workspaceId,
    brandId,
    triggerType: 'REVIEW_WAITING_24H',
    armedAt,
    createdByUserId: fixtures.a.userId,
  });
  return { brandId, ruleId };
}

describe('the trigger ships with its producer (D-173)', () => {
  it('is registered, rule-addressed, reaches its post through the review, and is authorable', () => {
    const trigger = findTrigger('REVIEW_WAITING_24H');
    expect(trigger).toMatchObject({
      refType: 'Approval',
      contentItemVia: 'approval',
      ruleAddressed: true,
      authorable: true,
    });
    expect(isAuthorablePair('REVIEW_WAITING_24H', 'NOTIFY_PERSON')).toBe(true);
  });
});

describe('what fires, and when', () => {
  it('a review pending for more than 24 hours fires once, naming the review', async () => {
    const { brandId, ruleId } = await setup(new Date(T.getTime() - 3 * DAY));
    const approvalId = await review(
      fixtures.a.workspaceId,
      brandId,
      new Date(T.getTime() - 25 * HOUR),
    );

    await sweepAt(T);
    const events = await eventsFor(platform, ruleId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      triggerType: 'REVIEW_WAITING_24H',
      refType: 'Approval',
      refId: approvalId,
      ruleId,
      brandId,
      dedupeKey: `REVIEW_WAITING_24H:${ruleId}:${approvalId}`,
    });

    // The same sweep again — and a second scheduler — add nothing.
    await dueNow(platform, ruleId);
    await sweepAt(new Date(T.getTime() + HOUR));
    expect(await eventsFor(platform, ruleId)).toHaveLength(1);
  });

  it('at 23 hours nothing; at exactly 24 hours (plus the sweep lag) it fires', async () => {
    const { brandId, ruleId } = await setup(new Date(T.getTime() - 3 * DAY));
    const askedAt = new Date(T.getTime() - 2 * DAY);
    await review(fixtures.a.workspaceId, brandId, askedAt);

    const lagMs = 120_000;
    await sweepAt(new Date(askedAt.getTime() + 23 * HOUR));
    expect(await eventsFor(platform, ruleId)).toHaveLength(0);

    await dueNow(platform, ruleId);
    await sweepAt(new Date(askedAt.getTime() + 24 * HOUR + lagMs));
    expect(await eventsFor(platform, ruleId)).toHaveLength(1);
  });

  it('a decided or cancelled review never fires', async () => {
    const { brandId, ruleId } = await setup(new Date(T.getTime() - 3 * DAY));
    await review(fixtures.a.workspaceId, brandId, new Date(T.getTime() - 30 * HOUR), 'APPROVED');
    await review(fixtures.a.workspaceId, brandId, new Date(T.getTime() - 30 * HOUR), 'CANCELLED');
    await sweepAt(T);
    expect(await eventsFor(platform, ruleId)).toHaveLength(0);
  });
});

describe('no backfill (D-417)', () => {
  it('a review that was already overdue when the rule was armed never fires', async () => {
    const armedAt = new Date(T.getTime() - HOUR);
    const { brandId, ruleId } = await setup(armedAt);
    // Due 2 hours before the arming.
    await review(fixtures.a.workspaceId, brandId, new Date(armedAt.getTime() - 26 * HOUR));
    await sweepAt(T);
    expect(await eventsFor(platform, ruleId)).toHaveLength(0);
  });

  it('a review asked for before the arming, but due after it, does fire', async () => {
    const armedAt = new Date(T.getTime() - 10 * HOUR);
    const { brandId, ruleId } = await setup(armedAt);
    // Asked 20 hours before arming: due 4 hours after it, 6 hours before now.
    await review(fixtures.a.workspaceId, brandId, new Date(armedAt.getTime() - 20 * HOUR));
    await sweepAt(T);
    expect(await eventsFor(platform, ruleId)).toHaveLength(1);
  });

  it('an unarmed rule produces nothing', async () => {
    const { brandId, ruleId } = await setup(new Date(T.getTime() - 3 * DAY));
    await platform.automationRule.update({ where: { id: ruleId }, data: { armedAt: null } });
    await review(fixtures.a.workspaceId, brandId, new Date(T.getTime() - 30 * HOUR));
    await sweepAt(T);
    expect(await eventsFor(platform, ruleId)).toHaveLength(0);
  });
});

describe('bounded work: 25 a visit, and nothing dropped (owner decision A)', () => {
  it('thirty overdue reviews: 25 on the first visit, the other 5 on the next', async () => {
    const { brandId, ruleId } = await setup(new Date(T.getTime() - 5 * DAY));
    for (let i = 0; i < 30; i += 1) {
      await review(fixtures.a.workspaceId, brandId, new Date(T.getTime() - 3 * DAY + i * 60_000));
    }
    await sweepAt(T);
    expect(await eventsFor(platform, ruleId)).toHaveLength(25);
    const parked = await platform.automationRule.findUniqueOrThrow({
      where: { id: ruleId },
      select: { nextEvaluationAt: true, dueWatermark: true },
    });
    // Stopped at the cap: due again at once, cursor at the 25th.
    expect(parked.nextEvaluationAt.getTime()).toBeLessThanOrEqual(T.getTime());

    await sweepAt(new Date(T.getTime() + 30_000));
    expect(await eventsFor(platform, ruleId)).toHaveLength(30);
  });
});

describe('isolation', () => {
  it('another brand’s or another workspace’s review never reaches this rule', async () => {
    const { ruleId } = await setup(new Date(T.getTime() - 3 * DAY));
    const otherBrand = await newBrand(platform, fixtures.a.workspaceId);
    await review(fixtures.a.workspaceId, otherBrand, new Date(T.getTime() - 30 * HOUR));
    const foreignBrand = await newBrand(platform, fixtures.b.workspaceId);
    await review(fixtures.b.workspaceId, foreignBrand, new Date(T.getTime() - 30 * HOUR));
    await sweepAt(T);
    expect(await eventsFor(platform, ruleId)).toHaveLength(0);
  });

  it('a switched-off rule produces nothing', async () => {
    const { brandId, ruleId } = await setup(new Date(T.getTime() - 3 * DAY));
    await platform.automationRule.update({ where: { id: ruleId }, data: { enabled: false } });
    await review(fixtures.a.workspaceId, brandId, new Date(T.getTime() - 30 * HOUR));
    await sweepAt(T);
    expect(await eventsFor(platform, ruleId)).toHaveLength(0);
  });
});

describe('delivery re-checks the review', () => {
  it('still waiting: the rule runs', async () => {
    const { brandId, ruleId } = await setup(new Date(T.getTime() - 3 * DAY));
    await review(fixtures.a.workspaceId, brandId, new Date(T.getTime() - 25 * HOUR));
    await sweepAt(T);
    const [event] = await eventsFor(platform, ruleId);
    await deliver(event!);
    const runs = await runsFor(platform, ruleId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'SUCCEEDED', failureCode: null });
  });

  it('decided before delivery: SKIPPED occurrence_stale, and nothing is sent', async () => {
    const { brandId, ruleId } = await setup(new Date(T.getTime() - 3 * DAY));
    const approvalId = await review(
      fixtures.a.workspaceId,
      brandId,
      new Date(T.getTime() - 25 * HOUR),
    );
    await sweepAt(T);
    const [event] = await eventsFor(platform, ruleId);
    await platform.approval.update({
      where: { id: approvalId },
      data: { status: 'APPROVED', decidedAt: new Date(), decidedByUserId: fixtures.a.userId },
    });
    const noticesBefore = await platform.notification.count({
      where: { workspaceId: fixtures.a.workspaceId, templateKey: 'automation.notice' },
    });
    await deliver(event!);
    const runs = await runsFor(platform, ruleId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'SKIPPED', failureCode: OCCURRENCE_STALE });
    expect(
      await platform.notification.count({
        where: { workspaceId: fixtures.a.workspaceId, templateKey: 'automation.notice' },
      }),
    ).toBe(noticesBefore);
  });
});
