import { withWorkspace } from '@brandspace/database';
import { PublishMediaResolver } from '@brandspace/assets';
import { objectStore } from './assets';
import { ContentApprovalService, TenantContentPolicySource } from '@brandspace/content';
import type { PublishSocialPostPayload, VerifySocialPostPayload } from '@brandspace/jobs';
import {
  createConnectorRegistry,
  PublishPipelineService,
  SocialTokenVault,
  TenantPublishingPolicySource,
} from '@brandspace/social-connectors';
import { createLogger, currentEnvironment } from '@brandspace/shared';
import { publishNotifier } from './publish-notifier';

/**
 * Publish one variant to one connected account.
 *
 * WHY PUBLISHING HAPPENS HERE AND NOT IN A REQUEST. An external call to a
 * social platform is unbounded work against somebody else's infrastructure: it
 * can take thirty seconds, it can time out, it can be rate limited for an hour.
 * On a request path that is a customer watching a spinner and a connection held
 * open; here it is a job with a retry schedule and a durable record.
 *
 * WHAT IDENTITY THIS PROCESS HOLDS. The TENANT one, and only that. The payload
 * names a workspace, `withWorkspace` re-applies it as the RLS context, and a
 * forged id therefore reaches exactly what that workspace's own policies allow
 * — which is nothing belonging to anyone else. This process cannot read
 * `secret_record` at all (F-07), and does not need to: the customer's token is
 * tenant data, encrypted under the SOCIAL key domain (D-136), and is decrypted
 * here inside that workspace's context.
 *
 * THE TOKEN NEVER TOUCHES THIS FILE'S LOGS. What is logged below is the
 * workspace, the job, the provider, the resulting status and the failure class.
 * Nothing else — and specifically not the caption, not the account name and not
 * the provider's own response.
 *
 * IDEMPOTENT BY CONSTRUCTION. The database row is the state: a duplicate
 * delivery re-enters `execute()`, fails to claim a job that is no longer
 * QUEUED, and returns what already happened. That is why at-least-once delivery
 * is safe here.
 */

const log = createLogger({ context: { component: 'worker.social.publishing' } });

/*
 * NO APPLICATION RESOLVER IS BUILT HERE, AND THAT IS THE POINT.
 *
 * `integrations.social-apps` is platform-owned configuration whose
 * `clientSecretRef` resolves through the Secret Service, which this process may
 * not import (F-07). Publishing does not need it — an access token is all a
 * post requires — so the pipeline is constructed without one and this file has
 * no path to a platform credential even by mistake.
 *
 * The operations that DO need it (starting an authorization, exchanging a code,
 * refreshing a token) live in `apps/api`, the designated platform surface.
 */

/**
 * Build the pipeline for one workspace. Shared by both processors so the
 * publish path and the verification path cannot end up with different
 * configuration, a different registry or a different notifier.
 */
async function withPipeline<T>(
  workspaceId: string,
  fn: (pipeline: PublishPipelineService) => Promise<T>,
): Promise<T> {
  const environment = currentEnvironment();
  return withWorkspace(workspaceId, async (db) => {
    // THE SAME CONFIGURATION THE DASHBOARD READS, through the same tenant-side
    // projection. A worker with its own retry schedule would be a second set of
    // settings an operator cannot see (CLAUDE.md §2.2).
    const policy = await new TenantPublishingPolicySource(db, environment).load();
    const contentPolicy = await new TenantContentPolicySource(db, environment).load();

    const pipeline = new PublishPipelineService({
      db,
      workspaceId,
      policy,
      registry: createConnectorRegistry({ policy, environment }),
      vault: new SocialTokenVault(),
      /*
       * THE APPROVAL GATE IS RE-CONSULTED HERE, immediately before the external
       * call. The calendar checked it when the slot was scheduled; approval can
       * be withdrawn in between, and the check that matters is the last one
       * (docs/SOCIAL-INTEGRATIONS.md §6.2).
       */
      approvals: new ContentApprovalService({
        db,
        workspaceId,
        policy: contentPolicy,
      }),
      /*
       * PHASE 8 — HOW ASSET IDS BECOME BYTES (AC-29.3, AC-29.4).
       *
       * A PORT, because resolving media needs the Asset Library's rules AND the
       * object store, and `packages/social-connectors` has neither. It runs on
       * the SAME scoped client, so RLS applies, and it uses the same predicate
       * the Content Studio used when the author attached the picture — so the
       * screen and the pipeline cannot disagree about what is publishable.
       *
       * BrandScope IS EMPTY HERE, and that is correct rather than a shortcut:
       * this is the WORKER, publishing something a member already composed,
       * approved and scheduled, and there is no member in the room. The brand
       * clause still confines it to the job's own brand plus the shared shelf,
       * which is the boundary that matters at this point.
       */
      media: {
        resolve: async ({ brandId, assetIds }) =>
          new PublishMediaResolver({ db, workspaceId, store: objectStore() }).resolve({
            brandId,
            assetIds,
            brandScope: [],
          }),
      },
      /*
       * THE INBOX ENTRY IS WRITTEN IN THE SAME TRANSACTION as the state change
       * it describes, because this whole processor runs inside one
       * `withWorkspace` transaction. A post that is recorded as published and a
       * notification that never arrived would be two answers to one question.
       */
      notifier: publishNotifier({
        db,
        workspaceId,
        accountNameFor: async (jobId) => {
          const job = await db.publishJob.findFirst({
            where: { id: jobId, workspaceId },
            select: { socialConnectionId: true },
          });
          if (!job) return null;
          const connection = await db.socialConnection.findFirst({
            where: { id: job.socialConnectionId, workspaceId },
            select: { displayName: true },
          });
          return connection ? { accountName: connection.displayName } : null;
        },
      }),
    });

    return fn(pipeline);
  });
}

export async function processPublishJob(payload: PublishSocialPostPayload): Promise<void> {
  const result = await withPipeline(payload.workspaceId, (pipeline) =>
    pipeline.execute(payload.publishJobId),
  );

  log.info('publish job finished', {
    workspaceId: payload.workspaceId,
    jobId: result.jobId,
    status: result.status,
    ...(result.failureClass ? { failureClass: result.failureClass } : {}),
    // The EXTERNAL POST ID, which is public on the platform and is the one
    // thing support needs to find the post. No token, no caption, no account.
    ...(result.externalPostId ? { externalPostId: result.externalPostId } : {}),
  });
}

/**
 * Recover a job whose worker died mid-flight — by asking, never by re-sending.
 *
 * THIS FUNCTION CALLS `recoverStaleClaim()` AND NOTHING ELSE, and that is the
 * safety property rather than a stylistic preference (D-143). There is no
 * branch here that reaches `execute()`, so a `social.verify-post` message has
 * no route to `adapter.publish()` at all — a duplicate delivery of one, a
 * malformed one, or one whose job has since finished all do the same harmless
 * thing.
 *
 * The provider lookup that resolves it is an external call, which is why it
 * runs here rather than in the API's sweep: unbounded work against somebody
 * else's infrastructure belongs in a worker, exactly as publishing does.
 */
export async function processVerifyJob(payload: VerifySocialPostPayload): Promise<void> {
  const result = await withPipeline(payload.workspaceId, (pipeline) =>
    pipeline.recoverStaleClaim(payload.publishJobId),
  );

  log.info('publish job verification finished', {
    workspaceId: payload.workspaceId,
    jobId: result.jobId,
    status: result.status,
    ...(result.failureClass ? { failureClass: result.failureClass } : {}),
    ...(result.externalPostId ? { externalPostId: result.externalPostId } : {}),
  });
}
