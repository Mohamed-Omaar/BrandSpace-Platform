import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import {
  createConnectorRegistry,
  parsePublishingPolicy,
  PublishPipelineService,
  publishIdempotencyKey,
  SocialTokenVault,
  type ConnectorRegistry,
  type PublishApprovalGate,
  type PublishingPolicy,
} from '@brandspace/social-connectors';
import {
  appRoleClient,
  createIsolationFixtures,
  FIXTURE_SOCIAL_KEK,
  type IsolationFixtures,
} from './fixtures';

/**
 * The publishing pipeline, against real PostgreSQL and the deterministic mocks.
 *
 * WHAT THIS SUITE IS ACTUALLY PROVING. Not that a happy path works — that was
 * never in doubt. It proves the four properties a customer's reputation rests
 * on:
 *
 *   1. A post goes out ONCE. Two dispatches, two workers, a replayed message —
 *      all of them converge on one external post.
 *   2. AN UNCERTAIN OUTCOME IS NEVER RESENT. A timeout is verified, not retried.
 *   3. CONTENT IN REVIEW NEVER PUBLISHES, whatever the calendar says.
 *   4. A FAILURE IS CLASSIFIED, and the class decides what happens next —
 *      rather than everything being retried five times because it failed.
 *
 * THE MOCKS ARE DETERMINISTIC BY IDEMPOTENCY KEY, so each behaviour below is
 * selected by naming it rather than by mutating shared state — which is what
 * makes these safe to run in any order and impossible to make flaky.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;
let policy: PublishingPolicy;

const vault = new SocialTokenVault({
  env: { SOCIAL_TOKEN_VAULT_KEK: FIXTURE_SOCIAL_KEK } as NodeJS.ProcessEnv,
});

/** Every provider enabled, so the registry hands back a working adapter. */
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
    // TRUE, so the indeterminate path can be VERIFIED rather than abandoned.
    // The test below flips it to false to prove the other branch.
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

/** An approval gate that answers however a test needs it to. */
function gate(options: { required: boolean; status?: string | null }): PublishApprovalGate {
  return {
    async policyForBrand() {
      return { requireApprovalBeforeScheduling: options.required };
    },
    async openForItem() {
      return options.status === undefined
        ? { status: 'APPROVED' }
        : options.status === null
          ? null
          : { status: options.status };
    },
  };
}

type Db = Parameters<Parameters<typeof withWorkspace>[1]>[0];

function pipelineIn<T>(
  workspaceId: string,
  fn: (pipeline: PublishPipelineService, db: Db) => Promise<T>,
  options: { policy?: PublishingPolicy; approvals?: PublishApprovalGate } = {},
): Promise<T> {
  const active = options.policy ?? policy;
  return withWorkspace(
    workspaceId,
    async (db) =>
      fn(
        new PublishPipelineService({
          db,
          workspaceId,
          policy: active,
          registry: createConnectorRegistry({ policy: active, environment: 'DEVELOPMENT' }),
          vault,
          approvals: options.approvals ?? gate({ required: false }),
        }),
        db as never,
      ),
    { prisma: app },
  ) as Promise<T>;
}

/** A fresh QUEUED job with a caller-chosen idempotency key, so a mock behaviour can be selected. */
async function seedJob(key: string, overrides: Record<string, unknown> = {}): Promise<string> {
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
          idempotencyKey: key,
          scheduledAtUtc: new Date(),
          maxAttempts: 5,
          nextAttemptAt: new Date(),
          createdByUserId: fixtures.a.userId,
          ...overrides,
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
    async (db) => db.publishJob.findFirst({ where: { id: jobId } }),
    { prisma: app },
  );
}

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
  policy = enabledPolicy();
  // The item must be publishable: the fixture leaves it wherever Phase 5B-3 put
  // it, and every test here is about the PIPELINE rather than the lifecycle.
  await withWorkspace(
    fixtures.a.workspaceId,
    async (db) => {
      await db.contentItem.update({
        where: { id: fixtures.a.contentItemId },
        data: { status: 'SCHEDULED' },
      });
    },
    { prisma: app },
  );
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

