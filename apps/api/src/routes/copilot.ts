import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AnalyticsQueryService,
  TenantAnalyticsPolicySource,
  createAnalyticsRegistry,
} from '@brandspace/analytics';
import { TenantAutomationPolicySource } from '@brandspace/automation';
import {
  COPILOT_SURFACE_KEYS,
  CopilotOrchestrator,
  CopilotPlanService,
  CopilotUndoService,
  TenantCopilotPolicySource,
  findTool,
  resolveLiveAuthorization,
  type CopilotSurface,
  type ExecutorContext,
  type ExternalActionPort,
  type LiveAuthorization,
} from '@brandspace/copilot';
import {
  CampaignService,
  ContentApprovalService,
  ContentCalendarService,
  ContentLibraryService,
  ContentStudioService,
  TenantContentPolicySource,
  resolveContentExpiry,
  resolveContentPolicy,
} from '@brandspace/content';
import {
  PublishPipelineService,
  SocialTokenVault,
  createConnectorRegistry,
  resolvePublishingPolicy,
} from '@brandspace/social-connectors';
import { getPrisma, withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { PUBLISH_SOCIAL_POST, enqueue, type PublishSocialPostPayload } from '@brandspace/jobs';
import { AppError, systemClock } from '@brandspace/shared';
import { route } from '../route-contract';
// ONE IMPLEMENTATION OF THE PLAN CEILING, shared with the automation route.
import { scheduleQuota } from './schedule-quota';
import { automationRuleCheck, copilotAutomationPort } from './copilot-automation';
import {
  configurationService,
  copilotDenialSink,
  currentEnvironment,
  entitlementGate,
  fail,
  gateway,
  resolveCaller,
  workspaceFacts,
} from './phase7-context';

/**
 * THE AI COPILOT'S HTTP SURFACE — four routes, and each one is a boundary.
 *
 *   POST /v1/copilot/session   open a conversation
 *   POST /v1/copilot/turn      ask; get a PLAN and a confirmation token
 *   POST /v1/copilot/confirm   confirm THAT plan, then execute it
 *   POST /v1/copilot/undo      compensate what it did, where that is still safe
 *
 * THE CONFIRMATION TOKEN IS RETURNED EXACTLY ONCE, by `/turn`, and only its hash
 * is stored — the same discipline the OAuth state carries (D-141), so a database
 * read cannot be replayed as a confirmation.
 *
 * `/confirm` DOES BOTH THE CONFIRMATION AND THE EXECUTION, in that order, in one
 * request. Not for convenience: separating them would create a window in which a
 * plan is CONFIRMED and unexecuted, and the only thing that could close it is a
 * second credential — which is the credential we just consumed. One request, one
 * consumption, one execution.
 *
 * WHY IT LIVES IN apps/api. The orchestrator and `content.draft` both call the AI
 * Gateway, which needs the PLATFORM identity that F-07 keeps out of the customer
 * dashboard. The dashboard proxies to here with the customer's own session,
 * exactly as it does for Brand Brain chat and the Content Studio.
 */

const COPILOT_PERMISSION = 'copilot.use';

const sessionSchema = z.object({
  brandId: z.string().uuid().nullable().default(null),
  /*
   * A CLOSED SET (P6-12). The surface reaches the model's instructions — the one
   * part of the prompt that is not fenced — so a free string here would be a
   * caller-controlled line in the system instruction.
   */
  surface: z.enum(COPILOT_SURFACE_KEYS as [CopilotSurface, ...CopilotSurface[]]).default('general'),
  locale: z.enum(['AR', 'EN']).default('EN'),
});

/*
 * NO `brandId` (P7-R1). The brand a turn runs against is the brand its SESSION
 * owns, and the session was admitted against the caller's BrandScope when it was
 * opened and again on every turn. A second, caller-supplied brand beside the
 * session id was two answers to one question, and the unchecked one won.
 */
const turnSchema = z.object({
  sessionId: z.string().uuid(),
  request: z.string().min(1).max(4_000),
  idempotencyKey: z.string().min(8).max(200),
});

const confirmSchema = z.object({
  planId: z.string().uuid(),
  /** The hash the customer was SHOWN. A stale one no longer matches. */
  planHash: z.string().length(64),
  token: z.string().min(16).max(200),
});

const undoSchema = z.object({ planId: z.string().uuid() });

const cancelSchema = z.object({ planId: z.string().uuid() });

/** The automations domain as the Copilot may reach it — see copilot-automation.ts. */
async function automationPort(db: TenantScopedClient, workspaceId: string) {
  const policy = await new TenantAutomationPolicySource(db, currentEnvironment()).load();
  return copilotAutomationPort({ db, workspaceId, policy });
}

/**
 * Everything a plan's steps may reach, assembled once per execution.
 *
 * ONE BUILDER for `/confirm` and for the read-only inspection `/turn` now runs
 * (P6-12), so an inspected plan and a confirmed one see exactly the same
 * collaborators — two copies of this list would drift the first time a tool was
 * added.
 */
async function executionContextFor(input: {
  db: TenantScopedClient;
  workspaceId: string;
  planKey: string | null;
  retention: Awaited<ReturnType<typeof workspaceFacts>>;
  correlationId: string;
}): Promise<(authorization: LiveAuthorization) => ExecutorContext> {
  const { db, workspaceId } = input;
  const contentPolicy = await resolveContentPolicy(configurationService(), currentEnvironment());
  const analyticsPolicy = await new TenantAnalyticsPolicySource(db, currentEnvironment()).load();
  const workspace = await db.workspace.findFirst({
    where: { id: workspaceId },
    select: { timezone: true },
  });
  const automations = await automationPort(db, workspaceId);
  return (authorization) => ({
    db,
    workspaceId,
    authorization,
    planKey: input.planKey,
    clock: systemClock,
    correlationId: input.correlationId,
    // Replaced per step by the plan service with the step's own key.
    idempotencyKey: input.correlationId,
    analytics: new AnalyticsQueryService({
      db,
      workspaceId,
      policy: analyticsPolicy,
      registry: createAnalyticsRegistry({ environment: currentEnvironment() }),
    }),
    campaigns: new CampaignService({ db, workspaceId }),
    calendar: new ContentCalendarService({
      db,
      workspaceId,
      policy: contentPolicy,
      timezone: workspace?.timezone ?? 'UTC',
      quota: scheduleQuota(db, workspaceId),
      /*
       * AC-14.6 — the calendar asks the APPROVALS MODULE whether this brand
       * requires approval, rather than reading one workspace-wide default. The
       * assistant is subject to the brand's own gate exactly as a person is.
       */
      approvalGate: new ContentApprovalService({ db, workspaceId, policy: contentPolicy }),
    }),
    studio: new ContentStudioService({
      db,
      workspaceId,
      policy: contentPolicy,
      gateway: gateway(),
    }),
    retention: input.retention,
    externalActions: externalActions(db),
    automations,
  });
}

/**
 * The publish port, wired HERE and nowhere else.
 *
 * WHY IT IS ON THIS SURFACE AND NOT ON THE WORKER. An external action needs a
 * fresh human confirmation, and the confirmation arrives on THIS request with
 * that person's own session behind it. A worker holding this port could publish
 * with nobody having agreed — which is exactly what must be impossible, and the
 * way it is made impossible is that the worker is not given the port.
 *
 * IT MATERIALISES AND DISPATCHES; IT DOES NOT PUBLISH INLINE. The publish itself
 * is unbounded work against somebody else's platform and belongs on the queue,
 * with its retry schedule, its verification path and its durable record. This
 * creates the slot and the jobs and hands them over — the same path the calendar
 * sweep uses, so there is one publishing pipeline rather than two.
 */
function externalActions(db: TenantScopedClient): ExternalActionPort {
  return {
    async publishNow(input) {
      const environment = currentEnvironment();
      const contentPolicy = await new TenantContentPolicySource(db, environment).load();

      /*
       * THE TARGET IS ADMITTED BEFORE ANYTHING IS BUILT (P7-R3).
       *
       * One query, three predicates, all in the WHERE: the workspace, the
       * caller's LIVE BrandScope, and the brand the confirmed step NAMED. The
       * third is what binds `contentItemId` to `brandId` — a plan carrying a
       * brand the caller may act on and a content item belonging to a different
       * brand used to pass every check and publish the wrong post.
       *
       * IT COMES BEFORE EVERY EFFECT on purpose: no calendar, no slot, no
       * materialisation, no queue entry, no provider request. A refusal here
       * happens before anything exists to undo — the only acceptable shape for a
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

      const policy = await resolvePublishingPolicy(configurationService(), environment);

      const workspace = await db.workspace.findFirst({
        where: { id: input.workspaceId },
        select: { timezone: true },
      });
      const calendar = new ContentCalendarService({
        db,
        workspaceId: input.workspaceId,
        policy: contentPolicy,
        timezone: workspace?.timezone ?? 'UTC',
        // THE REAL QUOTA. Publishing through the assistant is subject to the
        // plan's monthly ceiling exactly as scheduling by hand is; an assistant
        // that could exceed it would be a way to buy headroom by asking nicely.
        quota: scheduleQuota(db, input.workspaceId),
      });

      /*
       * "NOW" IS A SLOT AT THIS INSTANT, not a bypass of the calendar. The
       * approval gate, the brand policy and the quota all apply, because they
       * apply to `schedule()` and this goes through `schedule()`.
       */
      const now = systemClock.now();
      const localTime = new Intl.DateTimeFormat('en-CA', {
        timeZone: workspace?.timezone ?? 'UTC',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
        .formatToParts(now)
        .reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {} as Record<string, string>);

      const view = await calendar.schedule({
        contentItemId: input.contentItemId,
        localTime: `${localTime['year']}-${localTime['month']}-${localTime['day']}T${localTime['hour']}:${localTime['minute']}`,
        actorUserId: input.actorUserId,
        /*
         * THE CONFIRMER'S OWN SCOPE. It used to be `[]` with a comment claiming
         * the calendar re-checked anyway — but empty means UNRESTRICTED here, so
         * that literal DISABLED the calendar's brand check on the one action
         * that leaves the platform. Carrying the real scope is what makes the
         * re-check a re-check.
         */
        actorBrandScope: input.actorBrandScope,
      });

      const pipeline = new PublishPipelineService({
        db,
        workspaceId: input.workspaceId,
        policy,
        registry: createConnectorRegistry({ policy, environment }),
        // A vault that cannot decrypt: materialisation never opens a credential,
        // and the publish that does runs on the worker.
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
          // THE JOB'S OWN DERIVED KEY, so a retried confirmation cannot queue a
          // second attempt at the same post.
          idempotencyKey: job.idempotencyKey,
          publishJobId: job.id,
        } satisfies PublishSocialPostPayload);
      }

      return { jobsCreated: materialised.created, slotId: view.slot.id };
    },
  };
}

export function registerCopilotRoutes(app: FastifyInstance): void {
  route(
    app,
    'POST',
    '/v1/copilot/session',
    { scope: 'workspace', permission: COPILOT_PERMISSION, rateLimit: 'workspace.write' },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, COPILOT_PERMISSION);
      if (!caller) return;
      const parsed = sessionSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });

      try {
        const facts = await workspaceFacts(caller.workspaceId);
        const contentPolicy = await resolveContentPolicy(
          configurationService(),
          currentEnvironment(),
        );
        const session = await withWorkspace(
          caller.workspaceId,
          async (db) => {
            const policy = await new TenantCopilotPolicySource(db, currentEnvironment()).load();
            const orchestrator = new CopilotOrchestrator({
              db,
              workspaceId: caller.workspaceId,
              policy,
              gateway: gateway(),
            });
            /*
             * THE LIVE AUTHORIZATION, BEFORE A SESSION EXISTS (P7-R1). The
             * orchestrator admits the brand against this scope with a query, and
             * refuses an out-of-scope or fabricated brand identically.
             */
            const authorization = await resolveLiveAuthorization(
              db,
              caller.workspaceId,
              caller.userId,
            );
            if (!authorization) throw new AppError('NOT_FOUND', 'Conversation not found.');

            return orchestrator.openSession({
              authorization,
              brandId: parsed.data.brandId,
              surface: parsed.data.surface,
              locale: parsed.data.locale,
              expiresAt: resolveContentExpiry(contentPolicy, facts, systemClock),
            });
          },
          { prisma: getPrisma() },
        );
        return reply.send({ sessionId: session.id });
      } catch (error: unknown) {
        return fail(reply, 'copilot session', error);
      }
    },
  );

  /**
   * One turn: a request in, a PLAN out.
   *
   * NOTHING IS EXECUTED HERE. The response carries the steps, their previews,
   * the estimated credit cost and — when the plan changes state — a single-use
   * confirmation token. A plan that only reads is confirmed at creation and runs
   * on the next call without ceremony, which is the one case where ceremony would
   * be noise.
   */
  route(
    app,
    'POST',
    '/v1/copilot/turn',
    {
      scope: 'workspace',
      permission: COPILOT_PERMISSION,
      rateLimit: 'ai.generate',
      idempotent: true,
    },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, COPILOT_PERMISSION);
      if (!caller) return;
      const parsed = turnSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });
      const body = parsed.data;

      try {
        const facts = await workspaceFacts(caller.workspaceId);
        const contentPolicy = await resolveContentPolicy(
          configurationService(),
          currentEnvironment(),
        );
        const expiresAt = resolveContentExpiry(contentPolicy, facts, systemClock);

        const result = await withWorkspace(
          caller.workspaceId,
          async (db) => {
            /*
             * THE LIVE AUTHORIZATION, EVEN FOR A PLAN THAT ONLY PROPOSES. The
             * session resolved a permission set at sign-in; this reads the
             * membership as it is now, so a plan is never built with authority
             * the person has already lost.
             */
            const authorization = await resolveLiveAuthorization(
              db,
              caller.workspaceId,
              caller.userId,
            );
            if (!authorization) throw new AppError('NOT_FOUND', 'Conversation not found.');

            const policy = await new TenantCopilotPolicySource(db, currentEnvironment()).load();
            const orchestrator = new CopilotOrchestrator({
              db,
              workspaceId: caller.workspaceId,
              policy,
              gateway: gateway(),
            });
            const turn = await orchestrator.turn({
              sessionId: body.sessionId,
              request: body.request,
              authorization,
              planKey: facts.planKey,
              idempotencyKey: body.idempotencyKey,
              locale: 'EN',
              expiresAt,
            });

            const plans = new CopilotPlanService({
              db,
              workspaceId: caller.workspaceId,
              policy,
              denialSink: copilotDenialSink(caller.workspaceId),
            });
            const created = await plans.createPlan({
              sessionId: body.sessionId,
              // THE SESSION'S BRAND, returned by the turn that just admitted it.
              brandId: turn.brandId,
              authorization,
              steps: turn.steps,
              summary: turn.summary,
              // What the AI work in this plan would cost, quoted through the
              // gateway's own route resolution so the price shown is the price
              // reserved.
              estimatedCreditsMilli: await estimateFor(
                turn.steps,
                caller.workspaceId,
                facts.planKey,
              ),
              idempotencyKey: `plan:${body.idempotencyKey}`,
              expiresAt,
              automationRules: automationRuleCheck,
            });

            /*
             * INSPECT (P6-12). A plan that only READS was confirmed at creation
             * and, until now, could never run: `/confirm` requires a token a
             * read-only plan is deliberately not given, so every read tool was
             * offered and none executed. It runs here, through the same
             * `execute` — live authorization, per-step permission, brand and
             * entitlement checks, audit — because there is nothing for a person
             * to confirm about a read. A replayed turn finds its plan already
             * executed and reads the stored calls back instead of running twice.
             */
            let inspection: Awaited<ReturnType<CopilotPlanService['execute']>> | null = null;
            if (
              !created.plan.requiresConfirmation &&
              created.steps.length > 0 &&
              created.plan.status === 'CONFIRMED'
            ) {
              inspection = await plans.execute({
                planId: created.plan.id,
                userId: caller.userId,
                entitlements: entitlementGate(db, caller.workspaceId),
                context: await executionContextFor({
                  db,
                  workspaceId: caller.workspaceId,
                  planKey: facts.planKey,
                  retention: facts,
                  correlationId: created.plan.id,
                }),
              });
            }
            const readBack =
              inspection === null && !created.plan.requiresConfirmation
                ? await db.copilotToolCall.findMany({
                    where: { workspaceId: caller.workspaceId, planId: created.plan.id },
                    orderBy: { ordinal: 'asc' },
                  })
                : null;

            return { turn, created, inspection, readBack };
          },
          { prisma: getPrisma() },
        );

        return reply.send({
          summary: result.turn.summary,
          rejectedToolKeys: result.turn.rejectedToolKeys,
          planId: result.created.plan.id,
          planHash: result.created.plan.planHash,
          planVersion: result.created.plan.planVersion,
          requiresConfirmation: result.created.plan.requiresConfirmation,
          highestActionClass: result.created.plan.highestActionClass,
          estimatedCreditsMilli: result.created.plan.estimatedCreditsMilli.toString(),
          confirmationExpiresAt: result.created.plan.confirmationExpiresAt?.toISOString() ?? null,
          steps: result.created.steps.map((step) => ({
            ordinal: step.ordinal,
            toolKey: step.toolKey,
            messageKey: step.messageKey,
            actionClass: step.actionClass,
            spendsCredits: step.spendsCredits,
            undoable: step.undoable,
            preview: step.preview,
          })),
          // RETURNED EXACTLY ONCE. Only its hash is stored.
          confirmationToken: result.created.confirmationToken,
          creditsChargedMilli: result.turn.creditsChargedMilli.toString(),
          /*
           * WHAT A READ-ONLY PLAN FOUND. Tool results are METADATA by
           * construction (`ExecutorResult.result`): ids, counts, statuses and
           * stored figures — never brand knowledge text, never a provider
           * payload — and they are scoped by the same predicates the tools ran
           * under. Null when the plan changes state and waits for a person.
           */
          inspection: (() => {
            const calls = result.inspection?.toolCalls ?? result.readBack;
            if (!calls) return null;
            return calls.map((call) => ({
              ordinal: call.ordinal,
              toolKey: call.toolKey,
              status: call.status,
              failureCode: call.failureCode,
              result: call.resultJson ?? null,
            }));
          })(),
        });
      } catch (error: unknown) {
        return fail(reply, 'copilot turn', error);
      }
    },
  );

  /**
   * Confirm a plan and run it.
   *
   * THE HIGH-IMPACT ROUTE OF THE PHASE, and it declares so in its contract. The
   * confirmation is consumed by a conditional UPDATE that checks the plan, the
   * person, the token, the window AND the hash the customer was shown; execution
   * then re-resolves permissions, brand scope and entitlements from the LIVE
   * membership before every single step.
   */
  route(
    app,
    'POST',
    '/v1/copilot/confirm',
    {
      scope: 'workspace',
      permission: COPILOT_PERMISSION,
      confirmation: 'required',
      rateLimit: 'workspace.write',
      idempotent: true,
    },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, COPILOT_PERMISSION);
      if (!caller) return;
      const parsed = confirmSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });
      const body = parsed.data;

      try {
        const facts = await workspaceFacts(caller.workspaceId);

        const outcome = await withWorkspace(
          caller.workspaceId,
          async (db) => {
            const policy = await new TenantCopilotPolicySource(db, currentEnvironment()).load();
            const plans = new CopilotPlanService({
              db,
              workspaceId: caller.workspaceId,
              policy,
              // A REFUSED CONFIRMATION MUST OUTLIVE THE TRANSACTION THAT REFUSED
              // IT. See `copilotDenialSink`.
              denialSink: copilotDenialSink(caller.workspaceId),
            });

            await plans.confirm({
              planId: body.planId,
              planHash: body.planHash,
              token: body.token,
              userId: caller.userId,
            });

            return plans.execute({
              planId: body.planId,
              userId: caller.userId,
              entitlements: entitlementGate(db, caller.workspaceId),
              context: await executionContextFor({
                db,
                workspaceId: caller.workspaceId,
                planKey: facts.planKey,
                retention: facts,
                correlationId: body.planId,
              }),
            });
          },
          { prisma: getPrisma() },
        );

        return reply.send({
          planId: outcome.plan.id,
          status: outcome.plan.status,
          undoStatus: outcome.plan.undoStatus,
          undoExpiresAt: outcome.plan.undoExpiresAt?.toISOString() ?? null,
          creditsChargedMilli: outcome.creditsChargedMilli.toString(),
          toolCalls: outcome.toolCalls.map((call) => ({
            ordinal: call.ordinal,
            toolKey: call.toolKey,
            status: call.status,
            failureCode: call.failureCode,
            resourceType: call.resourceType,
            resourceId: call.resourceId,
          })),
        });
      } catch (error: unknown) {
        return fail(reply, 'copilot confirm', error);
      }
    },
  );

  /**
   * Decline a plan (P6-12).
   *
   * `CopilotPlanService.cancel` has existed since Phase 7 and no route called
   * it, so "reject" in the dashboard only forgot the plan locally: the row
   * stayed AWAITING_CONFIRMATION until its window lapsed, still counting
   * against the open-plan ceiling — five rejections in ten minutes and the
   * customer could not ask for anything. Cancelling clears the confirmation
   * token and writes `copilot.plan_cancelled`. Only the plan's own author can
   * cancel it, and a plan that is not theirs is refused like one that does not
   * exist.
   */
  route(
    app,
    'POST',
    '/v1/copilot/cancel',
    { scope: 'workspace', permission: COPILOT_PERMISSION, rateLimit: 'workspace.write' },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, COPILOT_PERMISSION);
      if (!caller) return;
      const parsed = cancelSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });

      try {
        await withWorkspace(
          caller.workspaceId,
          async (db) => {
            const policy = await new TenantCopilotPolicySource(db, currentEnvironment()).load();
            const plans = new CopilotPlanService({
              db,
              workspaceId: caller.workspaceId,
              policy,
              denialSink: copilotDenialSink(caller.workspaceId),
            });
            await plans.cancel({
              planId: parsed.data.planId,
              userId: caller.userId,
              reason: 'declined_by_customer',
            });
          },
          { prisma: getPrisma() },
        );
        return reply.send({ planId: parsed.data.planId, status: 'CANCELLED' });
      } catch (error: unknown) {
        return fail(reply, 'copilot cancel', error);
      }
    },
  );

  /**
   * Undo what a plan did, where that is still safe.
   *
   * PARTIAL IS A REAL OUTCOME. The response says what was undone and what was
   * refused, with a machine code per refusal, because "we put two of your three
   * changes back and here is why the third stayed" is the truth.
   */
  route(
    app,
    'POST',
    '/v1/copilot/undo',
    {
      scope: 'workspace',
      permission: COPILOT_PERMISSION,
      confirmation: 'required',
      rateLimit: 'workspace.write',
    },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, COPILOT_PERMISSION);
      if (!caller) return;
      const parsed = undoSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });

      try {
        const contentPolicy = await resolveContentPolicy(
          configurationService(),
          currentEnvironment(),
        );
        const outcome = await withWorkspace(
          caller.workspaceId,
          async (db) => {
            const workspace = await db.workspace.findFirst({
              where: { id: caller.workspaceId },
              select: { timezone: true },
            });
            const undo = new CopilotUndoService({ db, workspaceId: caller.workspaceId });
            return undo.undo({
              planId: parsed.data.planId,
              userId: caller.userId,
              collaborators: {
                campaigns: new CampaignService({ db, workspaceId: caller.workspaceId }),
                calendar: new ContentCalendarService({
                  db,
                  workspaceId: caller.workspaceId,
                  policy: contentPolicy,
                  timezone: workspace?.timezone ?? 'UTC',
                  quota: scheduleQuota(db, caller.workspaceId),
                }),
                // THE CONTENT DOMAIN'S OWN ARCHIVE (P7-R4). The undo no longer
                // knows how to write a content row.
                library: new ContentLibraryService({
                  db,
                  workspaceId: caller.workspaceId,
                  policy: contentPolicy,
                }),
                // P6-12 — a rule the assistant composed is removed through the
                // engine's own delete, which re-checks `automation.manage`.
                automations: await automationPort(db, caller.workspaceId),
              },
            });
          },
          { prisma: getPrisma() },
        );

        return reply.send({
          planId: outcome.plan.id,
          undoStatus: outcome.plan.undoStatus,
          undone: outcome.undone,
          refused: outcome.refused,
        });
      } catch (error: unknown) {
        return fail(reply, 'copilot undo', error);
      }
    },
  );
}

