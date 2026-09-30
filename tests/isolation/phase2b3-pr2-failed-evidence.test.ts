import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type PublishFailureClass } from '@brandspace/database';
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
 * PHASE 2B-3, PR 2 — EVERY TRANSITION TO FAILED CONCLUDES WITH ATTEMPT
 * EVIDENCE, AGAINST REAL POSTGRESQL (owner decisions D1 and D2).
 *
 *   - A provider failure concludes with the row the call recorded — and no
 *     other row is added.
 *   - A pre-flight refusal writes ONE `PREFLIGHT_REFUSED` row numbered after
 *     the highest attempt so far; `attemptCount` is unchanged.
 *   - A recovered stale claim writes ONE `INDETERMINATE` row, class TIMEOUT,
 *     with no provider status or error code and a summary that says the send
 *     state is unknown; `attemptCount` is unchanged.
 *   - A verification failure concludes with the attempt being verified.
 *
 * The provider is scripted and counted exactly as in the PR 0 suite.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;
let policy: PublishingPolicy;
let noLookupPolicy: PublishingPolicy;

const vault = new SocialTokenVault({
  env: { SOCIAL_TOKEN_VAULT_KEK: FIXTURE_SOCIAL_KEK } as NodeJS.ProcessEnv,
});

function policyWith(input: { lookup: boolean }): PublishingPolicy {
  const capability = {
    enabled: true,
    postKinds: ['text'],
    maxBodyCharacters: 2_200,
    maxHashtags: 30,
    maxMediaItems: 10,
    supportsFirstComment: false,
    supportsDelete: false,
    supportsNativeScheduling: false,
    supportsPostLookup: input.lookup,
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
/** The brand requires approval and the post's approval was withdrawn: a pre-flight refusal. */
const withdrawnApproval: PublishApprovalGate = {
  async policyForBrand() {
    return { requireApprovalBeforeScheduling: true };
  },
  async latestForItem() {
    return { status: 'PENDING' };
  },
};

type Step = 'ok' | PublishFailureClass;

interface ScriptedProvider {
  readonly calls: number;
  readonly registryFor: (active: PublishingPolicy) => ReturnType<typeof createConnectorRegistry>;
}

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

function inPipeline<T>(
  provider: ScriptedProvider,
  fn: (pipeline: PublishPipelineService) => Promise<T>,
  active: PublishingPolicy = policy,
  gate: PublishApprovalGate = approvals,
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
          approvals: gate,
        }),
      ),
    { prisma: app },
  ) as Promise<T>;
}

const inA = <T>(fn: Parameters<typeof withWorkspace>[1]) =>
  withWorkspace(fixtures.a.workspaceId, fn, { prisma: app }) as Promise<T>;

async function seedJob(
  overrides: {
    status?: 'QUEUED' | 'PUBLISHING' | 'VERIFICATION_PENDING';
    attemptCount?: number;
    maxAttempts?: number;
    claimedAt?: Date | null;
    failureClass?: PublishFailureClass | null;
  } = {},
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
        status: overrides.status ?? 'QUEUED',
        // Never `timeout`: the mock lookup answers "not there" for this key.
        idempotencyKey: `pr2-evidence-${randomUUID()}`,
        scheduledAtUtc: new Date(),
        attemptCount: overrides.attemptCount ?? 0,
        maxAttempts: overrides.maxAttempts ?? policy.retry.maxAttempts,
        nextAttemptAt: overrides.status && overrides.status !== 'QUEUED' ? null : new Date(),
        claimedAt: overrides.claimedAt ?? null,
        failureClass: overrides.failureClass ?? null,
        createdByUserId: fixtures.a.userId,
      },
    });
    return job.id;
  });
}

async function seedAttempts(
  jobId: string,
  rows: readonly {
    outcome: 'RETRYABLE_FAILURE' | 'INDETERMINATE';
    failureClass: PublishFailureClass;
  }[],
): Promise<void> {
  await inA(async (db) => {
    let attemptNumber = 0;
    for (const row of rows) {
      attemptNumber += 1;
      await db.publishAttempt.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          publishJobId: jobId,
          attemptNumber,
          startedAt: new Date(),
          finishedAt: new Date(),
          durationMs: 0,
          outcome: row.outcome,
          failureClass: row.failureClass,
        },
      });
    }
  });
}

