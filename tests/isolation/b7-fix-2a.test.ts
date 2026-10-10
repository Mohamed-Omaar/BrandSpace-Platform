import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import { UsageService, QUOTA_FEATURES } from '@brandspace/entitlements';
import {
  ContentApprovalService,
  ContentCalendarService,
  PROPOSED_TIME_LOCKED_REASON,
  SCHEDULE_IN_PAST_REASON,
  formatLocalTime,
  type ContentPolicy,
  type ScheduleQuota,
} from '@brandspace/content';
import {
  appRoleClient,
  createIsolationFixtures,
  type IsolationFixtures,
  OPEN_CHANNEL_GATE,
} from './fixtures';

/**
 * BATCH 7 PR C (Fix PR 2a) — against a real PostgreSQL, RLS on.
 *
 *   B1.1  `propose()` keeps a proposed publish time on a post: it is a proposal,
 *         not a plan — no slot, no quota — and it changes only on a draft, a
 *         post sent back for changes, or an approved post.
 *   B3.1  `publishNow()` places a post at this instant with every rule of
 *         `schedule()` except the minimum lead, which refused it every time.
 *   B3.8  the review paths lock the post row as well as the approval row.
 *
 * The minimum lead here is 15 minutes, so "now" would be refused by
 * `schedule()`: the point of `publishNow()` is that it is not.
 */

const CONTENT_POLICY: ContentPolicy = {
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
    minLeadMinutes: 15,
    maxSlotsPerDay: 25,
    requireApprovalBeforeScheduling: false,
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
    maxNoteLength: 1_000,
    maxCyclesPerItem: 25,
  },
};

const ZONE = 'Asia/Riyadh';

let fixtures: IsolationFixtures;
let app: PrismaClient;
let platform: PrismaClient;
let usage: UsageService;

/** The ceiling this run's quota enforces. Rewritten per test that needs it. */
const quotaLimit: number | null = null;

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
  platform = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env['DATABASE_PLATFORM_URL'] ?? '' }),
  });
  usage = new UsageService({ prisma: platform });

  // The fixture ships one live slot so the tenancy suite has something to
  // measure. This suite creates its own, so that one is taken off first.
  await withWorkspace(
    fixtures.a.workspaceId,
    async (db) => {
      await db.calendarSlot.deleteMany({});
      await db.contentItem.updateMany({ data: { status: 'DRAFT' } });
    },
    { prisma: app },
  );
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

/** The real usage service behind the interface the calendar takes. */
function quota(): ScheduleQuota {
  return {
    limit: async () => quotaLimit,
    consume: async (idempotencyKey) => {
      try {
        await usage.consume({
          workspaceId: fixtures.a.workspaceId,
          featureKey: QUOTA_FEATURES.scheduledPostsPerMonth,
          limitValue: quotaLimit,
          period: 'month',
          idempotencyKey,
        });
        return true;
      } catch {
        return false;
      }
    },
    refund: async (idempotencyKey) => {
      await usage.refund({
        workspaceId: fixtures.a.workspaceId,
        featureKey: QUOTA_FEATURES.scheduledPostsPerMonth,
        period: 'month',
        idempotencyKey,
      });
    },
  };
}

function inA<T>(
  fn: (
    calendar: ContentCalendarService,
    db: Parameters<Parameters<typeof withWorkspace>[1]>[0],
  ) => Promise<T>,
  zone = ZONE,
): Promise<T> {
  return withWorkspace(
    fixtures.a.workspaceId,
    async (db) =>
      fn(
        new ContentCalendarService({
          channelGate: OPEN_CHANNEL_GATE,
          db,
          workspaceId: fixtures.a.workspaceId,
          policy: CONTENT_POLICY,
          timezone: zone,
          // PR 0: the gate is required. Approval is not this suite's subject.
          approvalGate: {
            policyForBrand: async () => ({ requireApprovalBeforeScheduling: false }),
          },
          quota: quota(),
        }),
        db,
      ),
    { prisma: app },
  );
}

/** A fresh draft with one variant — the shape the calendar will accept. */
async function makeDraft(title: string): Promise<string> {
  return withWorkspace(
    fixtures.a.workspaceId,
    async (db) => {
      const item = await db.contentItem.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          title,
          primaryLocale: 'EN',
          status: 'DRAFT',
          createdByUserId: fixtures.a.userId,
        },
      });
      await db.contentVariant.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          contentItemId: item.id,
          platformKey: 'instagram',
          locale: 'EN',
          body: 'A caption.',
          characterCount: 10,
          validationState: 'VALID',
        },
      });
      return item.id;
    },
    { prisma: app },
  );
}

