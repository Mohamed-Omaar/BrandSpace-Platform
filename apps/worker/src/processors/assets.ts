import {
  AssetProcessingService,
  createVirusScanner,
  TenantAssetPolicySource,
  type AssetPolicy,
} from '@brandspace/assets';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { createObjectStore, type ObjectStore } from '@brandspace/storage';
import { createLogger, currentEnvironment } from '@brandspace/shared';
import type { ProcessAssetPayload } from '@brandspace/jobs';

/**
 * Scan, inspect and derive one uploaded asset.
 *
 * THE JOB IS A POINTER AND THE DATABASE IS THE STATE, which is what makes this
 * idempotent (CLAUDE.md §5). A duplicate delivery — BullMQ at-least-once, a
 * reconciler racing the producer, a retry after a lost acknowledgement —
 * re-reads the `asset_processing_job` row, finds it claimed or finished, and
 * returns without a second scan. `claim()` owns that check; nothing here
 * guesses.
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

export function objectStore(): ObjectStore {
  // APP_ENV, not NODE_ENV: every built app has NODE_ENV=production, including
  // the one an end-to-end run serves. See createObjectStore and D-97.
  sharedStore ??= createObjectStore({ appEnv: process.env['APP_ENV'] ?? 'development' });
  return sharedStore;
}

export async function processAssetJob(payload: ProcessAssetPayload): Promise<void> {
  const service = (db: TenantScopedClient, policy: AssetPolicy) =>
    new AssetProcessingService({
      db,
      workspaceId: payload.workspaceId,
      store: objectStore(),
      policy,
      scanner: createVirusScanner({
        appEnv: process.env['APP_ENV'] ?? 'development',
        policy: policy.scanning,
        // PR F (g): Scanii's credentials are the worker's own variables, like
        // the storage keys — the worker holds no platform secret vault key.
        scaniiCredentials: {
          apiKey: process.env['SCANII_API_KEY'] ?? '',
          apiSecret: process.env['SCANII_API_SECRET'] ?? '',
        },
      }),
    });

  /*
   * THE CLAIM COMMITS ON ITS OWN, BEFORE ANY BYTE IS READ (final review of #83,
   * D-549 — the ingestion fix, D-413, made for assets).
   *
   * Claim and work used to share ONE transaction, so whatever threw or killed
   * the run rolled the claim back with it: the attempt was never counted, the
   * row was QUEUED again, and a file that failed the same way every time was
   * re-dispatched for ever while it read PROCESSING. Now the attempt is spent
   * the moment it is claimed. A run that dies leaves the row SCANNING; a
   * redelivery claims nothing (the row is no longer QUEUED); and the
   * maintenance scheduler's stuck-job sweep hands it back for the next attempt
   * under its own queue id, or fails it for good at the limit.
   */
  const { policy, claimed } = await withWorkspace(payload.workspaceId, async (db) => {
    // The SAME configuration the dashboard reads, through the same tenant-side
    // projection. A worker with its own ceilings would be a second set of
    // settings an operator cannot see (CLAUDE.md §2.2).
    const loaded = await new TenantAssetPolicySource(db, currentEnvironment()).load();
    return {
      policy: loaded,
      claimed: await service(db, loaded).claim(payload.processingJobId, payload.attempt),
    };
  });

  if (!claimed.claimed) {
    // A replayed or duplicate message, or an older attempt: nothing to do.
    log.info('asset processing message claimed nothing', {
      workspaceId: payload.workspaceId,
      jobId: payload.processingJobId,
      ...(payload.attempt === undefined ? {} : { attempt: payload.attempt }),
    });
    return;
  }

  const result = await withWorkspace(payload.workspaceId, async (db) =>
    service(db, policy).run(claimed),
  );

  log.info('asset processed', {
    // Identifiers, statuses and counts. NO FILE NAME — a customer file name is
    // routinely the most sensitive string in the record — and no storage key,
    // no checksum and no bytes reach a log sink (docs/SECURITY.md §5.1).
    workspaceId: payload.workspaceId,
    jobId: payload.processingJobId,
    attempt: claimed.attempt,
    assetId: result.assetId,
    status: result.status,
    scanStatus: result.scanStatus,
    derivatives: result.derivativesCreated,
    ...(result.failureReason ? { failureReason: result.failureReason } : {}),
  });
}
