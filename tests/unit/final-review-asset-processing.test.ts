import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ASSET_WORKER_LOCK_SECONDS, stuckAssetThresholdSeconds } from '@brandspace/assets';
import { assetJobKey } from '@brandspace/jobs';

/**
 * FINAL REVIEW OF #83 (D-549) — the parts of the asset processing retry and
 * the stuck-job sweep that need no database: the per-attempt id, the threshold
 * that keeps the sweep off a live worker, and where each is wired. The
 * behaviour itself is proven in tests/isolation/final-review-asset-processing.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8');

describe('D-549 · one queue id per attempt', () => {
  it('is colon-free and different for every attempt of the same job', () => {
    const job = '11111111-2222-3333-4444-555555555555';
    expect(assetJobKey(job, 1)).toBe(`asset-${job}-1`);
    expect(assetJobKey(job, 2)).not.toBe(assetJobKey(job, 1));
    for (const attempt of [1, 2, 3]) expect(assetJobKey(job, attempt)).not.toContain(':');
  });

  it('every producer names the attempt: upload and new version send 1, the reconciler the next one', () => {
    for (const file of [
      'apps/dashboard/src/server/asset-upload.ts',
      'apps/dashboard/src/app/[locale]/assets/actions.ts',
    ]) {
      const source = read(file);
      expect(
        source.match(
          /idempotencyKey: assetJobKey\(job\.id, 1\),\s*processingJobId: job\.id,\s*attempt: 1,/g,
        ),
        file,
      ).toHaveLength(1);
      expect(source, file).not.toContain('`asset-${job.id}`');
    }

    const scheduler = read('apps/api/src/scheduler.ts');
    const reconcile = scheduler.slice(scheduler.indexOf('async reconcileAssetProcessing('));
    const body = reconcile.slice(0, reconcile.indexOf('\n  }\n'));
    expect(body).toContain('const attempt = job.attempts + 1;');
    expect(body).toContain('idempotencyKey: assetJobKey(job.id, attempt),');
    expect(body).toContain("enqueueReplacingFinished('media-processing', PROCESS_ASSET");
  });

  it('the worker commits its claim before the run, and stops when nothing was claimed', () => {
    const worker = read('apps/worker/src/processors/assets.ts');
    expect(worker).toContain('.claim(payload.processingJobId, payload.attempt)');
    const claim = worker.indexOf('.claim(payload.processingJobId, payload.attempt)');
    const stop = worker.indexOf('if (!claimed.claimed) {');
    const run = worker.indexOf('.run(claimed)');
    expect(claim).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(claim);
    expect(run).toBeGreaterThan(stop);
    // Two transactions: the claim's and the run's.
    expect(worker.match(/await withWorkspace\(payload\.workspaceId/g)).toHaveLength(2);
  });
});

describe('D-549 · the sweep never takes a claim a live worker may still hold', () => {
  it('the floor is the scan bound plus the worker lock', () => {
    expect(
      stuckAssetThresholdSeconds({
        processing: { stuckAfterSeconds: 60 },
        scanning: { timeoutMs: 600_000 },
      }),
    ).toBe(600 + ASSET_WORKER_LOCK_SECONDS);
    expect(
      stuckAssetThresholdSeconds({
        processing: { stuckAfterSeconds: 900 },
        scanning: { timeoutMs: 30_000 },
      }),
    ).toBe(900);
    expect(
      stuckAssetThresholdSeconds({
        processing: { stuckAfterSeconds: 60 },
        scanning: { timeoutMs: 1_500 },
      }),
    ).toBe(2 + ASSET_WORKER_LOCK_SECONDS);
  });

  it("the lock it assumes is the media-processing worker's own", () => {
    const main = read('apps/worker/src/main.ts');
    const media = main.slice(main.indexOf("'media-processing'"), main.indexOf("'publish-jobs'"));
    expect(media).toContain('lockDuration: 5 * 60_000');
    expect(ASSET_WORKER_LOCK_SECONDS * 1000).toBe(5 * 60_000);
  });

  it('the scheduler recovers before it dispatches, on its timer and in runOnce', () => {
    const scheduler = read('apps/api/src/scheduler.ts');
    const runOnce = scheduler.slice(scheduler.indexOf('async runOnce()'));
    expect(runOnce.indexOf('this.recoverStuckAssetProcessing(')).toBeGreaterThan(-1);
    expect(runOnce.indexOf('this.recoverStuckAssetProcessing(')).toBeLessThan(
      runOnce.indexOf('this.reconcileAssetProcessing('),
    );
    const timer = scheduler.slice(scheduler.indexOf("'asset-reconcile'"));
    expect(timer.indexOf('this.recoverStuckAssetProcessing(')).toBeGreaterThan(-1);
    expect(timer.indexOf('this.recoverStuckAssetProcessing(')).toBeLessThan(
      timer.indexOf('this.reconcileAssetProcessing('),
    );
  });

  it('the sweep takes running stages only — never a QUEUED row', () => {
    const processing = read('packages/assets/src/processing.ts');
    expect(processing).toContain(
      "const RUNNING_STAGES = ['SCANNING', 'INSPECTING', 'DERIVING'] as const;",
    );
    const find = processing.slice(processing.indexOf('export async function findStuckAssetJobs'));
    expect(find.slice(0, find.indexOf('\n}\n'))).toContain('stage: { in: [...RUNNING_STAGES] }');
  });
});
