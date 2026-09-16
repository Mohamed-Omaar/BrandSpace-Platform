import type { Environment } from '@brandspace/config';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import {
  AnalyticsIngestionService,
  TenantAnalyticsPolicySource,
  createAnalyticsRegistry,
  type AdapterCredentials,
  type IngestionCursorRow,
} from '@brandspace/analytics';
import type { BackfillAnalyticsPayload, IngestAnalyticsPayload } from '@brandspace/jobs';
import { ProviderRateLimiter, SocialTokenVault } from '@brandspace/social-connectors';
import { createLogger, systemClock } from '@brandspace/shared';

/**
 * Pull one connection's analytics.
 *
 * WHY INGESTION HAPPENS HERE AND NOT IN A REQUEST, for the reason publishing
 * does: an external call to a platform's analytics API is unbounded work against
 * somebody else's infrastructure — it can take thirty seconds, time out, or be
 * rate limited for an hour. On a request path that is a customer watching a
 * spinner; here it is a job with a durable cursor and a backoff schedule.
 *
 * WHAT IDENTITY THIS PROCESS HOLDS. The TENANT one, and only that (F-07). The
 * payload names a workspace, `withWorkspace` re-applies it as the RLS context,
 * and a forged id therefore reaches exactly what that workspace's own policies
 * allow. The customer's token is tenant data under the SOCIAL key domain (D-136)
 * and is decrypted here, inside that workspace's context — the same path
 * publishing uses, and the only one.
 *
 * THE RATE LIMITER IS PROCESS-WIDE AND SHARED WITH PUBLISHING. One instance for
 * the whole worker, so a backfill and a scheduled post drawing on the same
 * platform account draw on the same budget — which is the entire point of the
 * limiter living in `@brandspace/social-connectors` rather than in the analytics
 * package.
 *
 * INGESTION SPENDS NO AI CREDITS. Nothing in this path touches the gateway, the
 * wallet or the ledger: a customer is never billed for a chart being refreshed.
 */

const log = createLogger({ context: { component: 'worker.analytics' } });

function currentEnvironment(): Environment {
  // APP_ENV, not NODE_ENV: every built app has NODE_ENV=production, including
  // the one an end-to-end run serves (D-97).
  const appEnv = process.env['APP_ENV'] ?? 'development';
  if (appEnv === 'production') return 'PRODUCTION';
  if (appEnv === 'staging') return 'STAGING';
  return 'DEVELOPMENT';
}

/**
 * ONE LIMITER FOR THE PROCESS.
 *
 * A per-job instance would mean every job believed the whole budget was free,
 * which is the same as having no limiter at all — and worse than none, because it
 * would look like protection.
 */
const rateLimiter = new ProviderRateLimiter({ clock: systemClock });

/**
 * Open the customer's token for a connection.
 *
 * ONE CODE PATH, and it lives here rather than in the analytics package for the
 * reason the adapter contract gives: an adapter is handed already-decrypted
 * material and can never resolve one for itself.
 */
function credentialResolver(db: TenantScopedClient, workspaceId: string) {
  const vault = new SocialTokenVault();
  return {
    async resolve(socialConnectionId: string): Promise<AdapterCredentials | null> {
      const credential = await db.socialCredential.findFirst({
        where: { workspaceId, socialConnectionId, retiredAt: null },
        orderBy: { version: 'desc' },
      });
      if (!credential) return null;
      const material = await vault.open({
        ciphertext: credential.ciphertext,
        iv: credential.iv,
        authTag: credential.authTag,
        wrappedDataKey: credential.wrappedDataKey,
        keyProvider: credential.keyProvider,
        keyId: credential.keyId,
        algorithm: 'AES-256-GCM',
        encryptionContext: credential.encryptionContext,
        maskedHint: credential.maskedHint,
        fingerprint: credential.fingerprint,
      });
      return { accessToken: material.accessToken, refreshToken: material.refreshToken };
    },
  };
}

async function withIngestion<T>(
  workspaceId: string,
  fn: (service: AnalyticsIngestionService, db: TenantScopedClient) => Promise<T>,
): Promise<T> {
  const environment = currentEnvironment();
  return withWorkspace(workspaceId, async (db) => {
    // THE SAME CONFIGURATION THE DASHBOARD READS, through the same tenant-side
    // projection. A worker with its own freshness window would be a second set
    // of settings an operator cannot see (CLAUDE.md §2.2).
    const policy = await new TenantAnalyticsPolicySource(db, environment).load();
    const service = new AnalyticsIngestionService({
      db,
      workspaceId,
      policy,
      registry: createAnalyticsRegistry({ environment }),
      credentials: credentialResolver(db, workspaceId),
      rateLimiter,
    });
    return fn(service, db);
  });
}

async function cursorFor(
  db: TenantScopedClient,
  workspaceId: string,
  cursorId: string,
): Promise<IngestionCursorRow | null> {
  return db.analyticsIngestionCursor.findFirst({
    where: { id: cursorId, workspaceId },
    select: {
      id: true,
      workspaceId: true,
      brandId: true,
      socialConnectionId: true,
      provider: true,
      subjectType: true,
      granularity: true,
      lastCoveredPeriodEnd: true,
      lastSucceededAt: true,
      backfillCursor: true,
      backfillCompletedAt: true,
      consecutiveFailureCount: true,
    },
  });
}

export async function processAnalyticsIngestJob(payload: IngestAnalyticsPayload): Promise<void> {
  const result = await withIngestion(payload.workspaceId, async (service, db) => {
    const cursor = await cursorFor(db, payload.workspaceId, payload.cursorId);
    // A CURSOR THAT NO LONGER EXISTS IS NOT AN ERROR. The connection was
    // disconnected between the dispatch and the pull; the message is acknowledged
    // and nothing is retried.
    if (!cursor) return null;
    return service.pull(cursor, 'SCHEDULED');
  });

  if (!result) {
    log.info('analytics cursor no longer exists', {
      workspaceId: payload.workspaceId,
      cursorId: payload.cursorId,
    });
    return;
  }

  log.info('analytics pull finished', {
    workspaceId: payload.workspaceId,
    cursorId: result.cursorId,
    status: result.status,
    written: result.observationsWritten,
    unchanged: result.observationsUnchanged,
    // The CLASS, never a provider message — which can echo request content.
    ...(result.failureClass ? { failureClass: result.failureClass } : {}),
  });
}

/**
 * The BACKFILL path.
 *
 * A DIFFERENT KIND REACHING A DIFFERENT CALL, not a flag on the one above. The
 * two walk the window in opposite directions and only one of them is bounded by a
 * horizon; a boolean would put both behaviours behind one `if`, which is the
 * shape that let a Phase 6 defect exist.
 */
export async function processAnalyticsBackfillJob(
  payload: BackfillAnalyticsPayload,
): Promise<void> {
  const result = await withIngestion(payload.workspaceId, async (service, db) => {
    const cursor = await cursorFor(db, payload.workspaceId, payload.cursorId);
    if (!cursor) return null;
    return service.pull(cursor, 'BACKFILL');
  });

  if (!result) return;

  log.info('analytics backfill finished', {
    workspaceId: payload.workspaceId,
    cursorId: result.cursorId,
    status: result.status,
    written: result.observationsWritten,
    ...(result.failureClass ? { failureClass: result.failureClass } : {}),
  });
}
