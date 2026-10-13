import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import type { PublishFailureClass } from '@brandspace/database';
import {
  createConnectorRegistry,
  executePublishJob,
  parsePublishingPolicy,
  PublishPipelineService,
  recoverStalePublishJob,
  SocialTokenVault,
  type PipelineTransactions,
  type PublishApprovalGate,
  type PublishingPolicy,
  type SocialConnectorAdapter,
} from '@brandspace/social-connectors';
import type { Clock } from '@brandspace/shared';
import {
  appRoleClient,
  createIsolationFixtures,
  FIXTURE_SOCIAL_KEK,
  type IsolationFixtures,
} from './fixtures';

/**
 * CONNECTORS A, W1 (D-505) — NO PROVIDER CALL RUNS INSIDE A TRANSACTION.
 *
 * THE DEFECT. The worker ran the claim, the provider call and the outcome in
 * ONE tenant transaction. A provider slower than that transaction's timeout
 * aborted it: the claim rolled back to QUEUED while the post was possibly
 * live, and the redelivery called `publish()` again — a duplicate post from
 * nothing more than a slow platform.
 *
 * THE RULE THESE TESTS HOLD. The claim and preflight commit first; the
 * provider is called outside any transaction; the outcome is recorded in a
 * second one, fenced on the claim. Each test runs every step with a
 * transaction timeout of ONE SECOND and a provider that takes longer than
 * that, and counts the provider's calls — "never twice" is only provable if
 * the calls are observable.
 */

const TX_TIMEOUT_MS = 1_000;
const SLOWER_THAN_THE_TRANSACTION_MS = 1_600;

let app: PrismaClient;
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Answer = 'ok' | PublishFailureClass;
type Lookup = 'found' | 'absent' | 'throws';

/** The real LinkedIn mock, slowed down, with `publish()` and the lookup scripted and counted. */
function slowProvider(answer: Answer, lookup: Lookup = 'absent', lookupDelayMs = 0) {
  const counts = { publish: 0, lookup: 0 };
  const real = createConnectorRegistry({ policy, environment: 'DEVELOPMENT' }).get('LINKEDIN');
  const publish: SocialConnectorAdapter['publish'] = async (input) => {
    counts.publish += 1;
    await sleep(SLOWER_THAN_THE_TRANSACTION_MS);
    if (answer === 'ok') return real.publish(input);
    return {
      ok: false,
      failureClass: answer,
      failureCode: `scripted.${answer.toLowerCase()}`,
      providerStatusCode: 504,
      providerErrorCode: 'SCRIPTED',
      safeSummary: 'Scripted failure.',
    };
  };
  const findPostByIdempotencyKey: NonNullable<
    SocialConnectorAdapter['findPostByIdempotencyKey']
  > = async () => {
    counts.lookup += 1;
    await sleep(lookupDelayMs);
    if (lookup === 'throws') throw new Error('lookup unavailable');
    return lookup === 'found'
      ? { externalPostId: `w1-found-${randomUUID()}`, externalPostUrl: null }
      : null;
  };
  const adapter = new Proxy(real, {
    get(target, property) {
      if (property === 'publish') return publish;
      if (property === 'findPostByIdempotencyKey') return findPostByIdempotencyKey;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
  const registry = createConnectorRegistry({
    policy,
    environment: 'DEVELOPMENT',
    adapters: { LINKEDIN: adapter },
  });
  return { counts, registry };
}

/**
 * EXACTLY HOW THE WORKER RUNS A JOB: every step in a tenant transaction of
 * its own, here with a one-second timeout the provider is slower than.
 */
function transactions(
  registry: ReturnType<typeof createConnectorRegistry>,
  clock?: Clock,
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
              registry,
              vault,
              approvals,
              ...(clock ? { clock } : {}),
            }),
          ),
        { prisma: app, timeoutMs: TX_TIMEOUT_MS },
      ),
  };
}

async function seedJob(): Promise<string> {
  return withWorkspace(
    fixtures.a.workspaceId,
    async (db) => {
      const job = await db.publishJob.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          calendarSlotId: fixtures.a.calendarSlotId,
          contentItemId: fixtures.a.contentItemId,
          contentVariantId: fixtures.a.contentVariantId,
          socialConnectionId: fixtures.a.socialConnectionId,
          provider: 'LINKEDIN',
          status: 'QUEUED',
          idempotencyKey: `w1-split-${randomUUID()}`,
          scheduledAtUtc: new Date(),
          maxAttempts: policy.retry.maxAttempts,
          nextAttemptAt: new Date(),
          createdByUserId: fixtures.a.userId,
        },
      });
      return job.id;
    },
    { prisma: app },
  );
}

async function readJob(jobId: string) {
  return withWorkspace(
    fixtures.a.workspaceId,
    async (db) => db.publishJob.findFirstOrThrow({ where: { id: jobId } }),
    { prisma: app },
  );
}

async function attempts(jobId: string) {
  return withWorkspace(
    fixtures.a.workspaceId,
    async (db) =>
      db.publishAttempt.findMany({
        where: { publishJobId: jobId },
        orderBy: { attemptNumber: 'asc' },
        select: { attemptNumber: true, outcome: true },
      }),
    { prisma: app },
  );
}