const readJob = (jobId: string) =>
  inA<Awaited<ReturnType<PrismaClient['publishJob']['findFirstOrThrow']>>>((db) =>
    db.publishJob.findFirstOrThrow({ where: { id: jobId } }),
  );

const attempts = (jobId: string) =>
  inA<
    {
      attemptNumber: number;
      outcome: string;
      failureClass: string | null;
      providerStatusCode: number | null;
      providerErrorCode: string | null;
      safeSummary: string | null;
    }[]
  >((db) =>
    db.publishAttempt.findMany({
      where: { publishJobId: jobId },
      orderBy: { attemptNumber: 'asc' },
      select: {
        attemptNumber: true,
        outcome: true,
        failureClass: true,
        providerStatusCode: true,
        providerErrorCode: true,
        safeSummary: true,
      },
    }),
  );

const LONG_AGO = new Date(Date.now() - 24 * 60 * 60 * 1_000);

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
  policy = policyWith({ lookup: true });
  noLookupPolicy = policyWith({ lookup: false });
  await inA((db) =>
    db.contentItem.update({
      where: { id: fixtures.a.contentItemId },
      data: { status: 'SCHEDULED' },
    }),
  );
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

describe('M2 — the database knows PREFLIGHT_REFUSED', () => {
  it('PublishAttemptOutcome carries the new value after every earlier one', async () => {
    const rows = await app.$queryRaw<{ value: string }[]>`
      SELECT unnest(enum_range(NULL::"PublishAttemptOutcome"))::text AS value
    `;
    expect(rows.map((row) => row.value)).toEqual([
      'SUCCEEDED',
      'RETRYABLE_FAILURE',
      'PERMANENT_FAILURE',
      'INDETERMINATE',
      'PREFLIGHT_REFUSED',
    ]);
  });

  it('a PREFLIGHT_REFUSED row must say why — the existing CHECK applies to it', async () => {
    const jobId = await seedJob();
    await expect(
      inA((db) =>
        db.publishAttempt.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            publishJobId: jobId,
            attemptNumber: 1,
            startedAt: new Date(),
            finishedAt: new Date(),
            durationMs: 0,
            outcome: 'PREFLIGHT_REFUSED',
            failureClass: null,
          },
        }),
      ),
    ).rejects.toThrow(/publish_attempt_failure_class_matches_outcome/);
  });
});

describe('a provider failure concludes with the row the call recorded', () => {
  it('a permanent failure: one attempt, the provider’s, and nothing added', async () => {
    const provider = scriptedProvider(['CONTENT_REJECTED']);
    const jobId = await seedJob();
    const result = await inPipeline(provider, (pipeline) => pipeline.execute(jobId));
    expect(result.status).toBe('FAILED');
    expect(await attempts(jobId)).toEqual([
      {
        attemptNumber: 1,
        outcome: 'PERMANENT_FAILURE',
        failureClass: 'CONTENT_REJECTED',
        providerStatusCode: 500,
        providerErrorCode: 'SCRIPTED',
        safeSummary: 'Scripted failure.',
      },
    ]);
    expect((await readJob(jobId)).attemptCount).toBe(1);
  });

  it('a retry budget spent on retryable failures: one row per call, the last concludes it', async () => {
    const budget = policy.retry.maxAttempts;
    const provider = scriptedProvider(
      Array.from({ length: budget }, () => 'RATE_LIMITED' as const),
    );
    const jobId = await seedJob();
    for (let call = 0; call < budget; call += 1) {
      await inPipeline(provider, (pipeline) => pipeline.execute(jobId));
    }
    const job = await readJob(jobId);
    expect(job.status).toBe('FAILED');
    expect(job.attemptCount).toBe(budget);
    const rows = await attempts(jobId);
    expect(rows.map((row) => row.attemptNumber)).toEqual(
      Array.from({ length: budget }, (_, index) => index + 1),
    );
    expect(rows.every((row) => row.outcome === 'RETRYABLE_FAILURE')).toBe(true);
    expect(provider.calls).toBe(budget);
  });
});

