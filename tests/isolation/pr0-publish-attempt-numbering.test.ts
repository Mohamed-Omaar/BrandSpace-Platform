import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import type { PublishFailureClass } from '@brandspace/database';
import {
  createConnectorRegistry,
  parsePublishingPolicy,
  PublishPipelineService,
  SocialTokenVault,
  type PublishApprovalGate,
  type PublishingPolicy,
  type SocialConnectorAdapter,
} from '@brandspace/social-connectors';
import {
  appRoleClient,
  createIsolationFixtures,
  FIXTURE_SOCIAL_KEK,
  type IsolationFixtures,
} from './fixtures';

/**
 * PR 0 — PUBLISH ATTEMPT NUMBERS ARE MONOTONIC ACROSS EVERY HUMAN RETRY.
 *
 * THE DEFECT. `execute()` numbers the next provider attempt `attemptCount + 1`
 * and records it AFTER the provider call, under
 * `@@unique([workspaceId, publishJobId, attemptNumber])`. The three human
 * paths — `retry()`, `retryOnReconnectedAccount()` and
 * `resolveVerification(NOT_PUBLISHED)` — reset `attemptCount` to 0, so the
 * next execution re-used attempt number 1: the provider was called, and then
 * recording what it said collided with the attempt history. The worker runs
 * `execute()` in one tenant transaction, so the collision rolled the claim
 * back to QUEUED and a redelivery CALLED THE PROVIDER AGAIN.
 *
 * THE RULE THESE TESTS HOLD. `attemptCount` never moves backwards and attempt
 * rows are never rewritten or renumbered; a human retry grants a fresh budget
 * by extending `maxAttempts` instead. The budget and the automatic backoff a
 * person sees after pressing Retry are exactly what they were before.
 *
 * THE PROVIDER IS SCRIPTED AND COUNTED. The mocks choose their behaviour from
 * the idempotency key, which a retry does not change, so each test wraps the
 * real mock adapter and scripts the outcome of each call in turn — and counts
 * the calls, because "no duplicate provider publish" is only provable if the
 * calls are observable.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;
let policy: PublishingPolicy;
/** The same policy with post lookup switched off: an indeterminate outcome must wait for a person. */
let noLookupPolicy: PublishingPolicy;

const vault = new SocialTokenVault({
  env: { SOCIAL_TOKEN_VAULT_KEK: FIXTURE_SOCIAL_KEK } as NodeJS.ProcessEnv,
});

function policyWith(supportsPostLookup: boolean): PublishingPolicy {
  const capability = {
    enabled: true,
    postKinds: ['text'],
    maxBodyCharacters: 2_200,
    maxHashtags: 30,
    maxMediaItems: 10,
    supportsFirstComment: false,
    supportsDelete: false,
    supportsNativeScheduling: false,
    supportsPostLookup,
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

const approvals: PublishApprovalGate = {
  async policyForBrand() {
    return { requireApprovalBeforeScheduling: false };
  },
  async latestForItem() {
    return { status: 'APPROVED' };
  },
};

/** What the scripted provider answers on one call. */
type Step = 'ok' | PublishFailureClass;

interface ScriptedProvider {
  /** Every call the pipeline made to `publish()`, in order. */
  readonly calls: number;
  readonly registryFor: (active: PublishingPolicy) => ReturnType<typeof createConnectorRegistry>;
}

/**
 * The real LinkedIn mock, with `publish()` answering from a script.
 *
 * A PROXY rather than a subclass or a spread: the mock keeps state in private
 * fields, so every other method must run on the real instance.
 */
function scriptedProvider(steps: readonly Step[]): ScriptedProvider {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    registryFor(active) {
      const real = createConnectorRegistry({ policy: active, environment: 'DEVELOPMENT' }).get(
        'LINKEDIN',
      );
      const publish: SocialConnectorAdapter['publish'] = async (input) => {
        const step = steps[calls];
        calls += 1;
        if (step === undefined) throw new Error(`unscripted provider call #${calls}`);
        if (step === 'ok') return real.publish(input);
        return {
          ok: false,
          failureClass: step,
          failureCode: `scripted.${step.toLowerCase()}`,
          providerStatusCode: 500,
          providerErrorCode: 'SCRIPTED',
          safeSummary: 'Scripted failure.',
        } as Awaited<ReturnType<SocialConnectorAdapter['publish']>>;
      };
      const adapter = new Proxy(real, {
        get(target, property) {
          if (property === 'publish') return publish;
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
        },
      });
      return createConnectorRegistry({
        policy: active,
        environment: 'DEVELOPMENT',
        adapters: { LINKEDIN: adapter },
      });
    },
  };
}

type Pipeline = PublishPipelineService;

/** One pipeline call in its own tenant transaction — exactly how the worker runs `execute()`. */
function inPipeline<T>(
  provider: ScriptedProvider,
  fn: (pipeline: Pipeline) => Promise<T>,
  active: PublishingPolicy = policy,
): Promise<T> {
  return withWorkspace(
    fixtures.a.workspaceId,
    async (db) =>
      fn(
        new PublishPipelineService({
          db,
          workspaceId: fixtures.a.workspaceId,
          policy: active,
          registry: provider.registryFor(active),
          vault,
          approvals,
        }),
      ),
    { prisma: app },
  ) as Promise<T>;
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
          idempotencyKey: `pr0-attempts-${randomUUID()}`,
          scheduledAtUtc: new Date(),
          // As `materialiseSlot` creates every job: the policy's own budget.
          maxAttempts: policy.retry.maxAttempts,
          nextAttemptAt: new Date(),
          createdByUserId: fixtures.a.userId,
        },
      });
      return job.id;
    },
    { prisma: app },
  ) as Promise<string>;
}