beforeAll(async () => {
  app = appRoleClient();
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
  policy = parsePublishingPolicy({ providers: { linkedin: capability } });
  await withWorkspace(
    fixtures.a.workspaceId,
    async (db) =>
      db.contentItem.update({
        where: { id: fixtures.a.contentItemId },
        data: { status: 'SCHEDULED' },
      }),
    { prisma: app },
  );
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

describe('W1 — a provider slower than the transaction timeout', () => {
  it('THE DEFECT, REPRODUCED: one transaction around the call rolls the claim back to QUEUED and the redelivery sends again', async () => {
    // The control. Without it, the tests below could pass only because the
    // provider was not, in fact, slower than the transaction.
    const provider = slowProvider('ok');
    const jobId = await seedJob();
    const inOneTransaction = () =>
      withWorkspace(
        fixtures.a.workspaceId,
        async (db) =>
          new PublishPipelineService({
            db,
            workspaceId: fixtures.a.workspaceId,
            policy,
            registry: provider.registry,
            vault,
            approvals,
          }).execute(jobId),
        { prisma: app, timeoutMs: TX_TIMEOUT_MS },
      );

    await expect(inOneTransaction()).rejects.toThrow();
    expect((await readJob(jobId)).status).toBe('QUEUED');
    await expect(inOneTransaction()).rejects.toThrow();
    expect(provider.counts.publish).toBe(2);
  });

  it('never returns the job to QUEUED, and a redelivery never calls publish() twice', async () => {
    const provider = slowProvider('ok');
    const jobId = await seedJob();
    const run = transactions(provider.registry);

    const first = executePublishJob(run, jobId);
    // WHILE THE PROVIDER IS STILL ANSWERING: the claim is committed, and the
    // same message delivered again finds it and sends nothing.
    await sleep(SLOWER_THAN_THE_TRANSACTION_MS / 2);
    expect((await readJob(jobId)).status).toBe('PUBLISHING');
    const duringTheCall = await executePublishJob(run, jobId);
    expect(duringTheCall.status).toBe('PUBLISHING');

    const result = await first;
    const afterTheCall = await executePublishJob(run, jobId);

    expect({
      result: result.status,
      redeliveredAfter: afterTheCall.status,
      job: (await readJob(jobId)).status,
      publishCalls: provider.counts.publish,
      attempts: await attempts(jobId),
    }).toEqual({
      result: 'PUBLISHED',
      redeliveredAfter: 'PUBLISHED',
      job: 'PUBLISHED',
      publishCalls: 1,
      attempts: [{ attemptNumber: 1, outcome: 'SUCCEEDED' }],
    });
  });

  it('an indeterminate answer whose lookup is slow AND throws is held for verification, never re-queued', async () => {
    const provider = slowProvider('TIMEOUT', 'throws', SLOWER_THAN_THE_TRANSACTION_MS);
    const jobId = await seedJob();
    const run = transactions(provider.registry);

    const result = await executePublishJob(run, jobId);
    const redelivered = await executePublishJob(run, jobId);

    expect({
      result: result.status,
      redelivered: redelivered.status,
      publishCalls: provider.counts.publish,
      lookups: provider.counts.lookup,
      attempts: await attempts(jobId),
    }).toEqual({
      result: 'VERIFICATION_PENDING',
      redelivered: 'VERIFICATION_PENDING',
      publishCalls: 1,
      lookups: 1,
      attempts: [{ attemptNumber: 1, outcome: 'INDETERMINATE' }],
    });
  });

  it('an indeterminate answer whose slow lookup finds the post is PUBLISHED', async () => {
    const provider = slowProvider('TIMEOUT', 'found', SLOWER_THAN_THE_TRANSACTION_MS);
    const jobId = await seedJob();

    const result = await executePublishJob(transactions(provider.registry), jobId);

    expect(result.status).toBe('PUBLISHED');
    expect(provider.counts).toEqual({ publish: 1, lookup: 1 });
  });
});

describe('W1 — recovery and verification ask outside any transaction', () => {
  const anHourLater: Clock = { now: () => new Date(Date.now() + 60 * 60_000) };

  it('a slow lookup during recovery does not undo the recovery, and never publishes', async () => {
    const provider = slowProvider('ok', 'found', SLOWER_THAN_THE_TRANSACTION_MS);
    const jobId = await seedJob();
    // A claim whose worker died: PUBLISHING, with a claim long past its lease.
    await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.publishJob.update({
          where: { id: jobId },
          data: { status: 'PUBLISHING', claimedAt: new Date(), startedAt: new Date() },
        }),
      { prisma: app },
    );

    const result = await recoverStalePublishJob(
      transactions(provider.registry, anHourLater),
      jobId,
    );

    expect({
      result: result.status,
      job: (await readJob(jobId)).status,
      counts: provider.counts,
      attempts: await attempts(jobId),
    }).toEqual({
      result: 'PUBLISHED',
      job: 'PUBLISHED',
      counts: { publish: 0, lookup: 1 },
      attempts: [{ attemptNumber: 1, outcome: 'INDETERMINATE' }],
    });
  });

  it('a worker that answers AFTER recovery re-queued its job still records the post it published — and nothing sends twice', async () => {
    const provider = slowProvider('ok', 'absent');
    const jobId = await seedJob();
    const run = transactions(provider.registry);

    const worker = executePublishJob(run, jobId);
    await sleep(SLOWER_THAN_THE_TRANSACTION_MS / 2);
    // Recovery decides the claim is dead, asks, hears "not there", re-queues.
    const recovered = await recoverStalePublishJob(
      transactions(provider.registry, anHourLater),
      jobId,
    );
    expect(recovered.status).toBe('QUEUED');

    const result = await worker;

    expect({
      result: result.status,
      job: (await readJob(jobId)).status,
      publishCalls: provider.counts.publish,
      attempts: await attempts(jobId),
    }).toEqual({
      result: 'PUBLISHED',
      job: 'PUBLISHED',
      publishCalls: 1,
      // The unknown-send-state row recovery wrote, then the worker's answer —
      // numbered when it was recorded, so the two never collide.
      attempts: [
        { attemptNumber: 1, outcome: 'INDETERMINATE' },
        { attemptNumber: 2, outcome: 'SUCCEEDED' },
      ],
    });
  });
});
