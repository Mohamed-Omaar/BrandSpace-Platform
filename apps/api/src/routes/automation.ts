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
  TenantContentPolicySource,
} from '@brandspace/content';
import {
  PublishPipelineService,
  SocialTokenVault,
  createConnectorRegistry,
  resolvePublishingPolicy,
} from '@brandspace/social-connectors';
import { getPrisma, withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { PUBLISH_SOCIAL_POST, enqueue, type PublishSocialPostPayload } from '@brandspace/jobs';
import { systemClock } from '@brandspace/shared';
import { route } from '../route-contract';
import {
  automationDenialSink,
  configurationService,
  currentEnvironment,
  fail,
  resolveCaller,
} from './phase7-context';
// ONE IMPLEMENTATION OF THE PLAN CEILING, shared with the Copilot route.
import { scheduleQuota } from './schedule-quota';

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

const CONFIRM_PERMISSION = 'publishing.manage';

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
      const workspace = await db.workspace.findFirst({
        where: { id: input.workspaceId },
        select: { timezone: true },
      });
      const timezone = workspace?.timezone ?? 'UTC';

      const now = systemClock.now();
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
        .formatToParts(now)
        .reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {} as Record<string, string>);

      const calendar = new ContentCalendarService({
        db,
        workspaceId: input.workspaceId,
        policy: contentPolicy,
        timezone,
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

      const view = await calendar.schedule({
        contentItemId: input.contentItemId,
        localTime: `${parts['year']}-${parts['month']}-${parts['day']}T${parts['hour']}:${parts['minute']}`,
        actorUserId: input.actorUserId,
        actorBrandScope: [],
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

export function registerAutomationRoutes(app: FastifyInstance): void {
  route(
    app,
    'POST',
    '/v1/automations/confirm',
    {
      scope: 'workspace',
      permission: CONFIRM_PERMISSION,
      confirmation: 'required',
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
              // THE PUBLISH PORT, on this surface and only this one.
              ports: { publishing: publishPort(db) },
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
