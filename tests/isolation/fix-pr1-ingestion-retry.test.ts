import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import { UsageService } from '@brandspace/entitlements';
import {
  BrandIngestionService,
  ExtractorRegistry,
  InMemoryObjectStore,
  PlainTextExtractor,
  extractSourceDocument,
  recoverStuckIngestionJob,
  type ExtractionLimits,
  type IngestionPolicy,
} from '@brandspace/brand-brain';
import {
  INGEST_SOURCE_DOCUMENT,
  closeQueues,
  enqueueReplacingFinished,
  ingestionJobKey,
  queueFor,
  queueUrl,
} from '@brandspace/jobs';
import { MaintenanceScheduler } from '../../apps/api/src/scheduler';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * FIX PR 1 · F2 (D-413) — A BRAND BRAIN DOCUMENT NO LONGER STAYS "PROCESSING".
 *
 * Three defects, one symptom:
 *   1. A transient failure re-queued the SAME row and the reconciler re-sent the
 *      SAME BullMQ id (`ingest-<id>`); BullMQ keeps finished jobs and ignores a
 *      re-add, so the retry never ran.
 *   2. The claim was an unconditional update, so a redelivered message re-ran a
 *      job that was running or finished.
 *   3. `sweepStuckJobs` had no caller, and was unsafe to give one: it took QUEUED
 *      rows and raced the worker.
 *
 * Proven against real PostgreSQL (RLS, the tenant role) and real Redis, through
 * the same three phases the worker runs.
 */

let fixtures: IsolationFixtures;
let app: PrismaClient;

const POLICY: IngestionPolicy = {
  allowedMimeTypes: ['text/plain'],
  maxFileBytes: 1024 * 1024,
  maxDocumentsPerBrand: 500,
  maxAttempts: 3,
  retryBackoffSeconds: 60,
  chunkTargetChars: 300,
  chunkOverlapChars: 50,
  maxChunksPerDocument: 50,
  minimumCandidateConfidenceMilli: 400,
};
const LIMITS: ExtractionLimits = {
  maxPages: 50,
  maxTextChars: 200_000,
  maxArchiveEntries: 256,
  maxArchiveBytes: 8 * 1024 * 1024,
  maxCompressionRatio: 200,
  timeoutMs: 30_000,
};
const TEXT = [
  'Our mission is to help independent bakers compete with national chains.',
  '',
  'Our audience is owners of small bakeries in the Gulf region.',
].join('\n');