describe('the idempotency key is derived, so it cannot differ between callers', () => {
  it('is a pure function of the four ids', () => {
    const input = {
      workspaceId: 'w',
      calendarSlotId: 's',
      socialConnectionId: 'c',
      contentVariantId: 'v',
    };
    expect(publishIdempotencyKey(input)).toBe(publishIdempotencyKey(input));
  });

  it('differs when ANY of the four differs', () => {
    const base = {
      workspaceId: 'w',
      calendarSlotId: 's',
      socialConnectionId: 'c',
      contentVariantId: 'v',
    };
    const keys = new Set([
      publishIdempotencyKey(base),
      publishIdempotencyKey({ ...base, workspaceId: 'w2' }),
      publishIdempotencyKey({ ...base, calendarSlotId: 's2' }),
      publishIdempotencyKey({ ...base, socialConnectionId: 'c2' }),
      publishIdempotencyKey({ ...base, contentVariantId: 'v2' }),
    ]);
    expect(keys.size).toBe(5);
  });

  it('carries NO clock and NO randomness — the same call, an hour later, is the same key', () => {
    const input = {
      workspaceId: fixtures.a.workspaceId,
      calendarSlotId: fixtures.a.calendarSlotId,
      socialConnectionId: fixtures.a.socialConnectionId,
      contentVariantId: fixtures.a.contentVariantId,
    };
    const first = publishIdempotencyKey(input);
    expect(publishIdempotencyKey(input)).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('a post goes out once', () => {
  it('publishes, records the external id, and settles the lifecycle', async () => {
    const jobId = await seedJob(`ok-${randomUUID()}`);
    const result = await pipelineIn(fixtures.a.workspaceId, (pipeline) => pipeline.execute(jobId));
    expect(result.status).toBe('PUBLISHED');
    expect(result.externalPostId).toBeTruthy();

    const job = await readJob(jobId);
    expect(job?.status).toBe('PUBLISHED');
    expect(job?.publishedAt).not.toBeNull();
    expect(job?.failureClass).toBeNull();
  });

  it('A SECOND EXECUTION DOES NOT SEND AGAIN — it reports what already happened', async () => {
    const jobId = await seedJob(`once-${randomUUID()}`);
    const first = await pipelineIn(fixtures.a.workspaceId, (pipeline) => pipeline.execute(jobId));
    const second = await pipelineIn(fixtures.a.workspaceId, (pipeline) => pipeline.execute(jobId));

    expect(first.status).toBe('PUBLISHED');
    // The claim fails because the job is no longer QUEUED, so the second call
    // returns the row's state rather than making a second external call.
    expect(second.status).toBe('PUBLISHED');
    expect(second.externalPostId).toBe(first.externalPostId);

    const attempts = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.publishAttempt.count({ where: { publishJobId: jobId } }),
      { prisma: app },
    );
    // ONE attempt, not two. The evidence trail agrees that one call was made.
    expect(attempts).toBe(1);
  });

  it('the derived key refuses a second job for the same triple', async () => {
    const key = publishIdempotencyKey({
      workspaceId: fixtures.a.workspaceId,
      calendarSlotId: fixtures.a.calendarSlotId,
      socialConnectionId: fixtures.a.socialConnectionId,
      contentVariantId: fixtures.a.contentVariantId,
    });
    const jobId = await seedJob(key);
    await expect(seedJob(key)).rejects.toThrow();
    await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.publishJob.delete({ where: { id: jobId } }),
      { prisma: app },
    );
  });
});

describe('failures are classified, and the class decides what happens next', () => {
  it('a rejected caption is PERMANENT — retrying would reject it again', async () => {
    const jobId = await seedJob(`reject-content-${randomUUID()}`);
    const result = await pipelineIn(fixtures.a.workspaceId, (pipeline) => pipeline.execute(jobId));
    expect(result.status).toBe('FAILED');
    expect(result.failureClass).toBe('CONTENT_REJECTED');

    const job = await readJob(jobId);
    expect(job?.nextAttemptAt).toBeNull();
    expect(job?.attemptCount).toBe(1);
  });

  it('a rate limit is RETRYABLE, and honours the provider Retry-After', async () => {
    const jobId = await seedJob(`rate-limit-${randomUUID()}`);
    const result = await pipelineIn(fixtures.a.workspaceId, (pipeline) => pipeline.execute(jobId));
    expect(result.status).toBe('QUEUED');
    expect(result.failureClass).toBe('RATE_LIMITED');

    const job = await readJob(jobId);
    expect(job?.nextAttemptAt).not.toBeNull();
    // The mock returns Retry-After: 60. With jitter at ±20% the window is
    // 48–72 seconds, so the assertion is a RANGE rather than a magic number.
    const delayMs = (job?.nextAttemptAt?.getTime() ?? 0) - Date.now();
    expect(delayMs).toBeGreaterThan(40_000);
    expect(delayMs).toBeLessThan(80_000);
  });

  it('a revoked authorization marks the CONNECTION, not just the job', async () => {
    const jobId = await seedJob(`auth-revoked-${randomUUID()}`);
    const result = await pipelineIn(fixtures.a.workspaceId, (pipeline) => pipeline.execute(jobId));
    expect(result.status).toBe('FAILED');
    expect(result.failureClass).toBe('AUTH_REVOKED');

    const connection = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.socialConnection.findFirst({
          where: { id: fixtures.a.socialConnectionId },
          select: { status: true, lastFailureClass: true },
        }),
      { prisma: app },
    );
    expect(connection?.status).toBe('NEEDS_REAUTH');
    expect(connection?.lastFailureClass).toBe('AUTH_REVOKED');

    // Restore, so the ordering of tests in this file cannot matter.
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

  it('every attempt is recorded, with a REDACTED summary and no provider prose', async () => {
    const jobId = await seedJob(`media-invalid-${randomUUID()}`);
    await pipelineIn(fixtures.a.workspaceId, (pipeline) => pipeline.execute(jobId));
    const attempt = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.publishAttempt.findFirst({ where: { publishJobId: jobId } }),
      { prisma: app },
    );
    expect(attempt?.outcome).toBe('PERMANENT_FAILURE');
    expect(attempt?.failureClass).toBe('MEDIA_INVALID');
    expect(attempt?.providerStatusCode).toBe(400);
    expect((attempt?.safeSummary ?? '').length).toBeLessThanOrEqual(500);
  });
});

describe('AN UNCERTAIN OUTCOME IS VERIFIED, NEVER RESENT', () => {
  it('a timeout whose post DID land is recorded as published, not retried', async () => {
    /*
     * The single most important behaviour in this milestone. The request left,
     * the answer did not come back, and the post is live. Retrying would post
     * a second time; asking the provider is the only correct move.
     */
    const jobId = await seedJob(`timeout-${randomUUID()}`);
    const result = await pipelineIn(fixtures.a.workspaceId, (pipeline) => pipeline.execute(jobId));
    expect(result.status).toBe('PUBLISHED');
    expect(result.externalPostId).toBeTruthy();

    const attempt = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.publishAttempt.findFirst({ where: { publishJobId: jobId } }),
      { prisma: app },
    );
    // The ATTEMPT is honest about what happened even though the JOB succeeded.
    expect(attempt?.outcome).toBe('INDETERMINATE');
    expect(attempt?.failureClass).toBe('TIMEOUT');
  });

  it('WHERE THE PROVIDER CANNOT BE ASKED, the job STOPS and waits for a human', async () => {
    /*
     * The other branch, and the one that matters most: with no lookup
     * capability there is no way to know whether the post landed, so the only
     * safe behaviour is to stop. A duplicate post is worse than a missing one.
     */
    const noLookup = parsePublishingPolicy({
      providers: {
        linkedin: {
          enabled: true,
          supportsPostLookup: false,
          scopes: ['w_member_social'],
          targetKind: 'organization',
        },
      },
    });
    const jobId = await seedJob(`timeout-nolookup-${randomUUID()}`);
    const result = await pipelineIn(fixtures.a.workspaceId, (pipeline) => pipeline.execute(jobId), {
      policy: noLookup,
    });
    expect(result.status).toBe('VERIFICATION_PENDING');
    expect(result.externalPostId).toBeNull();

    const job = await readJob(jobId);
    // NOT QUEUED. Nothing will pick this up automatically, which is the point.
    expect(job?.nextAttemptAt).toBeNull();
  });
});

describe('the approval gate is enforced in the job, not only in the UI', () => {
  it('APPROVAL REVOKED BETWEEN SCHEDULING AND DISPATCH stops the post', async () => {
    const jobId = await seedJob(`gate-${randomUUID()}`);
    const result = await pipelineIn(fixtures.a.workspaceId, (pipeline) => pipeline.execute(jobId), {
      approvals: gate({ required: true, status: 'CHANGES_REQUESTED' }),
    });
    expect(result.status).toBe('FAILED');
    expect(result.failureClass).toBe('APPROVAL_REVOKED');
  });

  it('NO APPROVAL AT ALL, where the brand requires one, stops the post', async () => {
    const jobId = await seedJob(`gate-missing-${randomUUID()}`);
    const result = await pipelineIn(fixtures.a.workspaceId, (pipeline) => pipeline.execute(jobId), {
      approvals: gate({ required: true, status: null }),
    });
    expect(result.failureClass).toBe('APPROVAL_REVOKED');
  });

  it('CONTENT IN REVIEW NEVER PUBLISHES, whatever the gate says', async () => {
    /*
     * Checked against the ITEM's own state rather than inferred from the slot.
     * The two are kept in step deliberately, and a rule that depended on them
     * being in step would fail exactly when they were not.
     */
    await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.contentItem.update({
          where: { id: fixtures.a.contentItemId },
          data: { status: 'IN_REVIEW' },
        }),
      { prisma: app },
    );
    const jobId = await seedJob(`in-review-${randomUUID()}`);
    const result = await pipelineIn(
      fixtures.a.workspaceId,
      (pipeline) => pipeline.execute(jobId),
      // The gate says approval is NOT required — and it still refuses.
      { approvals: gate({ required: false }) },
    );
    expect(result.status).toBe('FAILED');
    expect(result.failureClass).toBe('APPROVAL_REVOKED');

    await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.contentItem.update({
          where: { id: fixtures.a.contentItemId },
          data: { status: 'SCHEDULED' },
        }),
      { prisma: app },
    );
  });
});

