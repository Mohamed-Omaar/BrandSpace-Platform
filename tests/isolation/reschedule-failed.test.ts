import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfigPayload } from '@brandspace/config';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import {
  ContentApprovalService,
  ContentCalendarService,
  ContentLibraryService,
  parseContentPolicy,
  scheduleUsageKey,
} from '@brandspace/content';
import {
  PUBLISH_JOB_SUPERSEDED_REASON,
  PublishPipelineService,
  SocialTokenVault,
  createConnectorRegistry,
  parsePublishingPolicy,
  type PublishingPolicy,
} from '@brandspace/social-connectors';
import {
  appRoleClient,
  createIsolationFixtures,
  FIXTURE_SOCIAL_KEK,
  platformRoleClient,
  type IsolationFixtures,
  OPEN_CHANNEL_GATE,
} from './fixtures';

/**
 * ITEM 9 (Phase 2B-2) — RESCHEDULE A FAILED POST, the owner's Option 1 on the
 * D-332 follow-up, AGAINST REAL POSTGRESQL.
 *
 * A post that failed with nothing published is scheduled again as a NEW slot:
 * the F2 rule applies, the quota is charged fresh under the new slot's own
 * key, the old FAILED slot and its jobs stay as history, and retrying them is
 * refused once the new slot exists. A brand that requires approval sends the
 * post for review again through the normal flow, with every earlier approval
 * left as it was. Migration `20261006130000_calendar_slot_live_excludes_failed`
 * is what lets the database hold the two slots.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let publishing: PublishingPolicy;

const contentPolicy = parseContentPolicy(parseConfigPayload('content', {}));
const vault = new SocialTokenVault({
  env: { SOCIAL_TOKEN_VAULT_KEK: FIXTURE_SOCIAL_KEK } as NodeJS.ProcessEnv,
});
const FUTURE = `${new Date().getUTCFullYear() + 1}-07-20T09:00`;
const PAST_SCHEDULE = new Date(Date.UTC(2026, 8, 20, 9, 0));

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  const capability = {
    enabled: true,
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
  publishing = parsePublishingPolicy({
    providers: {
      facebook: capability,
      instagram: capability,
      tiktok: capability,
      linkedin: capability,
      x: capability,
    },
  });
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

function inA<T>(fn: (db: TenantScopedClient) => Promise<T>): Promise<T> {
  return withWorkspace(fixtures.a.workspaceId, fn, { prisma: app }) as Promise<T>;
}

function pipeline(db: TenantScopedClient, at: Date): PublishPipelineService {
  return new PublishPipelineService({
    db,
    workspaceId: fixtures.a.workspaceId,
    policy: publishing,
    registry: createConnectorRegistry({ policy: publishing, environment: 'DEVELOPMENT' }),
    vault,
    approvals: {
      policyForBrand: async () => ({ requireApprovalBeforeScheduling: false }),
      latestForItem: async () => ({ status: 'APPROVED' }),
    },
    clock: { now: () => at },
  });
}

function calendar(db: TenantScopedClient, consumed: string[], requireApproval = false) {
  return new ContentCalendarService({
    channelGate: OPEN_CHANNEL_GATE,
    db,
    workspaceId: fixtures.a.workspaceId,
    policy: contentPolicy,
    timezone: 'UTC',
    quota: {
      limit: async () => null,
      consume: async (key) => {
        consumed.push(key);
        return true;
      },
      refund: async () => undefined,
    },
    approvalGate: {
      policyForBrand: async () => ({ requireApprovalBeforeScheduling: requireApproval }),
    },
  });
}

/**
 * A post of its own that FAILED: one LinkedIn channel, its slot materialised,
 * the job failed, and slot and item moved to FAILED exactly as the publisher's
 * lifecycle sync leaves them.
 */
