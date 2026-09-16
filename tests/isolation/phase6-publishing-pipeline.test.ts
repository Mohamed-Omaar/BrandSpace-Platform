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
