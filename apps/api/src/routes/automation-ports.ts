import type { AutomationPorts } from '@brandspace/automation';
import type { Environment } from '@brandspace/config';
import {
  CampaignService,
  ContentApprovalService,
  TenantContentPolicySource,
} from '@brandspace/content';
import type { TenantScopedClient } from '@brandspace/database';
import { isAppError } from '@brandspace/shared';
import {
  PUBLISH_DEADLINE_PASSED_REASON,
  PUBLISH_JOB_SUPERSEDED_REASON,
  PublishPipelineService,
  SocialTokenVault,
  createConnectorRegistry,
  type PublishingPolicy,
} from '@brandspace/social-connectors';

/**
 * PHASE 2B-3 PR 5 — THE TWO ASKS-FIRST ACTIONS' PORTS, in a module the
 * isolation suite imports directly, so what is tested is what the confirm route
 * runs. Wired on `POST /v1/automations/confirm` ONLY, beside the publish port:
 * the engine calls them downstream of a person's approval by construction, and
 * the worker holds neither.
 */

/**
 * RETRY A FAILED POST, as the APPROVER with their live scope. The pipeline's own
 * `retry()`, under its conditional write; it only re-queues the job and the
 * dispatch sweep sends it, exactly as after a person pressing Retry. Its
 * refusals come back typed, so the run says which.
 */
export function publishRetryPort(
  db: TenantScopedClient,
  options: {
    readonly environment: Environment;
    readonly loadPolicy: () => Promise<PublishingPolicy>;
  },
): NonNullable<AutomationPorts['publishRetry']> {
  return {
    async retry(input) {
      const policy = await options.loadPolicy();
      const contentPolicy = await new TenantContentPolicySource(db, options.environment).load();
      const pipeline = new PublishPipelineService({
        db,
        workspaceId: input.workspaceId,
        policy,
        registry: createConnectorRegistry({ policy, environment: options.environment }),
        vault: new SocialTokenVault(),
        approvals: new ContentApprovalService({
          db,
          workspaceId: input.workspaceId,
          policy: contentPolicy,
        }),
      });
      try {
        await pipeline.retry({
          jobId: input.jobId,
          actorUserId: input.actorUserId,
          brandScope: input.actorBrandScope,
        });
        return { kind: 'queued' };
      } catch (error: unknown) {
        if (!isAppError(error)) throw error;
        if (error.code === 'NOT_FOUND') return { kind: 'refused', reason: 'not_found' };
        const reason = error.publicDetails['reason'];
        if (reason === PUBLISH_DEADLINE_PASSED_REASON) {
          return { kind: 'refused', reason: 'deadline_passed' };
        }
        if (reason === PUBLISH_JOB_SUPERSEDED_REASON) {
          return { kind: 'refused', reason: 'superseded' };
        }
        if (error.code === 'CONFLICT') return { kind: 'refused', reason: 'not_retryable' };
        throw error;
      }
    },
  };
}

/** PAUSE THE CAMPAIGN THE RULE NAMES, as the APPROVER. `CampaignService.pause` decides. */
export function campaignPausePort(
  db: TenantScopedClient,
): NonNullable<AutomationPorts['campaignPause']> {
  return {
    async pause(input) {
      const result = await new CampaignService({ db, workspaceId: input.workspaceId }).pause({
        campaignId: input.campaignId,
        brandId: input.brandId,
        actor: { userId: input.actorUserId, brandScope: input.actorBrandScope },
      });
      return result.kind === 'paused' ? { kind: 'paused' } : result;
    },
  };
}
