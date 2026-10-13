import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { closeQueues } from '@brandspace/jobs';
import { createScheduleQuota } from '@brandspace/entitlements';
import {
  CHANNELS_NOT_CONNECTABLE_REASON,
  ContentCalendarService,
  type ContentPolicy,
} from '@brandspace/content';
import {
  parsePublishingPolicy,
  unreachableChannelGate,
  type PublishingPolicy,
} from '@brandspace/social-connectors';
import { MaintenanceScheduler } from '../../apps/api/src/scheduler';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * B-PRE 2 (owner review of #80) — A POST WHOSE TIME COMES WHILE NONE OF ITS
 * CHANNELS CAN BE CONNECTED IS HELD, NOT FAILED. Against real PostgreSQL,
 * through the real publishing sweep.
 *
 * The post was scheduled before Q8 (D-510) existed; its platform is now
 * switched off. At its time it must not fail and must not send a "failed"
 * notice. It goes back to PLANNED on its day, its quota comes back, the post
 * returns to APPROVED (DRAFT when nobody approved it) with its time kept as
 * its proposal, and nothing is queued. A second pass changes nothing.
 *
 * THE DATES ARE IN 1999 so the sweep, driven by an injected clock, sees only
 * this suite's slots.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;
const AT = new Date(Date.UTC(1999, 4, 10, 9, 0));
const LOCAL = '1999-05-10T09:00';

function capability(enabled: boolean) {
  return {
    enabled,
    postKinds: ['text'],
    maxBodyCharacters: 2_200,
    maxHashtags: 30,
    maxMediaItems: 10,
    supportsFirstComment: false,
    supportsDelete: false,
    supportsNativeScheduling: false,
    supportsPostLookup: true,
    scopes: ['w_member_social'],
    targetKind: 'organization',
  };
}

/** Every platform switched off — staging's state. */
const allOff = (): PublishingPolicy =>
  parsePublishingPolicy({
    providers: {
      facebook: capability(false),
      instagram: capability(false),
      tiktok: capability(false),
      linkedin: capability(false),
      x: capability(false),
    },
  });
/** LinkedIn on, the rest off. */
const linkedInOn = (): PublishingPolicy =>
  parsePublishingPolicy({
    providers: {
      facebook: capability(false),
      instagram: capability(false),
      tiktok: capability(false),
      linkedin: capability(true),
      x: capability(false),
    },
  });

const sweep = (publishingPolicy: PublishingPolicy) =>
  new MaintenanceScheduler({
    environment: 'DEVELOPMENT',
    clock: { now: () => AT },
    publishingPolicy,
  }).sweepPublishing(500);

function inA<T>(fn: (db: TenantScopedClient) => Promise<T>): Promise<T> {
  return withWorkspace(fixtures.a.workspaceId, fn, { prisma: app }) as Promise<T>;
}

/** A post scheduled before Q8: SCHEDULED, charged, due at `AT`. */
async function scheduledPost(options: { approved: boolean; platformKey?: string }) {
  const suffix = randomUUID().slice(0, 8);
  const usageKey = `held-slot-${suffix}`;
  return inA(async (db) => {
    const workspaceId = fixtures.a.workspaceId;
    const brandId = fixtures.a.brandId;
    const item = await db.contentItem.create({
      data: {
        workspaceId,
        brandId,
        title: `Held post ${suffix}`,
        contentType: 'POST',
        primaryLocale: 'EN',
        status: 'SCHEDULED',
        origin: 'HUMAN',
        createdByUserId: fixtures.a.userId,
        idempotencyKey: `held-item-${suffix}`,
      },
    });
    await db.contentVariant.create({
      data: {
        workspaceId,
        brandId,
        contentItemId: item.id,
        platformKey: options.platformKey ?? 'linkedin',
        locale: 'EN',
        body: 'Caption',
        hashtags: [],
        characterCount: 7,
        validationState: 'VALID',
        origin: 'HUMAN',
      },
    });
    if (options.approved) {
      await db.approval.create({
        data: {
          workspaceId,
          brandId,
          contentItemId: item.id,
          requestedByUserId: fixtures.a.userId,
          status: 'APPROVED',
          decidedByUserId: fixtures.a.userId,
          decidedAt: new Date(),
        },
      });
    }
    // The quota it was charged when it was scheduled, in the current window.
    expect(
      await createScheduleQuota({ db, workspaceId, environment: 'DEVELOPMENT' }).consume(usageKey),
    ).toBe(true);
    const slot = await db.calendarSlot.create({
      data: {
        workspaceId,
        brandId,
        contentItemId: item.id,
        scheduledAtUtc: AT,
        scheduledLocalTime: LOCAL,
        timezone: 'UTC',
        status: 'SCHEDULED',
        platformKeys: [options.platformKey ?? 'linkedin'],
        createdByUserId: fixtures.a.userId,
        usageIdempotencyKey: usageKey,
      },
    });
    return { itemId: item.id, slotId: slot.id, usageKey };
  });
}

const state = (post: { itemId: string; slotId: string; usageKey: string }) =>
  inA(async (db) => ({
    slot: await db.calendarSlot.findUniqueOrThrow({
      where: { id: post.slotId },
      select: { status: true, scheduledLocalTime: true, rescheduleAttempt: true },
    }),
    item: await db.contentItem.findUniqueOrThrow({
      where: { id: post.itemId },
      select: { status: true, proposedLocalTime: true, publishChoice: true },
    }),
    jobs: await db.publishJob.count({ where: { calendarSlotId: post.slotId } }),
    notices: await db.notification.count({
      where: { resourceId: { in: [post.slotId, post.itemId] } },
    }),
    refunds: await db.usageEvent.findMany({
      where: { idempotencyKey: `${post.usageKey}:refund` },
      select: { amount: true },
    }),
    audits: await db.auditEvent.findMany({
      where: { resourceId: post.slotId, action: 'content.rescheduled' },
      select: { actorType: true, after: true },
    }),
  }));

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 60_000);

