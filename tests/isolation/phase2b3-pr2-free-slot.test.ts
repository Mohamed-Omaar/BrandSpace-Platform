import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { defaultPayload } from '@brandspace/config';
import {
  ContentCalendarService,
  type ContentPolicy,
  type NextFreeSlotOutcome,
  type ScheduleQuota,
} from '@brandspace/content';
import {
  AutomationEngine,
  parseAutomationPolicy,
  type AutomationActor,
  type AutomationPorts,
} from '@brandspace/automation';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';
import { seedStoredRule } from './stored-automation-rule';

/**
 * PHASE 2B-3, PR 2 — SCHEDULE IN THE NEXT FREE SLOT, AGAINST REAL POSTGRESQL.
 *
 *   - The first local day from tomorrow on which the brand has no live slot
 *     and the workspace is under its per-day cap, at the shared default time
 *     (brand default → country suggestion → 09:00), through `schedule()`.
 *   - A post that already has a time is not moved; every other reason not to
 *     schedule is a code and writes nothing.
 *   - UNDER THE WORKSPACE'S ADVISORY LOCK (D7): two concurrent runs never take
 *     the same free day and never push a day past the cap.
 *
 * Every test owns its brand and its dates (a year of its own in the future), so
 * nothing another suite scheduled can make a day look busy.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;

function policy(calendar: Partial<ContentPolicy['calendar']> = {}): ContentPolicy {
  return {
    dialects: {
      defaultKey: 'msa',
      supported: [{ key: 'msa', labelKey: 'content.dialect.msa', bcp47: 'ar' }],
    },
    platforms: [
      {
        key: 'instagram',
        labelKey: 'content.platform.instagram',
        maxBodyChars: 2_200,
        maxHashtags: 30,
        allowsFirstComment: true,
        maxMediaItems: 10,
      },
    ],
    generation: {
      maxVariantsPerRequest: 4,
      maxDraftsPerBrand: 500,
      maxContextItems: 12,
      maxContextChunks: 8,
      maxContextChars: 12_000,
      maxBriefChars: 2_000,
    },
    retention: { cancellationGraceDays: 30, minCustomerRetentionDays: 7 },
    calendar: {
      weekStartsOn: 0,
      maxDaysAhead: 365,
      minLeadMinutes: 5,
      maxSlotsPerDay: 25,
      requireApprovalBeforeScheduling: false,
      ...calendar,
    },
    learning: {
      preferenceMinObservations: 4,
      preferenceMinPosts: 3,
      workflowMinRepeats: 4,
      windowDays: 90,
      snoozeDays: 30,
    },
    approvals: {
      requireApprovalBeforeScheduling: false,
      allowSelfApproval: false,
      clientApprovalEnabled: false,
      maxNoteLength: 200,
      maxCyclesPerItem: 3,
    },
  };
}

const openQuota: ScheduleQuota = {
  limit: async () => null,
  consume: async () => true,
  refund: async () => undefined,
};
const spentQuota: ScheduleQuota = { ...openQuota, consume: async () => false };

let year = 2040;
/** A clock at noon UTC on 10 March of a year no other test uses. */
function ownYear(): Date {
  year += 1;
  return new Date(Date.UTC(year, 2, 10, 12, 0));
}

function calendar(
  db: TenantScopedClient,
  now: Date,
  options: {
    readonly calendar?: Partial<ContentPolicy['calendar']>;
    readonly quota?: ScheduleQuota;
    readonly approvalRequired?: boolean;
  } = {},
): ContentCalendarService {
  return new ContentCalendarService({
    db,
    workspaceId: fixtures.a.workspaceId,
    policy: policy(options.calendar),
    timezone: 'UTC',
    quota: options.quota ?? openQuota,
    clock: { now: () => now },
    approvalGate: {
      policyForBrand: async () => ({
        requireApprovalBeforeScheduling: options.approvalRequired ?? false,
      }),
    },
  });
}

async function brand(defaultPostTime: string | null = null): Promise<string> {
  const row = await inA((db) =>
    db.brand.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        slug: `pr2-slot-${randomUUID().slice(0, 8)}`,
        name: 'PR 2 free slot',
        status: 'ACTIVE',
        defaultPostTime,
      },
      select: { id: true },
    }),
  );
  return row.id;
}

