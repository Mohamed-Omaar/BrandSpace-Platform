import {
  AssetProcessingService,
  createVirusScanner,
  TenantAssetPolicySource,
} from '@brandspace/assets';
import type { Environment } from '@brandspace/config';
import { withWorkspace } from '@brandspace/database';
import { createObjectStore, type ObjectStore } from '@brandspace/storage';
import { createLogger } from '@brandspace/shared';
import type { ProcessAssetPayload } from '@brandspace/jobs';

/**
 * Scan, inspect and derive one uploaded asset.
 *
 * THE JOB IS A POINTER AND THE DATABASE IS THE STATE, which is what makes this
 * idempotent (CLAUDE.md §5). A duplicate delivery — BullMQ at-least-once, a
 * reconciler racing the producer, a retry after a lost acknowledgement —
 * re-reads the `asset_processing_job` row, finds it finished, and returns
 * without a second scan. `process()` owns that check; nothing here guesses.
 *
 * THE WORKSPACE COMES FROM THE PAYLOAD AND IS RE-APPLIED RATHER THAN TRUSTED.
 * `withWorkspace` sets the RLS context for the transaction, so a forged id in a
 * queue message reaches exactly what that workspace's policies allow — which is
 * nothing belonging to anyone else. This process holds only the tenant
 * credential, so there is no wider reach available to it in the first place
 * (docs/SECURITY.md §2.1 layer 8).
 */

const log = createLogger({ context: { component: 'worker.assets.processing' } });

let sharedStore: ObjectStore | null = null;

function objectStore(): ObjectStore {
  // APP_ENV, not NODE_ENV: every built app has NODE_ENV=production, including
  // the one an end-to-end run serves. See createObjectStore and D-97.
  sharedStore ??= createObjectStore({ appEnv: process.env['APP_ENV'] ?? 'development' });
  return sharedStore;
}

function currentEnvironment(): Environment {
  const appEnv = process.env['APP_ENV'] ?? 'development';
  if (appEnv === 'production') return 'PRODUCTION';
  if (appEnv === 'staging') return 'STAGING';
  return 'DEVELOPMENT';
}

export async function processAssetJob(payload: ProcessAssetPayload): Promise<void> {
  const result = await withWorkspace(payload.workspaceId, async (db) => {
    // The SAME configuration the dashboard reads, through the same tenant-side
    // projection. A worker with its own ceilings would be a second set of
    // settings an operator cannot see (CLAUDE.md §2.2).
    const policy = await new TenantAssetPolicySource(db, currentEnvironment()).load();

    const processing = new AssetProcessingService({
      db,
      workspaceId: payload.workspaceId,
      store: objectStore(),
      policy,
      scanner: createVirusScanner({
        appEnv: process.env['APP_ENV'] ?? 'development',
        policy: policy.scanning,
      }),
    });

    return processing.process(payload.processingJobId);
  });

  log.info('asset processed', {
    // Identifiers, statuses and counts. NO FILE NAME — a customer file name is
    // routinely the most sensitive string in the record — and no storage key,
    // no checksum and no bytes reach a log sink (docs/SECURITY.md §5.1).
    workspaceId: payload.workspaceId,
    jobId: payload.processingJobId,
    assetId: result.assetId,
    status: result.status,
    scanStatus: result.scanStatus,
    derivatives: result.derivativesCreated,
    ...(result.failureReason ? { failureReason: result.failureReason } : {}),
  });
}
