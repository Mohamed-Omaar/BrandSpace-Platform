import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import {
  createConnectorRegistry,
  executePublishJob,
  parsePublishingPolicy,
  PublishPipelineService,
  SocialTokenVault,
  TIKTOK_OPTIONS_HELD_CODE,
  type PipelineTransactions,
  type PublishApprovalGate,
  type PublishingPolicy,
  type PublishNotifier,
} from '@brandspace/social-connectors';
import {
  appRoleClient,
  createIsolationFixtures,
  FIXTURE_SOCIAL_KEK,
  type IsolationFixtures,
} from './fixtures';

/**
 * D-538 (OWNER, #82) — A TIKTOK POST WHOSE OPTIONS ARE NOT CHOSEN IS HELD
 * BEFORE DISPATCH, NEVER SENT AND NEVER FAILED. Against real PostgreSQL,
 * through `executePublishJob` exactly as the worker runs it.
 *
 * The Studio requires the options only when the brand has a TikTok account,
 * so a post scheduled before the account was connected reaches its time
 * without them. Then:
 *
 *   - before its lateness deadline the job waits, QUEUED with
 *     `held.tiktok_options_missing`: no attempt, no failure class, nothing
 *     FAILED, no notice, and nothing reaches TikTok;
 *   - once someone completes the panel, the next look sends it;
 *   - past the deadline with the panel still incomplete it is held as D-531
 *     holds a job: CANCELLED with the same code, the post back to PLANNED with
 *     its time kept and its quota refunded — still no failure and no notice;
 *   - another channel of the same post is left to go out.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;
const vault = new SocialTokenVault({
  env: { SOCIAL_TOKEN_VAULT_KEK: FIXTURE_SOCIAL_KEK } as NodeJS.ProcessEnv,
});
const LOCAL = '2030-03-04T09:30';
const LATENESS_MINUTES = 120;

function capability() {
  return {
    enabled: true,
    postKinds: ['text'],
    maxBodyCharacters: 2_200,
    maxHashtags: 30,
    maxMediaItems: 10,
    supportsFirstComment: false,
    supportsDelete: false,
    supportsNativeScheduling: false,
    supportsPostLookup: true,
    scopes: ['video.publish'],
    targetKind: 'profile',
  };
}
const policy: PublishingPolicy = parsePublishingPolicy({
  providers: { tiktok: capability(), linkedin: capability() },
  dispatch: { latenessToleranceMinutes: LATENESS_MINUTES },
});

const approvals: PublishApprovalGate = {
  policyForBrand: async () => ({ requireApprovalBeforeScheduling: false }),
  latestForItem: async () => ({ status: 'APPROVED' }),
};

function spyNotifier() {
  const calls = { failed: 0, published: 0 };
  const notifier: PublishNotifier = {
    published: async () => {
      calls.published += 1;
    },
    failed: async () => {
      calls.failed += 1;
    },
  } as unknown as PublishNotifier;
  return { calls, notifier };
}

function transactions(notifier: PublishNotifier, refunds: string[]): PipelineTransactions {
  return {
    run: (step) =>
      withWorkspace(
        fixtures.a.workspaceId,
        async (db) =>
          step(
            new PublishPipelineService({
              db,
              workspaceId: fixtures.a.workspaceId,
              policy,
              registry: createConnectorRegistry({ policy, environment: 'DEVELOPMENT' }),
              vault,
              approvals,
              notifier,
              scheduleQuota: {
                refund: async (key) => {
                  refunds.push(key);
                },
              },
            }),
          ),
        { prisma: app },
      ),
  };
}

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn, { prisma: app }) as Promise<T>;

const COMPLETE = {
  privacyLevel: 'SELF_ONLY',
  allowComment: false,
  allowDuet: false,
  allowStitch: false,
  disclosure: { enabled: false, yourBrand: false, brandedContent: false },
};

/** An ACTIVE TikTok account of brand A, with a sealed (fake) token. */
async function tiktokAccount(): Promise<string> {
  return inA(async (db) => {
    const connection = await db.socialConnection.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        provider: 'TIKTOK',
        externalAccountId: `tiktok-${randomUUID()}`,
        displayName: 'Creator',
        targetKind: 'profile',
        status: 'ACTIVE',
        grantedScopes: ['video.publish'],
        connectedByUserId: fixtures.a.userId,
        connectedAt: new Date(),
      },
    });
    const sealed = await vault.seal({
      workspaceId: fixtures.a.workspaceId,
      socialConnectionId: connection.id,
      version: 1,
      material: { accessToken: 'test-tiktok-held-token', refreshToken: null },
    });
    await db.socialCredential.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        socialConnectionId: connection.id,
        version: 1,
        ...sealed,
        hasRefreshToken: false,
      },
    });
    return connection.id;
  });
}