async function post(
  brandId: string,
  status: 'DRAFT' | 'APPROVED' | 'IN_REVIEW' = 'APPROVED',
  withVariant = true,
): Promise<string> {
  return inA(async (db) => {
    const item = await db.contentItem.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId,
        title: `PR 2 slot ${randomUUID().slice(0, 8)}`,
        primaryLocale: 'EN',
        status,
        createdByUserId: fixtures.a.userId,
      },
    });
    if (withVariant) {
      await db.contentVariant.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId,
          contentItemId: item.id,
          platformKey: 'instagram',
          locale: 'EN',
          body: 'A caption.',
          characterCount: 10,
          validationState: 'VALID',
        },
      });
    }
    return item.id;
  });
}

/** A slot occupying `localTime` (UTC) for `brandId`. */
async function occupy(brandId: string, localTime: string): Promise<void> {
  const itemId = await post(brandId);
  await inA(async (db) => {
    await db.calendarSlot.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId,
        contentItemId: itemId,
        scheduledAtUtc: new Date(`${localTime}:00Z`),
        scheduledLocalTime: localTime,
        timezone: 'UTC',
        status: 'SCHEDULED',
        platformKeys: ['instagram'],
        createdByUserId: fixtures.a.userId,
        usageIdempotencyKey: `pr2-occupy-${randomUUID()}`,
      },
    });
    await db.contentItem.update({ where: { id: itemId }, data: { status: 'SCHEDULED' } });
  });
}

const next = (
  contentItemId: string,
  now: Date,
  options: Parameters<typeof calendar>[2] = {},
): Promise<NextFreeSlotOutcome> =>
  inA((db) =>
    calendar(db, now, options).scheduleNextFreeSlot({
      contentItemId,
      actorUserId: fixtures.a.userId,
      actorBrandScope: [],
    }),
  );

const localTimeOf = (outcome: NextFreeSlotOutcome) =>
  outcome.kind === 'scheduled' ? outcome.localTime : `refused:${outcome.reason}`;

const slotsOf = (contentItemId: string) =>
  inA((db) => db.calendarSlot.findMany({ where: { contentItemId } }));

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

describe('the day and the time', () => {
  it('tomorrow, at the brand’s own default time', async () => {
    const now = ownYear();
    const itemId = await post(await brand('18:30'));
    const outcome = await next(itemId, now);
    expect(localTimeOf(outcome)).toBe(`${year}-03-11T18:30`);
    const [slot] = await slotsOf(itemId);
    expect(slot).toMatchObject({ status: 'SCHEDULED', scheduledLocalTime: `${year}-03-11T18:30` });
    const item = await inA((db) => db.contentItem.findUniqueOrThrow({ where: { id: itemId } }));
    expect(item.status).toBe('SCHEDULED');
  });

  it('09:00 when the brand has no default and the country has no suggestion', async () => {
    const now = ownYear();
    const outcome = await next(await post(await brand(null)), now);
    expect(localTimeOf(outcome)).toBe(`${year}-03-11T09:00`);
  });

  it('skips a day the brand already has a live slot on', async () => {
    const now = ownYear();
    const brandId = await brand('10:00');
    await occupy(brandId, `${year}-03-11T15:00`);
    await occupy(brandId, `${year}-03-12T08:00`);
    expect(localTimeOf(await next(await post(brandId), now))).toBe(`${year}-03-13T10:00`);
  });

  it('another brand’s slot does not make the day busy for this brand', async () => {
    const now = ownYear();
    await occupy(await brand(), `${year}-03-11T10:00`);
    expect(localTimeOf(await next(await post(await brand('10:00')), now))).toBe(
      `${year}-03-11T10:00`,
    );
  });

  it('skips a day at the workspace’s per-day cap', async () => {
    const now = ownYear();
    await occupy(await brand(), `${year}-03-11T07:00`);
    await occupy(await brand(), `${year}-03-11T08:00`);
    const outcome = await next(await post(await brand('10:00')), now, {
      calendar: { maxSlotsPerDay: 2 },
    });
    expect(localTimeOf(outcome)).toBe(`${year}-03-12T10:00`);
  });

  it('no free day inside the scheduling window: no_free_day, nothing written', async () => {
    const now = ownYear();
    const brandId = await brand('10:00');
    for (const day of ['11', '12', '13']) await occupy(brandId, `${year}-03-${day}T09:00`);
    const itemId = await post(brandId);
    expect(localTimeOf(await next(itemId, now, { calendar: { maxDaysAhead: 3 } }))).toBe(
      'refused:no_free_day',
    );
    expect(await slotsOf(itemId)).toEqual([]);
  });
});