/** A wall-clock a comfortable distance in the future, so nothing is "too soon". */
let dayCursor = 0;
function futureLocal(hour = 9): string {
  dayCursor += 1;
  const when = new Date(Date.now() + (30 + dayCursor) * 24 * 3_600_000);
  const day = when.toISOString().slice(0, 10);
  return `${day}T${String(hour).padStart(2, '0')}:00`;
}

const actor = () => ({ actorUserId: fixtures.a.userId, actorBrandScope: [] as string[] });

function requiringApproval<T>(fn: (calendar: ContentCalendarService) => Promise<T>): Promise<T> {
  return withWorkspace(
    fixtures.a.workspaceId,
    async (db) =>
      fn(
        new ContentCalendarService({
          channelGate: OPEN_CHANNEL_GATE,
          db,
          workspaceId: fixtures.a.workspaceId,
          policy: CONTENT_POLICY,
          timezone: ZONE,
          approvalGate: {
            policyForBrand: async () => ({ requireApprovalBeforeScheduling: true }),
          },
          quota: quota(),
        }),
      ),
    { prisma: app },
  );
}

async function errorOf(
  work: () => Promise<unknown>,
): Promise<{ code?: string | undefined; reason?: unknown }> {
  try {
    await work();
  } catch (error) {
    const e = error as { code?: string; publicDetails?: { reason?: unknown } };
    return { code: e.code, reason: e.publicDetails?.reason };
  }
  return {};
}

async function statusOf(id: string): Promise<{ status: string; proposedLocalTime: string | null }> {
  return withWorkspace(
    fixtures.a.workspaceId,
    async (db) =>
      db.contentItem.findUniqueOrThrow({
        where: { id },
        select: { status: true, proposedLocalTime: true },
      }),
    { prisma: app },
  );
}

async function setStatus(id: string, status: 'IN_REVIEW' | 'APPROVED' | 'CHANGES_REQUESTED') {
  await withWorkspace(
    fixtures.a.workspaceId,
    async (db) => db.contentItem.update({ where: { id }, data: { status } }),
    { prisma: app },
  );
}

// ---------------------------------------------------------------------------

describe('B1.1 — a proposed publish time is kept on the post, and is only a proposal', () => {
  it('stores and clears the wall-clock, with no slot and no quota used', async () => {
    const id = await makeDraft('Proposed time');
    const when = futureLocal(10);
    const item = await inA((calendar) =>
      calendar.propose({ contentItemId: id, localTime: when, ...actor() }),
    );
    expect(item.proposedLocalTime).toBe(when);
    expect(item.status).toBe('DRAFT');
    const slots = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.calendarSlot.count({ where: { contentItemId: id } }),
      { prisma: app },
    );
    expect(slots).toBe(0);

    await inA((calendar) => calendar.propose({ contentItemId: id, localTime: null, ...actor() }));
    expect((await statusOf(id)).proposedLocalTime).toBeNull();
  });

  it('is audited without any caption', async () => {
    const id = await makeDraft('Audited proposal');
    const when = futureLocal(11);
    await inA((calendar) => calendar.propose({ contentItemId: id, localTime: when, ...actor() }));
    const events = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.auditEvent.findMany({
          where: { action: 'content.proposed_time_set', resourceId: id },
        }),
      { prisma: app },
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.after).toEqual({ proposedLocalTime: when, timezone: ZONE });
  });

  it('may be set on a draft, a post sent back for changes and an approved post', async () => {
    for (const status of ['CHANGES_REQUESTED', 'APPROVED'] as const) {
      const id = await makeDraft(`Proposal on ${status}`);
      await setStatus(id, status);
      const when = futureLocal(12);
      await inA((calendar) => calendar.propose({ contentItemId: id, localTime: when, ...actor() }));
      expect((await statusOf(id)).proposedLocalTime).toBe(when);
    }
  });

  it('is locked while the post is in review', async () => {
    const id = await makeDraft('In review');
    await setStatus(id, 'IN_REVIEW');
    const refused = await errorOf(() =>
      inA((calendar) =>
        calendar.propose({ contentItemId: id, localTime: futureLocal(9), ...actor() }),
      ),
    );
    expect(refused).toEqual({ code: 'CONFLICT', reason: PROPOSED_TIME_LOCKED_REASON });
  });

  it('refuses a time already past, and one that does not exist', async () => {
    const id = await makeDraft('Past proposal');
    const past = formatLocalTime(new Date(Date.now() - 3_600_000), ZONE);
    expect(
      await errorOf(() =>
        inA((calendar) => calendar.propose({ contentItemId: id, localTime: past, ...actor() })),
      ),
    ).toEqual({ code: 'VALIDATION_FAILED', reason: SCHEDULE_IN_PAST_REASON });
    expect(
      (
        await errorOf(() =>
          inA((calendar) =>
            calendar.propose({ contentItemId: id, localTime: '2026-02-31T09:00', ...actor() }),
          ),
        )
      ).code,
    ).toBe('VALIDATION_FAILED');
  });

  it("cannot reach another workspace's post", async () => {
    const foreign = await withWorkspace(
      fixtures.b.workspaceId,
      async (db) =>
        db.contentItem.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            brandId: fixtures.b.brandId,
            title: 'B post',
            primaryLocale: 'EN',
            status: 'DRAFT',
            createdByUserId: fixtures.b.userId,
          },
          select: { id: true },
        }),
      { prisma: app },
    );
    const refused = await errorOf(() =>
      inA((calendar) =>
        calendar.propose({ contentItemId: foreign.id, localTime: futureLocal(9), ...actor() }),
      ),
    );
    expect(refused.code).toBe('NOT_FOUND');
  });
});