async function readJob(jobId: string) {
  return withWorkspace(
    fixtures.a.workspaceId,
    async (db) => db.publishJob.findFirstOrThrow({ where: { id: jobId } }),
    { prisma: app },
  );
}

async function attemptNumbers(jobId: string): Promise<number[]> {
  const rows = await withWorkspace(
    fixtures.a.workspaceId,
    async (db) =>
      db.publishAttempt.findMany({
        where: { publishJobId: jobId },
        orderBy: { attemptNumber: 'asc' },
        select: { attemptNumber: true },
      }),
    { prisma: app },
  );
  return rows.map((row) => row.attemptNumber);
}

const human = () => ({ actorUserId: fixtures.a.userId, brandScope: [] as string[] });

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
  policy = policyWith(true);
  noLookupPolicy = policyWith(false);
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

afterEach(async () => {
  // The reconnect case marks the fixture's connection NEEDS_REAUTH; every test
  // starts from a live one.
  await withWorkspace(
    fixtures.a.workspaceId,
    async (db) =>
      db.socialConnection.update({
        where: { id: fixtures.a.socialConnectionId },
        data: { status: 'ACTIVE', lastFailureClass: null, consecutiveFailureCount: 0 },
      }),
    { prisma: app },
  );
});

afterAll(async () => {
  await app?.$disconnect();
});