/**
 * What the AI work in a plan is estimated to cost.
 *
 * QUOTED THROUGH THE GATEWAY'S OWN ROUTE RESOLUTION, so the number shown is the
 * number `execute` will reserve — the discipline AC-11.1 established. A plan with
 * no generating step costs nothing, and the UI shows no number rather than a zero
 * that reads as "free for ever".
 */
async function estimateFor(
  steps: readonly { toolKey: string }[],
  workspaceId: string,
  planKey: string | null,
): Promise<bigint> {
  /*
   * ONLY A STEP THAT SPENDS CREDITS IS QUOTED (P6-12). This used to quote a
   * caption generation for ANY plan with a step in it, so "list my campaigns"
   * was shown a cost it would never incur — and under a placeholder workspace
   * id, so the quote was not even this workspace's route resolution.
   */
  const spending = steps.filter((step) => findTool(step.toolKey)?.spendsCredits === true);
  if (spending.length === 0) return 0n;
  try {
    const quote = await gateway().quote({
      workspaceId,
      taskKey: 'caption.generate',
      planKey,
      input: { kind: 'text', prompt: 'x'.repeat(400) },
    });
    return quote.estimateMilli * BigInt(spending.length);
  } catch {
    // A routing failure here must not fail the turn: the plan is still valid and
    // the customer is shown no estimate rather than a wrong one.
    return 0n;
  }
}