describe('B3.1 — publish now goes through, with every rule but the lead', () => {
  it('places the post at this instant although the lead would refuse "now"', async () => {
    const id = await makeDraft('Publish now');
    const nowLocal = formatLocalTime(new Date(), ZONE);
    // The old path: schedule() at the current minute is refused by the lead.
    expect(
      await errorOf(() =>
        inA((calendar) =>
          calendar.schedule({ contentItemId: id, localTime: nowLocal, ...actor() }),
        ),
      ),
    ).toEqual({ code: 'VALIDATION_FAILED', reason: SCHEDULE_IN_PAST_REASON });

    const before = Date.now();
    const { slot, item } = await inA((calendar) =>
      calendar.publishNow({ contentItemId: id, ...actor() }),
    );
    expect(slot.status).toBe('SCHEDULED');
    expect(item.status).toBe('SCHEDULED');
    expect(slot.scheduledAtUtc.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    expect(slot.scheduledAtUtc.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    expect(slot.usageIdempotencyKey).not.toBeNull();
  });

  it('keeps the approval gate', async () => {
    const id = await makeDraft('Needs approval');
    const refused = await errorOf(() =>
      requiringApproval((calendar) => calendar.publishNow({ contentItemId: id, ...actor() })),
    );
    expect(refused.code).toBe('CONFLICT');
    expect((await statusOf(id)).status).toBe('DRAFT');
  });

  it('moves an already scheduled post to now instead of refusing it', async () => {
    const id = await makeDraft('Already scheduled');
    const first = await inA((calendar) =>
      calendar.schedule({ contentItemId: id, localTime: futureLocal(9), ...actor() }),
    );
    const { slot } = await inA((calendar) =>
      calendar.publishNow({ contentItemId: id, ...actor() }),
    );
    expect(slot.id).toBe(first.slot.id);
    expect(slot.scheduledAtUtc.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    const live = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.calendarSlot.count({ where: { contentItemId: id, status: 'SCHEDULED' } }),
      { prisma: app },
    );
    expect(live).toBe(1);
  });
});

describe('B3.8 — the review paths lock the post row too', () => {
  it('withdrawing a review reads the post only after a concurrent change commits', async () => {
    const id = await makeDraft('Locked post');
    await setStatus(id, 'IN_REVIEW');
    await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.approval.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            contentItemId: id,
            requestedByUserId: fixtures.a.userId,
          },
        }),
      { prisma: app },
    );

    /*
     * Another transaction holds the post and archives it. Without the post
     * lock, the withdrawal read "IN_REVIEW" before that commit and then wrote
     * DRAFT over the archive. With it, the withdrawal waits, reads ARCHIVED,
     * and leaves it alone.
     */
    let locked: () => void = () => undefined;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = withWorkspace(
      fixtures.a.workspaceId,
      async (db) => {
        await db.$queryRaw`SELECT "id" FROM "content_item" WHERE "id" = ${id}::uuid FOR UPDATE`;
        locked();
        await new Promise((resolve) => setTimeout(resolve, 400));
        await db.contentItem.update({ where: { id }, data: { status: 'ARCHIVED' } });
      },
      { prisma: app },
    );
    await isLocked;

    const withdraw = withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        new ContentApprovalService({
          db,
          workspaceId: fixtures.a.workspaceId,
          policy: CONTENT_POLICY,
        }).withdrawForEdit({ itemId: id, actorUserId: fixtures.a.userId }),
      { prisma: app },
    );
    await Promise.all([holder, withdraw]);

    expect((await statusOf(id)).status).toBe('ARCHIVED');
  });
});
