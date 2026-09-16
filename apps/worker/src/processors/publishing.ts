import type { Environment } from '@brandspace/config';
import { withWorkspace } from '@brandspace/database';
import { ContentApprovalService, TenantContentPolicySource } from '@brandspace/content';
import type { PublishSocialPostPayload } from '@brandspace/jobs';
import {
  createConnectorRegistry,
  PublishPipelineService,
  SocialTokenVault,
  TenantPublishingPolicySource,
} from '@brandspace/social-connectors';
import { createLogger } from '@brandspace/shared';
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

function currentEnvironment(): Environment {
  // APP_ENV, not NODE_ENV: every built app has NODE_ENV=production, including
  // the one an end-to-end run serves (D-97).
  const appEnv = process.env['APP_ENV'] ?? 'development';
  if (appEnv === 'production') return 'PRODUCTION';
  if (appEnv === 'staging') return 'STAGING';
  return 'DEVELOPMENT';
}

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

export async function processPublishJob(payload: PublishSocialPostPayload): Promise<void> {
  const environment = currentEnvironment();

  const result = await withWorkspace(payload.workspaceId, async (db) => {
    // THE SAME CONFIGURATION THE DASHBOARD READS, through the same tenant-side
    // projection. A worker with its own retry schedule would be a second set of
    // settings an operator cannot see (CLAUDE.md §2.2).
    const policy = await new TenantPublishingPolicySource(db, environment).load();
    const contentPolicy = await new TenantContentPolicySource(db, environment).load();

    const pipeline = new PublishPipelineService({
      db,
      workspaceId: payload.workspaceId,
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
        workspaceId: payload.workspaceId,
        policy: contentPolicy,
      }),
      /*
       * THE INBOX ENTRY IS WRITTEN IN THE SAME TRANSACTION as the state change
       * it describes, because this whole processor runs inside one
       * `withWorkspace` transaction. A post that is recorded as published and a
       * notification that never arrived would be two answers to one question.
       */
      notifier: publishNotifier({
        db,
        workspaceId: payload.workspaceId,
        accountNameFor: async (jobId) => {
          const job = await db.publishJob.findFirst({
            where: { id: jobId, workspaceId: payload.workspaceId },
            select: { socialConnectionId: true },
          });
          if (!job) return null;
          const connection = await db.socialConnection.findFirst({
            where: { id: job.socialConnectionId, workspaceId: payload.workspaceId },
            select: { displayName: true },
          });
          return connection ? { accountName: connection.displayName } : null;
        },
      }),
    });

    return pipeline.execute(payload.publishJobId);
  });

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