/**
 * A post on its way out (PUBLISHING) with a QUEUED TikTok job whose variant
 * has no options — scheduled before the account existed — and, optionally, a
 * LinkedIn job beside it. `minutesLate` puts the scheduled time in the past.
 */
async function queuedTikTokPost(input: { minutesLate: number; withLinkedIn?: boolean }) {
  const tiktokConnectionId = await tiktokAccount();
  return inA(async (db) => {
    const workspaceId = fixtures.a.workspaceId;
    const brandId = fixtures.a.brandId;
    const suffix = randomUUID().slice(0, 8);
    const scheduledAtUtc = new Date(Date.now() - input.minutesLate * 60_000);
    const item = await db.contentItem.create({
      data: {
        workspaceId,
        brandId,
        title: `TikTok without options ${suffix}`,
        contentType: 'POST',
        primaryLocale: 'EN',
        status: 'PUBLISHING',
        origin: 'HUMAN',
        createdByUserId: fixtures.a.userId,
        idempotencyKey: `held-${suffix}`,
      },
    });
    const providers = input.withLinkedIn
      ? (['TIKTOK', 'LINKEDIN'] as const)
      : (['TIKTOK'] as const);
    const slot = await db.calendarSlot.create({
      data: {
        workspaceId,
        brandId,
        contentItemId: item.id,
        scheduledAtUtc,
        scheduledLocalTime: LOCAL,
        timezone: 'UTC',
        status: 'PUBLISHING',
        platformKeys: providers.map((provider) => provider.toLowerCase()),
        createdByUserId: fixtures.a.userId,
        usageIdempotencyKey: `held-slot-${suffix}`,
      },
    });
    const jobs: Record<string, string> = {};
    const variants: Record<string, string> = {};
    for (const provider of providers) {
      const variant = await db.contentVariant.create({
        data: {
          workspaceId,
          brandId,
          contentItemId: item.id,
          platformKey: provider.toLowerCase(),
          locale: 'EN',
          body: 'Caption',
          hashtags: [],
          characterCount: 7,
          validationState: 'VALID',
          origin: 'HUMAN',
        },
      });
      const job = await db.publishJob.create({
        data: {
          workspaceId,
          brandId,
          calendarSlotId: slot.id,
          contentItemId: item.id,
          contentVariantId: variant.id,
          socialConnectionId:
            provider === 'TIKTOK' ? tiktokConnectionId : fixtures.a.socialConnectionId,
          provider,
          status: 'QUEUED',
          idempotencyKey: `held-job-${suffix}-${provider}`,
          scheduledAtUtc,
          maxAttempts: 5,
          nextAttemptAt: new Date(),
          createdByUserId: fixtures.a.userId,
        },
      });
      jobs[provider] = job.id;
      variants[provider] = variant.id;
    }
    return {
      itemId: item.id,
      slotId: slot.id,
      tiktokJob: jobs['TIKTOK']!,
      tiktokVariant: variants['TIKTOK']!,
      linkedinJob: jobs['LINKEDIN'] ?? null,
      usageKey: `held-slot-${suffix}`,
    };
  });
}

type Post = Awaited<ReturnType<typeof queuedTikTokPost>>;

const stateOf = (post: Post) =>
  inA(async (db) => {
    const jobIds = [post.tiktokJob, ...(post.linkedinJob ? [post.linkedinJob] : [])];
    return {
      tiktok: await db.publishJob.findUniqueOrThrow({
        where: { id: post.tiktokJob },
        select: {
          status: true,
          failureCode: true,
          failureClass: true,
          nextAttemptAt: true,
          attemptCount: true,
        },
      }),
      linkedin: post.linkedinJob
        ? await db.publishJob.findUniqueOrThrow({
            where: { id: post.linkedinJob },
            select: { status: true },
          })
        : null,
      attempts: await db.publishAttempt.count({ where: { publishJobId: { in: jobIds } } }),
      slot: await db.calendarSlot.findUniqueOrThrow({
        where: { id: post.slotId },
        select: { status: true, scheduledLocalTime: true },
      }),
      item: await db.contentItem.findUniqueOrThrow({
        where: { id: post.itemId },
        select: { status: true, proposedLocalTime: true },
      }),
      notices: await db.notification.count({
        where: { resourceId: { in: [post.itemId, post.slotId, ...jobIds] } },
      }),
      audits: await db.auditEvent.findMany({
        where: { resourceId: post.tiktokJob },
        select: { action: true },
      }),
    };
  });

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

