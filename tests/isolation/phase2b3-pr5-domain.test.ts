import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type PublishFailureClass } from '@brandspace/database';
import { CampaignService } from '@brandspace/content';
import {
  createConnectorRegistry,
  parsePublishingPolicy,
  PublishPipelineService,
  SocialTokenVault,
  type PublishApprovalGate,
  type PublishingPolicy,
} from '@brandspace/social-connectors';
import {
  appRoleClient,
  createIsolationFixtures,
  FIXTURE_SOCIAL_KEK,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * PHASE 2B-3 PR 5 — THE TWO DOMAIN PATHS AN APPROVED REQUEST CALLS, AGAINST
 * REAL POSTGRESQL.
 *
 *   - `retryRefusal()` answers, read-only, what `retry()` would refuse (D3);
 *     `retry()` moves a FAILED job under a conditional write, so two retries
 *     racing re-queue it once.
 *   - `CampaignService.pause()` pauses only the named campaign of the named
 *     brand, only from PLANNED or ACTIVE, under a version compare-and-swap with
 *     one re-read; refusals are typed and change nothing.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let policy: PublishingPolicy;

const vault = new SocialTokenVault({
  env: { SOCIAL_TOKEN_VAULT_KEK: FIXTURE_SOCIAL_KEK } as NodeJS.ProcessEnv,
});
const approvals: PublishApprovalGate = {
  async policyForBrand() {
    return { requireApprovalBeforeScheduling: false };
  },
  async latestForItem() {
    return { status: 'APPROVED' };
  },
};

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
    supportsPostLookup: false,
    scopes: ['w_member_social'],
    targetKind: 'organization',
  };
  policy = parsePublishingPolicy({
    providers: {
      facebook: capability,
      instagram: capability,
      tiktok: capability,
      linkedin: capability,
      x: capability,
    },
  });
}, 90_000);

afterAll(async () => {
  await app.$disconnect();
  await platform.$disconnect();
});

const inA = <T>(fn: Parameters<typeof withWorkspace>[1]) =>
  withWorkspace(fixtures.a.workspaceId, fn, { prisma: app }) as Promise<T>;

const pipelineIn = <T>(fn: (pipeline: PublishPipelineService) => Promise<T>) =>
  inA<T>(async (db) =>
    fn(
      new PublishPipelineService({
        db,
        workspaceId: fixtures.a.workspaceId,
        policy,
        registry: createConnectorRegistry({ policy, environment: 'DEVELOPMENT' }),
        vault,
        approvals,
      }),
    ),
  );

async function failedJob(
  overrides: { failureClass?: PublishFailureClass | null; scheduledAtUtc?: Date } = {},
): Promise<string> {
  return inA<string>(async (db) => {
    const job = await db.publishJob.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        calendarSlotId: fixtures.a.calendarSlotId,
        contentItemId: fixtures.a.contentItemId,
        contentVariantId: fixtures.a.contentVariantId,
        socialConnectionId: fixtures.a.socialConnectionId,
        provider: 'LINKEDIN',
        status: 'FAILED',
        idempotencyKey: `pr5-retry-${randomUUID()}`,
        scheduledAtUtc: overrides.scheduledAtUtc ?? new Date(),
        attemptCount: 1,
        maxAttempts: 3,
        nextAttemptAt: null,
        failureClass:
          overrides.failureClass === undefined ? 'CONTENT_REJECTED' : overrides.failureClass,
        completedAt: new Date(),
        createdByUserId: fixtures.a.userId,
      },
    });
    return job.id;
  });
}

const statusOf = async (jobId: string) =>
  (await platform.publishJob.findUniqueOrThrow({ where: { id: jobId } })).status;

describe('retryRefusal — what retry() would refuse, changing nothing', () => {
  it('a FAILED job a retry can help: null, and the job is untouched', async () => {
    const jobId = await failedJob();
    expect(await pipelineIn((p) => p.retryRefusal({ jobId, brandScope: [] }))).toBeNull();
    expect(await statusOf(jobId)).toBe('FAILED');
  });

  it('each refusal, by its reason', async () => {
    const indeterminate = await failedJob({ failureClass: 'TIMEOUT' });
    const needsReconnect = await failedJob({ failureClass: 'AUTH_REVOKED' });
    const late = await failedJob({ scheduledAtUtc: new Date(Date.now() - 30 * 86_400_000) });
    const refusal = (jobId: string, brandScope: readonly string[] = []) =>
      pipelineIn((p) => p.retryRefusal({ jobId, brandScope }));
    expect(await refusal(indeterminate)).toBe('not_retryable');
    expect(await refusal(needsReconnect)).toBe('not_retryable');
    expect(await refusal(late)).toBe('deadline_passed');
    expect(await refusal(randomUUID())).toBe('not_found');
    // Outside the caller's brands: not found, never "forbidden".
    expect(await refusal(await failedJob(), [randomUUID()])).toBe('not_found');
    for (const jobId of [indeterminate, needsReconnect, late]) {
      expect(await statusOf(jobId)).toBe('FAILED');
    }
  });
});

