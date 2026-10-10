import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AutomationEngine,
  TenantAutomationPolicySource,
  type AutomationPorts,
} from '@brandspace/automation';
import {
  ContentApprovalService,
  ContentCalendarService,
  ContentLibraryService,
  TenantContentPolicySource,
} from '@brandspace/content';
import {
  PublishPipelineService,
  SocialTokenVault,
  createConnectorRegistry,
  resolvePublishingPolicy,
  unreachableChannelGate,
} from '@brandspace/social-connectors';
import { getPrisma, withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { PUBLISH_SOCIAL_POST, enqueue, type PublishSocialPostPayload } from '@brandspace/jobs';
import { route } from '../route-contract';
import {
  automationDenialSink,
  configurationService,
  currentEnvironment,
  entitlementGate,
  fail,
  resolveCaller,
} from './phase7-context';
// ONE IMPLEMENTATION OF THE PLAN CEILING, shared with the Copilot route.
import { scheduleQuota } from './schedule-quota';
import { campaignPausePort, publishRetryPort } from './automation-ports';

/**
 * THE ONE ROUTE AN AUTOMATION'S EXTERNAL ACTION CAN REACH THE WORLD THROUGH.
 *
 * WHY IT IS HERE AND NOT ON THE WORKER. An external action needs a fresh human
 * confirmation, and the confirmation arrives on THIS request with that person's
 * own session behind it. The worker that evaluates rules is deliberately wired
 * WITHOUT a publish port, so there is no code path by which an automation reaches
 * a platform unless a person has clicked — not a guarded one, none.
 *
 * THE CONFIRMER'S OWN AUTHORITY IS WHAT COUNTS, not the rule creator's. The
 * engine checks that the person confirming holds the action's permission and the
 * brand, because otherwise a rule written by an admin would let anyone holding a
 * link authorize a publish.
 *
 * READING AND WRITING RULES IS NOT HERE. That is ordinary tenant work with no
 * gateway and no platform identity in it, so it lives in the dashboard on the
 * tenant pool, where it belongs.
 */

/*
 * THE ROUTE'S FLOOR, NOT THE DECISION (Phase 2B-3 PR 5, report §13.4). Each
 * asks-first action needs its OWN permission — publishing for a publish or a
 * retry, campaigns for a pause — and the engine checks exactly that against the
 * caller, with their live brand scope, on every token and every approval. A
 * route gate of `publishing.manage` would have locked out a campaign manager
 * from approving a pause they are entitled to decide; `automation.read` is the
 * least a person needs to see a request at all.
 */
const CONFIRM_PERMISSION = 'automation.read';

const confirmSchema = z.object({
  runId: z.string().uuid(),
  token: z.string().min(16).max(200),
});

/**
 * The publish port, wired on THIS surface only.
 *
 * It materialises the slot through the ordinary calendar and publishing pipeline
 * and hands the jobs to the queue — so an automation's publish is the same
 * publish a person's is, with the same approval gate, the same retry schedule and
 * the same verification path.
 */
function publishPort(db: TenantScopedClient): NonNullable<AutomationPorts['publishing']> {
  return {
    async publishNow(input) {
      const environment = currentEnvironment();
      const policy = await resolvePublishingPolicy(configurationService(), environment);
      const contentPolicy = await new TenantContentPolicySource(db, environment).load();

      /*
       * THE TARGET IS ADMITTED BEFORE ANYTHING IS BUILT (P7-R3).
       *
       * The content domain's own query, carrying BOTH the run's brand and the
       * CONFIRMING PERSON'S live BrandScope — so an item belonging to a
       * different brand, or one the confirmer may not act on, is refused here,
       * before a slot, a publish job, a queue entry or a provider request
       * exists. Nothing to unwind, which is the only acceptable shape for a
       * fail-closed check on an action that leaves the platform.
       */
      await new ContentLibraryService({
        db,
        workspaceId: input.workspaceId,
        policy: contentPolicy,
      }).requireItemForBrand({
        contentItemId: input.contentItemId,
        brandId: input.brandId,
        brandScope: input.actorBrandScope,
      });

      const workspace = await db.workspace.findFirst({
        where: { id: input.workspaceId },
        select: { timezone: true },
      });
      const timezone = workspace?.timezone ?? 'UTC';

      const calendar = new ContentCalendarService({
        db,
        workspaceId: input.workspaceId,
        policy: contentPolicy,
        timezone,
        // Q9 (D-332): a channel whose every account was revoked is refused.
        channelGate: unreachableChannelGate(db, input.workspaceId),
        // A no-op quota is NOT acceptable here: the plan ceiling applies to an
        // automation exactly as it does to a person, so the caller supplies the
        // real one through the shared helper below.
        quota: scheduleQuota(db, input.workspaceId),
        approvalGate: new ContentApprovalService({
          db,
          workspaceId: input.workspaceId,
          policy: contentPolicy,
        }),
      });

      // Batch 7 PR C (B3.1): "now" through `publishNow()`, which keeps every
      // rule of `schedule()` except the minimum lead that refused it.
      const view = await calendar.publishNow({
        contentItemId: input.contentItemId,
        actorUserId: input.actorUserId,
        /*
         * THE CONFIRMER'S OWN SCOPE (P7-R3). `[]` here did not "re-check
         * anyway" — empty is UNRESTRICTED on this platform, so the literal
         * disabled the calendar's brand check on the one action that leaves it.
         */
        actorBrandScope: input.actorBrandScope,
      });

      const pipeline = new PublishPipelineService({
        db,
        workspaceId: input.workspaceId,
        policy,
        registry: createConnectorRegistry({ policy, environment }),
        vault: new SocialTokenVault(),
        approvals: new ContentApprovalService({
          db,
          workspaceId: input.workspaceId,
          policy: contentPolicy,
        }),
      });
      const materialised = await pipeline.materialiseSlot(view.slot.id);

      const jobs = await db.publishJob.findMany({
        where: { workspaceId: input.workspaceId, calendarSlotId: view.slot.id, status: 'QUEUED' },
        select: { id: true, idempotencyKey: true },
      });
      for (const job of jobs) {
        await enqueue('publish-jobs', PUBLISH_SOCIAL_POST, {
          kind: PUBLISH_SOCIAL_POST,
          workspaceId: input.workspaceId,
          idempotencyKey: job.idempotencyKey,
          publishJobId: job.id,
        } satisfies PublishSocialPostPayload);
      }

      return { jobsCreated: materialised.created, slotId: view.slot.id };
    },
  };
}

const confirmationTokenSchema = z.object({ runId: z.string().uuid() });

export function registerAutomationRoutes(app: FastifyInstance): void {
  /**
   * ISSUE A CONFIRMATION CREDENTIAL FOR A PROPOSED EXTERNAL ACTION.
   *
   * WHY THIS ROUTE HAS TO EXIST. The run's token is minted in the WORKER, stored
   * as a hash, and returned to a background process that logs a status and drops
   * it. The notification that tells a person to come and look deliberately
   * carries no payload, because a live publish credential does not belong in a
   * notification row. So the credential existed nowhere, and `PROPOSE_PUBLISH`
   * was an action nobody in the world could confirm.
   *
   * IT IS NOT A WAY AROUND THE CONFIRMATION, it is the way TO it. The engine
   * applies the same two checks `confirmRun` does — the action's own permission
   * against THIS caller, and the run's brand against THIS caller's live scope —
   * and rotates the stored digest under a compare-and-swap, so asking twice
   * leaves one live credential rather than two.
   *
   * THE RAW TOKEN IS STILL NEVER STORED. It is returned once, to a person who
   * has just been authorized, and it expires on the policy's own window.
   */
  route(
    app,
    'POST',
    '/v1/automations/confirmation-token',
    {
      scope: 'workspace',
      permission: CONFIRM_PERMISSION,
      rateLimit: 'workspace.write',
      idempotent: false,
    },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, CONFIRM_PERMISSION);
      if (!caller) return;
      const parsed = confirmationTokenSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });

      try {
        const issued = await withWorkspace(
          caller.workspaceId,
          async (db) => {
            const policy = await new TenantAutomationPolicySource(db, currentEnvironment()).load();
            const engine = new AutomationEngine({
              db,
              workspaceId: caller.workspaceId,
              policy,
              // NO PUBLISH PORT. This route issues a credential and performs no
              // action, so it has no business holding the thing that acts.
              ports: {},
              denialSink: automationDenialSink(caller.workspaceId),
            });
            return engine.reissueRunConfirmation({
              runId: parsed.data.runId,
              actor: {
                userId: caller.userId,
                roleKey: caller.roleKey,
                permissionKeys: caller.permissionKeys,
                brandScope: caller.brandScope,
              },
            });
          },
          { prisma: getPrisma() },
        );

        /*
         * PHASE 2B-3 PR 5 (D1, D2) — THE REQUEST WAS ENDED, NOT ISSUED. Its rule
         * was switched off or its creator no longer holds what it needs; the
         * engine ended it BLOCKED inside this transaction, which commits
         * because nothing threw. The caller gets the ordinary refusal and the
         * run history says why.
         */
        if (issued.token === null) {
          return reply.code(409).send({ error: { code: 'CONFLICT' } });
        }
        return reply.send({
          runId: issued.run.id,
          // RETURNED EXACTLY ONCE. Only its hash is stored.
          token: issued.token,
          expiresAt: issued.run.confirmationExpiresAt?.toISOString() ?? null,
        });
      } catch (error: unknown) {
        return fail(reply, 'automation confirmation token', error);
      }
    },
  );

  route(
    app,
    'POST',
    '/v1/automations/confirm',
    {
      scope: 'workspace',
      permission: CONFIRM_PERMISSION,
      confirmation: 'required',
      confirmedBy: 'single_use_token',
      rateLimit: 'workspace.write',
      idempotent: true,
    },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, CONFIRM_PERMISSION);
      if (!caller) return;
      const parsed = confirmSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });

      try {
        const run = await withWorkspace(
          caller.workspaceId,
          async (db) => {
            const policy = await new TenantAutomationPolicySource(db, currentEnvironment()).load();
            const engine = new AutomationEngine({
              db,
              workspaceId: caller.workspaceId,
              policy,
              // THE PUBLISH PORT, on this surface and only this one — and the
              // entitlement gate, asked again at the moment the action happens.
              ports: {
                publishing: publishPort(db),
                // Phase 2B-3 PR 5 — the two other asks-first actions, here only.
                publishRetry: publishRetryPort(db, {
                  environment: currentEnvironment(),
                  loadPolicy: () =>
                    resolvePublishingPolicy(configurationService(), currentEnvironment()),
                }),
                campaignPause: campaignPausePort(db),
                entitlements: entitlementGate(db, caller.workspaceId),
              },
              // A REFUSED CONFIRMATION MUST OUTLIVE THE TRANSACTION THAT REFUSED
              // IT. See `automationDenialSink`.
              denialSink: automationDenialSink(caller.workspaceId),
            });
            return engine.confirmRun({
              runId: parsed.data.runId,
              token: parsed.data.token,
              actor: {
                userId: caller.userId,
                roleKey: caller.roleKey,
                permissionKeys: caller.permissionKeys,
                brandScope: caller.brandScope,
              },
            });
          },
          { prisma: getPrisma() },
        );

        return reply.send({
          runId: run.id,
          status: run.status,
          resourceType: run.resourceType,
          resourceId: run.resourceId,
        });
      } catch (error: unknown) {
        return fail(reply, 'automation confirm', error);
      }
    },
  );
}