async function failedPost() {
  const suffix = randomUUID().slice(0, 8);
  const world = await inA(async (db) => {
    const workspaceId = fixtures.a.workspaceId;
    const brand = await db.brand.create({
      data: { workspaceId, slug: `i9-${suffix}`, name: `I9 ${suffix}`, status: 'ACTIVE' },
    });
    const connection = await db.socialConnection.create({
      data: {
        workspaceId,
        brandId: brand.id,
        provider: 'LINKEDIN',
        externalAccountId: `i9-${suffix}`,
        displayName: `I9 ${suffix}`,
        targetKind: 'organization',
        status: 'ACTIVE',
        grantedScopes: ['w_member_social'],
        connectedByUserId: fixtures.a.userId,
        connectedAt: new Date(),
        tokenExpiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const sealed = await vault.seal({
      workspaceId,
      socialConnectionId: connection.id,
      version: 1,
      material: { accessToken: `i9-token-${suffix}`, refreshToken: `i9-refresh-${suffix}` },
    });
    await db.socialCredential.create({
      data: {
        workspaceId,
        socialConnectionId: connection.id,
        version: 1,
        ciphertext: sealed.ciphertext,
        iv: sealed.iv,
        authTag: sealed.authTag,
        wrappedDataKey: sealed.wrappedDataKey,
        keyProvider: sealed.keyProvider,
        keyId: sealed.keyId,
        algorithm: sealed.algorithm,
        encryptionContext: sealed.encryptionContext,
        maskedHint: sealed.maskedHint,
        fingerprint: sealed.fingerprint,
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
        hasRefreshToken: true,
      },
    });
    const item = await db.contentItem.create({
      data: {
        workspaceId,
        brandId: brand.id,
        title: `I9 ${suffix}`,
        contentType: 'POST',
        primaryLocale: 'EN',
        status: 'SCHEDULED',
        origin: 'HUMAN',
        createdByUserId: fixtures.a.userId,
        idempotencyKey: `i9-item-${suffix}`,
      },
    });
    await db.contentVariant.create({
      data: {
        workspaceId,
        brandId: brand.id,
        contentItemId: item.id,
        platformKey: 'linkedin',
        locale: 'EN',
        body: 'I9 caption',
        hashtags: [],
        characterCount: 10,
        validationState: 'VALID',
        origin: 'HUMAN',
      },
    });
    const slot = await db.calendarSlot.create({
      data: {
        workspaceId,
        brandId: brand.id,
        contentItemId: item.id,
        scheduledAtUtc: PAST_SCHEDULE,
        scheduledLocalTime: '2026-09-20T09:00',
        timezone: 'UTC',
        status: 'SCHEDULED',
        platformKeys: ['linkedin'],
        createdByUserId: fixtures.a.userId,
        usageIdempotencyKey: scheduleUsageKey(workspaceId, randomUUID(), 0),
      },
    });
    return { brandId: brand.id, itemId: item.id, slotId: slot.id };
  });
  await inA((db) => pipeline(db, PAST_SCHEDULE).materialiseSlot(world.slotId));
  const job = await platform.publishJob.findFirstOrThrow({
    where: { calendarSlotId: world.slotId },
  });
  await platform.publishJob.update({
    where: { id: job.id },
    data: { status: 'FAILED', failureClass: 'CONTENT_REJECTED', completedAt: PAST_SCHEDULE },
  });
  await platform.calendarSlot.update({ where: { id: world.slotId }, data: { status: 'FAILED' } });
  await platform.contentItem.update({ where: { id: world.itemId }, data: { status: 'FAILED' } });
  const oldSlot = await platform.calendarSlot.findUniqueOrThrow({ where: { id: world.slotId } });
  return { ...world, jobId: job.id, oldAttempt: oldSlot.rescheduleAttempt };
}

const schedule = (itemId: string, consumed: string[], localTime = FUTURE, approval = false) =>
  inA((db) =>
    calendar(db, consumed, approval).schedule({
      contentItemId: itemId,
      localTime,
      actorUserId: fixtures.a.userId,
      actorBrandScope: [],
    }),
  );

describe('rescheduling a FAILED post', () => {
  it('creates a NEW slot at attempt 0, charged under its own key, and keeps the old one as history', async () => {
    const post = await failedPost();
    const consumed: string[] = [];
    const view = await schedule(post.itemId, consumed);

    expect(view.slot.id).not.toBe(post.slotId);
    expect(view.slot.status).toBe('SCHEDULED');
    expect(view.slot.rescheduleAttempt).toBe(0);
    expect(consumed).toEqual([scheduleUsageKey(fixtures.a.workspaceId, view.slot.id, 0)]);
    expect(view.item.status).toBe('SCHEDULED');

    const old = await platform.calendarSlot.findUniqueOrThrow({ where: { id: post.slotId } });
    expect(old.status).toBe('FAILED');
    expect(old.rescheduleAttempt).toBe(post.oldAttempt);
    const oldJob = await platform.publishJob.findUniqueOrThrow({ where: { id: post.jobId } });
    expect(oldJob.status).toBe('FAILED');

    const audit = await platform.auditEvent.findFirstOrThrow({
      where: { action: 'content.scheduled', resourceId: view.slot.id },
    });
    expect(audit.after).toMatchObject({ replacesFailedSlotId: post.slotId });
  });

  it('keeps the F2 rule: a past time is refused and nothing is charged', async () => {
    const post = await failedPost();
    const consumed: string[] = [];
    await expect(schedule(post.itemId, consumed, '2020-01-01T09:00')).rejects.toMatchObject({
      publicDetails: { reason: 'schedule_in_past' },
    });
    expect(consumed).toEqual([]);
  });

  it('refuses a retry of the old attempt once the new slot exists; the job stays FAILED', async () => {
    const post = await failedPost();
    await schedule(post.itemId, []);
    const withinWindow = new Date(PAST_SCHEDULE.getTime() + 10 * 60_000);
    await expect(
      inA((db) =>
        pipeline(db, withinWindow).retry({
          jobId: post.jobId,
          actorUserId: fixtures.a.userId,
          brandScope: [],
        }),
      ),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      publicDetails: { reason: PUBLISH_JOB_SUPERSEDED_REASON },
    });
    expect(
      (await platform.publishJob.findUniqueOrThrow({ where: { id: post.jobId } })).status,
    ).toBe('FAILED');
  });

  it('while a retry of the failed slot is in flight, the post is not scheduled again', async () => {
    const post = await failedPost();
    const withinWindow = new Date(PAST_SCHEDULE.getTime() + 10 * 60_000);
    await inA((db) =>
      pipeline(db, withinWindow).retry({
        jobId: post.jobId,
        actorUserId: fixtures.a.userId,
        brandScope: [],
      }),
    );
    await expect(schedule(post.itemId, [])).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('never reschedules a partly published post (some channel went out)', async () => {
    const post = await failedPost();
    // The state the publisher's lifecycle sync leaves when one channel published.
    await platform.calendarSlot.update({
      where: { id: post.slotId },
      data: { status: 'PARTIALLY_PUBLISHED' },
    });
    await platform.contentItem.update({
      where: { id: post.itemId },
      data: { status: 'PARTIALLY_PUBLISHED' },
    });
    const consumed: string[] = [];
    await expect(schedule(post.itemId, consumed)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(consumed).toEqual([]);
  });

  it('a brand that requires approval: the gate refuses, and the post is sent for review again as a NEW cycle', async () => {
    const post = await failedPost();
    // The earlier, approved cycle — history that must stay exactly as it is.
    const earlier = await platform.approval.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId: post.brandId,
        subjectType: 'CONTENT_ITEM',
        contentItemId: post.itemId,
        requestedByUserId: fixtures.a.userId,
        status: 'APPROVED',
        decidedByUserId: fixtures.a.userId,
        decidedAt: PAST_SCHEDULE,
        cycle: 1,
      } as never,
    });
    await expect(schedule(post.itemId, [], FUTURE, true)).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    const approval = await inA((db) =>
      new ContentApprovalService({
        db,
        workspaceId: fixtures.a.workspaceId,
        policy: contentPolicy,
      }).submit({
        itemId: post.itemId,
        actor: {
          userId: fixtures.a.userId,
          roleKey: 'workspace_owner',
          permissionKeys: ['content.submit', 'content.read'],
          brandScope: [],
        },
      }),
    );
    expect(approval.cycle).toBe(2);
    expect(approval.status).toBe('PENDING');
    expect(
      (await platform.contentItem.findUniqueOrThrow({ where: { id: post.itemId } })).status,
    ).toBe('IN_REVIEW');
    const untouched = await platform.approval.findUniqueOrThrow({ where: { id: earlier.id } });
    expect(untouched).toEqual(earlier);
  });

  it('the database allows several FAILED slots and one live slot per post, never two live ones', async () => {
    const post = await failedPost();
    const view = await schedule(post.itemId, []);
    await expect(
      platform.calendarSlot.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: post.brandId,
          contentItemId: post.itemId,
          scheduledAtUtc: new Date(Date.UTC(2031, 0, 1, 9, 0)),
          scheduledLocalTime: '2031-01-01T09:00',
          timezone: 'UTC',
          status: 'SCHEDULED',
          platformKeys: ['linkedin'],
        },
      }),
    ).rejects.toThrow();
    expect(view.slot.status).toBe('SCHEDULED');
  });

  it('the calendar tray offers the FAILED post again; a published post is not offered', async () => {
    const post = await failedPost();
    const listed = await inA((db) =>
      new ContentLibraryService({
        db,
        workspaceId: fixtures.a.workspaceId,
        policy: contentPolicy,
      }).listItems({
        brandId: post.brandId,
        statuses: ['DRAFT', 'APPROVED', 'FAILED'],
        unscheduledOnly: true,
        limit: 50,
      }),
    );
    expect(listed.map((item) => item.id)).toContain(post.itemId);

    await platform.calendarSlot.update({
      where: { id: post.slotId },
      data: { status: 'PUBLISHED' },
    });
    await platform.contentItem.update({ where: { id: post.itemId }, data: { status: 'DRAFT' } });
    const again = await inA((db) =>
      new ContentLibraryService({
        db,
        workspaceId: fixtures.a.workspaceId,
        policy: contentPolicy,
      }).listItems({
        brandId: post.brandId,
        statuses: ['DRAFT', 'APPROVED', 'FAILED'],
        unscheduledOnly: true,
        limit: 50,
      }),
    );
    expect(again.map((item) => item.id)).not.toContain(post.itemId);
  });

  it('another workspace cannot reschedule it', async () => {
    const post = await failedPost();
    await expect(
      withWorkspace(
        fixtures.b.workspaceId,
        (db) =>
          new ContentCalendarService({
            channelGate: OPEN_CHANNEL_GATE,
            db,
            workspaceId: fixtures.b.workspaceId,
            policy: contentPolicy,
            timezone: 'UTC',
            // PR 0: the gate is required. Approval is not this suite's subject.
            approvalGate: {
              policyForBrand: async () => ({ requireApprovalBeforeScheduling: false }),
            },
            quota: {
              limit: async () => null,
              consume: async () => true,
              refund: async () => undefined,
            },
          }).schedule({
            contentItemId: post.itemId,
            localTime: FUTURE,
            actorUserId: fixtures.b.userId,
            actorBrandScope: [],
          }),
        { prisma: app },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
