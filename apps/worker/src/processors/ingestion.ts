import {
  BrandIngestionService,
  TenantBrandBrainPolicySource,
  createObjectStore,
  extractSourceDocument,
  extractorRegistryFor,
  type ObjectStore,
} from '@brandspace/brand-brain';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { createLogger, currentEnvironment } from '@brandspace/shared';
import type { IngestSourceDocumentPayload } from '@brandspace/jobs';

/**
 * Process one uploaded source document.
 *
 * THE JOB IS A POINTER AND THE DATABASE IS THE STATE, which is what makes this
 * idempotent (CLAUDE.md §5). A duplicate delivery — BullMQ at-least-once, a
 * reconciler racing the producer, a retry after a lost acknowledgement — claims
 * nothing: `startProcessing` is one compare-and-set on the row being QUEUED on
 * the attempt the message names (Fix PR 1 · F2, D-413), so a job that is
 * running, finished or already on a later attempt is neither parsed again nor
 * written again. This comment used to say so while the claim was an
 * unconditional update; now it is true.
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
  /*
   * PHASE 2C-4 — THREE SHORT STEPS, AND THE PARSE IS IN NONE OF THEM'S
   * TRANSACTION.
   *
   * This used to run the whole pipeline inside ONE `withWorkspace` transaction:
   * the tenant connection, its RLS context and its row locks were held while
   * pdf.js walked up to `extraction.maxPages` pages for up to
   * `extraction.timeoutMs`. Now:
   *
   *   1. a short transaction reads the configuration and claims the job;
   *   2. the stored bytes are read and extracted with NO database access, under
   *      the configured wall-clock bound for the whole document;
   *   3. a second short transaction writes the chunks, the PENDING candidates
   *      and the final state — atomically, or not at all.
   *
   * A crash between 1 and 3 leaves the job EXTRACTING. A redelivery claims
   * nothing (the row is no longer QUEUED); the maintenance scheduler's stuck-job
   * sweep hands the row back once its claim has gone silent, and the next
   * attempt runs under its own id (D-413).
   */
  const service = (db: TenantScopedClient, policy: Awaited<ReturnType<typeof loadPolicy>>) =>
    new BrandIngestionService({
      db,
      workspaceId: payload.workspaceId,
      store: objectStore(),
      policy: policy.ingestion,
      extractors: policy.extractors,
    });

  const { policy, started } = await withWorkspace(payload.workspaceId, async (db) => {
    // The SAME configuration the dashboard reads, through the same tenant-side
    // projection. A worker with its own ceilings would be a second set of
    // settings an operator cannot see (CLAUDE.md §2.2).
    const loaded = await loadPolicy(db);
    return {
      policy: loaded,
      started: await service(db, loaded).startProcessing(payload.ingestionJobId, payload.attempt),
    };
  });

  if (!started.claimed && !started.removed) {
    // A replayed or duplicate message, or an older attempt: nothing to do.
    log.info('ingestion message claimed nothing', {
      workspaceId: payload.workspaceId,
      jobId: payload.ingestionJobId,
      ...(payload.attempt === undefined ? {} : { attempt: payload.attempt }),
    });
    return;
  }

  const outcome = await extractSourceDocument({
    store: objectStore(),
    extractors: policy.extractors,
    started,
  });

  const result = await withWorkspace(payload.workspaceId, async (db) =>
    service(db, policy).finishProcessing(started, outcome),
  );

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

/** The activated Brand Brain policy, and the extractor registry built from its limits. */
async function loadPolicy(db: TenantScopedClient) {
  const policy = await new TenantBrandBrainPolicySource(db, currentEnvironment()).load();
  return { ...policy, extractors: await extractorRegistryFor(policy.extraction) };
}