/** A store whose first read fails — a storage hiccup, which earns a retry. */
class FlakyStore extends InMemoryObjectStore {
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

function service(db: Db, workspaceId: string, store: InMemoryObjectStore, now?: Date) {
  return new BrandIngestionService({
    db,
    workspaceId,
    storage: { usage: new UsageService({ prisma: db as unknown as PrismaClient }), limitGb: null },
    store,
    policy: POLICY,
    extractors: new ExtractorRegistry([new PlainTextExtractor(LIMITS)]),
    ...(now ? { clock: { now: () => now } } : {}),
  });
}

const inWorkspace = <T>(workspaceId: string, fn: (db: Db) => Promise<T>) =>
  withWorkspace(workspaceId, fn as never, { prisma: app }) as Promise<T>;
const inA = <T>(fn: (db: Db) => Promise<T>) => inWorkspace(fixtures.a.workspaceId, fn);

/** Upload one document into `store`; returns its job and document ids. */
async function uploaded(store: InMemoryObjectStore, workspace: 'a' | 'b' = 'a') {
  const f = workspace === 'a' ? fixtures.a : fixtures.b;
  return inWorkspace(f.workspaceId, async (db) => {
    const { document, job } = await service(db, f.workspaceId, store).upload({
      brandId: f.brandId,
      fileName: `f2-${randomUUID().slice(0, 6)}.txt`,
      mimeType: 'text/plain',
      bytes: new TextEncoder().encode(`${TEXT}\n${randomUUID()}`),
      idempotencyKey: `f2-${randomUUID()}`,
      actorUserId: f.userId,
      actorBrandScope: [],
    });
    return { jobId: job.id, documentId: document.id };
  });
}

/** The worker's three phases, each in its own transaction, for one message. */
async function deliver(store: InMemoryObjectStore, jobId: string, attempt?: number) {
  const started = await inA((db) =>
    service(db, fixtures.a.workspaceId, store).startProcessing(jobId, attempt),
  );
  const outcome = await extractSourceDocument({
    store,
    extractors: new ExtractorRegistry([new PlainTextExtractor(LIMITS)]),
    started,
  });
  const result = await inA((db) =>
    service(db, fixtures.a.workspaceId, store).finishProcessing(started, outcome),
  );
  return { started, result };
}

const jobRow = (id: string) =>
  inA((db) => db.brandIngestionJob.findUniqueOrThrow({ where: { id } }));
const documentRow = (id: string) =>
  inA((db) => db.brandSourceDocument.findUniqueOrThrow({ where: { id } }));
const chunkIds = (documentId: string) =>
  inA(async (db) =>
    (
      await db.brandSourceChunk.findMany({
        where: { sourceDocumentId: documentId },
        select: { id: true },
        orderBy: { chunkIndex: 'asc' },
      })
    ).map((c) => c.id),
  );
const audits = (documentId: string, action: string) =>
  inA((db) => db.auditEvent.count({ where: { resourceId: documentId, action } }));

const scheduler = () => new MaintenanceScheduler({ environment: 'DEVELOPMENT' });

/**
 * BullMQ's own Worker, to take one job and finish it WITHOUT a processor — the
 * only way to put a job into the completed set on purpose. `bullmq` is a
 * dependency of `@brandspace/jobs`, not of this test package, so it is loaded
 * from there rather than added here. Only the members used are typed.
 */
interface ManualWorker {
  getNextJob(token: string): Promise<
    | {
        id?: string;
        moveToCompleted(value: unknown, token: string, fetchNext: boolean): Promise<unknown>;
      }
    | undefined
  >;
  close(): Promise<void>;
}
const jobsRequire = createRequire(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../packages/jobs/package.json'),
);
const { Worker } = jobsRequire('bullmq') as {
  Worker: new (
    name: string,
    processor: null,
    options: { connection: { url: string }; autorun: boolean },
  ) => ManualWorker;
};
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

describe('F2 · a transient failure is really retried, exactly once', () => {
  it('the retry is dispatched under its own id, runs, and a replay of either attempt changes nothing', async () => {
    const store = new FlakyStore(1);
    const { jobId, documentId } = await uploaded(store);

    // Attempt 1 hits the storage hiccup: QUEUED again, document still PROCESSING.
    const first = await deliver(store, jobId, 1);
    expect(first.started.claimed).toBe(true);
    expect(await jobRow(jobId)).toMatchObject({ stage: 'QUEUED', attempts: 1 });
    expect((await documentRow(documentId)).status).toBe('PROCESSING');

    // The reconciler, once the backoff has passed, names attempt 2 — a new id.
    await inA((db) =>
      db.brandIngestionJob.update({ where: { id: jobId }, data: { nextAttemptAt: new Date(0) } }),
    );
    const secondId = ingestionJobKey(jobId, 2);
    queued.push(ingestionJobKey(jobId, 1), secondId);
    await scheduler().reconcileIngestion(500);
    const dispatched = await queueFor('media-processing').getJob(secondId);
    expect(dispatched?.data).toMatchObject({
      kind: INGEST_SOURCE_DOCUMENT,
      ingestionJobId: jobId,
      attempt: 2,
      idempotencyKey: secondId,
    });

    // Attempt 2 runs.
    const second = await deliver(store, jobId, 2);
    expect(second.result.status).toBe('READY');
    expect(await jobRow(jobId)).toMatchObject({ stage: 'COMPLETED', attempts: 2 });
    const chunks = await chunkIds(documentId);
    expect(chunks.length).toBeGreaterThan(0);
    expect(await audits(documentId, 'brand_brain.source.processed')).toBe(1);

    // A replay of attempt 1, of attempt 2, and a message from the previous
    // release with no attempt at all: none claims, none writes.
    for (const attempt of [1, 2, undefined]) {
      const replay = await deliver(store, jobId, attempt);
      expect(replay.started.claimed).toBe(false);
    }
    expect(await jobRow(jobId)).toMatchObject({ stage: 'COMPLETED', attempts: 2 });
    expect(await chunkIds(documentId)).toEqual(chunks);
    expect(await audits(documentId, 'brand_brain.source.processed')).toBe(1);
  });

  it('two deliveries of the same attempt at once: exactly one claims', async () => {
    const store = new InMemoryObjectStore();
    const { jobId } = await uploaded(store);
    const claims = await Promise.all(
      [0, 1].map(() =>
        inA((db) => service(db, fixtures.a.workspaceId, store).startProcessing(jobId, 1)),
      ),
    );
    expect(claims.filter((c) => c.claimed)).toHaveLength(1);
    expect(await jobRow(jobId)).toMatchObject({ stage: 'EXTRACTING', attempts: 1 });
  });

  it('a FINISHED BullMQ job under the id is replaced; a waiting one is left alone', async () => {
    const queue = queueFor('media-processing');
    const id = `ingest-${randomUUID()}-1`;
    queued.push(id);
    const payload = {
      kind: INGEST_SOURCE_DOCUMENT,
      workspaceId: fixtures.a.workspaceId,
      idempotencyKey: id,
      ingestionJobId: randomUUID(),
      attempt: 1,
    } as const;

    // WAITING: a re-add adds nothing and keeps the same job.
    await queue.add(INGEST_SOURCE_DOCUMENT, payload, { jobId: id, lifo: true });
    const waiting = await queue.getJob(id);
    await enqueueReplacingFinished('media-processing', INGEST_SOURCE_DOCUMENT, payload);
    expect((await queue.getJob(id))?.timestamp).toBe(waiting?.timestamp);

    // COMPLETED (taken and finished without claiming — as a message that threw
    // before the claim and spent BullMQ's retries): the next dispatch REPLACES it.
    const worker = new Worker('media-processing', null, {
      connection: { url: queueUrl() as string },
      autorun: false,
    });
    try {
      const token = randomUUID();
      const taken = await worker.getNextJob(token);
      expect(taken?.id).toBe(id);
      await taken?.moveToCompleted('claimed nothing', token, false);
      expect(await (await queue.getJob(id))?.isCompleted()).toBe(true);

      const result = await enqueueReplacingFinished(
        'media-processing',
        INGEST_SOURCE_DOCUMENT,
        payload,
      );
      expect(result.dispatched).toBe(true);
      const again = await queue.getJob(id);
      expect(await again?.isCompleted()).toBe(false);
      expect(await again?.getState()).toMatch(/waiting|prioritized|delayed/);
    } finally {
      await worker.close();
    }
  });
});

describe('F2 · the stuck-job sweep, wired into the scheduler', () => {
  async function stuck(attempts: number, startedAgoSeconds: number) {
    const store = new InMemoryObjectStore();
    const ids = await uploaded(store);
    await inA((db) =>
      db.brandIngestionJob.update({
        where: { id: ids.jobId },
        data: {
          stage: 'EXTRACTING',
          attempts,
          startedAt: new Date(Date.now() - startedAgoSeconds * 1000),
        },
      }),
    );
    return ids;
  }

  it('hands a silent claim back to the queue, audited, and the next reconcile sends the NEXT attempt', async () => {
    const { jobId, documentId } = await stuck(1, 3 * 3600);
    const sweep = scheduler();
    expect(await sweep.recoverStuckIngestion(500)).toBeGreaterThanOrEqual(1);
    const row = await jobRow(jobId);
    expect(row).toMatchObject({ stage: 'QUEUED', attempts: 1, failureCode: 'stuck_timeout' });
    expect(row.nextAttemptAt).not.toBeNull();
    expect((await documentRow(documentId)).status).toBe('PROCESSING');
    expect(await audits(documentId, 'brand_brain.source.retry_scheduled')).toBe(1);

    await inA((db) =>
      db.brandIngestionJob.update({ where: { id: jobId }, data: { nextAttemptAt: new Date(0) } }),
    );
    const next = ingestionJobKey(jobId, 2);
    queued.push(next);
    await sweep.reconcileIngestion(500);
    expect((await queueFor('media-processing').getJob(next))?.data.attempt).toBe(2);
  });

  it('at the attempt limit it fails the job and the document for good, audited', async () => {
    const { jobId, documentId } = await stuck(3, 3 * 3600);
    await scheduler().recoverStuckIngestion(500);
    expect(await jobRow(jobId)).toMatchObject({ stage: 'FAILED', failureCode: 'stuck_timeout' });
    expect(await documentRow(documentId)).toMatchObject({
      status: 'FAILED',
      failureMessage: 'stuck_timeout',
    });
    expect(await audits(documentId, 'brand_brain.source.failed')).toBe(1);
  });

  it('leaves a recent claim alone, and never touches a QUEUED row', async () => {
    const recent = await stuck(1, 5);
    const store = new InMemoryObjectStore();
    const waiting = await uploaded(store);
    await inA((db) =>
      db.brandIngestionJob.update({
        where: { id: waiting.jobId },
        data: { startedAt: new Date(Date.now() - 3 * 3600_000), attempts: 1 },
      }),
    );
    const before = await jobRow(waiting.jobId);

    await scheduler().recoverStuckIngestion(500);
    expect(await jobRow(recent.jobId)).toMatchObject({ stage: 'EXTRACTING', attempts: 1 });
    // The QUEUED row keeps its schedule: the sweep used to push it back each pass.
    expect(await jobRow(waiting.jobId)).toMatchObject({
      stage: 'QUEUED',
      nextAttemptAt: before.nextAttemptAt,
      failureCode: before.failureCode,
    });
  });

  it('sweep first, then the late worker: the worker writes NOTHING', async () => {
    const store = new InMemoryObjectStore();
    const { jobId, documentId } = await uploaded(store);
    const started = await inA((db) =>
      service(db, fixtures.a.workspaceId, store).startProcessing(jobId, 1),
    );
    expect(started.claimed).toBe(true);
    const outcome = await extractSourceDocument({
      store,
      extractors: new ExtractorRegistry([new PlainTextExtractor(LIMITS)]),
      started,
    });

    // The parse overran; the sweep, whose clock is later, hands the row back.
    const later = new Date(Date.now() + 24 * 3600_000);
    const swept = await inA((db) =>
      service(db, fixtures.a.workspaceId, store, later).sweepStuckJobs(60),
    );
    expect(swept).toBeGreaterThanOrEqual(1);
    expect(await jobRow(jobId)).toMatchObject({ stage: 'QUEUED', attempts: 1 });

    // The zombie finishes: fenced out.
    await inA((db) =>
      service(db, fixtures.a.workspaceId, store).finishProcessing(started, outcome),
    );
    expect(await chunkIds(documentId)).toEqual([]);
    expect(await jobRow(jobId)).toMatchObject({ stage: 'QUEUED', attempts: 1 });
    expect(await audits(documentId, 'brand_brain.source.processed')).toBe(0);
  });

  it('worker first, then the sweep: the finished job is kept', async () => {
    const store = new InMemoryObjectStore();
    const { jobId } = await uploaded(store);
    const done = await deliver(store, jobId, 1);
    expect(done.result.status).toBe('READY');
    const row = await jobRow(jobId);
    const outcome = await inA((db) =>
      recoverStuckIngestionJob({
        db,
        workspaceId: fixtures.a.workspaceId,
        job: { ...row, attempts: 1 },
        stuckBefore: new Date(Date.now() + 24 * 3600_000),
        retryBackoffSeconds: 60,
        clock: { now: () => new Date() },
      }),
    );
    expect(outcome).toBe('skipped');
    expect(await jobRow(jobId)).toMatchObject({ stage: 'COMPLETED' });
  });

  it('two sweeps at once (two replicas) recover a row once, with one audit event', async () => {
    const { jobId, documentId } = await stuck(1, 3 * 3600);
    const row = await jobRow(jobId);
    const recover = () =>
      inA((db) =>
        recoverStuckIngestionJob({
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
    expect(await audits(documentId, 'brand_brain.source.retry_scheduled')).toBe(1);
  });

  it("another workspace's stuck row cannot be touched from this workspace's context", async () => {
    const store = new InMemoryObjectStore();
    const theirs = await uploaded(store, 'b');
    await inWorkspace(fixtures.b.workspaceId, (db) =>
      db.brandIngestionJob.update({
        where: { id: theirs.jobId },
        data: { stage: 'EXTRACTING', attempts: 1, startedAt: new Date(Date.now() - 3 * 3600_000) },
      }),
    );
    const row = await inWorkspace(fixtures.b.workspaceId, (db) =>
      db.brandIngestionJob.findUniqueOrThrow({ where: { id: theirs.jobId } }),
    );
    const outcome = await inA((db) =>
      recoverStuckIngestionJob({
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
      db.brandIngestionJob.findUniqueOrThrow({ where: { id: theirs.jobId } }),
    );
    expect(after).toMatchObject({ stage: 'EXTRACTING', attempts: 1 });
  });
});