describe('cancellation and manual retry', () => {
  it('a QUEUED post can be cancelled before it leaves', async () => {
    const jobId = await seedJob(`cancel-${randomUUID()}`);
    const result = await pipelineIn(fixtures.a.workspaceId, (pipeline) =>
      pipeline.cancel({ jobId, actorUserId: fixtures.a.userId, brandScope: [] }),
    );
    expect(result.status).toBe('CANCELLED');
    const job = await readJob(jobId);
    expect(job?.cancelledAt).not.toBeNull();
  });

  it('A PUBLISHED POST CANNOT BE CANCELLED — we do not claim to undo the world', async () => {
    const jobId = await seedJob(`published-then-cancel-${randomUUID()}`);
    await pipelineIn(fixtures.a.workspaceId, (pipeline) => pipeline.execute(jobId));
    await expect(
      pipelineIn(fixtures.a.workspaceId, (pipeline) =>
        pipeline.cancel({ jobId, actorUserId: fixtures.a.userId, brandScope: [] }),
      ),
    ).rejects.toThrow();
  });

  it('a FAILED post can be retried by hand, with a fresh attempt budget', async () => {
    const jobId = await seedJob(`reject-content-retry-${randomUUID()}`);
    await pipelineIn(fixtures.a.workspaceId, (pipeline) => pipeline.execute(jobId));
    const before = await readJob(jobId);
    expect(before?.status).toBe('FAILED');

    const result = await pipelineIn(fixtures.a.workspaceId, (pipeline) =>
      pipeline.retry({ jobId, actorUserId: fixtures.a.userId, brandScope: [] }),
    );
    expect(result.status).toBe('QUEUED');
    const after = await readJob(jobId);
    expect(after?.attemptCount).toBe(0);
    expect(after?.failureClass).toBeNull();
  });

  it('A REVOKED AUTHORIZATION CANNOT BE RETRIED — it needs a reconnection', async () => {
    const jobId = await seedJob(`auth-revoked-retry-${randomUUID()}`);
    await pipelineIn(fixtures.a.workspaceId, (pipeline) => pipeline.execute(jobId));
    await expect(
      pipelineIn(fixtures.a.workspaceId, (pipeline) =>
        pipeline.retry({ jobId, actorUserId: fixtures.a.userId, brandScope: [] }),
      ),
    ).rejects.toThrow();

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

  it('BRANDSCOPE IS A PREDICATE on cancel and retry (D-134)', async () => {
    /*
     * A member scoped to another brand gets the same not-found a job that never
     * existed gives — and the job is NOT cancelled, which is the part that
     * matters.
     */
    const jobId = await seedJob(`scope-${randomUUID()}`);
    await expect(
      pipelineIn(fixtures.a.workspaceId, (pipeline) =>
        pipeline.cancel({ jobId, actorUserId: fixtures.a.userId, brandScope: [randomUUID()] }),
      ),
    ).rejects.toThrow(/not found/i);

    const job = await readJob(jobId);
    expect(job?.status).toBe('QUEUED');
  });
});

/**
 * P6-R3 — THE PUBLISH PATH AND THE VERIFICATION PATH ARE DIFFERENT PATHS.
 *
 * WHAT WAS WRONG. `execute()` claimed `status: { in: ['QUEUED',
 * 'VERIFICATION_PENDING'] }` and then ran straight into `adapter.publish()`.
 * `VERIFICATION_PENDING` means exactly one thing — the request left, no answer
 * came back, THE POST MAY BE LIVE — so publishing such a job is the single
 * outcome this pipeline exists to prevent. A duplicate BullMQ delivery, which
 * at-least-once queues guarantee rather than merely permit, was enough.
 *
 * A SECOND ROUTE TO THE SAME PLACE. `retry()` accepted `VERIFICATION_PENDING`
 * and `TIMEOUT`/`PLATFORM_UNAVAILABLE` are both `indeterminate: true` AND
 * `manualRetryUseful: true` — so the Retry button in the publishing history did
 * it too, from the product, in two clicks.
 *
 * AND A THIRD PROBLEM, THE OPPOSITE ONE. `execute()` moves a job to PUBLISHING
 * before the external call, but the sweep only ever re-dispatched QUEUED. A
 * worker that died mid-flight left a row stuck at PUBLISHING for ever.
 *
 * EVERY CASE BELOW COUNTS `publish()` CALLS DIRECTLY rather than inferring them
 * from state, because "the status looks right" is what the defective version
 * also produced.
 */
describe('P6-R3 — an uncertain outcome is verified, never resent', () => {
  interface Counter {
    publishes: number;
    lookups: number;
  }

  /**
   * The registry, with every `publish()` and lookup counted.
   *
   * DELEGATED EXPLICITLY RATHER THAN PROXIED, so the adapter contract is
   * satisfied by name and a method added to the interface later fails to
   * compile here instead of silently escaping the count.
   */
  function countingRegistry(base: ConnectorRegistry, counter: Counter): ConnectorRegistry {
    return {
      enabledProviders: () => base.enabledProviders(),
      get: (provider) => {
        const inner = base.get(provider);
        const lookup = inner.findPostByIdempotencyKey;
        return {
          provider: inner.provider,
          capabilities: inner.capabilities,
          buildAuthorizationUrl: (request) => inner.buildAuthorizationUrl(request),
          exchangeCode: (input) => inner.exchangeCode(input),
          refreshToken: (input) => inner.refreshToken(input),
          revoke: (input) => inner.revoke(input),
          listTargets: (input) => inner.listTargets(input),
          checkHealth: (input) => inner.checkHealth(input),
          publish: async (input) => {
            counter.publishes += 1;
            return inner.publish(input);
          },
          ...(lookup
            ? {
                findPostByIdempotencyKey: async (input) => {
                  counter.lookups += 1;
                  return lookup.call(inner, input);
                },
              }
            : {}),
          classifyError: (error: unknown) => inner.classifyError(error),
        };
      },
    };
  }

  function countingPipelineIn<T>(
    counter: Counter,
    fn: (pipeline: PublishPipelineService) => Promise<T>,
    options: { policy?: PublishingPolicy } = {},
  ): Promise<T> {
    const active = options.policy ?? policy;
    return withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        fn(
          new PublishPipelineService({
            db,
            workspaceId: fixtures.a.workspaceId,
            policy: active,
            registry: countingRegistry(
              createConnectorRegistry({ policy: active, environment: 'DEVELOPMENT' }),
              counter,
            ),
            vault,
            approvals: gate({ required: false }),
          }),
        ),
      { prisma: app },
    ) as Promise<T>;
  }

  it('EXECUTING A VERIFICATION_PENDING JOB CANNOT INVOKE publish()', async () => {
    const counter: Counter = { publishes: 0, lookups: 0 };
    const jobId = await seedJob(`timeout-verify-${randomUUID()}`, {
      status: 'VERIFICATION_PENDING',
      failureClass: 'TIMEOUT',
      failureCode: 'adapter.timeout',
      attemptCount: 1,
      nextAttemptAt: null,
    });

    const result = await countingPipelineIn(counter, (pipeline) => pipeline.execute(jobId));

    // THE ASSERTION THAT FAILS AGAINST THE PRE-FIX CLAIM PREDICATE. The old
    // `status: { in: ['QUEUED', 'VERIFICATION_PENDING'] }` claimed this job and
    // sent the post a second time.
    expect(counter.publishes).toBe(0);
    expect(result.status).toBe('VERIFICATION_PENDING');
    expect((await readJob(jobId))?.status).toBe('VERIFICATION_PENDING');
  });

  it('RETRYING A VERIFICATION_PENDING JOB IS REFUSED — the button that double-posted', async () => {
    const jobId = await seedJob(`timeout-retry-${randomUUID()}`, {
      status: 'VERIFICATION_PENDING',
      failureClass: 'TIMEOUT',
      failureCode: 'adapter.timeout',
      attemptCount: 1,
      nextAttemptAt: null,
    });

    await expect(
      pipelineIn(fixtures.a.workspaceId, (pipeline) =>
        pipeline.retry({ jobId, actorUserId: fixtures.a.userId, brandScope: [] }),
      ),
    ).rejects.toThrow();
    expect((await readJob(jobId))?.status).toBe('VERIFICATION_PENDING');
  });

  it('RETRYING A JOB THAT FAILED ON AN INDETERMINATE CLASS IS REFUSED TOO', async () => {
    // The longer route to the same duplicate: a TIMEOUT that exhausted its
    // attempts reaches FAILED, and its last request may still have landed.
    const jobId = await seedJob(`timeout-exhausted-${randomUUID()}`, {
      status: 'FAILED',
      failureClass: 'TIMEOUT',
      failureCode: 'adapter.timeout',
      attemptCount: 5,
      nextAttemptAt: null,
    });

    await expect(
      pipelineIn(fixtures.a.workspaceId, (pipeline) =>
        pipeline.retry({ jobId, actorUserId: fixtures.a.userId, brandScope: [] }),
      ),
    ).rejects.toThrow();
  });

  it('A STALE PUBLISHING CLAIM IS RECOVERED — and verified, not resent', async () => {
    const counter: Counter = { publishes: 0, lookups: 0 };
    // `timeout` in the key makes the mock's lookup answer "yes, it landed".
    const jobId = await seedJob(`timeout-stale-${randomUUID()}`, {
      status: 'PUBLISHING',
      // Claimed well beyond the 900s lease: the worker is gone.
      claimedAt: new Date(Date.now() - 3_600_000),
      startedAt: new Date(Date.now() - 3_600_000),
      attemptCount: 1,
    });

    const result = await countingPipelineIn(counter, (pipeline) =>
      pipeline.recoverStaleClaim(jobId),
    );

    // ASKED ONCE, SENT NEVER.
    expect(counter.lookups).toBe(1);
    expect(counter.publishes).toBe(0);
    // And the provider said the post is there, so the job is PUBLISHED with the
    // id the provider gave us rather than one we invented.
    expect(result.status).toBe('PUBLISHED');
    expect(result.externalPostId).toBeTruthy();
  });

  it('A CLAIM STILL INSIDE ITS LEASE IS LEFT ALONE — a live worker is not stolen from', async () => {
    const counter: Counter = { publishes: 0, lookups: 0 };
    const jobId = await seedJob(`timeout-fresh-${randomUUID()}`, {
      status: 'PUBLISHING',
      claimedAt: new Date(),
      startedAt: new Date(),
    });

    const result = await countingPipelineIn(counter, (pipeline) =>
      pipeline.recoverStaleClaim(jobId),
    );
    expect(result.status).toBe('PUBLISHING');
    expect(counter.publishes).toBe(0);
    expect(counter.lookups).toBe(0);
  });

  it('A PROVIDER WITH NO LOOKUP IS NEVER AUTOMATICALLY RESENT — it waits for a human', async () => {
    const counter: Counter = { publishes: 0, lookups: 0 };
    const blind = parsePublishingPolicy({
      providers: {
        linkedin: {
          enabled: true,
          // THE LOAD-BEARING FALSE. We cannot ask, so we must not guess.
          supportsPostLookup: false,
          scopes: ['w_member_social'],
          targetKind: 'organization',
        },
      },
    });
    const jobId = await seedJob(`timeout-blind-${randomUUID()}`, {
      status: 'PUBLISHING',
      claimedAt: new Date(Date.now() - 3_600_000),
      startedAt: new Date(Date.now() - 3_600_000),
      attemptCount: 1,
    });

    const result = await countingPipelineIn(
      counter,
      (pipeline) => pipeline.recoverStaleClaim(jobId),
      {
        policy: blind,
      },
    );

    expect(result.status).toBe('VERIFICATION_PENDING');
    expect(counter.publishes).toBe(0);
    // NOT EVEN ONCE, however long it has been waiting. Elapsed time is not
    // evidence about whether a post landed.
    const again = await countingPipelineIn(counter, (pipeline) => pipeline.verify(jobId), {
      policy: blind,
    });
    expect(again.status).toBe('VERIFICATION_PENDING');
    expect(counter.publishes).toBe(0);
  });

  it('A VERIFICATION THAT FINDS NOTHING REQUEUES — the provider authorised that, not a timer', async () => {
    const counter: Counter = { publishes: 0, lookups: 0 };
    // `platform-down` makes the mock's lookup answer "no, nothing landed".
    const jobId = await seedJob(`platform-down-verify-${randomUUID()}`, {
      status: 'VERIFICATION_PENDING',
      failureClass: 'PLATFORM_UNAVAILABLE',
      failureCode: 'adapter.platform_unavailable',
      attemptCount: 1,
      nextAttemptAt: null,
    });

    const result = await countingPipelineIn(counter, (pipeline) => pipeline.verify(jobId));
    expect(counter.lookups).toBe(1);
    // STILL NOT SENT FROM HERE. It goes back on the queue and the ordinary
    // path sends it, once, with its attempt budget intact.
    expect(counter.publishes).toBe(0);
    expect(result.status).toBe('QUEUED');
  });

  it('A DUPLICATE DELIVERY IS HARMLESS IN EVERY NON-QUEUED STATE', async () => {
    const states = [
      { status: 'PUBLISHING' as const, claimedAt: new Date() },
      { status: 'VERIFICATION_PENDING' as const, failureClass: 'TIMEOUT' as const },
      {
        status: 'PUBLISHED' as const,
        externalPostId: 'mock-post-already',
        publishedAt: new Date(),
      },
      { status: 'FAILED' as const, failureClass: 'CONTENT_REJECTED' as const },
      { status: 'CANCELLED' as const, cancelledAt: new Date() },
    ];

    for (const state of states) {
      const counter: Counter = { publishes: 0, lookups: 0 };
      const jobId = await seedJob(`duplicate-delivery-${randomUUID()}`, {
        ...state,
        nextAttemptAt: null,
      });
      const result = await countingPipelineIn(counter, (pipeline) => pipeline.execute(jobId));
      expect(counter.publishes, `execute() sent a post for a ${state.status} job`).toBe(0);
      expect(result.status).toBe(state.status);
    }
  });

  it('A QUEUED JOB STILL PUBLISHES — the fix must not break the working case', async () => {
    const counter: Counter = { publishes: 0, lookups: 0 };
    const jobId = await seedJob(`happy-${randomUUID()}`);
    const result = await countingPipelineIn(counter, (pipeline) => pipeline.execute(jobId));
    expect(counter.publishes).toBe(1);
    expect(result.status).toBe('PUBLISHED');
  });
});

/**
 * P6-R3, the other half — A ROW NOBODY WAS LOOKING AT.
 *
 * The reconciliation sweep selected `status: 'QUEUED'` and nothing else, so a
 * job left at PUBLISHING by a worker that died had no path back into the
 * system. This asserts the gap directly, over real PostgreSQL: the old
 * predicate cannot see such a row and the new one can.
 */
describe('P6-R3 — a stale PUBLISHING claim is discoverable by the sweep', () => {
  const LEASE_SECONDS = 900;

  it('THE QUEUED-ONLY PREDICATE CANNOT SEE IT — this is the stall', async () => {
    const jobId = await seedJob(`stale-sweep-${randomUUID()}`, {
      status: 'PUBLISHING',
      claimedAt: new Date(Date.now() - 3_600_000),
      startedAt: new Date(Date.now() - 3_600_000),
      nextAttemptAt: new Date(Date.now() - 3_600_000),
    });

    const queuedOnly = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.publishJob.findMany({
          // VERBATIM the pre-fix sweep's predicate.
          where: { status: 'QUEUED', nextAttemptAt: { lte: new Date() } },
          select: { id: true },
        }),
      { prisma: app },
    );
    expect(queuedOnly.map((row) => row.id)).not.toContain(jobId);

    const staleClaims = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.publishJob.findMany({
          where: {
            status: 'PUBLISHING',
            claimedAt: { lt: new Date(Date.now() - LEASE_SECONDS * 1_000) },
          },
          select: { id: true },
        }),
      { prisma: app },
    );
    expect(staleClaims.map((row) => row.id)).toContain(jobId);
  });

  it('A JOB INSIDE ITS LEASE IS NOT SWEPT — a live worker keeps its claim', async () => {
    const jobId = await seedJob(`fresh-sweep-${randomUUID()}`, {
      status: 'PUBLISHING',
      claimedAt: new Date(),
      startedAt: new Date(),
    });
    const staleClaims = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.publishJob.findMany({
          where: {
            status: 'PUBLISHING',
            claimedAt: { lt: new Date(Date.now() - LEASE_SECONDS * 1_000) },
          },
          select: { id: true },
        }),
      { prisma: app },
    );
    expect(staleClaims.map((row) => row.id)).not.toContain(jobId);
  });
});

