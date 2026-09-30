import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  INGESTION_WORKER_LOCK_SECONDS,
  stuckIngestionThresholdSeconds,
} from '@brandspace/brand-brain';
import { ingestionJobKey } from '@brandspace/jobs';

/**
 * FIX PR 1 · F2 (D-413) — the parts of the ingestion retry and the stuck-job
 * sweep that need no database: the per-attempt id, the threshold that keeps
 * the sweep off a live worker, and where each is wired.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8');

describe('F2 · one queue id per attempt', () => {
  it('is colon-free and different for every attempt of the same job', () => {
    const job = '11111111-2222-3333-4444-555555555555';
    expect(ingestionJobKey(job, 1)).toBe(`ingest-${job}-1`);
    expect(ingestionJobKey(job, 2)).not.toBe(ingestionJobKey(job, 1));
    for (const attempt of [1, 2, 3]) expect(ingestionJobKey(job, attempt)).not.toContain(':');
  });

  it('every producer names the attempt: upload and Read again send 1, the reconciler the next one', () => {
    const actions = read('apps/dashboard/src/app/[locale]/brand-brain/actions.ts');
    expect(
      actions.match(/idempotencyKey: ingestionJobKey\(job\.id, 1\),\s*attempt: 1,/g),
    ).toHaveLength(2);
    expect(actions).not.toContain('`ingest-${job.id}`');

    const scheduler = read('apps/api/src/scheduler.ts');
    expect(scheduler).toContain('const attempt = job.attempts + 1;');
    expect(scheduler).toContain('idempotencyKey: ingestionJobKey(job.id, attempt),');
    expect(scheduler).toContain(
      "enqueueReplacingFinished('media-processing', INGEST_SOURCE_DOCUMENT",
    );
  });

  it('the worker passes the attempt to the claim, and stops when nothing was claimed', () => {
    const worker = read('apps/worker/src/processors/ingestion.ts');
    expect(worker).toContain('startProcessing(payload.ingestionJobId, payload.attempt)');
    expect(worker.indexOf('if (!started.claimed && !started.removed)')).toBeLessThan(
      worker.indexOf('const outcome = await extractSourceDocument({'),
    );
  });
});

describe('F2 · the sweep never takes a claim a live worker may still hold', () => {
  it('the floor is the extraction bound plus the worker lock', () => {
    expect(
      stuckIngestionThresholdSeconds({ stuckAfterSeconds: 60, extraction: { timeoutMs: 600_000 } }),
    ).toBe(600 + INGESTION_WORKER_LOCK_SECONDS);
    expect(
      stuckIngestionThresholdSeconds({ stuckAfterSeconds: 900, extraction: { timeoutMs: 60_000 } }),
    ).toBe(900);
    expect(
      stuckIngestionThresholdSeconds({ stuckAfterSeconds: 60, extraction: { timeoutMs: 1_500 } }),
    ).toBe(2 + INGESTION_WORKER_LOCK_SECONDS);
  });

  it("the lock it assumes is the media-processing worker's own", () => {
    const main = read('apps/worker/src/main.ts');
    const media = main.slice(main.indexOf("'media-processing'"), main.indexOf("'publish-jobs'"));
    expect(media).toContain('lockDuration: 5 * 60_000');
    expect(INGESTION_WORKER_LOCK_SECONDS * 1000).toBe(5 * 60_000);
  });

  it('the scheduler recovers before it dispatches, on its timer and in runOnce', () => {
    const scheduler = read('apps/api/src/scheduler.ts');
    const runOnce = scheduler.slice(scheduler.indexOf('async runOnce()'));
    expect(runOnce.indexOf('this.recoverStuckIngestion(')).toBeLessThan(
      runOnce.indexOf('this.reconcileIngestion('),
    );
    const timer = scheduler.slice(scheduler.indexOf("'ingestion-reconcile'"));
    expect(timer.indexOf('this.recoverStuckIngestion(')).toBeLessThan(
      timer.indexOf('this.reconcileIngestion('),
    );
  });

  it('the sweep takes running stages only — never a QUEUED row', () => {
    const ingestion = read('packages/brand-brain/src/ingestion.ts');
    expect(ingestion).toContain(
      "const RUNNING_STAGES = ['EXTRACTING', 'CHUNKING', 'EXTRACTING_FACTS'] as const;",
    );
    const find = ingestion.slice(ingestion.indexOf('export async function findStuckIngestionJobs'));
    expect(find.slice(0, find.indexOf('\n}\n'))).toContain('stage: { in: [...RUNNING_STAGES] }');
  });
});