describe('retry() — one conditional write', () => {
  it('two retries at once: the job is re-queued once, the other is refused', async () => {
    const jobId = await failedJob();
    const results = await Promise.allSettled([
      pipelineIn((p) => p.retry({ jobId, actorUserId: fixtures.a.userId, brandScope: [] })),
      pipelineIn((p) => p.retry({ jobId, actorUserId: fixtures.a.userId, brandScope: [] })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'CONFLICT' });
    expect(await statusOf(jobId)).toBe('QUEUED');
    const audits = await platform.auditEvent.count({
      where: { action: 'social.post.retry_requested', resourceId: jobId },
    });
    expect(audits).toBe(1);
  });
});

describe('CampaignService.pause', () => {
  const campaigns = (db: Parameters<Parameters<typeof withWorkspace>[1]>[0]) =>
    new CampaignService({ db: db as never, workspaceId: fixtures.a.workspaceId });

  async function campaign(
    status: 'DRAFT' | 'PLANNED' | 'ACTIVE' | 'PAUSED' | 'COMPLETED',
    brandId = fixtures.a.brandId,
  ) {
    return (
      await platform.campaign.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId,
          name: `PR5 ${status} ${randomUUID().slice(0, 6)}`,
          objective: 'AWARENESS',
          status,
          createdByUserId: fixtures.a.userId,
        },
        select: { id: true },
      })
    ).id;
  }

  const pause = (campaignId: string, brandId = fixtures.a.brandId, brandScope: string[] = []) =>
    inA<Awaited<ReturnType<CampaignService['pause']>>>((db) =>
      campaigns(db).pause({
        campaignId,
        brandId,
        actor: { userId: fixtures.a.userId, brandScope },
      }),
    );

  it('PLANNED and ACTIVE pause, audited by the approver with reason automation_pause', async () => {
    for (const status of ['PLANNED', 'ACTIVE'] as const) {
      const id = await campaign(status);
      expect(await pause(id)).toMatchObject({ kind: 'paused', campaign: { status: 'PAUSED' } });
      const audit = await platform.auditEvent.findFirstOrThrow({
        where: { action: 'campaign.updated', resourceId: id },
      });
      expect(audit).toMatchObject({ actorId: fixtures.a.userId, reason: 'automation_pause' });
    }
  });

  it('any other status: not pausable, nothing changes', async () => {
    for (const status of ['DRAFT', 'PAUSED', 'COMPLETED'] as const) {
      const id = await campaign(status);
      expect(await pause(id)).toEqual({ kind: 'refused', reason: 'campaign_not_pausable' });
      const row = await platform.campaign.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe(status);
      expect(row.version).toBe(1);
    }
  });

  it('another brand, out of scope, deleted or unknown: unavailable, nothing changes', async () => {
    const otherBrand = (
      await platform.brand.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          slug: `pr5-${randomUUID().slice(0, 8)}`,
          name: 'PR 5 other brand',
          status: 'ACTIVE',
        },
        select: { id: true },
      })
    ).id;
    const elsewhere = await campaign('ACTIVE', otherBrand);
    const here = await campaign('ACTIVE');
    const deleted = await campaign('ACTIVE');
    await platform.campaign.update({ where: { id: deleted }, data: { deletedAt: new Date() } });
    const unavailable = { kind: 'refused', reason: 'campaign_unavailable' };
    // The rule's brand is A's; the campaign named is the other brand's.
    expect(await pause(elsewhere)).toEqual(unavailable);
    // The approver's scope excludes the rule's brand.
    expect(await pause(here, fixtures.a.brandId, [otherBrand])).toEqual(unavailable);
    expect(await pause(deleted)).toEqual(unavailable);
    expect(await pause(randomUUID())).toEqual(unavailable);
    for (const id of [elsewhere, here]) {
      expect((await platform.campaign.findUniqueOrThrow({ where: { id } })).status).toBe('ACTIVE');
    }
  });

  it('another workspace’s campaign is never reached', async () => {
    const theirs = (
      await platform.campaign.create({
        data: {
          workspaceId: fixtures.b.workspaceId,
          brandId: fixtures.b.brandId,
          name: 'PR5 B campaign',
          objective: 'AWARENESS',
          status: 'ACTIVE',
          createdByUserId: fixtures.b.userId,
        },
        select: { id: true },
      })
    ).id;
    expect(await pause(theirs, fixtures.b.brandId)).toEqual({
      kind: 'refused',
      reason: 'campaign_unavailable',
    });
    expect((await platform.campaign.findUniqueOrThrow({ where: { id: theirs } })).status).toBe(
      'ACTIVE',
    );
  });

  it('two pauses at once: one pause, one audit; the other finds it no longer pausable', async () => {
    const id = await campaign('ACTIVE');
    const [first, second] = await Promise.all([pause(id), pause(id)]);
    const kinds = [first.kind, second.kind].sort();
    expect(kinds).toEqual(['paused', 'refused']);
    expect(
      await platform.auditEvent.count({ where: { action: 'campaign.updated', resourceId: id } }),
    ).toBe(1);
    expect((await platform.campaign.findUniqueOrThrow({ where: { id } })).version).toBe(2);
  });
});
