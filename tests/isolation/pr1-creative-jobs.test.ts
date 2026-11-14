import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { AiGateway, MockProviderAdapter, type AiConfiguration } from '@brandspace/ai-gateway';
import {
  AssetProcessingService,
  AssetUploadService,
  MockVirusScanner,
  TenantAssetPolicySource,
} from '@brandspace/assets';
import { CreditLedgerService, UsageService } from '@brandspace/entitlements';
import {
  CREATIVE_JOB_MAX_ATTEMPTS,
  CreativeGenerationJobs,
  CreativeStudioService,
  findStaleCreativeJobs,
  runCreativeGenerationJob,
  type CreativeJobRunHost,
} from '@brandspace/creative';
import { createObjectStore } from '@brandspace/storage';
import { defaultPayload } from '@brandspace/config';
import { ContentLibraryService, parseContentPolicy } from '@brandspace/content';
import { appRoleClient, createIsolationFixtures, platformRoleClient } from './fixtures';
import type { IsolationFixtures } from './fixtures';

/**
 * PR 1 (Images, D-597) — AN IMAGE IS A BACKGROUND JOB.
 *
 *   - a job is QUEUED at once and finished by a run, SUCCEEDED or FAILED;
 *   - a job asked for from a post attaches its image to that variant on the
 *     server, once, audited — with nobody's editor open;
 *   - a second run, the recovery sweep, or two runners at once NEVER charge
 *     twice and never make a second image;
 *   - a failed generation charges nothing and attaches nothing;
 *   - a finished job is deleted on the content retention schedule;
 *   - TENANT ISOLATION: another workspace's job cannot be read, listed,
 *     counted, updated, deleted or run, and another workspace's (or brand's)
 *     variant cannot be the target.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let mock: MockProviderAdapter;
let gateway: AiGateway;

const inWs = <T>(workspaceId: string, fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(workspaceId, fn as never, { prisma: app }) as Promise<T>;
const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) => inWs(fixtures.a.workspaceId, fn);
const inB = <T>(fn: (db: TenantScopedClient) => Promise<T>) => inWs(fixtures.b.workspaceId, fn);

const MODEL_KEY = 'mock-image-pr1';

function aiConfiguration(): AiConfiguration {
  return {
    providers: [
      {
        key: 'mock',
        baseUrl: 'https://mock.invalid',
        apiKeySecretRef: null,
        status: 'active',
        timeoutMs: 30_000,
      },
    ],
    models: [
      {
        key: MODEL_KEY,
        providerKey: 'mock',
        modality: 'image',
        qualityTier: 'balanced',
        status: 'available',
        disableSwitch: false,
      },
    ],
    costBases: [
      {
        modelKey: MODEL_KEY,
        inputCostPerUnitMicroMinor: 0,
        outputCostPerUnitMicroMinor: 40_000,
        costUnit: 'image',
        costCurrency: 'USD',
      },
    ],
    routingRules: [
      {
        taskKey: 'image.generate',
        scope: 'global',
        planKey: null,
        workspaceId: null,
        primaryModelKey: MODEL_KEY,
        fallbackModelKeys: [],
        timeoutMs: 10_000,
        maxCostPerRequestMinor: null,
        priority: 0,
        parameters: {
          temperature: 0.4,
          maxOutputTokens: 256,
          promptTemplateVersion: 1,
          persistOutput: false,
          outputRetentionDays: null,
        },
        retryPolicy: { maxAttempts: 1, backoff: 'none', initialDelayMs: 0, jitter: false },
        moderateInput: false,
        moderationModelKey: null,
      },
    ],
    creditRules: [
      {
        taskKey: 'image.generate',
        modelKey: MODEL_KEY,
        baseMilliCredits: 400,
        perUnitMilliCredits: 0,
        unit: 'image',
      },
    ],
    budgets: {
      defaults: {
        creditsPerDayMilli: null,
        creditsPerMonthMilli: null,
        maxConcurrentRequests: null,
      },
      perPlan: [],
    },
  };
}

const IDENTITY = {
  name: 'Creative Alpha',
  industry: 'Coffee',
  description: 'A speciality roastery.',
  palette: ['#7935FE', '#FFDD15'],
  typography: ['Inter'],
  knowledge: [],
};

let revoked = false;

/**
 * THE ASSET WORKER, IN THE TEST (PR A, the #122 race). A made image is
 * scanned by the worker after upload, and the job now waits for that verdict
 * before it succeeds. These tests run no worker, so the host's `sleep` —
 * called between the job's looks at the image — does the worker's job: it
 * scans what is queued in the workspace, through the real processing service.
 */
async function scanQueued(workspaceId: string): Promise<void> {
  const queued = await inWs(workspaceId, (db) =>
    db.assetProcessingJob.findMany({ where: { stage: 'QUEUED' }, select: { id: true } }),
  );
  for (const job of queued) {
    await inWs(workspaceId, async (db) =>
      new AssetProcessingService({
        db,
        workspaceId,
        store: createObjectStore({ appEnv: 'test' }),
        policy: await new TenantAssetPolicySource(db, 'DEVELOPMENT').load(),
        scanner: new MockVirusScanner(),
      }).process(job.id),
    );
  }
}

