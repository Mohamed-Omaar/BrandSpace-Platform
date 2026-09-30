import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import {
  VERIFY_SOCIAL_POST,
  closeQueues,
  queueFor,
  queueUrl,
  verifySocialPostJobKey,
} from '@brandspace/jobs';
import {
  PublishPipelineService,
  SocialTokenVault,
  createConnectorRegistry,
  parsePublishingPolicy,
  type PublishingPolicy,
} from '@brandspace/social-connectors';
import { MaintenanceScheduler } from '../../apps/api/src/scheduler';
import {
  FIXTURE_SOCIAL_KEK,
  appRoleClient,
  createIsolationFixtures,
  type IsolationFixtures,
} from './fixtures';

/**
 * FIX PR 1 · F1 (D-410) — A STALLED PUBLISHING POST IS VERIFIED, ONCE.
 *
 * `execute()` moves a job to PUBLISHING before the provider call; a worker that
 * dies in between leaves the row there. The maintenance sweep is meant to send
 * a `social.verify-post` message for every claim past its lease. It keyed that
 * message `verify:<key>`, and `enqueue` refuses any key containing `:` (BullMQ
 * cannot use one as a job id), so NO verification was ever sent and the post
 * stayed "Publishing" for ever. The earlier suite copied the sweep's query
 * rather than running the sweep, which is how that went unseen.
 *
 * These tests run the REAL sweep against real PostgreSQL and real Redis, then
 * do exactly what the worker's `processVerifyJob` does with the message it
 * finds: `recoverStaleClaim(publishJobId)`.
 *
 * THE DATES ARE IN 2000/2001 and the sweep's clock is injected, so the sweep
 * sees only this suite's claims.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;
let policy: PublishingPolicy;

const vault = new SocialTokenVault({
  env: { SOCIAL_TOKEN_VAULT_KEK: FIXTURE_SOCIAL_KEK } as NodeJS.ProcessEnv,
});
const NOW = new Date(Date.UTC(2001, 0, 10, 9, 0));
const HOURS_AGO = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);
const applications = {
  resolve: async () => ({
    appId: 'fixture-app',
    clientSecret: 'fixture-secret',
    redirectUri: 'https://example.test/callback',
  }),
};

function enabledPolicy(): PublishingPolicy {
  const capability = {
    enabled: true,
    postKinds: ['text'],
    maxBodyCharacters: 2_200,
    maxHashtags: 30,
    maxMediaItems: 10,
    supportsFirstComment: false,
    supportsDelete: false,
    supportsNativeScheduling: false,
    // TRUE, so the verification can ASK the provider.
    supportsPostLookup: true,
    scopes: ['w_member_social'],
    targetKind: 'organization',
  };
  return parsePublishingPolicy({
    providers: {
      facebook: capability,
      instagram: capability,
      tiktok: capability,
      linkedin: capability,
      x: capability,
    },
  });
}

function inA<T>(fn: (db: TenantScopedClient) => Promise<T>): Promise<T> {
  return withWorkspace(fixtures.a.workspaceId, fn, { prisma: app }) as Promise<T>;
}

const sweep = () =>
  new MaintenanceScheduler({
    environment: 'DEVELOPMENT',
    clock: { now: () => NOW },
    socialApplications: applications,
    publishingPolicy: policy,
  }).sweepPublishing(500);

/** What `processVerifyJob` does with the message: recover the claim, and nothing else. */
const recover = (publishJobId: string) =>
  inA((db) =>
    new PublishPipelineService({
      db,
      workspaceId: fixtures.a.workspaceId,
      policy,
      registry: createConnectorRegistry({ policy, environment: 'DEVELOPMENT' }),
      vault,
      approvals: {
        policyForBrand: async () => ({ requireApprovalBeforeScheduling: false }),
        latestForItem: async () => ({ status: 'APPROVED' }),
      },
      clock: { now: () => NOW },
    }).recoverStaleClaim(publishJobId),
  );

/**
 * A PUBLISHING job claimed at `claimedAt`. `timeout` in the key makes the mock
 * provider's lookup answer "yes, it landed".
 */
async function stalledJob(claimedAt: Date): Promise<{ id: string; key: string }> {
  const key = `timeout-f1-${randomUUID()}`;
  const job = await inA((db) =>
    db.publishJob.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        calendarSlotId: fixtures.a.calendarSlotId,
        contentItemId: fixtures.a.contentItemId,
        contentVariantId: fixtures.a.contentVariantId,
        socialConnectionId: fixtures.a.socialConnectionId,
        provider: 'LINKEDIN',
        status: 'PUBLISHING',
        idempotencyKey: key,
        scheduledAtUtc: claimedAt,
        claimedAt,
        startedAt: claimedAt,
        attemptCount: 1,
        maxAttempts: 5,
        nextAttemptAt: null,
        createdByUserId: fixtures.a.userId,
      },
    }),
  );
  return { id: job.id, key };
}