describe('what it refuses, and writes nothing for', () => {
  it('a post that already has a time is not moved', async () => {
    const now = ownYear();
    const brandId = await brand();
    const itemId = await post(brandId);
    const first = await next(itemId, now);
    expect(first.kind).toBe('scheduled');
    expect(localTimeOf(await next(itemId, now))).toBe('refused:already_has_time');
    expect(await slotsOf(itemId)).toHaveLength(1);
  });

  it('approval required and the post is not approved', async () => {
    const now = ownYear();
    const itemId = await post(await brand(), 'DRAFT');
    expect(localTimeOf(await next(itemId, now, { approvalRequired: true }))).toBe(
      'refused:approval_required',
    );
    expect(await slotsOf(itemId)).toEqual([]);
  });

  it('a post under review, or with nothing to publish, is not schedulable', async () => {
    const now = ownYear();
    const brandId = await brand();
    expect(localTimeOf(await next(await post(brandId, 'IN_REVIEW'), now))).toBe(
      'refused:not_schedulable',
    );
    expect(localTimeOf(await next(await post(brandId, 'APPROVED', false), now))).toBe(
      'refused:not_schedulable',
    );
  });

  it('the plan’s scheduled-post quota is spent', async () => {
    const now = ownYear();
    const itemId = await post(await brand());
    expect(localTimeOf(await next(itemId, now, { quota: spentQuota }))).toBe(
      'refused:schedule_quota_reached',
    );
    expect(await slotsOf(itemId)).toEqual([]);
  });

  it('a post outside the actor’s scope, or of another workspace, is unavailable', async () => {
    const now = ownYear();
    const itemId = await post(await brand());
    const scoped = await inA((db) =>
      calendar(db, now).scheduleNextFreeSlot({
        contentItemId: itemId,
        actorUserId: fixtures.a.userId,
        actorBrandScope: [randomUUID()],
      }),
    );
    expect(localTimeOf(scoped)).toBe('refused:content_unavailable');
    expect(localTimeOf(await next(fixtures.b.contentItemId, now))).toBe(
      'refused:content_unavailable',
    );
  });
});

describe('D7 — two concurrent runs, one workspace lock', () => {
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * The first run schedules and then HOLDS its transaction open, so the second
   * genuinely overlaps it. Without the lock the second would read the same
   * free day the first just took (uncommitted) and take it too.
   */
  async function race(
    first: string,
    second: string,
    now: Date,
    options: Parameters<typeof calendar>[2] = {},
  ): Promise<[NextFreeSlotOutcome, NextFreeSlotOutcome]> {
    const one = inA(async (db) => {
      const outcome = await calendar(db, now, options).scheduleNextFreeSlot({
        contentItemId: first,
        actorUserId: fixtures.a.userId,
        actorBrandScope: [],
      });
      await pause(400);
      return outcome;
    });
    await pause(100);
    const two = inA((db) =>
      calendar(db, now, options).scheduleNextFreeSlot({
        contentItemId: second,
        actorUserId: fixtures.a.userId,
        actorBrandScope: [],
      }),
    );
    return Promise.all([one, two]);
  }

  it('two posts of one brand get two different days', async () => {
    const now = ownYear();
    const brandId = await brand('10:00');
    const [a, b] = await race(await post(brandId), await post(brandId), now);
    expect([localTimeOf(a), localTimeOf(b)]).toEqual([
      `${year}-03-11T10:00`,
      `${year}-03-12T10:00`,
    ]);
  });

  it('two brands under a per-day cap of one never share a day', async () => {
    const now = ownYear();
    const [a, b] = await race(
      await post(await brand('10:00')),
      await post(await brand('10:00')),
      now,
      {
        calendar: { maxSlotsPerDay: 1 },
      },
    );
    expect([localTimeOf(a), localTimeOf(b)]).toEqual([
      `${year}-03-11T10:00`,
      `${year}-03-12T10:00`,
    ]);
    const perDay = await inA((db) =>
      db.calendarSlot.groupBy({
        by: ['scheduledLocalTime'],
        where: { scheduledAtUtc: { gte: now }, scheduledLocalTime: { startsWith: `${year}-` } },
        _count: { _all: true },
      }),
    );
    for (const day of perDay) expect(day._count._all).toBe(1);
  });
});

