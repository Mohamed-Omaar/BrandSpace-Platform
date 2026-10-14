import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AssetProcessingService,
  AssetUploadService,
  MockVirusScanner,
  assetPolicyFrom,
  recoverStuckAssetJob,
  type AssetClaim,
  type ScanResult,
  type VirusScanner,
} from '@brandspace/assets';
import { defaultPayload } from '@brandspace/config';
import { withWorkspace } from '@brandspace/database';
import { UsageService } from '@brandspace/entitlements';
import { PROCESS_ASSET, assetJobKey, closeQueues, queueFor, queueUrl } from '@brandspace/jobs';
import { InMemoryObjectStore } from '@brandspace/storage';
import { WORKSPACE_PERMISSIONS } from '@brandspace/shared';
import { MaintenanceScheduler } from '../../apps/api/src/scheduler';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * FINAL REVIEW OF #83 (D-549) — AN UPLOAD NO LONGER STAYS "PROCESSING".
 *
 * Uploads are live in the beta, scanning off, and every one of them goes
 * through `asset_processing_job`. Three defects, one symptom — the same three
 * D-413 fixed for Brand Brain ingestion:
 *   1. A retryable failure re-queued the SAME row and the reconciler re-sent the
 *      SAME BullMQ id (`asset-<id>`); BullMQ keeps finished jobs and ignores a
 *      re-add, so the retry never ran.
 *   2. The claim was an unconditional update inside the run's own transaction:
 *      two deliveries both ran, and a run that threw rolled its claim back, so
 *      the attempt was never counted and a file that failed the same way every
 *      time was re-dispatched for ever.
 *   3. `reclaimStuckJobs` had no caller, and only listed rows.
 *
 * Proven against real PostgreSQL (RLS, the tenant role) and real Redis, through
 * the same two transactions the worker runs: the claim, committed, then the run.
 */

let fixtures: IsolationFixtures;
let app: PrismaClient;

const policy = assetPolicyFrom(defaultPayload('assets'));
const ALL: readonly string[] = WORKSPACE_PERMISSIONS.map((p) => p.key);

/** A scanner whose first `failures` scans throw — the engine unreachable, which earns a retry. */
class FlakyScanner implements VirusScanner {
  readonly key = 'flaky';
  readonly #inner = new MockVirusScanner();
  #failures: number;
  constructor(failures: number) {
    this.#failures = failures;
  }
  async scan(input: { bytes: Uint8Array; declaredMimeType: string }): Promise<ScanResult> {
    if (this.#failures > 0) {
      this.#failures -= 1;
      throw new Error('scanner unreachable');
    }
    return this.#inner.scan(input);
  }
}

/** A store whose reads throw `failures` times — a storage outage the run cannot survive. */
class ThrowingStore extends InMemoryObjectStore {
  #failures: number;
  constructor(failures: number) {
    super();
    this.#failures = failures;
  }
  override async get(storageKey: string): Promise<Uint8Array | null> {
    if (this.#failures > 0) {
      this.#failures -= 1;
      throw new Error('storage unavailable');
    }
    return super.get(storageKey);
  }
}

type Db = Parameters<Parameters<typeof withWorkspace>[1]>[0];

const inWorkspace = <T>(workspaceId: string, fn: (db: Db) => Promise<T>) =>
  withWorkspace(workspaceId, fn as never, { prisma: app }) as Promise<T>;
const inA = <T>(fn: (db: Db) => Promise<T>) => inWorkspace(fixtures.a.workspaceId, fn);

function processing(
  db: Db,
  store: InMemoryObjectStore,
  scanner: VirusScanner = new MockVirusScanner(),
  workspaceId = fixtures.a.workspaceId,
) {
  return new AssetProcessingService({ db, workspaceId, store, policy, scanner });
}

function png(): Uint8Array {
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...new TextEncoder().encode(randomUUID()),
  ]);
}

/** Upload one file into `store`; returns its processing job and asset ids. */
async function uploaded(store: InMemoryObjectStore, workspace: 'a' | 'b' = 'a') {
  const f = workspace === 'a' ? fixtures.a : fixtures.b;
  return inWorkspace(f.workspaceId, async (db) => {
    const upload = new AssetUploadService({
      db,
      workspaceId: f.workspaceId,
      policy,
      store,
      usage: new UsageService({ prisma: db as unknown as PrismaClient }),
      storageLimitGb: null,
    });
    const actor = { userId: f.userId, permissionKeys: ALL, brandScope: [] };
    const bytes = png();
    const session = await upload.initiate({
      brandId: null,
      folderId: null,
      fileName: `d549-${randomUUID().slice(0, 6)}.png`,
      mimeType: 'image/png',
      sizeBytes: bytes.byteLength,
      idempotencyKey: `d549-${randomUUID()}`,
      actor,
    });
    const completed = await upload.complete({ sessionId: session.session.id, bytes, actor });
    if (!completed.job) throw new Error('an upload must queue a processing job');
    return { jobId: completed.job.id, assetId: completed.asset.id };
  });
}