const recoveries = (jobId: string) =>
  inA((db) =>
    db.auditEvent.count({
      where: { action: 'social.post.claim_recovered', resourceId: jobId },
    }),
  );

const queue = () => queueFor('publish-jobs');
const queuedKeys: string[] = [];

beforeAll(async () => {
  if (!queueUrl()) {
    throw new Error(
      'REDIS_URL is not configured. The dispatch is the defect this suite proves fixed; ' +
        'skipping it would leave the recovery unproven.',
    );
  }
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
  policy = enabledPolicy();
}, 60_000);

afterAll(async () => {
  for (const key of queuedKeys)
    await queue()
      .remove(key)
      .catch(() => undefined);
  await closeQueues();
  await app?.$disconnect();
});

describe('F1 · D-410 — the stale-claim sweep really sends the verification', () => {
  it('the verification key has no colon and differs from the publish message key', () => {
    const claimedAt = HOURS_AGO(3);
    const key = verifySocialPostJobKey('a'.repeat(64), claimedAt);
    expect(key).not.toContain(':');
    expect(key).toBe(`verify-${'a'.repeat(64)}-${claimedAt.getTime()}`);
    // The publish message for the same job is `<key>-<nextAttemptAt>`.
    expect(key.startsWith('verify-')).toBe(true);
  });

  it('a claim past its lease is dispatched as social.verify-post — once, however many sweeps see it', async () => {
    const claimedAt = HOURS_AGO(3);
    const job = await stalledJob(claimedAt);
    const id = verifySocialPostJobKey(job.key, claimedAt);
    queuedKeys.push(id);

    // THE DEFECT: before the fix nothing was ever queued under any id.
    const first = await sweep();
    expect(first.recovered).toBeGreaterThanOrEqual(1);
    const queued = await queue().getJob(id);
    expect(queued).toBeTruthy();
    expect(queued?.name).toBe(VERIFY_SOCIAL_POST);
    expect(queued?.data).toMatchObject({
      kind: VERIFY_SOCIAL_POST,
      workspaceId: fixtures.a.workspaceId,
      publishJobId: job.id,
      idempotencyKey: id,
    });

    // A SECOND SWEEP — or a second API replica — before the worker gets to it
    // builds the same id, and BullMQ keeps one job.
    await Promise.all([sweep(), sweep()]);
    expect((await queue().getJob(id))?.timestamp).toBe(queued?.timestamp);

    // THE WORKER: ask the provider. It answers "it landed", so PUBLISHED.
    const result = await recover(job.id);
    expect(result.status).toBe('PUBLISHED');
    expect(result.externalPostId).toBeTruthy();
    expect(await recoveries(job.id)).toBe(1);

    // A DUPLICATE DELIVERY, and a later sweep, change nothing: the row is no
    // longer PUBLISHING, so there is nothing left to recover or to dispatch.
    const again = await recover(job.id);
    expect(again.status).toBe('PUBLISHED');
    await sweep();
    expect(await recoveries(job.id)).toBe(1);
  });

  it('the same job stalling AGAIN later gets a new id — BullMQ keeps finished jobs', async () => {
    const firstClaim = HOURS_AGO(5);
    const job = await stalledJob(firstClaim);
    const firstId = verifySocialPostJobKey(job.key, firstClaim);
    queuedKeys.push(firstId);
    await sweep();
    expect(await queue().getJob(firstId)).toBeTruthy();

    // The job went round again (verified "not there", re-queued, re-claimed)
    // and stalled a second time, with a newer claim.
    const secondClaim = HOURS_AGO(2);
    await inA((db) =>
      db.publishJob.update({
        where: { id: job.id },
        data: { status: 'PUBLISHING', claimedAt: secondClaim },
      }),
    );
    const secondId = verifySocialPostJobKey(job.key, secondClaim);
    queuedKeys.push(secondId);
    expect(secondId).not.toBe(firstId);

    await sweep();
    const second = await queue().getJob(secondId);
    expect(second).toBeTruthy();
    expect(second?.data.publishJobId).toBe(job.id);
  });

  it('a claim still inside its lease is not dispatched — a live worker keeps it', async () => {
    const claimedAt = new Date(NOW.getTime() - 1_000);
    const job = await stalledJob(claimedAt);
    const id = verifySocialPostJobKey(job.key, claimedAt);
    queuedKeys.push(id);

    await sweep();
    expect(await queue().getJob(id)).toBeFalsy();
    const row = await inA((db) => db.publishJob.findUniqueOrThrow({ where: { id: job.id } }));
    expect(row.status).toBe('PUBLISHING');
  });
});