describe('D2 — a pre-flight refusal writes one PREFLIGHT_REFUSED row', () => {
  it('nothing sent: one row numbered 1, the refusal’s class, no provider fields, attemptCount 0', async () => {
    const provider = scriptedProvider([]);
    const jobId = await seedJob();
    const result = await inPipeline(
      provider,
      (pipeline) => pipeline.execute(jobId),
      policy,
      withdrawnApproval,
    );
    expect(result).toMatchObject({ status: 'FAILED', failureClass: 'APPROVAL_REVOKED' });
    expect(provider.calls).toBe(0);
    expect(await attempts(jobId)).toEqual([
      {
        attemptNumber: 1,
        outcome: 'PREFLIGHT_REFUSED',
        failureClass: 'APPROVAL_REVOKED',
        providerStatusCode: null,
        providerErrorCode: null,
        safeSummary: 'Refused before sending: no request was made.',
      },
    ]);
    const job = await readJob(jobId);
    expect(job).toMatchObject({ attemptCount: 0, failureCode: 'preflight.approval_revoked' });
  });

  it('after a real attempt: numbered after it, attemptCount unchanged, no number reused', async () => {
    const provider = scriptedProvider(['RATE_LIMITED']);
    const jobId = await seedJob();
    const first = await inPipeline(provider, (pipeline) => pipeline.execute(jobId));
    expect(first.status).toBe('QUEUED');
    // Due again now, then refused before sending.
    await inA((db) =>
      db.publishJob.update({ where: { id: jobId }, data: { nextAttemptAt: new Date() } }),
    );
    const second = await inPipeline(
      provider,
      (pipeline) => pipeline.execute(jobId),
      policy,
      withdrawnApproval,
    );
    expect(second.status).toBe('FAILED');
    expect(provider.calls).toBe(1);
    expect((await attempts(jobId)).map((row) => [row.attemptNumber, row.outcome])).toEqual([
      [1, 'RETRYABLE_FAILURE'],
      [2, 'PREFLIGHT_REFUSED'],
    ]);
    const job = await readJob(jobId);
    expect(job.attemptCount).toBe(1);
    expect(job.attemptCount).toBeLessThanOrEqual(job.maxAttempts);
  });

  it('a duplicate delivery after the refusal adds nothing', async () => {
    const provider = scriptedProvider([]);
    const jobId = await seedJob();
    await inPipeline(provider, (pipeline) => pipeline.execute(jobId), policy, withdrawnApproval);
    const again = await inPipeline(
      provider,
      (pipeline) => pipeline.execute(jobId),
      policy,
      withdrawnApproval,
    );
    expect(again.status).toBe('FAILED');
    expect(await attempts(jobId)).toHaveLength(1);
  });
});

describe('D1 — a recovered stale claim records an unknown send state', () => {
  it('one INDETERMINATE row: TIMEOUT, no provider fields, a summary that claims no send', async () => {
    const provider = scriptedProvider([]);
    const jobId = await seedJob({ status: 'PUBLISHING', claimedAt: LONG_AGO, attemptCount: 1 });
    await seedAttempts(jobId, [{ outcome: 'RETRYABLE_FAILURE', failureClass: 'RATE_LIMITED' }]);

    const result = await inPipeline(
      provider,
      (pipeline) => pipeline.recoverStaleClaim(jobId),
      noLookupPolicy,
    );
    // Nobody can be asked: it waits for a person, as before.
    expect(result.status).toBe('VERIFICATION_PENDING');
    expect(provider.calls).toBe(0);
    const rows = await attempts(jobId);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({
      attemptNumber: 2,
      outcome: 'INDETERMINATE',
      failureClass: 'TIMEOUT',
      providerStatusCode: null,
      providerErrorCode: null,
      safeSummary:
        'The worker claim ended before its result was recorded; whether the request was sent is unknown.',
    });
    // It says the send state is unknown, and never that an answer came back
    // or that the post went out.
    expect(rows[1]?.safeSummary).toContain('is unknown');
    expect(rows[1]?.safeSummary).not.toMatch(/\b(responded|received|delivered|published)\b/i);
    expect((await readJob(jobId)).attemptCount).toBe(1);
  });

  it('a claim that is not stale records nothing', async () => {
    const provider = scriptedProvider([]);
    const jobId = await seedJob({ status: 'PUBLISHING', claimedAt: new Date() });
    const result = await inPipeline(provider, (pipeline) => pipeline.recoverStaleClaim(jobId));
    expect(result.status).toBe('PUBLISHING');
    expect(await attempts(jobId)).toEqual([]);
  });

  it('the verification that follows fails citing that row, and adds none', async () => {
    const provider = scriptedProvider([]);
    const max = policy.retry.maxAttempts;
    const jobId = await seedJob({
      status: 'PUBLISHING',
      claimedAt: LONG_AGO,
      attemptCount: max,
      maxAttempts: max,
    });
    await seedAttempts(
      jobId,
      Array.from({ length: max }, () => ({
        outcome: 'RETRYABLE_FAILURE' as const,
        failureClass: 'RATE_LIMITED' as const,
      })),
    );
    // The lookup answers "not there" and the budget is spent: verify.exhausted.
    const result = await inPipeline(provider, (pipeline) => pipeline.recoverStaleClaim(jobId));
    expect(result.status).toBe('FAILED');
    const job = await readJob(jobId);
    expect(job).toMatchObject({ failureCode: 'verify.exhausted', attemptCount: max });
    const rows = await attempts(jobId);
    expect(rows).toHaveLength(max + 1);
    expect(rows.at(-1)).toMatchObject({ attemptNumber: max + 1, outcome: 'INDETERMINATE' });
    expect(provider.calls).toBe(0);
  });
});