describe('PR 0 — a manual retry continues the attempt history, it never rewinds it', () => {
  it('attempt 1 fails → Retry → the next provider attempt is attempt 2', async () => {
    const provider = scriptedProvider(['CONTENT_REJECTED', 'ok']);
    const jobId = await seedJob();

    const first = await inPipeline(provider, (pipeline) => pipeline.execute(jobId));
    expect(first.status).toBe('FAILED');
    expect(await attemptNumbers(jobId)).toEqual([1]);

    await inPipeline(provider, (pipeline) => pipeline.retry({ jobId, ...human() }));
    const queued = await readJob(jobId);
    // THE HISTORY IS NOT REWOUND: the count stays where it was, and the fresh
    // budget is granted by extending the ceiling instead.
    expect(queued.status).toBe('QUEUED');
    expect(queued.attemptCount).toBe(1);
    expect(queued.maxAttempts).toBe(1 + policy.retry.maxAttempts);

    const second = await inPipeline(provider, (pipeline) => pipeline.execute(jobId));
    expect(second.status).toBe('PUBLISHED');
    expect(await attemptNumbers(jobId)).toEqual([1, 2]);
    expect(provider.calls).toBe(2);

    const published = await readJob(jobId);
    expect(published.attemptCount).toBe(2);
    expect(published.attemptCount).toBeLessThanOrEqual(published.maxAttempts);
  });

  it('THE REPRODUCTION: after a retry, recording the attempt must not collide and a redelivery must not send again', async () => {
    const provider = scriptedProvider(['CONTENT_REJECTED', 'ok', 'ok']);
    const jobId = await seedJob();

    await inPipeline(provider, (pipeline) => pipeline.execute(jobId));
    await inPipeline(provider, (pipeline) => pipeline.retry({ jobId, ...human() }));

    // The execution after the retry, then the SAME message delivered again — a
    // BullMQ redelivery or a second worker. Errors are collected rather than
    // thrown so the whole sequence is visible in one failure message.
    const errors: string[] = [];
    for (let delivery = 0; delivery < 2; delivery += 1) {
      await inPipeline(provider, (pipeline) => pipeline.execute(jobId)).catch((error: unknown) => {
        errors.push(
          error instanceof Error ? (error.message.split('\n').at(-1) ?? '') : String(error),
        );
      });
    }
    const job = await readJob(jobId);

    expect({
      errors,
      providerCalls: provider.calls,
      status: job.status,
      attemptNumbers: await attemptNumbers(jobId),
    }).toEqual({
      errors: [],
      providerCalls: 2,
      status: 'PUBLISHED',
      attemptNumbers: [1, 2],
    });
  });

  it('repeated retries number 1, 2, 3, 4 — never 1, 1, 1', async () => {
    const provider = scriptedProvider([
      'CONTENT_REJECTED',
      'CONTENT_REJECTED',
      'CONTENT_REJECTED',
      'ok',
    ]);
    const jobId = await seedJob();

    await inPipeline(provider, (pipeline) => pipeline.execute(jobId));
    for (let round = 0; round < 3; round += 1) {
      await inPipeline(provider, (pipeline) => pipeline.retry({ jobId, ...human() }));
      await inPipeline(provider, (pipeline) => pipeline.execute(jobId));
    }

    expect(await attemptNumbers(jobId)).toEqual([1, 2, 3, 4]);
    expect(provider.calls).toBe(4);
    const job = await readJob(jobId);
    expect(job.status).toBe('PUBLISHED');
    expect(job.attemptCount).toBe(4);
    expect(job.attemptCount).toBeLessThanOrEqual(job.maxAttempts);
  });

  it('a job the OLD code already rewound continues after its highest recorded attempt', async () => {
    // What production may already hold: attempts 1 and 2 on record, and a
    // human retry that reset the counter to 0 before PR 0 shipped.
    const provider = scriptedProvider(['ok']);
    const jobId = await seedJob();
    await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => {
        for (const attemptNumber of [1, 2]) {
          await db.publishAttempt.create({
            data: {
              workspaceId: fixtures.a.workspaceId,
              publishJobId: jobId,
              attemptNumber,
              startedAt: new Date(),
              finishedAt: new Date(),
              durationMs: 0,
              outcome: 'PERMANENT_FAILURE',
              failureClass: 'CONTENT_REJECTED',
            },
          });
        }
      },
      { prisma: app },
    );

    const result = await inPipeline(provider, (pipeline) => pipeline.execute(jobId));
    expect(result.status).toBe('PUBLISHED');
    expect(await attemptNumbers(jobId)).toEqual([1, 2, 3]);
    expect(provider.calls).toBe(1);
  });

  it('retryOnReconnectedAccount continues the numbering too', async () => {
    const provider = scriptedProvider(['AUTH_REVOKED', 'ok']);
    const jobId = await seedJob();

    const first = await inPipeline(provider, (pipeline) => pipeline.execute(jobId));
    expect(first.status).toBe('FAILED');
    const failed = await readJob(jobId);

    // The account is reconnected AFTER the failure — the precondition the
    // reconnect retry exists for.
    await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.socialConnection.update({
          where: { id: fixtures.a.socialConnectionId },
          data: {
            status: 'ACTIVE',
            lastFailureClass: null,
            consecutiveFailureCount: 0,
            lastRefreshedAt: new Date((failed.completedAt ?? new Date()).getTime() + 1_000),
          },
        }),
      { prisma: app },
    );

    await inPipeline(provider, (pipeline) =>
      pipeline.retryOnReconnectedAccount({ jobId, ...human() }),
    );
    const queued = await readJob(jobId);
    expect(queued.attemptCount).toBe(1);
    expect(queued.maxAttempts).toBe(1 + policy.retry.maxAttempts);

    const second = await inPipeline(provider, (pipeline) => pipeline.execute(jobId));
    expect(second.status).toBe('PUBLISHED');
    expect(await attemptNumbers(jobId)).toEqual([1, 2]);
    expect(provider.calls).toBe(2);
  });

  it('resolveVerification(NOT_PUBLISHED) continues the numbering too', async () => {
    // No post lookup: an indeterminate outcome waits for a person.
    const provider = scriptedProvider(['TIMEOUT', 'ok']);
    const jobId = await seedJob();

    const first = await inPipeline(provider, (pipeline) => pipeline.execute(jobId), noLookupPolicy);
    expect(first.status).toBe('VERIFICATION_PENDING');
    expect(await attemptNumbers(jobId)).toEqual([1]);

    await inPipeline(
      provider,
      (pipeline) =>
        pipeline.resolveVerification({ jobId, resolution: 'NOT_PUBLISHED', ...human() }),
      noLookupPolicy,
    );
    const queued = await readJob(jobId);
    expect(queued.status).toBe('QUEUED');
    expect(queued.attemptCount).toBe(1);
    expect(queued.maxAttempts).toBe(1 + noLookupPolicy.retry.maxAttempts);

    const second = await inPipeline(
      provider,
      (pipeline) => pipeline.execute(jobId),
      noLookupPolicy,
    );
    expect(second.status).toBe('PUBLISHED');
    expect(await attemptNumbers(jobId)).toEqual([1, 2]);
    expect(provider.calls).toBe(2);
  });
});

