import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import {
  createConnectorRegistry,
  executePublishJob,
  parsePublishingPolicy,
  PLATFORM_SWITCHED_OFF_CODE,
  PublishPipelineService,
  SocialTokenVault,
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
 * D-531 (OWNER, STEP B) — A POST ALREADY QUEUED WHEN ITS PLATFORM IS SWITCHED
 * OFF IS HELD, THE SAME WAY AS ONE NOT YET QUEUED. Against real PostgreSQL,
 * through `executePublishJob` exactly as the worker runs it.
 *
 *   - every platform the post was queued for switched off: its jobs are
 *     CANCELLED with `held.platform_switched_off` (no attempt, nothing FAILED,
 *     no "failed" notice), the slot goes back to PLANNED on its day, the
 *     scheduling quota is refunded once, and the post returns to APPROVED
 *     (DRAFT without an approval) with its time kept as its proposal;
 *   - another of its platforms still on: only the switched-off job is held;
 *     the other is left to go out.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;
const vault = new SocialTokenVault({
  env: { SOCIAL_TOKEN_VAULT_KEK: FIXTURE_SOCIAL_KEK } as NodeJS.ProcessEnv,
});
const LOCAL = '2030-03-04T09:30';

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
const policyWith = (linkedin: boolean, x: boolean): PublishingPolicy =>
  parsePublishingPolicy({ providers: { linkedin: capability(linkedin), x: capability(x) } });

function gate(approved: boolean): PublishApprovalGate {
  return {
    policyForBrand: async () => ({ requireApprovalBeforeScheduling: false }),
    latestForItem: async () => (approved ? { status: 'APPROVED' } : null),
  };
}

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

function transactions(
  policy: PublishingPolicy,
  approvals: PublishApprovalGate,
  notifier: PublishNotifier,
  refunds: string[],
): PipelineTransactions {
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

/** A post on its way out (PUBLISHING) with one QUEUED job per given provider. */
async function queuedPost(providers: readonly ('LINKEDIN' | 'X')[]) {
  return inA(async (db) => {
    const workspaceId = fixtures.a.workspaceId;
    const brandId = fixtures.a.brandId;
    const suffix = randomUUID().slice(0, 8);
    const item = await db.contentItem.create({
      data: {
        workspaceId,
        brandId,
        title: `Queued post ${suffix}`,
        contentType: 'POST',
        primaryLocale: 'EN',
        status: 'PUBLISHING',
        origin: 'HUMAN',
        createdByUserId: fixtures.a.userId,
        idempotencyKey: `queued-${suffix}`,
      },
    });
    const slot = await db.calendarSlot.create({
      data: {
        workspaceId,
        brandId,
        contentItemId: item.id,
        scheduledAtUtc: new Date(),
        scheduledLocalTime: LOCAL,
        timezone: 'UTC',
        status: 'PUBLISHING',
        platformKeys: providers.map((provider) => provider.toLowerCase()),
        createdByUserId: fixtures.a.userId,
        usageIdempotencyKey: `queued-slot-${suffix}`,
      },
    });
    const jobIds: string[] = [];
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
          socialConnectionId: fixtures.a.socialConnectionId,
          provider,
          status: 'QUEUED',
          idempotencyKey: `queued-job-${suffix}-${provider}`,
          scheduledAtUtc: new Date(),
          maxAttempts: 5,
          nextAttemptAt: new Date(),
          createdByUserId: fixtures.a.userId,
        },
      });
      jobIds.push(job.id);
    }
    return { itemId: item.id, slotId: slot.id, jobIds, usageKey: `queued-slot-${suffix}` };
  });
}

const stateOf = (post: { itemId: string; slotId: string; jobIds: string[] }) =>
  inA(async (db) => ({
    jobs: await db.publishJob.findMany({
      where: { id: { in: post.jobIds } },
      orderBy: { provider: 'asc' },
      select: { provider: true, status: true, failureCode: true, failureClass: true },
    }),
    attempts: await db.publishAttempt.count({ where: { publishJobId: { in: post.jobIds } } }),
    slot: await db.calendarSlot.findUniqueOrThrow({
      where: { id: post.slotId },
      select: { status: true, scheduledLocalTime: true, rescheduleAttempt: true },
    }),
    item: await db.contentItem.findUniqueOrThrow({
      where: { id: post.itemId },
      select: { status: true, proposedLocalTime: true, publishChoice: true },
    }),
    notices: await db.notification.count({
      where: { resourceId: { in: [post.itemId, post.slotId, ...post.jobIds] } },
    }),
  }));

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