/** The worker's two transactions for one message: the claim (committed), then the run. */
async function deliver(
  store: InMemoryObjectStore,
  jobId: string,
  attempt?: number,
  scanner?: VirusScanner,
) {
  const claimed: AssetClaim = await inA((db) =>
    processing(db, store, scanner).claim(jobId, attempt),
  );
  if (!claimed.claimed) return { claimed, result: null };
  const result = await inA((db) => processing(db, store, scanner).run(claimed));
  return { claimed, result };
}

const jobRow = (id: string) =>
  inA((db) => db.assetProcessingJob.findUniqueOrThrow({ where: { id } }));
const assetRow = (id: string) => inA((db) => db.asset.findUniqueOrThrow({ where: { id } }));
const audits = (assetId: string, action: string) =>
  inA((db) => db.auditEvent.count({ where: { resourceId: assetId, action } }));

const scheduler = () => new MaintenanceScheduler({ environment: 'DEVELOPMENT' });
const queued: string[] = [];

beforeAll(async () => {
  if (!queueUrl()) {
    throw new Error('REDIS_URL is not configured. The retry dispatch is the defect under test.');
  }
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 60_000);

afterAll(async () => {
  for (const id of queued)
    await queueFor('media-processing')
      .remove(id)
      .catch(() => undefined);
  await closeQueues();
  await app?.$disconnect();
});

describe('D-549 · a retryable failure is really retried, exactly once', () => {
  it('the retry is dispatched under its own id, runs, and a replay of either attempt changes nothing', async () => {
    const store = new InMemoryObjectStore();
    const scanner = new FlakyScanner(1);
    const { jobId, assetId } = await uploaded(store);

    // Attempt 1: the scanner is unreachable. QUEUED again, the file still unusable.
    const first = await deliver(store, jobId, 1, scanner);
    expect(first.claimed.claimed).toBe(true);
    expect(await jobRow(jobId)).toMatchObject({ stage: 'QUEUED', attempts: 1 });
    expect((await assetRow(assetId)).status).toBe('QUARANTINED');

    // The reconciler, once the backoff has passed, names attempt 2 — a new id.
    await inA((db) =>
      db.assetProcessingJob.update({ where: { id: jobId }, data: { nextAttemptAt: new Date(0) } }),
    );
    const secondId = assetJobKey(jobId, 2);
    queued.push(assetJobKey(jobId, 1), secondId);
    await scheduler().reconcileAssetProcessing(500);
    const dispatched = await queueFor('media-processing').getJob(secondId);
    expect(dispatched?.data).toMatchObject({
      kind: PROCESS_ASSET,
      processingJobId: jobId,
      attempt: 2,
      idempotencyKey: secondId,
    });

    // Attempt 2 runs: the file is READY.
    const second = await deliver(store, jobId, 2, scanner);
    expect(second.result?.status).toBe('READY');
    expect(await jobRow(jobId)).toMatchObject({ stage: 'COMPLETED', attempts: 2 });
    expect(await audits(assetId, 'assets.processed')).toBe(1);

    // A replay of attempt 1, of attempt 2, and a message from the previous
    // release with no attempt at all: none claims, none writes.
    for (const attempt of [1, 2, undefined]) {
      const replay = await deliver(store, jobId, attempt, scanner);
      expect(replay.claimed.claimed).toBe(false);
    }
    expect(await jobRow(jobId)).toMatchObject({ stage: 'COMPLETED', attempts: 2 });
    expect(await audits(assetId, 'assets.processed')).toBe(1);
  });

  it('two deliveries at once, each in its own transaction: the file is processed once', async () => {
    const store = new InMemoryObjectStore();
    const { jobId, assetId } = await uploaded(store);
    await Promise.all([0, 1].map(() => inA((db) => processing(db, store).process(jobId))));
    expect(await jobRow(jobId)).toMatchObject({ stage: 'COMPLETED', attempts: 1 });
    expect(await audits(assetId, 'assets.processed')).toBe(1);
  });

  it('two claims of the same attempt at once: exactly one claims', async () => {
    const store = new InMemoryObjectStore();
    const { jobId } = await uploaded(store);
    const claims = await Promise.all(
      [0, 1].map(() => inA((db) => processing(db, store).claim(jobId, 1))),
    );
    expect(claims.filter((c) => c.claimed)).toHaveLength(1);
    expect(await jobRow(jobId)).toMatchObject({ stage: 'SCANNING', attempts: 1 });
  });

  it('a run that throws after its claim has still spent the attempt', async () => {
    const store = new ThrowingStore(1);
    const { jobId } = await uploaded(store);
    await expect(deliver(store, jobId, 1)).rejects.toThrow('storage unavailable');
    // Before: the claim rolled back with the run — QUEUED, 0 attempts, for ever.
    expect(await jobRow(jobId)).toMatchObject({ stage: 'SCANNING', attempts: 1 });
    // A redelivery of the same message claims nothing.
    expect((await deliver(store, jobId, 1)).claimed.claimed).toBe(false);
  });
});

describe('D-549 · the stuck-job sweep, wired into the scheduler', () => {
  async function stuck(attempts: number, startedAgoSeconds: number, workspace: 'a' | 'b' = 'a') {
    const store = new InMemoryObjectStore();
    const ids = await uploaded(store, workspace);
    const f = workspace === 'a' ? fixtures.a : fixtures.b;
    await inWorkspace(f.workspaceId, (db) =>
      db.assetProcessingJob.update({
        where: { id: ids.jobId },
        data: {
          stage: 'SCANNING',
          attempts,
          startedAt: new Date(Date.now() - startedAgoSeconds * 1000),
        },
      }),
    );
    return ids;
  }

  it('hands a silent claim back to the queue, audited, and the next reconcile sends the NEXT attempt', async () => {
    const { jobId, assetId } = await stuck(1, 3 * 3600);
    const sweep = scheduler();
    expect(await sweep.recoverStuckAssetProcessing(500)).toBeGreaterThanOrEqual(1);
    const row = await jobRow(jobId);
    expect(row).toMatchObject({ stage: 'QUEUED', attempts: 1, failureCode: 'stuck_timeout' });
    expect(row.nextAttemptAt).not.toBeNull();
    expect((await assetRow(assetId)).status).toBe('PROCESSING');
    expect(await audits(assetId, 'assets.processing_retry_scheduled')).toBe(1);

    await inA((db) =>
      db.assetProcessingJob.update({ where: { id: jobId }, data: { nextAttemptAt: new Date(0) } }),
    );
    const next = assetJobKey(jobId, 2);
    queued.push(next);
    await sweep.reconcileAssetProcessing(500);
    expect((await queueFor('media-processing').getJob(next))?.data.attempt).toBe(2);
  });

  it('at the attempt limit it fails the job, and the file reads PROCESSING_FAILED — not processing', async () => {
    const { jobId, assetId } = await stuck(3, 3 * 3600);
    await scheduler().recoverStuckAssetProcessing(500);
    expect(await jobRow(jobId)).toMatchObject({ stage: 'FAILED', failureCode: 'stuck_timeout' });
    expect(await assetRow(assetId)).toMatchObject({
      status: 'PROCESSING_FAILED',
      failureReason: 'stuck_timeout',
    });
    expect(await audits(assetId, 'assets.processing_failed')).toBe(1);
  });

  it('leaves a recent claim alone, and never touches a QUEUED row', async () => {
    const recent = await stuck(1, 5);
    const store = new InMemoryObjectStore();
    const waiting = await uploaded(store);
    await inA((db) =>
      db.assetProcessingJob.update({
        where: { id: waiting.jobId },
        data: { startedAt: new Date(Date.now() - 3 * 3600_000), attempts: 1 },
      }),
    );
    const before = await jobRow(waiting.jobId);

    await scheduler().recoverStuckAssetProcessing(500);
    expect(await jobRow(recent.jobId)).toMatchObject({ stage: 'SCANNING', attempts: 1 });
    expect(await jobRow(waiting.jobId)).toMatchObject({
      stage: 'QUEUED',
      nextAttemptAt: before.nextAttemptAt,
      failureCode: before.failureCode,
    });
  });

  it('sweep first, then the late worker: the worker writes NOTHING', async () => {
    const store = new InMemoryObjectStore();
    const { jobId, assetId } = await uploaded(store);
    const claimed = await inA((db) => processing(db, store).claim(jobId, 1));
    expect(claimed.claimed).toBe(true);

    // The run went silent; the sweep, whose cut-off is later, hands the row back.
    const row = await jobRow(jobId);
    const outcome = await inA((db) =>
      recoverStuckAssetJob({
        db,
        workspaceId: fixtures.a.workspaceId,
        job: row,
        stuckBefore: new Date(Date.now() + 24 * 3600_000),
        retryBackoffSeconds: 60,
        clock: { now: () => new Date() },
      }),
    );
    expect(outcome).toBe('requeued');

    // The zombie runs: fenced out.
    const late = await inA((db) => processing(db, store).run(claimed));
    expect(late.status).toBe('PROCESSING');
    expect(await jobRow(jobId)).toMatchObject({ stage: 'QUEUED', attempts: 1 });
    expect(await audits(assetId, 'assets.processed')).toBe(0);
  });

  it('worker first, then the sweep: the finished job is kept', async () => {
    const store = new InMemoryObjectStore();
    const { jobId } = await uploaded(store);
    expect((await deliver(store, jobId, 1)).result?.status).toBe('READY');
    const row = await jobRow(jobId);
    const outcome = await inA((db) =>
      recoverStuckAssetJob({
        db,
        workspaceId: fixtures.a.workspaceId,
        job: row,
        stuckBefore: new Date(Date.now() + 24 * 3600_000),
        retryBackoffSeconds: 60,
        clock: { now: () => new Date() },
      }),
    );
    expect(outcome).toBe('skipped');
    expect(await jobRow(jobId)).toMatchObject({ stage: 'COMPLETED' });
  });

  it('two sweeps at once (two replicas) recover a row once, with one audit event', async () => {
    const { jobId, assetId } = await stuck(1, 3 * 3600);
    const row = await jobRow(jobId);
    const recover = () =>
      inA((db) =>
        recoverStuckAssetJob({
          db,
          workspaceId: fixtures.a.workspaceId,
          job: row,
          stuckBefore: new Date(Date.now() - 60_000),
          retryBackoffSeconds: 60,
          clock: { now: () => new Date() },
        }),
      );
    const outcomes = await Promise.all([recover(), recover()]);
    expect(outcomes.filter((o) => o === 'requeued')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'skipped')).toHaveLength(1);
    expect(await audits(assetId, 'assets.processing_retry_scheduled')).toBe(1);
  });

  it("another workspace's stuck row cannot be touched from this workspace's context", async () => {
    const theirs = await stuck(1, 3 * 3600, 'b');
    const row = await inWorkspace(fixtures.b.workspaceId, (db) =>
      db.assetProcessingJob.findUniqueOrThrow({ where: { id: theirs.jobId } }),
    );
    const outcome = await inA((db) =>
      recoverStuckAssetJob({
        db,
        workspaceId: fixtures.a.workspaceId,
        job: row,
        stuckBefore: new Date(),
        retryBackoffSeconds: 60,
        clock: { now: () => new Date() },
      }),
    );
    expect(outcome).toBe('skipped');
    const after = await inWorkspace(fixtures.b.workspaceId, (db) =>
      db.assetProcessingJob.findUniqueOrThrow({ where: { id: theirs.jobId } }),
    );
    expect(after).toMatchObject({ stage: 'SCANNING', attempts: 1 });
  });
});