describe('PR 0 — the safety rules around it are unchanged', () => {
  it('an INDETERMINATE outcome is verified, never re-sent — with or without a lookup', async () => {
    // With lookup: the scripted timeout is followed by the mock's own lookup,
    // which finds the post because the key names `timeout`.
    const provider = scriptedProvider(['TIMEOUT']);
    const jobId = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        (
          await db.publishJob.create({
            data: {
              workspaceId: fixtures.a.workspaceId,
              brandId: fixtures.a.brandId,
              calendarSlotId: fixtures.a.calendarSlotId,
              contentItemId: fixtures.a.contentItemId,
              contentVariantId: fixtures.a.contentVariantId,
              socialConnectionId: fixtures.a.socialConnectionId,
              provider: 'LINKEDIN',
              status: 'QUEUED',
              idempotencyKey: `pr0-timeout-${randomUUID()}`,
              scheduledAtUtc: new Date(),
              maxAttempts: policy.retry.maxAttempts,
              nextAttemptAt: new Date(),
              createdByUserId: fixtures.a.userId,
            },
          })
        ).id,
      { prisma: app },
    );
    const verified = await inPipeline(provider, (pipeline) => pipeline.execute(jobId));
    expect(verified.status).toBe('PUBLISHED');
    expect(provider.calls).toBe(1);

    // Without lookup: VERIFICATION_PENDING, and a redelivery sends nothing.
    const waiting = scriptedProvider(['TIMEOUT']);
    const pendingId = await seedJob();
    const pending = await inPipeline(
      waiting,
      (pipeline) => pipeline.execute(pendingId),
      noLookupPolicy,
    );
    expect(pending.status).toBe('VERIFICATION_PENDING');
    const redelivered = await inPipeline(
      waiting,
      (pipeline) => pipeline.execute(pendingId),
      noLookupPolicy,
    );
    expect(redelivered.status).toBe('VERIFICATION_PENDING');
    expect(waiting.calls).toBe(1);
  });

  it('a human retry grants exactly the policy budget, with the first backoff step', async () => {
    const budget = policy.retry.maxAttempts;
    // One rejection, then nothing but rate limits: the fresh budget is spent
    // entirely on automatic retries and the job then fails.
    const provider = scriptedProvider([
      'CONTENT_REJECTED',
      ...Array.from({ length: budget }, () => 'RATE_LIMITED' as const),
    ]);
    const jobId = await seedJob();
    await inPipeline(provider, (pipeline) => pipeline.execute(jobId));
    await inPipeline(provider, (pipeline) => pipeline.retry({ jobId, ...human() }));

    const before = Date.now();
    const firstAfterRetry = await inPipeline(provider, (pipeline) => pipeline.execute(jobId));
    const scheduled = await readJob(jobId);
    if (budget > 1) {
      expect(firstAfterRetry.status).toBe('QUEUED');
      // THE FIRST STEP OF THE BACKOFF, as it was when the count was reset — not
      // a step computed from the whole history.
      const delaySeconds = ((scheduled.nextAttemptAt?.getTime() ?? 0) - before) / 1_000;
      const initial = policy.retry.initialBackoffSeconds;
      const spread = initial * policy.retry.jitterRatio;
      expect(delaySeconds).toBeGreaterThanOrEqual(Math.max(1, initial - spread) - 2);
      expect(delaySeconds).toBeLessThanOrEqual(initial + spread + 2);
    }

    for (let attempt = 2; attempt <= budget; attempt += 1) {
      await inPipeline(provider, (pipeline) => pipeline.execute(jobId));
    }
    const exhausted = await readJob(jobId);
    expect(exhausted.status).toBe('FAILED');
    expect(provider.calls).toBe(1 + budget);
    expect(exhausted.attemptCount).toBe(1 + budget);
    expect(exhausted.attemptCount).toBe(exhausted.maxAttempts);
    expect(await attemptNumbers(jobId)).toEqual(
      Array.from({ length: 1 + budget }, (_, index) => index + 1),
    );
  });

  it('no job ever holds two attempts with the same number', async () => {
    const duplicates = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.$queryRaw<{ count: bigint }[]>`
          SELECT count(*)::bigint AS "count" FROM (
            SELECT "publishJobId", "attemptNumber" FROM "publish_attempt"
             GROUP BY 1, 2 HAVING count(*) > 1
          ) AS "dupes"`,
      { prisma: app },
    );
    expect(Number(duplicates[0]?.count ?? 0)).toBe(0);
  });
});