describe('D-538 · a TikTok post whose options were never chosen', () => {
  it('before its deadline it waits, labelled, and nothing is attempted, failed or noticed', async () => {
    const post = await queuedTikTokPost({ minutesLate: 0 });
    const { calls, notifier } = spyNotifier();
    const refunds: string[] = [];
    const before = Date.now();

    const result = await executePublishJob(transactions(notifier, refunds), post.tiktokJob);

    expect(result).toMatchObject({ status: 'QUEUED', failureClass: null, externalPostId: null });
    const after = await stateOf(post);
    expect(after.tiktok).toMatchObject({
      status: 'QUEUED',
      failureCode: TIKTOK_OPTIONS_HELD_CODE,
      failureClass: null,
      attemptCount: 0,
    });
    // Looked at again after the recheck interval, never later than the deadline.
    const next = after.tiktok.nextAttemptAt!.getTime();
    expect(next).toBeGreaterThan(before);
    expect(next).toBeLessThanOrEqual(Date.now() + 60_000 + 1_000);
    expect(after.attempts).toBe(0);
    expect(after.slot.status).toBe('PUBLISHING');
    expect(after.item.status).toBe('PUBLISHING');
    expect(calls).toEqual({ failed: 0, published: 0 });
    expect(after.notices).toBe(0);
    expect(refunds).toEqual([]);
    expect(after.audits.map((audit) => audit.action)).toEqual(['social.post.held']);

    // Looked at again, still without options: still held, one audit only.
    await inA((db) =>
      db.publishJob.update({ where: { id: post.tiktokJob }, data: { nextAttemptAt: new Date() } }),
    );
    await executePublishJob(transactions(notifier, refunds), post.tiktokJob);
    const again = await stateOf(post);
    expect(again.tiktok.status).toBe('QUEUED');
    expect(again.attempts).toBe(0);
    expect(again.audits.map((audit) => audit.action)).toEqual(['social.post.held']);
  });

  it('once someone completes the panel, the next look sends it', async () => {
    const post = await queuedTikTokPost({ minutesLate: 0 });
    const { calls, notifier } = spyNotifier();
    await executePublishJob(transactions(notifier, []), post.tiktokJob);
    expect((await stateOf(post)).tiktok.failureCode).toBe(TIKTOK_OPTIONS_HELD_CODE);

    await inA((db) =>
      db.contentVariant.update({
        where: { id: post.tiktokVariant },
        data: { platformOptions: COMPLETE },
      }),
    );
    await inA((db) =>
      db.publishJob.update({ where: { id: post.tiktokJob }, data: { nextAttemptAt: new Date() } }),
    );
    const result = await executePublishJob(transactions(notifier, []), post.tiktokJob);

    expect(result.status).toBe('PUBLISHED');
    const after = await stateOf(post);
    expect(after.tiktok).toMatchObject({ status: 'PUBLISHED', failureCode: null });
    expect(after.attempts).toBe(1);
    expect(calls.failed).toBe(0);
  });

  it('past its deadline still without options: held as D-531 holds one — PLANNED, time kept, quota refunded, no FAILED, no notice', async () => {
    const post = await queuedTikTokPost({ minutesLate: LATENESS_MINUTES + 5 });
    const { calls, notifier } = spyNotifier();
    const refunds: string[] = [];

    const result = await executePublishJob(transactions(notifier, refunds), post.tiktokJob);

    expect(result).toMatchObject({ status: 'CANCELLED', failureClass: null });
    const after = await stateOf(post);
    expect(after.tiktok).toMatchObject({
      status: 'CANCELLED',
      failureCode: TIKTOK_OPTIONS_HELD_CODE,
      failureClass: null,
    });
    expect(after.attempts).toBe(0);
    expect(after.slot).toEqual({ status: 'PLANNED', scheduledLocalTime: LOCAL });
    expect(after.item).toEqual({ status: 'APPROVED', proposedLocalTime: LOCAL });
    expect(refunds).toEqual([`${post.usageKey}:refund`]);
    expect(calls).toEqual({ failed: 0, published: 0 });
    expect(after.notices).toBe(0);
    expect(after.audits.map((audit) => audit.action)).toEqual(['social.post.cancelled']);
  });

  it('another channel of the same post is left to go out', async () => {
    const post = await queuedTikTokPost({ minutesLate: LATENESS_MINUTES + 5, withLinkedIn: true });
    const { calls, notifier } = spyNotifier();
    const refunds: string[] = [];

    await executePublishJob(transactions(notifier, refunds), post.tiktokJob);

    const after = await stateOf(post);
    expect(after.tiktok.status).toBe('CANCELLED');
    expect(after.linkedin).toEqual({ status: 'QUEUED' });
    expect(after.slot.status).toBe('PUBLISHING');
    expect(after.item.status).toBe('PUBLISHING');
    expect(refunds).toEqual([]);
    expect(calls.failed).toBe(0);
  });
});