afterAll(async () => {
  await closeQueues();
  await app?.$disconnect();
});

describe('B-pre 2 · a scheduled post whose channel was switched off, at its time', () => {
  it('is held: back to PLANNED on its day, APPROVED with its time kept, quota refunded — no job, no FAILED, no notice', async () => {
    const post = await scheduledPost({ approved: true });

    await sweep(allOff());
    const after = await state(post);

    expect(after.slot).toEqual({
      status: 'PLANNED',
      scheduledLocalTime: LOCAL,
      rescheduleAttempt: 1,
    });
    expect(after.item).toEqual({
      status: 'APPROVED',
      proposedLocalTime: LOCAL,
      publishChoice: 'PICK',
    });
    expect(after.jobs).toBe(0);
    expect(after.notices).toBe(0);
    expect(after.refunds).toEqual([{ amount: -1 }]);
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0]?.actorType).toBe('SYSTEM');
    expect(after.audits[0]?.after).toMatchObject({
      reason: 'no_connectable_channel',
      toStatus: 'PLANNED',
      itemStatus: 'APPROVED',
    });
  });

  it('a post nobody approved goes back to DRAFT, with its time kept', async () => {
    const post = await scheduledPost({ approved: false });
    await sweep(allOff());
    expect((await state(post)).item).toEqual({
      status: 'DRAFT',
      proposedLocalTime: LOCAL,
      publishChoice: 'PICK',
    });
  });

  it('a second pass changes nothing: one hold, one refund, one audit', async () => {
    const post = await scheduledPost({ approved: true });
    await sweep(allOff());
    await sweep(allOff());
    const after = await state(post);
    expect(after.slot.rescheduleAttempt).toBe(1);
    expect(after.refunds).toHaveLength(1);
    expect(after.audits).toHaveLength(1);
  });

  it('a post with a channel that can be connected is NOT held: it goes out', async () => {
    const post = await scheduledPost({ approved: true });
    await sweep(linkedInOn());
    const after = await state(post);
    // It goes on its way as before (the fixture workspace has a LinkedIn account).
    expect(after.slot.status).toBe('PUBLISHING');
    expect(after.jobs).toBeGreaterThan(0);
    expect(after.refunds).toHaveLength(0);
    expect(after.audits).toHaveLength(0);
  });
});

describe('B-pre 2 · what can still be done with a held post while every channel is off', () => {
  const POLICY = {
    calendar: {
      weekStartsOn: 0,
      maxDaysAhead: 365,
      minLeadMinutes: 15,
      maxSlotsPerDay: 25,
      requireApprovalBeforeScheduling: false,
    },
  } as unknown as ContentPolicy;

  function calendarIn<T>(fn: (calendar: ContentCalendarService) => Promise<T>): Promise<T> {
    return inA((db) =>
      fn(
        new ContentCalendarService({
          db,
          workspaceId: fixtures.a.workspaceId,
          policy: POLICY,
          timezone: 'UTC',
          approvalGate: {
            policyForBrand: async () => ({ requireApprovalBeforeScheduling: false }),
          },
          quota: { limit: async () => null, consume: async () => true, refund: async () => {} },
          // Development: the activated publishing policy, every platform off by default.
          channelGate: {
            notConnectable: async (keys: readonly string[]) => keys,
            unreachableChannels: unreachableChannelGate(db, fixtures.a.workspaceId)
              .unreachableChannels,
          },
        }),
      ),
    );
  }

  it('moving it is refused (Q8), but taking it off the calendar works and keeps its time', async () => {
    const post = await scheduledPost({ approved: true });
    await sweep(allOff());
    const actor = { actorUserId: fixtures.a.userId, actorBrandScope: [] as string[] };

    const day = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
    const refused = await calendarIn((calendar) =>
      calendar.reschedule({ slotId: post.slotId, localTime: `${day}T10:00`, ...actor }),
    ).then(
      () => null,
      (error: { publicDetails?: { reason?: unknown } }) => error.publicDetails?.reason,
    );
    expect(refused).toBe(CHANNELS_NOT_CONNECTABLE_REASON);

    await calendarIn((calendar) => calendar.cancel({ slotId: post.slotId, ...actor }));
    const after = await state(post);
    expect(after.slot.status).toBe('CANCELLED');
    expect(after.item).toEqual({
      status: 'APPROVED',
      proposedLocalTime: LOCAL,
      publishChoice: 'PICK',
    });
  });
});