/**
 * P6-R4 — MATERIALISATION IS CONCURRENCY-SAFE, NOT MERELY CORRECT-ON-AVERAGE.
 *
 * WHAT WAS WRONG. `materialiseSlot` asked `findFirst` whether a job existed and
 * then called `create`. Two sweeps running together — the scheduler and a
 * manual dispatch, or two API instances, which IS the normal deployment — both
 * see no row, both insert, and the unique index correctly refuses the second.
 * Correct data, and a thrown `P2002` that aborts the loser's entire workspace
 * pass, so every later slot in that batch goes unmaterialised because an
 * earlier one was already done. The check-then-act was never atomic; the index
 * was doing all the work and reporting it as a crash.
 *
 * THE RACE IS FORCED, NOT HOPED FOR. Each caller blocks inside the approval
 * gate — which `materialiseSlot` awaits AFTER reading the slot and BEFORE
 * writing any job — until every caller has arrived. Releasing them together
 * puts all of them in the read-then-write window simultaneously, which is
 * exactly the interleaving the defect needs and exactly the one an unassisted
 * `Promise.all` only sometimes produces.
 */
describe('P6-R4 — concurrent materialisation of one slot', () => {
  const CONCURRENCY = 6;

  /**
   * An approval gate that holds every caller until all of them have arrived.
   *
   * It answers the same thing the ordinary gate does; the only difference is
   * WHEN. A barrier here is a barrier in the middle of `materialiseSlot`.
   */
  function barrierGate(expected: number): PublishApprovalGate {
    let arrived = 0;
    let release: () => void = () => {};
    const open = new Promise<void>((resolve) => {
      release = resolve;
    });
    /*
     * AND IT OPENS ANYWAY AFTER A MOMENT. A barrier that waits for a caller who
     * never arrives — because an earlier guard short-circuited them — is a
     * suite that hangs until the runner's timeout and reports nothing useful.
     * The window only has to be wide enough to overlap the callers that DID
     * arrive, so a late opening costs a weaker race, never a stuck test.
     */
    const failsafe = setTimeout(() => release(), 250);
    if (typeof failsafe.unref === 'function') failsafe.unref();
    return {
      async policyForBrand() {
        arrived += 1;
        if (arrived >= expected) {
          clearTimeout(failsafe);
          release();
        }
        await open;
        return { requireApprovalBeforeScheduling: false };
      },
      async openForItem() {
        return { status: 'APPROVED' };
      },
    };
  }

  /**
   * A content item, variant and slot of its own.
   *
   * ITS OWN EVERYTHING, DELIBERATELY. `calendar_slot_one_live_per_item` allows
   * one live slot per content item, so borrowing the fixture's item would make
   * these cases depend on what the rest of the suite left behind — the coupling
   * this repository has already been bitten by once.
   */
  async function seedSlot(): Promise<{ slotId: string; variantId: string }> {
    return withWorkspace(
      fixtures.a.workspaceId,
      async (db) => {
        const item = await db.contentItem.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            title: `Concurrency fixture ${randomUUID()}`,
            contentType: 'POST',
            primaryLocale: 'EN',
            // PUBLISHABLE: these cases are about the INSERT race, not about the
            // approval gate, which has its own suite above.
            status: 'SCHEDULED',
            origin: 'AI_GENERATED',
            createdByUserId: fixtures.a.userId,
            arabicDialect: 'msa',
            idempotencyKey: `p6r4-item-${randomUUID()}`,
          },
        });
        const variant = await db.contentVariant.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            contentItemId: item.id,
            // The fixture's connection is LINKEDIN and its variant is
            // instagram, so a matching variant has to exist for any job to be
            // produced at all.
            platformKey: 'linkedin',
            locale: 'EN',
            body: 'Concurrency fixture.',
            hashtags: [],
            characterCount: 21,
            validationState: 'VALID',
            origin: 'AI_GENERATED',
          },
        });
        const slot = await db.calendarSlot.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            contentItemId: item.id,
            status: 'SCHEDULED',
            scheduledAtUtc: new Date(),
            scheduledLocalTime: '2026-01-15T09:00',
            timezone: 'UTC',
            platformKeys: ['linkedin'],
            createdByUserId: fixtures.a.userId,
            usageIdempotencyKey: `p6r4-${randomUUID()}`,
          },
        });
        return { slotId: slot.id, variantId: variant.id };
      },
      { prisma: app },
    ) as Promise<{ slotId: string; variantId: string }>;
  }

  it('NEITHER CALLER FAILS, AND EXACTLY ONE JOB EXISTS', async () => {
    const { slotId, variantId } = await seedSlot();
    const gateForAll = barrierGate(CONCURRENCY);

    const outcomes = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, () =>
        pipelineIn(fixtures.a.workspaceId, (pipeline) => pipeline.materialiseSlot(slotId), {
          approvals: gateForAll,
        }),
      ),
    );

    /*
     * THE ASSERTION THAT FAILS AGAINST THE PRE-FIX CODE. A rejected caller is a
     * maintenance pass that aborted — every slot after this one in that batch
     * goes unmaterialised, on a schedule nobody is watching.
     */
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(
      rejected.map((outcome) =>
        outcome.status === 'rejected' ? String(outcome.reason) : 'unreachable',
      ),
      'a concurrent materialisation aborted the workspace pass',
    ).toEqual([]);

    // ONE LOGICAL JOB, whichever caller won the insert.
    const key = publishIdempotencyKey({
      workspaceId: fixtures.a.workspaceId,
      calendarSlotId: slotId,
      socialConnectionId: fixtures.a.socialConnectionId,
      contentVariantId: variantId,
    });
    const jobs = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.publishJob.findMany({ where: { calendarSlotId: slotId } }),
      { prisma: app },
    );
    expect(jobs.length).toBe(1);
    expect(jobs[0]?.idempotencyKey).toBe(key);
    expect(jobs[0]?.status).toBe('QUEUED');

    // EXACTLY ONE CALLER CREATED IT and the rest reported it as existing, so
    // the counts a maintenance log prints are true rather than approximate.
    const fulfilled = outcomes.flatMap((outcome) =>
      outcome.status === 'fulfilled' ? [outcome.value] : [],
    );
    expect(fulfilled.reduce((total, result) => total + result.created, 0)).toBe(1);
    expect(fulfilled.reduce((total, result) => total + result.existing, 0)).toBe(
      fulfilled.filter((result) => result.skipped === 0).length - 1,
    );
  });

  it('THE LIFECYCLE IS STILL CORRECT AFTER THE RACE', async () => {
    const { slotId } = await seedSlot();
    // ONE barrier shared by all the callers. Building it inside the map would
    // give each caller its own, and each would then wait for five arrivals that
    // can never come.
    const gateForAll = barrierGate(CONCURRENCY);
    await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, () =>
        pipelineIn(fixtures.a.workspaceId, (pipeline) => pipeline.materialiseSlot(slotId), {
          approvals: gateForAll,
        }),
      ),
    );

    const slot = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.calendarSlot.findFirst({ where: { id: slotId } }),
      { prisma: app },
    );
    // MOVED ONCE, to PUBLISHING — not left SCHEDULED by a pass that aborted,
    // and not written six times into an inconsistent state.
    expect(slot?.status).toBe('PUBLISHING');
  });

  it('A SECOND PASS OVER THE SAME SLOT CREATES NOTHING AND RAISES NOTHING', async () => {
    const { slotId } = await seedSlot();
    const first = await pipelineIn(fixtures.a.workspaceId, (pipeline) =>
      pipeline.materialiseSlot(slotId),
    );
    expect(first.created).toBe(1);

    // The slot is PUBLISHING now, so the ordinary second pass skips. Put it
    // back to SCHEDULED to reach the INSERT and prove the conflict is absorbed
    // rather than raised.
    await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.calendarSlot.update({ where: { id: slotId }, data: { status: 'SCHEDULED' } }),
      { prisma: app },
    );

    const second = await pipelineIn(fixtures.a.workspaceId, (pipeline) =>
      pipeline.materialiseSlot(slotId),
    );
    expect(second.created).toBe(0);
    expect(second.existing).toBe(1);
  });
});