function host(workspaceId: string, userId: string): CreativeJobRunHost {
  return {
    workspaceId,
    planKey: null,
    inWorkspace: (fn) => inWs(workspaceId, fn),
    studioFor: async (db) =>
      new CreativeStudioService({
        db,
        workspaceId,
        gateway,
        uploads: new AssetUploadService({
          db,
          workspaceId,
          store: createObjectStore({ appEnv: 'test' }),
          policy: await new TenantAssetPolicySource(db, 'DEVELOPMENT').load(),
          usage: new UsageService({ prisma: db as unknown as PrismaClient }),
          storageLimitGb: null,
        }),
      }),
    identityFor: async () => IDENTITY,
    authorize: async () =>
      revoked ? null : { userId, permissionKeys: ['assets.upload', 'assets.read'], brandScope: [] },
    sleep: () => scanQueued(workspaceId),
  };
}

const enqueueA = (
  overrides: {
    contentVariantId?: string;
    brandId?: string;
    addLogo?: boolean;
    headline?: string | null;
  } = {},
) =>
  inA((db) =>
    new CreativeGenerationJobs({ db, workspaceId: fixtures.a.workspaceId }).enqueue({
      brandId: overrides.brandId ?? fixtures.a.brandId,
      requestedByUserId: fixtures.a.userId,
      brandScope: [],
      idempotencyKey: `pr1-${randomUUID()}`,
      // A distinct brief per job: the deterministic provider draws the same
      // bytes for the same prompt, and the library refuses a duplicate file.
      brief: `A van at sunrise, warm light (${randomUUID().slice(0, 8)}).`,
      formatKey: 'square',
      ...(overrides.contentVariantId ? { contentVariantId: overrides.contentVariantId } : {}),
      ...(overrides.addLogo !== undefined ? { addLogo: overrides.addLogo } : {}),
      ...(overrides.headline !== undefined ? { headline: overrides.headline } : {}),
    }),
  );

const jobRow = (id: string) => platform.creativeGenerationJob.findUniqueOrThrow({ where: { id } });
const balance = async () =>
  (
    await platform.creditWallet.findUniqueOrThrow({
      where: { workspaceId: fixtures.a.workspaceId },
    })
  ).balanceMilliCredits;