describe('the automation runs it', () => {
  const actor = (): AutomationActor => ({
    userId: fixtures.a.userId,
    roleKey: 'workspace_owner',
    permissionKeys: ['workspace.read', 'automation.manage', 'content.schedule'],
    brandScope: [],
  });

  async function runFor(itemId: string, brandId: string, now: Date) {
    const rule = await inA((db) =>
      seedStoredRule(db, {
        workspaceId: fixtures.a.workspaceId,
        brandId,
        name: `pr2 slot rule ${randomUUID().slice(0, 8)}`,
        triggerType: 'CONTENT_APPROVED',
        actionType: 'SCHEDULE_NEXT_FREE_SLOT',
        createdByUserId: fixtures.a.userId,
      }),
    );
    return inA((db) => {
      // The worker's port, over this test's calendar and clock.
      const ports: AutomationPorts = {
        calendar: {
          placeOnCalendar: async () => {
            throw new Error('not this action');
          },
          scheduleNextFreeSlot: async (input) => {
            const outcome = await calendar(db, now).scheduleNextFreeSlot(input);
            return outcome.kind === 'scheduled'
              ? { kind: 'scheduled', slotId: outcome.view.slot.id, localTime: outcome.localTime }
              : outcome;
          },
        },
      };
      return new AutomationEngine({
        db,
        workspaceId: fixtures.a.workspaceId,
        policy: parseAutomationPolicy(defaultPayload('automations')),
        ports,
      }).run({
        rule: { ...rule, enabled: true },
        event: {
          type: 'CONTENT_APPROVED',
          brandId,
          refType: 'ContentItem',
          refId: itemId,
          eventKey: `CONTENT_APPROVED:${randomUUID()}`,
          facts: {},
        },
        resolveActor: async () => actor(),
      });
    });
  }

  it('SUCCEEDED, naming the slot it created', async () => {
    const now = ownYear();
    const brandId = await brand('10:00');
    const itemId = await post(brandId);
    const outcome = await runFor(itemId, brandId, now);
    expect(outcome.status).toBe('SUCCEEDED');
    const [slot] = await slotsOf(itemId);
    expect(outcome.run).toMatchObject({ resourceType: 'CalendarSlot', resourceId: slot?.id });
  });

  it('a refusal ends the run with its code and status, and changes nothing', async () => {
    const now = ownYear();
    const brandId = await brand('10:00');
    const itemId = await post(brandId);
    await runFor(itemId, brandId, now);
    const again = await runFor(itemId, brandId, now);
    expect(again.status).toBe('SKIPPED');
    expect(again.run?.failureCode).toBe('already_has_time');
    expect(await slotsOf(itemId)).toHaveLength(1);

    const draft = await post(brandId, 'IN_REVIEW');
    const blocked = await runFor(draft, brandId, now);
    expect(blocked.status).toBe('BLOCKED_BY_POLICY');
    expect(blocked.run?.failureCode).toBe('not_schedulable');
  });

  it('a post the event names that is not on the rule’s brand is SKIPPED content_unavailable', async () => {
    const now = ownYear();
    const brandId = await brand('10:00');
    const elsewhere = await post(await brand('10:00'));
    const outcome = await runFor(elsewhere, brandId, now);
    expect(outcome.status).toBe('SKIPPED');
    expect(outcome.run?.failureCode).toBe('content_unavailable');
    expect(await slotsOf(elsewhere)).toEqual([]);
  });
});