describe('D-549 · an upload that fails every time ends, it does not spin', () => {
  it('a run that throws on every attempt ends PROCESSING_FAILED after the attempt limit', async () => {
    const store = new ThrowingStore(Number.MAX_SAFE_INTEGER);
    const { jobId, assetId } = await uploaded(store);
    const later = new Date(Date.now() + 24 * 3600_000);

    for (let attempt = 1; attempt <= policy.processing.maxAttempts; attempt += 1) {
      // The message: claimed, then the run throws.
      await expect(deliver(store, jobId, attempt)).rejects.toThrow('storage unavailable');
      expect(await jobRow(jobId)).toMatchObject({ stage: 'SCANNING', attempts: attempt });
      // The sweep, once the claim has gone silent.
      const row = await jobRow(jobId);
      await inA((db) =>
        recoverStuckAssetJob({
          db,
          workspaceId: fixtures.a.workspaceId,
          job: row,
          stuckBefore: later,
          retryBackoffSeconds: 0,
          clock: { now: () => new Date() },
        }),
      );
    }

    expect(await jobRow(jobId)).toMatchObject({
      stage: 'FAILED',
      attempts: policy.processing.maxAttempts,
    });
    expect(await assetRow(assetId)).toMatchObject({
      status: 'PROCESSING_FAILED',
      failureReason: 'stuck_timeout',
    });
    // Nothing is left for the reconciler to send.
    expect((await deliver(store, jobId)).claimed.claimed).toBe(false);
  });
});