const imageCalls = () => mock.calls.filter((call) => call.operation === 'generateImage').length;
const variantAssets = async () =>
  (
    await platform.contentVariant.findUniqueOrThrow({
      where: { id: fixtures.a.contentVariantId },
      select: { assetIds: true },
    })
  ).assetIds;

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);

  const ledger = new CreditLedgerService({ prisma: platform });
  mock = new MockProviderAdapter({});
  gateway = new AiGateway({
    prisma: platform,
    ledger,
    adapters: new Map([['mock', mock]]),
    configuration: { load: async () => aiConfiguration() },
    credentials: { resolve: async () => null },
    environment: 'DEVELOPMENT',
  });
  await platform.creditWallet.upsert({
    where: { workspaceId: fixtures.a.workspaceId },
    create: { workspaceId: fixtures.a.workspaceId },
    update: {},
  });
  await ledger.grant({
    workspaceId: fixtures.a.workspaceId,
    source: 'PLAN_GRANT',
    credits: 5_000,
    reason: 'pr1 creative jobs allowance',
    idempotencyKey: `pr1-jobs-grant-${fixtures.a.workspaceId}`,
  });
}, 90_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('PR 1 · a job, end to end', () => {
  it('is QUEUED at once, then SUCCEEDED with an image, charged once', async () => {
    const before = await balance();
    const { job, created } = await enqueueA();
    expect(created).toBe(true);
    expect(job.status).toBe('QUEUED');

    const outcome = await runCreativeGenerationJob(
      host(fixtures.a.workspaceId, fixtures.a.userId),
      job.id,
    );
    expect(outcome).toBe('succeeded');
    const row = await jobRow(job.id);
    expect(row).toMatchObject({ status: 'SUCCEEDED', attempts: 1, failureReason: null });
    expect(row.assetId).not.toBeNull();
    expect(row.completedAt).not.toBeNull();
    const spent = before - (await balance());
    expect(spent).toBeGreaterThan(0n);
    expect(row.creditsChargedMilli).toBe(spent);
  });

  it('a job asked for from a post attaches the image to that variant, once, audited', async () => {
    const before = await variantAssets();
    const { job } = await enqueueA({ contentVariantId: fixtures.a.contentVariantId });
    await runCreativeGenerationJob(host(fixtures.a.workspaceId, fixtures.a.userId), job.id);

    const row = await jobRow(job.id);
    expect(row.status).toBe('SUCCEEDED');
    expect(row.attachedAt).not.toBeNull();
    const after = await variantAssets();
    expect(after).toEqual([...before, row.assetId]);
    expect(
      await platform.auditEvent.count({
        where: {
          workspaceId: fixtures.a.workspaceId,
          action: 'content.media.attached_by_generation',
          resourceId: fixtures.a.contentVariantId,
        },
      }),
    ).toBeGreaterThanOrEqual(1);
    // Attaching changes media, never the post's status.
    const item = await platform.contentItem.findUniqueOrThrow({
      where: { id: fixtures.a.contentItemId },
      select: { status: true },
    });
    expect(item.status).toBe('DRAFT');
  });

  it('the same key returns the same job; another person or brand gets a miss', async () => {
    const key = `pr1-${randomUUID()}`;
    const ask = (userId: string, brandId: string) =>
      inA((db) =>
        new CreativeGenerationJobs({ db, workspaceId: fixtures.a.workspaceId }).enqueue({
          brandId,
          requestedByUserId: userId,
          brandScope: [],
          idempotencyKey: key,
          brief: 'Same ask twice.',
          formatKey: 'square',
        }),
      );
    const first = await ask(fixtures.a.userId, fixtures.a.brandId);
    const again = await ask(fixtures.a.userId, fixtures.a.brandId);
    expect(again).toEqual({ job: first.job, created: false });
    await expect(ask(randomUUID(), fixtures.a.brandId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('PR 1 · never charged twice', () => {
  it('a second run of a finished job does nothing', async () => {
    const { job } = await enqueueA();
    await runCreativeGenerationJob(host(fixtures.a.workspaceId, fixtures.a.userId), job.id);
    const calls = imageCalls();
    const after = await balance();
    expect(
      await runCreativeGenerationJob(host(fixtures.a.workspaceId, fixtures.a.userId), job.id),
    ).toBe('skipped');
    expect(imageCalls()).toBe(calls);
    expect(await balance()).toBe(after);
  });

  it('two runners at once: one wins, one image, one charge', async () => {
    const before = await balance();
    const calls = imageCalls();
    const { job } = await enqueueA();
    const outcomes = await Promise.all([
      runCreativeGenerationJob(host(fixtures.a.workspaceId, fixtures.a.userId), job.id),
      runCreativeGenerationJob(host(fixtures.a.workspaceId, fixtures.a.userId), job.id),
    ]);
    expect([...outcomes].sort()).toEqual(['skipped', 'succeeded']);
    expect(imageCalls()).toBe(calls + 1);
    const row = await jobRow(job.id);
    expect(before - (await balance())).toBe(row.creditsChargedMilli);
  });

  it('RECOVERY: a job that died after the image was made is finished without a second charge', async () => {
    const before = await balance();
    const { job } = await enqueueA({ contentVariantId: fixtures.a.contentVariantId });
    const first = host(fixtures.a.workspaceId, fixtures.a.userId);
    // The process "dies" after the image is stored but before the job is
    // finished: claimed, generated with the job's own key, never finished.
    const claimed = await inA((db) =>
      new CreativeGenerationJobs({ db, workspaceId: fixtures.a.workspaceId }).claim(job.id),
    );
    expect(claimed?.status).toBe('RUNNING');
    // The generation itself happens (same key the job will use).
    await CreativeStudioService.generateWith(
      (fn) => first.inWorkspace(async (db) => fn(await first.studioFor(db))),
      {
        brandId: fixtures.a.brandId,
        brief: (await jobRow(job.id)).brief,
        formatKey: 'square',
        identity: IDENTITY,
        idempotencyKey: (await jobRow(job.id)).idempotencyKey,
        actorUserId: fixtures.a.userId,
        planKey: null,
        actor: { userId: fixtures.a.userId, permissionKeys: ['assets.upload'], brandScope: [] },
      },
    );
    const charged = before - (await balance());
    const calls = imageCalls();
    // Make the claim look silent for 20 minutes, then sweep.
    await platform.creativeGenerationJob.update({
      where: { id: job.id },
      data: { startedAt: new Date(Date.now() - 20 * 60_000) },
    });
    const stale = await findStaleCreativeJobs(platform as never, {
      queuedBefore: new Date(Date.now() - 60_000),
      runningBefore: new Date(Date.now() - 15 * 60_000),
      limit: 50,
    });
    expect(stale.map((entry) => entry.id)).toContain(job.id);
    const outcome = await runCreativeGenerationJob(first, job.id, {
      staleBefore: new Date(Date.now() - 15 * 60_000),
    });
    expect(outcome).toBe('succeeded');
    expect(imageCalls()).toBe(calls); // no second provider call
    expect(before - (await balance())).toBe(charged); // no second charge
    const row = await jobRow(job.id);
    expect(row).toMatchObject({ status: 'SUCCEEDED', attempts: 2 });
    // The recovered job still lands in the post.
    expect(row.attachedAt).not.toBeNull();
    expect(await variantAssets()).toContain(row.assetId);
  });

  it('RECOVERY: a job claimed the maximum number of times is failed, never run again', async () => {
    const { job } = await enqueueA();
    await platform.creativeGenerationJob.update({
      where: { id: job.id },
      data: {
        status: 'RUNNING',
        attempts: CREATIVE_JOB_MAX_ATTEMPTS,
        startedAt: new Date(Date.now() - 20 * 60_000),
      },
    });
    const calls = imageCalls();
    expect(
      await runCreativeGenerationJob(host(fixtures.a.workspaceId, fixtures.a.userId), job.id, {
        staleBefore: new Date(Date.now() - 15 * 60_000),
      }),
    ).toBe('skipped');
    const failed = await inA((db) =>
      new CreativeGenerationJobs({ db, workspaceId: fixtures.a.workspaceId }).fail(
        { id: job.id, attempts: CREATIVE_JOB_MAX_ATTEMPTS },
        'stuck_timeout',
      ),
    );
    expect(failed).toBe(true);
    expect(imageCalls()).toBe(calls);
    expect(await jobRow(job.id)).toMatchObject({
      status: 'FAILED',
      failureReason: 'stuck_timeout',
    });
  });
});

describe('PR 1 · failures charge nothing and attach nothing', () => {
  it('a provider TIMEOUT fails the job with a reason key', async () => {
    const before = await balance();
    const assets = await variantAssets();
    mock.program({ failWith: 'TIMEOUT', times: 1 });
    const { job } = await enqueueA({ contentVariantId: fixtures.a.contentVariantId });
    const outcome = await runCreativeGenerationJob(
      host(fixtures.a.workspaceId, fixtures.a.userId),
      job.id,
    );
    expect(outcome).toBe('failed');
    expect(await jobRow(job.id)).toMatchObject({
      status: 'FAILED',
      failureReason: 'generation_failed',
      assetId: null,
      attachedAt: null,
    });
    expect(await balance()).toBe(before);
    expect(await variantAssets()).toEqual(assets);
  });

  it('a requester who lost access gets nothing made', async () => {
    const calls = imageCalls();
    const { job } = await enqueueA();
    revoked = true;
    try {
      expect(
        await runCreativeGenerationJob(host(fixtures.a.workspaceId, fixtures.a.userId), job.id),
      ).toBe('failed');
    } finally {
      revoked = false;
    }
    expect(imageCalls()).toBe(calls);
    expect(await jobRow(job.id)).toMatchObject({
      status: 'FAILED',
      failureReason: 'access_revoked',
    });
  });
});

describe('PR 1 · retention', () => {
  it('a finished job past the content retention window is deleted; an unfinished one never is', async () => {
    const done = await enqueueA();
    await runCreativeGenerationJob(host(fixtures.a.workspaceId, fixtures.a.userId), done.job.id);
    const open = await enqueueA();
    const purged = await inA((db) =>
      new CreativeGenerationJobs({
        db,
        workspaceId: fixtures.a.workspaceId,
        clock: { now: () => new Date(Date.now() + 40 * 24 * 3600_000) },
      }).purgeExpired({
        // 30 days of retention, counted from when the job finished.
        expiryFrom: (finishedAt) => new Date(finishedAt.getTime() + 30 * 24 * 3600_000),
        limit: 500,
      }),
    );
    expect(purged).toBeGreaterThanOrEqual(1);
    expect(await platform.creativeGenerationJob.count({ where: { id: done.job.id } })).toBe(0);
    expect(await platform.creativeGenerationJob.count({ where: { id: open.job.id } })).toBe(1);
  });

  it('no retention configured (null) keeps every job', async () => {
    const { job } = await enqueueA();
    await runCreativeGenerationJob(host(fixtures.a.workspaceId, fixtures.a.userId), job.id);
    await inA((db) =>
      new CreativeGenerationJobs({ db, workspaceId: fixtures.a.workspaceId }).purgeExpired({
        expiryFrom: () => null,
        limit: 500,
      }),
    );
    expect(await platform.creativeGenerationJob.count({ where: { id: job.id } })).toBe(1);
  });
});

describe('PR 1 · tenant isolation for creative_generation_job', () => {
  it('B cannot read, list, count, update, delete or run A’s job', async () => {
    const { job } = await enqueueA();
    expect(
      await inB((db) => db.creativeGenerationJob.findFirst({ where: { id: job.id } })),
    ).toBeNull();
    expect(
      await inB((db) =>
        db.creativeGenerationJob.findMany({ where: { workspaceId: fixtures.a.workspaceId } }),
      ),
    ).toEqual([]);
    expect(await inB((db) => db.creativeGenerationJob.count({ where: { id: job.id } }))).toBe(0);
    const updated = await inB((db) =>
      db.creativeGenerationJob.updateMany({ where: { id: job.id }, data: { status: 'FAILED' } }),
    );
    expect(updated.count).toBe(0);
    const deleted = await inB((db) =>
      db.creativeGenerationJob.deleteMany({ where: { id: job.id } }),
    );
    expect(deleted.count).toBe(0);
    // Running it from B's context claims nothing.
    expect(
      await runCreativeGenerationJob(host(fixtures.b.workspaceId, fixtures.b.userId), job.id),
    ).toBe('skipped');
    expect(await jobRow(job.id)).toMatchObject({ status: 'QUEUED', attempts: 0 });
    // And B's service answers A's id as a miss.
    await expect(
      inB((db) =>
        new CreativeGenerationJobs({ db, workspaceId: fixtures.b.workspaceId }).get(job.id, {
          userId: fixtures.b.userId,
          brandScope: [],
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('B cannot write a row into A, nor target A’s variant', async () => {
    await expect(
      inB((db) =>
        db.creativeGenerationJob.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            idempotencyKey: `pr1-x-${randomUUID()}`,
            brief: 'cross',
            formatKey: 'square',
          },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      inB((db) =>
        new CreativeGenerationJobs({ db, workspaceId: fixtures.b.workspaceId }).enqueue({
          brandId: fixtures.b.brandId,
          requestedByUserId: fixtures.b.userId,
          brandScope: [],
          idempotencyKey: `pr1-${randomUUID()}`,
          brief: 'Into A’s post',
          formatKey: 'square',
          contentVariantId: fixtures.a.contentVariantId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // The composite foreign key refuses it below the service too.
    await expect(
      inB((db) =>
        db.creativeGenerationJob.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            brandId: fixtures.b.brandId,
            idempotencyKey: `pr1-fk-${randomUUID()}`,
            brief: 'fk',
            formatKey: 'square',
            contentVariantId: fixtures.a.contentVariantId,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('A cannot target a variant of another of its own brands', async () => {
    const other = await inA((db) =>
      db.brand.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          slug: `pr1-${randomUUID().slice(0, 8)}`,
          name: 'Other brand',
          status: 'ACTIVE',
        },
        select: { id: true },
      }),
    );
    await expect(
      enqueueA({ brandId: other.id, contentVariantId: fixtures.a.contentVariantId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

/**
 * The sweep reads stale jobs across every workspace. Jobs earlier tests here
 * queued and left (a key reused, a refusal) turn stale once this file has run
 * past a minute — which composing the image (PR B) makes it do — and the sweep
 * would then run them too (and so would jobs an earlier, interrupted run
 * left). Each sweep test first finishes exactly what the sweep would pick up,
 * so it sees only its own job.
 */
async function retireLeftovers(): Promise<void> {
  // Exactly what the sweep would pick up (its own criteria), in any workspace.
  await platform.creativeGenerationJob.updateMany({
    where: {
      OR: [
        { status: 'QUEUED', createdAt: { lt: new Date(Date.now() - 60_000) } },
        { status: 'RUNNING', startedAt: { lt: new Date(Date.now() - 15 * 60_000) } },
      ],
    },
    data: { status: 'FAILED', completedAt: new Date(), failureReason: 'stuck_timeout' },
  });
}

describe('PR 1 · the scheduler sweep', () => {
  it('fails a job silent past the limit and claimed the maximum times, as stuck_timeout', async () => {
    const { MaintenanceScheduler } = await import('../../apps/api/src/scheduler');
    await retireLeftovers();
    const { job } = await enqueueA();
    await platform.creativeGenerationJob.update({
      where: { id: job.id },
      data: {
        status: 'RUNNING',
        attempts: CREATIVE_JOB_MAX_ATTEMPTS,
        startedAt: new Date(Date.now() - 60 * 60_000),
      },
    });
    const calls = imageCalls();
    const acted = await new MaintenanceScheduler({
      environment: 'DEVELOPMENT',
    }).recoverCreativeJobs(500);
    expect(acted).toBeGreaterThanOrEqual(1);
    expect(await jobRow(job.id)).toMatchObject({
      status: 'FAILED',
      failureReason: 'stuck_timeout',
    });
    expect(imageCalls()).toBe(calls);
  });
});

describe('PR 1 · carried into PR 2: the scheduler, end to end', () => {
  it('a QUEUED job left over a minute is run by the sweep, charged exactly once; a second sweep does nothing', async () => {
    const { MaintenanceScheduler } = await import('../../apps/api/src/scheduler');
    await retireLeftovers();
    const scheduler = new MaintenanceScheduler({
      environment: 'DEVELOPMENT',
      creativeJobHost: (workspaceId) => host(workspaceId, fixtures.a.userId),
    });
    const before = await balance();
    const calls = imageCalls();
    const { job } = await enqueueA({ contentVariantId: fixtures.a.contentVariantId });
    // The in-process start was lost (a restart): the row sat QUEUED.
    await platform.creativeGenerationJob.update({
      where: { id: job.id },
      data: { createdAt: new Date(Date.now() - 5 * 60_000) },
    });

    expect(await scheduler.recoverCreativeJobs(500)).toBeGreaterThanOrEqual(1);
    const row = await jobRow(job.id);
    expect(row).toMatchObject({ status: 'SUCCEEDED', attempts: 1 });
    expect(row.attachedAt).not.toBeNull();
    expect(imageCalls()).toBe(calls + 1);
    const charged = before - (await balance());
    expect(charged).toBe(row.creditsChargedMilli);

    // Swept again: nothing to do, nothing charged, no provider call.
    await scheduler.recoverCreativeJobs(500);
    expect(imageCalls()).toBe(calls + 1);
    expect(before - (await balance())).toBe(charged);
    expect(await jobRow(job.id)).toMatchObject({ status: 'SUCCEEDED', attempts: 1 });
  });

  it('the scheduler purge deletes a finished job past the workspace’s AI-content retention, brief and all', async () => {
    const { MaintenanceScheduler } = await import('../../apps/api/src/scheduler');
    const done = await enqueueA();
    await runCreativeGenerationJob(host(fixtures.a.workspaceId, fixtures.a.userId), done.job.id);
    const open = await enqueueA();
    const workspace = await platform.workspace.findUniqueOrThrow({
      where: { id: fixtures.a.workspaceId },
      select: { aiContentRetentionDays: true },
    });
    // The workspace's own retention setting, and a job finished long ago.
    await platform.workspace.update({
      where: { id: fixtures.a.workspaceId },
      data: { aiContentRetentionDays: 30 },
    });
    await platform.creativeGenerationJob.update({
      where: { id: done.job.id },
      data: { completedAt: new Date(Date.now() - 400 * 24 * 3600_000) },
    });
    try {
      const purged = await new MaintenanceScheduler({
        environment: 'DEVELOPMENT',
      }).purgeCreativeJobs(500);
      expect(purged).toBeGreaterThanOrEqual(1);
      expect(await platform.creativeGenerationJob.count({ where: { id: done.job.id } })).toBe(0);
      // An unfinished job, and its brief, are never purged.
      expect(await platform.creativeGenerationJob.count({ where: { id: open.job.id } })).toBe(1);
    } finally {
      await platform.workspace.update({
        where: { id: fixtures.a.workspaceId },
        data: { aiContentRetentionDays: workspace.aiContentRetentionDays },
      });
    }
  });
});

/**
 * PR A — THE #122 RACE, ORDER FORCED (owner, 2026-11-11).
 *
 * The job used to succeed and attach while its image was still being
 * scanned, and the editor's save — which takes only READY + CLEAN media —
 * answered NOT_FOUND. These tests hold the scan back on purpose and look at
 * the job, the post and the save in each order.
 */
describe('PR A · the image is checked before the job succeeds (the #122 race)', () => {
  const CONTENT_POLICY = parseContentPolicy(defaultPayload('content'));

  /** The editor's own save: the variant with these images, through the real service. */
  const save = (assetIds: readonly string[]) =>
    inA((db) =>
      new ContentLibraryService({
        db,
        workspaceId: fixtures.a.workspaceId,
        policy: CONTENT_POLICY,
      }).editVariant({
        variantId: fixtures.a.contentVariantId,
        body: 'Spring window, now with the picture.',
        assetIds,
        actorUserId: fixtures.a.userId,
        actorBrandScope: [],
        actorPermissionKeys: ['content.edit', 'content.schedule'],
      }),
    );

  const view = (id: string) =>
    inA((db) =>
      new CreativeGenerationJobs({ db, workspaceId: fixtures.a.workspaceId }).get(id, {
        userId: fixtures.a.userId,
        brandScope: [],
      }),
    );

  const clearVariant = () =>
    platform.contentVariant.update({
      where: { id: fixtures.a.contentVariantId },
      data: { assetIds: [] },
    });

  it('the image still being checked: the job stays RUNNING, nothing is attached, the save is NOT_FOUND; once READY + CLEAN it succeeds, attaches, and the save is SAVED', async () => {
    await clearVariant();
    const { job } = await enqueueA({ contentVariantId: fixtures.a.contentVariantId });
    let looked = 0;
    const base = host(fixtures.a.workspaceId, fixtures.a.userId);
    const outcome = await runCreativeGenerationJob(
      {
        ...base,
        sleep: async () => {
          looked += 1;
          // THE IMAGE IS MADE AND STORED, AND NOT YET CHECKED.
          const row = await jobRow(job.id);
          expect(row.assetId).not.toBeNull();
          const asset = await platform.asset.findUniqueOrThrow({
            where: { id: String(row.assetId) },
            select: { status: true, scanStatus: true },
          });
          expect(asset.status).not.toBe('READY');
          expect(asset.scanStatus).not.toBe('CLEAN');
          // The job waits: RUNNING, no image named to the person, none attached.
          expect(row).toMatchObject({ status: 'RUNNING', attachedAt: null, completedAt: null });
          expect((await view(job.id)).assetId).toBeNull();
          expect(await variantAssets()).toEqual([]);
          // The editor saving that image now is refused — which is why the
          // job must not hand it over yet.
          await expect(save([String(row.assetId)])).rejects.toMatchObject({ code: 'NOT_FOUND' });
          // Now the worker scans it.
          await base.sleep?.(0);
        },
      },
      job.id,
    );
    expect(looked).toBeGreaterThanOrEqual(1);
    expect(outcome).toBe('succeeded');

    const row = await jobRow(job.id);
    expect(row.status).toBe('SUCCEEDED');
    expect(row.attachedAt).not.toBeNull();
    const asset = await platform.asset.findUniqueOrThrow({
      where: { id: String(row.assetId) },
      select: { status: true, scanStatus: true },
    });
    expect(asset).toEqual({ status: 'READY', scanStatus: 'CLEAN' });
    expect(await variantAssets()).toEqual([row.assetId]);
    expect((await view(job.id)).assetId).toBe(row.assetId);
    // The editor's save of the attached image now goes through.
    const saved = await save(await variantAssets());
    expect(saved.assetIds).toEqual([row.assetId]);
  });

  it('the check refuses the image (quarantined): the job FAILS image_not_checked and nothing is attached', async () => {
    await clearVariant();
    const { job } = await enqueueA({ contentVariantId: fixtures.a.contentVariantId });
    const outcome = await runCreativeGenerationJob(
      {
        ...host(fixtures.a.workspaceId, fixtures.a.userId),
        // The worker's verdict on this image: infected, quarantined.
        sleep: async () => {
          const row = await jobRow(job.id);
          await platform.asset.update({
            where: { id: String(row.assetId) },
            data: { status: 'QUARANTINED', scanStatus: 'INFECTED' },
          });
        },
      },
      job.id,
    );
    expect(outcome).toBe('failed');
    const row = await jobRow(job.id);
    expect(row).toMatchObject({
      status: 'FAILED',
      failureReason: 'image_not_checked',
      attachedAt: null,
    });
    expect(await variantAssets()).toEqual([]);
    expect((await view(job.id)).assetId).toBeNull();
    expect(
      await platform.auditEvent.count({
        where: {
          workspaceId: fixtures.a.workspaceId,
          action: 'content.media.attached_by_generation',
          after: { path: ['creativeGenerationJobId'], equals: job.id },
        },
      }),
    ).toBe(0);
  });

  it('the attach re-checks in its own transaction: an image not READY + CLEAN finishes nothing', async () => {
    await clearVariant();
    const { job } = await enqueueA({ contentVariantId: fixtures.a.contentVariantId });
    const jobs = (db: TenantScopedClient) =>
      new CreativeGenerationJobs({ db, workspaceId: fixtures.a.workspaceId });
    const claimed = await inA((db) => jobs(db).claim(job.id));
    if (!claimed) throw new Error('not claimed');
    const run = host(fixtures.a.workspaceId, fixtures.a.userId);
    const made = await CreativeStudioService.generateWith(
      (fn) => run.inWorkspace(async (db) => fn(await run.studioFor(db))),
      {
        brandId: fixtures.a.brandId,
        brief: claimed.brief,
        formatKey: 'square',
        identity: IDENTITY,
        idempotencyKey: claimed.idempotencyKey,
        actorUserId: fixtures.a.userId,
        planKey: null,
        actor: { userId: fixtures.a.userId, permissionKeys: ['assets.upload'], brandScope: [] },
      },
    );
    expect(await inA((db) => jobs(db).recordGenerated(claimed, made))).toBe(true);

    // Not scanned yet: succeed() itself refuses, and writes nothing.
    expect(await inA((db) => jobs(db).succeed(claimed))).toEqual({ kind: 'not_clean' });
    expect(await jobRow(job.id)).toMatchObject({ status: 'RUNNING', attachedAt: null });
    expect(await variantAssets()).toEqual([]);

    // Scanned clean: the same call now finishes and attaches.
    await scanQueued(fixtures.a.workspaceId);
    const finished = await inA((db) => jobs(db).succeed(claimed));
    expect(finished.kind).toBe('done');
    expect(await variantAssets()).toEqual([made.assetId]);

    // A second finish of the same claim writes nothing more.
    expect(await inA((db) => jobs(db).succeed(claimed))).toEqual({ kind: 'lost' });
  });

  it('a check still undecided when the run stops waiting leaves the job RUNNING for the sweep, attached nowhere', async () => {
    await clearVariant();
    const { job } = await enqueueA({ contentVariantId: fixtures.a.contentVariantId });
    const outcome = await runCreativeGenerationJob(
      { ...host(fixtures.a.workspaceId, fixtures.a.userId), checkWaitMs: 0, sleep: async () => {} },
      job.id,
    );
    expect(outcome).toBe('skipped');
    expect(await jobRow(job.id)).toMatchObject({ status: 'RUNNING', attachedAt: null });
    expect(await variantAssets()).toEqual([]);
    // The worker scans it later; the sweep's re-run finishes it, uncharged.
    const before = await balance();
    const calls = imageCalls();
    await scanQueued(fixtures.a.workspaceId);
    await platform.creativeGenerationJob.update({
      where: { id: job.id },
      data: { startedAt: new Date(Date.now() - 20 * 60_000) },
    });
    expect(
      await runCreativeGenerationJob(host(fixtures.a.workspaceId, fixtures.a.userId), job.id, {
        staleBefore: new Date(Date.now() - 15 * 60_000),
      }),
    ).toBe('succeeded');
    expect(imageCalls()).toBe(calls);
    expect(await balance()).toBe(before);
    const row = await jobRow(job.id);
    expect(row.creditsChargedMilli).toBeGreaterThan(0n);
    expect(await variantAssets()).toEqual([row.assetId]);
  });
});

/**
 * PR B (D-601, D-602; owner 2026-11-14) — WHAT IS PUT ON THE MADE IMAGE, as
 * the person chose it: the brand's real logo (on by default, off when asked)
 * and an optional headline, stored on the job so any run uses exactly that.
 * The stored image says in its EXIF description which logo and font were used.
 */
describe('PR B · the logo and the headline, through the job', () => {
  const store = createObjectStore({ appEnv: 'test' });
  const logoFile = (hex: string) =>
    sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="120"><rect width="300" height="120" fill="${hex}"/></svg>`,
      ),
    )
      .png()
      .toBuffer();
  const withLogos = async (): Promise<CreativeJobRunHost> => {
    const base = host(fixtures.a.workspaceId, fixtures.a.userId);
    const logos = {
      primary: new Uint8Array(await logoFile('#111114')),
      secondary: new Uint8Array(await logoFile('#ffffff')),
    };
    return { ...base, identityFor: async () => ({ ...IDENTITY, logos }) };
  };
  /** What the stored image says it carries. */
  const note = async (jobId: string) => {
    const row = await jobRow(jobId);
    const asset = await platform.asset.findUniqueOrThrow({
      where: { id: String(row.assetId) },
      select: { storageKey: true, mimeType: true },
    });
    const bytes = await store.get(asset.storageKey);
    const { exif } = await sharp(Buffer.from(bytes ?? [])).metadata();
    return { mimeType: asset.mimeType, text: Buffer.from(exif ?? []).toString('latin1') };
  };

  it('by default the brand’s real logo is put on the image', async () => {
    const { job } = await enqueueA();
    expect(job).toMatchObject({ addLogo: true, headline: null });
    expect(await runCreativeGenerationJob(await withLogos(), job.id)).toBe('succeeded');
    const stored = await note(job.id);
    expect(stored.mimeType).toBe('image/jpeg');
    expect(stored.text).toMatch(/logo: (primary|secondary)/);
    expect(stored.text).toContain('headline font: none');
  });

  it('asked without the logo: none is put on, even though the brand has one', async () => {
    const { job } = await enqueueA({ addLogo: false });
    expect((await jobRow(job.id)).addLogo).toBe(false);
    expect(await runCreativeGenerationJob(await withLogos(), job.id)).toBe('succeeded');
    expect((await note(job.id)).text).toContain('logo: none');
  });

  it('a brand with no logo on file still gets its image, with none placed', async () => {
    const { job } = await enqueueA();
    expect(
      await runCreativeGenerationJob(host(fixtures.a.workspaceId, fixtures.a.userId), job.id),
    ).toBe('succeeded');
    expect((await note(job.id)).text).toContain('logo: none');
  });

  it('a headline is stored with the job and drawn in the licensed default font', async () => {
    const { job } = await enqueueA({ headline: '  خصم   ٢٠٪ هذا الأسبوع ' });
    // Stored tidy: trimmed, inner spaces collapsed.
    expect((await jobRow(job.id)).headline).toBe('خصم ٢٠٪ هذا الأسبوع');
    expect(await runCreativeGenerationJob(await withLogos(), job.id)).toBe('succeeded');
    expect((await note(job.id)).text).toContain('headline font: IBM Plex Sans Arabic');
  });

  it('a headline over 80 characters is refused before anything is queued; an empty one is none', async () => {
    await expect(enqueueA({ headline: 'x'.repeat(81) })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const { job } = await enqueueA({ headline: '   ' });
    expect((await jobRow(job.id)).headline).toBeNull();
    // And the database refuses one past the limit written around the service.
    await expect(
      platform.creativeGenerationJob.update({
        where: { id: job.id },
        data: { headline: 'y'.repeat(81) },
      }),
    ).rejects.toThrow();
  });

  it('TENANT ISOLATION: B cannot read or change A’s logo choice or headline', async () => {
    const { job } = await enqueueA({ headline: 'Private headline', addLogo: false });
    expect(
      await inB((db) =>
        db.creativeGenerationJob.findFirst({
          where: { id: job.id },
          select: { headline: true, addLogo: true },
        }),
      ),
    ).toBeNull();
    expect(
      await inB((db) =>
        db.creativeGenerationJob.count({ where: { headline: 'Private headline' } }),
      ),
    ).toBe(0);
    const changed = await inB((db) =>
      db.creativeGenerationJob.updateMany({
        where: { id: job.id },
        data: { headline: 'Changed by B', addLogo: true },
      }),
    );
    expect(changed.count).toBe(0);
    expect(await jobRow(job.id)).toMatchObject({ headline: 'Private headline', addLogo: false });
  });
});