describe('a verification failure concludes with the attempt being verified', () => {
  it('an INDETERMINATE provider answer, verified as not there with the budget spent', async () => {
    const provider = scriptedProvider([]);
    const jobId = await seedJob({
      status: 'VERIFICATION_PENDING',
      attemptCount: 1,
      maxAttempts: 1,
      failureClass: 'TIMEOUT',
    });
    await seedAttempts(jobId, [{ outcome: 'INDETERMINATE', failureClass: 'TIMEOUT' }]);
    const result = await inPipeline(provider, (pipeline) => pipeline.verify(jobId));
    expect(result.status).toBe('FAILED');
    expect((await attempts(jobId)).map((row) => row.outcome)).toEqual(['INDETERMINATE']);
    expect((await readJob(jobId)).attemptCount).toBe(1);
  });

  it('a job recovered before this release, with no such row, gets the D1 row once', async () => {
    const provider = scriptedProvider([]);
    const jobId = await seedJob({
      status: 'VERIFICATION_PENDING',
      attemptCount: 1,
      maxAttempts: 1,
      failureClass: 'TIMEOUT',
    });
    await seedAttempts(jobId, [{ outcome: 'RETRYABLE_FAILURE', failureClass: 'RATE_LIMITED' }]);
    const result = await inPipeline(provider, (pipeline) => pipeline.verify(jobId));
    expect(result.status).toBe('FAILED');
    expect((await attempts(jobId)).map((row) => [row.attemptNumber, row.outcome])).toEqual([
      [1, 'RETRYABLE_FAILURE'],
      [2, 'INDETERMINATE'],
    ]);
    expect((await readJob(jobId)).attemptCount).toBe(1);
  });
});

describe('the invariants hold across everything this suite wrote', () => {
  it('no job holds two attempts with the same number, and no count exceeds its ceiling', async () => {
    const [row] = await inA<{ dupes: bigint; over: bigint }[]>(
      (db) =>
        db.$queryRaw`
          SELECT
            (SELECT count(*) FROM (
               SELECT "publishJobId", "attemptNumber" FROM "publish_attempt"
                GROUP BY 1, 2 HAVING count(*) > 1) AS d)::bigint AS "dupes",
            (SELECT count(*) FROM "publish_job" WHERE "attemptCount" > "maxAttempts")::bigint AS "over"
        `,
    );
    expect(Number(row?.dupes)).toBe(0);
    expect(Number(row?.over)).toBe(0);
  });

  it('every FAILED job this suite produced concludes with at least one attempt', async () => {
    const [row] = await inA<{ bare: bigint }[]>(
      (db) =>
        db.$queryRaw`
          SELECT count(*)::bigint AS "bare" FROM "publish_job" j
           WHERE j."status" = 'FAILED' AND j."idempotencyKey" LIKE 'pr2-evidence-%'
             AND NOT EXISTS (SELECT 1 FROM "publish_attempt" a WHERE a."publishJobId" = j."id")
        `,
    );
    expect(Number(row?.bare)).toBe(0);
  });
});
