import {
  BrandIngestionService,
  ExtractorRegistry,
  TenantBrandBrainPolicySource,
  createObjectStore,
  defaultExtractors,
  type ObjectStore,
} from '@brandspace/brand-brain';
import { withWorkspace } from '@brandspace/database';
import { createLogger, currentEnvironment } from '@brandspace/shared';
import type { IngestSourceDocumentPayload } from '@brandspace/jobs';

/**
 * Process one uploaded source document.
 *
 * THE JOB IS A POINTER AND THE DATABASE IS THE STATE, which is what makes this
 * idempotent (CLAUDE.md §5). A duplicate delivery — BullMQ at-least-once, a
 * reconciler racing the producer, a retry after a lost acknowledgement — re-reads
 * the `brand_ingestion_job` row, finds it already RUNNING or done, and returns
 * without a second parse or a second set of candidates. `process()` owns that
 * check; nothing here needs to guess.
 *
 * THE WORKSPACE COMES FROM THE PAYLOAD, AND IS RE-APPLIED RATHER THAN TRUSTED.
 * `withWorkspace` sets the RLS context for the transaction, so a forged id in a
 * queue message reaches exactly what that workspace's policies allow — which is
 * nothing belonging to anyone else. This process holds only the tenant
 * credential, so there is no wider reach available to it in the first place
 * (docs/SECURITY.md §2.1 layer 8).
 */

const log = createLogger({ context: { component: 'worker.brand-brain.ingestion' } });

let sharedStore: ObjectStore | null = null;

function objectStore(): ObjectStore {
  // APP_ENV, not NODE_ENV: every built app has NODE_ENV=production, including
  // the one an end-to-end run serves. See createObjectStore.
  sharedStore ??= createObjectStore({ appEnv: process.env['APP_ENV'] ?? 'development' });
  return sharedStore;
}

export async function processIngestionJob(payload: IngestSourceDocumentPayload): Promise<void> {
  const result = await withWorkspace(payload.workspaceId, async (db) => {
    // The SAME configuration the dashboard reads, through the same tenant-side
    // projection. A worker with its own ceilings would be a second set of
    // settings an operator cannot see (CLAUDE.md §2.2).
    const policy = await new TenantBrandBrainPolicySource(db, currentEnvironment()).load();

    const ingestion = new BrandIngestionService({
      db,
      workspaceId: payload.workspaceId,
      store: objectStore(),
      policy: policy.ingestion,
      extractors: new ExtractorRegistry(await defaultExtractors(policy.extraction)),
    });

    return ingestion.process(payload.ingestionJobId);
  });

  log.info('source document processed', {
    // Identifiers and counts. No file name, no extracted text, no customer
    // content of any kind reaches a log sink.
    workspaceId: payload.workspaceId,
    jobId: payload.ingestionJobId,
    status: result.status,
    chunks: result.chunksCreated,
    candidates: result.candidatesCreated,
    ...(result.failureMessage ? { failureReason: result.failureMessage } : {}),
  });
}