describe('D-531 · a queued post whose platform was switched off', () => {
  it('is held: jobs cancelled as held, slot PLANNED, APPROVED with its time, quota refunded — no attempt, no FAILED, no notice', async () => {
    const post = await queuedPost(['LINKEDIN']);
    const { calls, notifier } = spyNotifier();
    const refunds: string[] = [];

    const result = await executePublishJob(
      transactions(policyWith(false, false), gate(true), notifier, refunds),
      post.jobIds[0]!,
    );

    expect(result.status).toBe('CANCELLED');
    const after = await stateOf(post);
    expect(after.jobs).toEqual([
      {
        provider: 'LINKEDIN',
        status: 'CANCELLED',
        failureCode: PLATFORM_SWITCHED_OFF_CODE,
        failureClass: null,
      },
    ]);
    expect(after.attempts).toBe(0);
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
    expect(refunds).toEqual([`${post.usageKey}:refund`]);
    expect(calls).toEqual({ failed: 0, published: 0 });
    expect(after.notices).toBe(0);
  });

  it('without an approval the post returns to DRAFT', async () => {
    const post = await queuedPost(['LINKEDIN']);
    const { notifier } = spyNotifier();
    await executePublishJob(
      transactions(policyWith(false, false), gate(false), notifier, []),
      post.jobIds[0]!,
    );
    expect((await stateOf(post)).item.status).toBe('DRAFT');
  });

  it('every switched-off sibling is held with it in one pass', async () => {
    const post = await queuedPost(['LINKEDIN', 'X']);
    const { calls, notifier } = spyNotifier();
    const refunds: string[] = [];
    await executePublishJob(
      transactions(policyWith(false, false), gate(true), notifier, refunds),
      post.jobIds[0]!,
    );
    const after = await stateOf(post);
    expect(after.jobs.map((job) => [job.provider, job.status, job.failureCode])).toEqual([
      ['LINKEDIN', 'CANCELLED', PLATFORM_SWITCHED_OFF_CODE],
      ['X', 'CANCELLED', PLATFORM_SWITCHED_OFF_CODE],
    ]);
    expect(after.slot.status).toBe('PLANNED');
    expect(refunds).toHaveLength(1);
    expect(calls.failed).toBe(0);
  });

  it('another platform still on: only the switched-off job is held, the other is left to go out', async () => {
    const post = await queuedPost(['LINKEDIN', 'X']);
    const { calls, notifier } = spyNotifier();
    const refunds: string[] = [];
    // LinkedIn switched off, X still on.
    await executePublishJob(
      transactions(policyWith(false, true), gate(true), notifier, refunds),
      post.jobIds[0]!,
    );
    const after = await stateOf(post);
    expect(after.jobs.map((job) => [job.provider, job.status])).toEqual([
      ['LINKEDIN', 'CANCELLED'],
      ['X', 'QUEUED'],
    ]);
    expect(after.slot.status).toBe('PUBLISHING');
    expect(after.item.status).toBe('PUBLISHING');
    expect(refunds).toEqual([]);
    expect(calls.failed).toBe(0);
  });

  it('a redelivery of a held job changes nothing', async () => {
    const post = await queuedPost(['LINKEDIN']);
    const { notifier } = spyNotifier();
    const refunds: string[] = [];
    const run = transactions(policyWith(false, false), gate(true), notifier, refunds);
    await executePublishJob(run, post.jobIds[0]!);
    const again = await executePublishJob(run, post.jobIds[0]!);
    expect(again.status).toBe('CANCELLED');
    expect(refunds).toHaveLength(1);
    expect((await stateOf(post)).slot.rescheduleAttempt).toBe(1);
  });
});
