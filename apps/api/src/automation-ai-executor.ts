import { randomUUID } from 'node:crypto';
import type { AiGateway, AiGatewayResult } from '@brandspace/ai-gateway';
import {
  DRAFT_IDEAS_TASK_KEY,
  WORKSPACE_PENDING_DELETION_FAILURE,
  draftIdeaKey,
  draftIdeasContext,
  draftIdeasPrompt,
  draftIdeasRequestKey,
  findAction,
  isDraftIdeasTrigger,
  parseDraftIdeas,
  ruleAuthorityRefusal,
  type ActionOutcomeCode,
  type AutomationPolicy,
  type DraftIdea,
  type DraftIdeasTrigger,
} from '@brandspace/automation';
import { writingGroundingWithoutQuestion, type Grounding } from '@brandspace/brand-brain';
import type { Environment } from '@brandspace/config';
import { readRetentionFacts, resolveContentExpiry, type ContentPolicy } from '@brandspace/content';
import {
  withWorkspace,
  writeAuditEvent,
  type AutomationRun,
  type AutomationRule,
  type Prisma,
  type PrismaClient,
  type TenantScopedClient,
} from '@brandspace/database';
import {
  AUTOMATION_AI_ACTIONS_FEATURE,
  EntitlementService,
  TenantCatalogueSource,
  createAutomationAiQuota,
  workspaceMonthLabel,
} from '@brandspace/entitlements';
import { isAppError, systemClock, type Clock } from '@brandspace/shared';

/**
 * PHASE 2B-3 PR 6 — THE AI EXECUTOR FOR AUTOMATION RUNS (DRAFT_IDEAS).
 *
 * The engine (in the worker) decides a run may happen and leaves it
 * AWAITING_EXECUTION. The worker has no AI gateway (F-07 / F-68), so this, in
 * the API's scheduler, does the rest — once per run, whatever crashes:
 *
 *   1. CLAIM (its own transaction). A compare-and-swap moves a due run to
 *      EXECUTING under a fresh lease id; a run whose lease expired is due
 *      again. Two executors, or two overlapping passes, cannot both hold it.
 *   2. RE-CHECK, then CLAIM A CAP SLOT (one transaction). The rule, its
 *      creator's authority (`ruleAuthorityRefusal`, the function an approval
 *      uses), the workspace, the brand, the plan, the facts, the draft
 *      headroom and the routing rule's `persistOutput` — every refusal here
 *      charges nothing and counts nothing. Only then one slot of the monthly
 *      cap, in the workspace's own month, recorded on the run.
 *   3. ASK THE GATEWAY, outside any transaction, with the run's own key
 *      (`automation-run:<runId>`): one reservation, one charge, ever. A retry
 *      after a crash replays the stored output (`persistOutput`, D-78).
 *   4. SAVE AND FINISH (one transaction): three DRAFT items, keyed per run,
 *      and the run's final state — guarded by the lease, so an executor that
 *      lost its lease saves nothing.
 *
 * Every refusal that charged nothing gives the cap slot back; an answer that
 * could not be used keeps it, and the charge stands (owner decision 9).
 */

export interface RoutingRuleView {
  readonly taskKey: string;
  readonly scope: string;
  readonly planKey: string | null;
  readonly workspaceId: string | null;
  readonly parameters?: { readonly persistOutput?: boolean } | undefined;
}

/**
 * MAY THIS WORKSPACE'S `ideas.generate` REQUEST BE REPLAYED AFTER A CRASH?
 *
 * Only if every routing rule that could apply to it keeps the output
 * (`persistOutput`). Otherwise a run whose charge succeeded and whose save was
 * interrupted could never recover its ideas — so it is not started at all, and
 * ends FAILED `ai_unavailable` with nothing charged (owner decision 13).
 */
export function ideasRouteKeepsOutput(
  rules: readonly RoutingRuleView[],
  target: { readonly planKey: string | null; readonly workspaceId: string },
): boolean {
  const applicable = rules.filter(
    (rule) =>
      rule.taskKey === DRAFT_IDEAS_TASK_KEY &&
      (rule.scope === 'global' ||
        (rule.scope === 'plan' && rule.planKey !== null && rule.planKey === target.planKey) ||
        (rule.scope === 'workspace' && rule.workspaceId === target.workspaceId)),
  );
  return (
    applicable.length > 0 && applicable.every((rule) => rule.parameters?.persistOutput === true)
  );
}

export interface AutomationAiExecutorOptions {
  readonly environment: Environment;
  readonly clock?: Clock;
  /** The PLATFORM identity: due runs are found across workspaces. */
  readonly platform: PrismaClient;
  /** The APPLICATION identity every per-run transaction runs under. */
  readonly app: PrismaClient;
  readonly gateway: Pick<AiGateway, 'execute' | 'sweepStuckRequests'>;
  readonly automationPolicy: () => Promise<AutomationPolicy>;
  readonly contentPolicy: () => Promise<ContentPolicy>;
  readonly routingRules: () => Promise<readonly RoutingRuleView[]>;
}

export interface AiExecutionSweep {
  readonly stuckRequestsReleased: number;
  readonly abandoned: number;
  readonly executed: number;
}

/** What one claimed run ended as, for tests and the log. */
export type ExecutionOutcome =
  | { readonly kind: 'not_claimed' }
  | { readonly kind: 'lease_lost' }
  | { readonly kind: 'retry_later' }
  | {
      readonly kind: 'finished';
      readonly status: AutomationRun['status'];
      readonly code: string | null;
    };

/** The executor's own stop: concludes and rolls back nothing it should keep. */
class LeaseLost extends Error {}

type Concluded = Extract<ExecutionOutcome, { kind: 'finished' }>;

interface Prepared {
  readonly kind: 'prepared';
  readonly rule: AutomationRule;
  readonly run: AutomationRun;
  readonly monthLabel: string;
  readonly planKey: string | null;
  readonly locale: 'EN' | 'AR';
  readonly prompt: string;
  readonly untrustedContext: readonly string[];
  readonly grounding: Grounding;
  readonly campaignId: string | null;
}

/** The gateway failure classes a retry cannot change (gateway.ts, D-222). */
const DETERMINISTIC_FAILURE_CLASSES: ReadonlySet<string> = new Set([
  'CONTENT_FILTERED',
  'INVALID_REQUEST',
  'CONTEXT_TOO_LONG',
]);

const INT_MAX = 2_147_483_647;

export class AutomationAiExecutor {
  readonly #options: AutomationAiExecutorOptions;
  readonly #clock: Clock;
  /** Overlapping passes on this timer are skipped, not stacked (F5's risk). */
  #inFlight = false;

  constructor(options: AutomationAiExecutorOptions) {
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * One pass: release gateway requests stuck past their deadline, give up on
   * runs that used every attempt, then execute what is due.
   */
  async sweep(): Promise<AiExecutionSweep> {
    if (this.#inFlight) return { stuckRequestsReleased: 0, abandoned: 0, executed: 0 };
    this.#inFlight = true;
    try {
      const policy = await this.#options.automationPolicy();
      const stuck = await this.#options.gateway.sweepStuckRequests(200);
      const abandoned = await this.#abandonExhausted(policy);
      const due = await this.#options.platform.automationRun.findMany({
        where: {
          status: { in: ['AWAITING_EXECUTION', 'EXECUTING'] },
          executionAvailableAt: { lte: this.#clock.now() },
          executionAttempts: { lt: policy.execution.aiMaxAttempts },
        },
        select: { id: true, workspaceId: true },
        orderBy: [{ executionAvailableAt: 'asc' }, { id: 'asc' }],
        take: policy.execution.aiExecutionBatchSize,
      });
      let executed = 0;
      for (const candidate of due) {
        try {
          const outcome = await this.executeRun(candidate.id, candidate.workspaceId, policy);
          if (outcome.kind === 'finished') executed += 1;
        } catch {
          // One run's failure never stops the pass. It keeps its lease, which
          // expires; the next claim retries it, and the gateway's key replays a
          // request that already ran rather than charging it again.
        }
      }
      return { stuckRequestsReleased: stuck.swept, abandoned, executed };
    } finally {
      this.#inFlight = false;
    }
  }

  /** Execute one run, start to finish. Exposed so a test can drive one run. */
  async executeRun(
    runId: string,
    workspaceId: string,
    policy?: AutomationPolicy,
  ): Promise<ExecutionOutcome> {
    const automationPolicy = policy ?? (await this.#options.automationPolicy());
    const leaseId = randomUUID();
    const claimed = await this.#claim(runId, workspaceId, leaseId, automationPolicy);
    if (!claimed) return { kind: 'not_claimed' };

    let prepared: Prepared | Concluded;
    try {
      prepared = await this.#prepare(runId, workspaceId, leaseId);
    } catch (error: unknown) {
      if (error instanceof LeaseLost) return { kind: 'lease_lost' };
      return this.#retryOrFail(runId, workspaceId, leaseId, automationPolicy);
    }
    if (prepared.kind === 'finished') return prepared;

    let result: AiGatewayResult;
    try {
      result = await this.#options.gateway.execute({
        workspaceId,
        userId: prepared.rule.createdByUserId,
        taskKey: DRAFT_IDEAS_TASK_KEY,
        planKey: prepared.planKey,
        idempotencyKey: draftIdeasRequestKey(runId),
        input: {
          kind: 'text',
          prompt: prepared.prompt,
          untrustedContext: [...prepared.untrustedContext],
        },
      });
    } catch (error: unknown) {
      return this.#onGatewayError(error, prepared, leaseId, automationPolicy);
    }

    if (result.status !== 'SUCCEEDED') {
      const deterministic =
        result.status === 'MODERATION_BLOCKED' ||
        (result.failureClass !== null && DETERMINISTIC_FAILURE_CLASSES.has(result.failureClass));
      // The gateway released the reservation: nothing was charged.
      return deterministic
        ? this.#finishReleasing(prepared, leaseId, 'FAILED', 'ai_unavailable')
        : this.#retryOrFail(runId, workspaceId, leaseId, automationPolicy, prepared.monthLabel);
    }

    // CHARGED from here on. An answer that cannot be used keeps the charge and
    // the cap slot (AC-11.9, owner decision 9).
    const ideas =
      result.output !== null && result.output.kind === 'text'
        ? parseDraftIdeas(result.output.text)
        : null;
    if (!ideas) return this.#finishKeeping(prepared, leaseId, 'FAILED', 'ai_output_unusable');
    return this.#save(prepared, leaseId, ideas, result.requestId);
  }

  // -------------------------------------------------------------------------
  // 1. Claim
  // -------------------------------------------------------------------------

  async #claim(
    runId: string,
    workspaceId: string,
    leaseId: string,
    policy: AutomationPolicy,
  ): Promise<boolean> {
    const now = this.#clock.now();
    const claimed = await this.#inWorkspace(workspaceId, (db) =>
      db.automationRun.updateMany({
        where: {
          id: runId,
          workspaceId,
          actionType: 'DRAFT_IDEAS',
          status: { in: ['AWAITING_EXECUTION', 'EXECUTING'] },
          executionAvailableAt: { lte: now },
          executionAttempts: { lt: policy.execution.aiMaxAttempts },
        },
        data: {
          status: 'EXECUTING',
          executionLeaseId: leaseId,
          executionAvailableAt: new Date(
            now.getTime() + policy.execution.claimLeaseSeconds * 1_000,
          ),
          executionAttempts: { increment: 1 },
        },
      }),
    );
    return claimed.count === 1;
  }

  // -------------------------------------------------------------------------
  // 2. Re-check, then claim a cap slot
  // -------------------------------------------------------------------------

  async #prepare(
    runId: string,
    workspaceId: string,
    leaseId: string,
  ): Promise<Prepared | Concluded> {
    const contentPolicy = await this.#options.contentPolicy();
    const routingRules = await this.#options.routingRules();
    return this.#inWorkspace(workspaceId, async (db) => {
      const run = await db.automationRun.findFirst({
        where: { id: runId, workspaceId, executionLeaseId: leaseId, status: 'EXECUTING' },
      });
      if (!run) throw new LeaseLost();
      const rule = await db.automationRule.findFirst({ where: { id: run.ruleId, workspaceId } });
      const action = findAction('DRAFT_IDEAS');
      if (!rule || !action) {
        return this.#concludeOrLose(db, run, null, leaseId, 'BLOCKED_BY_POLICY', 'rule_disabled');
      }

      // The creator, the rule — the same function an asks-first approval asks.
      const refusal = await ruleAuthorityRefusal(db, workspaceId, rule, action);
      if (refusal)
        return this.#concludeOrLose(db, run, rule, leaseId, refusal.status, refusal.code);

      const workspace = await db.workspace.findFirst({
        where: { id: workspaceId },
        select: { deletionScheduledFor: true, timezone: true, planKey: true },
      });
      if (!workspace || workspace.deletionScheduledFor) {
        return this.#concludeOrLose(
          db,
          run,
          rule,
          leaseId,
          'BLOCKED_BY_POLICY',
          WORKSPACE_PENDING_DELETION_FAILURE,
        );
      }

      const brand = await db.brand.findFirst({
        where: { id: run.brandId, workspaceId, deletedAt: null },
        select: { status: true, defaultLocale: true },
      });
      // Owner decision 8: only an ARCHIVED (or deleted) brand is skipped.
      if (!brand || brand.status === 'ARCHIVED') {
        return this.#concludeOrLose(db, run, rule, leaseId, 'SKIPPED', 'brand_not_active');
      }

      const entitlements = new EntitlementService({
        prisma: db as never,
        catalogueSource: new TenantCatalogueSource(db as never, this.#options.environment),
        environment: this.#options.environment,
      });
      if (!(await entitlements.can(workspaceId, AUTOMATION_AI_ACTIONS_FEATURE))) {
        return this.#concludeOrLose(db, run, rule, leaseId, 'BLOCKED_BY_POLICY', 'not_entitled');
      }

      // Owner decisions 6 and 7: approved facts only, through the shared layer;
      // Brand Brain off for writing, or nothing usable, skips.
      const grounding = await writingGroundingWithoutQuestion(
        db,
        {
          brandId: run.brandId,
          maxItems: contentPolicy.generation.maxContextItems,
          maxChars: contentPolicy.generation.maxContextChars,
        },
        this.#clock,
      );
      if (!grounding.enabled || grounding.insufficient) {
        return this.#concludeOrLose(db, run, rule, leaseId, 'SKIPPED', 'no_reviewed_facts');
      }

      // Room for three more drafts, under the content policy's per-brand limit.
      const live = await db.contentItem.count({
        where: { brandId: run.brandId, deletedAt: null, status: { notIn: ['ARCHIVED'] } },
      });
      if (live + 3 > contentPolicy.generation.maxDraftsPerBrand) {
        return this.#concludeOrLose(
          db,
          run,
          rule,
          leaseId,
          'BLOCKED_BY_POLICY',
          'draft_limit_reached',
        );
      }

      // Owner decision 13: never start a request that could not be replayed.
      const planKey = workspace.planKey;
      if (!ideasRouteKeepsOutput(routingRules, { planKey, workspaceId })) {
        return this.#concludeOrLose(db, run, rule, leaseId, 'FAILED', 'ai_unavailable');
      }

      const trigger = run.triggerType;
      if (!isDraftIdeasTrigger(trigger)) {
        return this.#concludeOrLose(db, run, rule, leaseId, 'FAILED', 'unknown_action');
      }
      const about = await this.#eventContext(db, run, trigger);

      // THE CAP, LAST: the month is decided once, kept on the run, and reused
      // by every later attempt and by the release.
      const monthLabel =
        capPeriodOf(run.actionResult) ??
        workspaceMonthLabel(workspace.timezone ?? 'UTC', this.#clock.now());
      const quota = createAutomationAiQuota({
        db,
        workspaceId,
        environment: this.#options.environment,
      });
      if ((await quota.claim(run.id, monthLabel)) === 'cap_reached') {
        return this.#concludeOrLose(db, run, rule, leaseId, 'SKIPPED', 'monthly_ai_cap_reached');
      }
      const kept = await db.automationRun.updateMany({
        where: { id: run.id, executionLeaseId: leaseId, status: 'EXECUTING' },
        data: { actionResult: { capPeriod: monthLabel } },
      });
      if (kept.count === 0) throw new LeaseLost();

      const locale = brand.defaultLocale === 'AR' ? 'AR' : 'EN';
      return {
        kind: 'prepared',
        rule,
        run,
        monthLabel,
        planKey,
        locale,
        prompt: draftIdeasPrompt({ trigger, locale }),
        untrustedContext: draftIdeasContext({
          brandFacts: grounding.contextText,
          about: about.lines,
        }),
        grounding,
        campaignId: about.campaignId,
      } satisfies Prepared;
    });
  }

  /** What the event was about, as data — never part of the instruction. */
  async #eventContext(
    db: TenantScopedClient,
    run: AutomationRun,
    trigger: DraftIdeasTrigger,
  ): Promise<{ readonly lines: readonly string[]; readonly campaignId: string | null }> {
    if (trigger === 'CAMPAIGN_STARTED' && run.triggerRefId) {
      const campaign = await db.campaign.findFirst({
        where: { id: run.triggerRefId, brandId: run.brandId, deletedAt: null },
        select: { id: true, name: true, objective: true, description: true },
      });
      if (!campaign) return { lines: [], campaignId: null };
      return {
        lines: [
          `Campaign: ${campaign.name}`,
          `Objective: ${campaign.objective}`,
          campaign.description ? `About: ${campaign.description}` : '',
        ],
        campaignId: campaign.id,
      };
    }
    if (trigger === 'POST_TOP_10_PERCENT' && run.triggerRefId) {
      const item = await db.contentItem.findFirst({
        where: { id: run.triggerRefId, brandId: run.brandId, deletedAt: null },
        select: { title: true },
      });
      return { lines: item ? [`Top post: ${item.title}`] : [], campaignId: null };
    }
    return { lines: [], campaignId: null };
  }

  // -------------------------------------------------------------------------
  // 3. The gateway's refusals
  // -------------------------------------------------------------------------

  async #onGatewayError(
    error: unknown,
    prepared: Prepared,
    leaseId: string,
    policy: AutomationPolicy,
  ): Promise<ExecutionOutcome> {
    const code = isAppError(error) ? error.code : null;
    if (code === 'INSUFFICIENT_CREDITS') {
      return this.#finishReleasing(prepared, leaseId, 'SKIPPED', 'ai_credits_insufficient');
    }
    if (code === 'FORBIDDEN' && isAppError(error)) {
      if (error.publicDetails['reason'] === 'WORKSPACE_PENDING_DELETION') {
        return this.#finishReleasing(
          prepared,
          leaseId,
          'BLOCKED_BY_POLICY',
          WORKSPACE_PENDING_DELETION_FAILURE,
        );
      }
    }
    // An earlier attempt's request is still marked running: wait until it
    // finishes or `sweepStuckRequests` times it out. The slot stays claimed.
    if (code === 'CONFLICT' || code === 'RATE_LIMITED') {
      return this.#retryOrFail(
        prepared.run.id,
        prepared.run.workspaceId,
        leaseId,
        policy,
        prepared.monthLabel,
      );
    }
    // Routing, pricing, a budget, a malformed request: nothing ran, nothing
    // was charged, and trying again will not change it.
    if (
      code === 'INTERNAL' ||
      code === 'QUOTA_EXCEEDED' ||
      code === 'VALIDATION_FAILED' ||
      code === 'FORBIDDEN'
    ) {
      return this.#finishReleasing(prepared, leaseId, 'FAILED', 'ai_unavailable');
    }
    return this.#retryOrFail(
      prepared.run.id,
      prepared.run.workspaceId,
      leaseId,
      policy,
      prepared.monthLabel,
    );
  }

  // -------------------------------------------------------------------------
  // 4. Save and finish
  // -------------------------------------------------------------------------

  async #save(
    prepared: Prepared,
    leaseId: string,
    ideas: readonly DraftIdea[],
    aiRequestId: string,
  ): Promise<ExecutionOutcome> {
    const contentPolicy = await this.#options.contentPolicy();
    const { run, rule } = prepared;
    try {
      return await this.#inWorkspace(run.workspaceId, async (db) => {
        const holder = await db.automationRun.findFirst({
          where: { id: run.id, executionLeaseId: leaseId, status: 'EXECUTING' },
          select: { id: true },
        });
        if (!holder) throw new LeaseLost();

        const expiresAt = resolveContentExpiry(
          contentPolicy,
          await readRetentionFacts(db, run.workspaceId),
          this.#clock,
        );
        const keys = ideas.map((_, index) => draftIdeaKey(run.id, index + 1));
        /*
         * IDEAS ONLY (owner decision 10). A DRAFT item with a title: no
         * variant, no slot, no approval, no publish job. `ContentItem` has no
         * free-text field outside a variant, so there is no angle line.
         * Keyed per run, so a replay after a crash creates nothing twice.
         */
        await db.contentItem.createMany({
          data: ideas.map((idea, index) => ({
            workspaceId: run.workspaceId,
            brandId: run.brandId,
            title: idea.title,
            primaryLocale: prepared.locale,
            status: 'DRAFT' as const,
            origin: 'AI_GENERATED' as const,
            createdByUserId: rule.createdByUserId,
            aiRequestId,
            campaignId: prepared.campaignId,
            ...(prepared.grounding.citations.length > 0
              ? { citations: prepared.grounding.citations as unknown as Prisma.InputJsonValue }
              : {}),
            idempotencyKey: keys[index] ?? null,
            expiresAt,
          })),
          skipDuplicates: true,
        });
        const items = await db.contentItem.findMany({
          where: {
            workspaceId: run.workspaceId,
            brandId: run.brandId,
            createdByUserId: rule.createdByUserId,
            idempotencyKey: { in: keys },
          },
          select: { id: true, idempotencyKey: true },
        });
        const ids = keys
          .map((key) => items.find((item) => item.idempotencyKey === key)?.id)
          .filter((id): id is string => id !== undefined);

        for (const id of ids) {
          await writeAuditEvent(db, run.workspaceId, {
            action: 'content.item.generated',
            actorType: 'AUTOMATION',
            resourceType: 'ContentItem',
            resourceId: id,
            brandId: run.brandId,
            traceId: run.correlationId,
            after: { origin: 'AI_GENERATED', automationRunId: run.id, aiRequestId },
          });
        }

        const finished = await this.#conclude(db, run, rule, leaseId, 'SUCCEEDED', null, {
          actionResult: { capPeriod: prepared.monthLabel, ideaItemIds: ids, aiRequestId },
          resourceType: 'ContentItem',
          resourceId: ids[0] ?? null,
        });
        // Lost the lease between the check and the finish: undo the save.
        if (finished.kind !== 'finished') throw new LeaseLost();
        return finished;
      });
    } catch (error: unknown) {
      if (error instanceof LeaseLost) return { kind: 'lease_lost' };
      throw error;
    }
  }

  /** End the run and give its cap slot back: nothing was charged. */
  async #finishReleasing(
    prepared: Prepared,
    leaseId: string,
    status: AutomationRun['status'],
    code: ActionOutcomeCode | string,
  ): Promise<ExecutionOutcome> {
    return this.#finishGuarded(
      prepared.run,
      prepared.rule,
      leaseId,
      status,
      code,
      prepared.monthLabel,
    );
  }

  /** End the run and keep its cap slot: the charge stands. */
  async #finishKeeping(
    prepared: Prepared,
    leaseId: string,
    status: AutomationRun['status'],
    code: ActionOutcomeCode,
  ): Promise<ExecutionOutcome> {
    return this.#finishGuarded(prepared.run, prepared.rule, leaseId, status, code, null);
  }

  async #finishGuarded(
    run: AutomationRun,
    rule: AutomationRule | null,
    leaseId: string,
    status: AutomationRun['status'],
    code: string,
    releaseLabel: string | null,
  ): Promise<ExecutionOutcome> {
    try {
      return await this.#inWorkspace(run.workspaceId, async (db) => {
        const finished = await this.#conclude(db, run, rule, leaseId, status, code);
        if (finished.kind !== 'finished') throw new LeaseLost();
        if (releaseLabel) await this.#release(db, run, releaseLabel);
        return finished;
      });
    } catch (error: unknown) {
      if (error instanceof LeaseLost) return { kind: 'lease_lost' };
      throw error;
    }
  }

  /**
   * Hand the run back to wait, or — on its last attempt — end it FAILED
   * `ai_unavailable` and give the slot back. Nothing was charged on this path.
   */
  async #retryOrFail(
    runId: string,
    workspaceId: string,
    leaseId: string,
    policy: AutomationPolicy,
    monthLabel?: string,
  ): Promise<ExecutionOutcome> {
    const now = this.#clock.now();
    try {
      return await this.#inWorkspace(workspaceId, async (db) => {
        const run = await db.automationRun.findFirst({
          where: { id: runId, executionLeaseId: leaseId, status: 'EXECUTING' },
        });
        if (!run) throw new LeaseLost();
        if (run.executionAttempts >= policy.execution.aiMaxAttempts) {
          const rule = await db.automationRule.findFirst({ where: { id: run.ruleId } });
          const finished = await this.#conclude(db, run, rule, leaseId, 'FAILED', 'ai_unavailable');
          if (finished.kind !== 'finished') throw new LeaseLost();
          const label = monthLabel ?? capPeriodOf(run.actionResult);
          if (label) await this.#release(db, run, label);
          return finished;
        }
        const backoffMs = run.executionAttempts * policy.execution.claimLeaseSeconds * 1_000;
        const waiting = await db.automationRun.updateMany({
          where: { id: runId, executionLeaseId: leaseId, status: 'EXECUTING' },
          data: {
            status: 'AWAITING_EXECUTION',
            executionLeaseId: null,
            executionAvailableAt: new Date(now.getTime() + backoffMs),
          },
        });
        if (waiting.count === 0) throw new LeaseLost();
        return { kind: 'retry_later' } as const;
      });
    } catch (error: unknown) {
      if (error instanceof LeaseLost) return { kind: 'lease_lost' };
      throw error;
    }
  }

  /**
   * RUNS THAT USED EVERY ATTEMPT AND ARE DUE AGAIN — a lease that expired on
   * the last attempt, so nobody will ever claim them. If the gateway did
   * charge for this run, the answer was never saved: the charge stands and so
   * does the slot. Otherwise nothing was charged and the slot is given back.
   */
  async #abandonExhausted(policy: AutomationPolicy): Promise<number> {
    const now = this.#clock.now();
    const exhausted = await this.#options.platform.automationRun.findMany({
      where: {
        status: { in: ['AWAITING_EXECUTION', 'EXECUTING'] },
        executionAvailableAt: { lte: now },
        executionAttempts: { gte: policy.execution.aiMaxAttempts },
      },
      select: { id: true, workspaceId: true },
      orderBy: [{ executionAvailableAt: 'asc' }, { id: 'asc' }],
      take: policy.execution.aiExecutionBatchSize,
    });
    let abandoned = 0;
    for (const candidate of exhausted) {
      const charged = await this.#options.platform.aiRequest.findFirst({
        where: {
          workspaceId: candidate.workspaceId,
          idempotencyKey: draftIdeasRequestKey(candidate.id),
          status: 'SUCCEEDED',
        },
        select: { id: true },
      });
      const done = await this.#inWorkspace(candidate.workspaceId, async (db) => {
        const run = await db.automationRun.findFirst({
          where: {
            id: candidate.id,
            status: { in: ['AWAITING_EXECUTION', 'EXECUTING'] },
            executionAvailableAt: { lte: now },
            executionAttempts: { gte: policy.execution.aiMaxAttempts },
          },
        });
        if (!run) return false;
        const rule = await db.automationRule.findFirst({ where: { id: run.ruleId } });
        const code = charged ? 'ai_output_unusable' : 'ai_unavailable';
        const ended = await this.#conclude(db, run, rule, run.executionLeaseId, 'FAILED', code);
        if (ended.kind !== 'finished') return false;
        const label = capPeriodOf(run.actionResult);
        if (!charged && label) await this.#release(db, run, label);
        return true;
      });
      if (done) abandoned += 1;
    }
    return abandoned;
  }

  // -------------------------------------------------------------------------
  // Shared
  // -------------------------------------------------------------------------

  /**
   * End a run, guarded by its lease (or, for an abandoned run, by its exact
   * waiting state), and record it on the rule exactly as the engine's own
   * `#finish` does — SKIPPED is not audited, everything else is.
   */
  async #conclude(
    db: TenantScopedClient,
    run: AutomationRun,
    rule: AutomationRule | null,
    leaseId: string | null,
    status: AutomationRun['status'],
    failureCode: string | null,
    extra: {
      readonly actionResult?: Prisma.InputJsonValue;
      readonly resourceType?: string;
      readonly resourceId?: string | null;
    } = {},
  ): Promise<Concluded | { readonly kind: 'lease_lost' }> {
    const now = this.#clock.now();
    const ended = await db.automationRun.updateMany({
      where: {
        id: run.id,
        workspaceId: run.workspaceId,
        status: { in: ['AWAITING_EXECUTION', 'EXECUTING'] },
        executionLeaseId: leaseId,
      },
      data: {
        status,
        failureCode,
        conditionsHeld: true,
        executionLeaseId: null,
        executionAvailableAt: null,
        finishedAt: now,
        durationMs: Math.min(INT_MAX, Math.max(0, now.getTime() - run.startedAt.getTime())),
        ...(extra.actionResult === undefined ? {} : { actionResult: extra.actionResult }),
        ...(extra.resourceType ? { resourceType: extra.resourceType } : {}),
        ...(extra.resourceId ? { resourceId: extra.resourceId } : {}),
      },
    });
    if (ended.count === 0) return { kind: 'lease_lost' };

    if (rule) {
      await db.automationRule.updateMany({
        where: { id: rule.id, workspaceId: run.workspaceId },
        data: { lastRunAt: now, lastRunStatus: status, runCount: { increment: 1 } },
      });
    }
    if (status !== 'SKIPPED') {
      await writeAuditEvent(db, run.workspaceId, {
        action: 'automation.run',
        actorType: 'AUTOMATION',
        resourceType: 'AutomationRun',
        resourceId: run.id,
        brandId: run.brandId,
        traceId: run.correlationId,
        outcome: status === 'SUCCEEDED' ? 'SUCCESS' : status === 'FAILED' ? 'ERROR' : 'DENIED',
        severity: status === 'BLOCKED_BY_AUTHORIZATION' ? 'WARNING' : 'INFO',
        ...(failureCode ? { reason: failureCode } : {}),
        after: { ruleId: run.ruleId, status, actionType: run.actionType },
      });
    }
    return { kind: 'finished', status, code: failureCode };
  }

  /** `#conclude`, where a lost lease abandons the whole transaction. */
  async #concludeOrLose(
    db: TenantScopedClient,
    run: AutomationRun,
    rule: AutomationRule | null,
    leaseId: string,
    status: AutomationRun['status'],
    failureCode: string,
  ): Promise<Concluded> {
    const finished = await this.#conclude(db, run, rule, leaseId, status, failureCode);
    if (finished.kind !== 'finished') throw new LeaseLost();
    return finished;
  }

  async #release(db: TenantScopedClient, run: AutomationRun, monthLabel: string): Promise<void> {
    await createAutomationAiQuota({
      db,
      workspaceId: run.workspaceId,
      environment: this.#options.environment,
    }).release(run.id, monthLabel);
  }

  #inWorkspace<T>(workspaceId: string, fn: (db: TenantScopedClient) => Promise<T>): Promise<T> {
    return withWorkspace(workspaceId, fn, { prisma: this.#options.app });
  }
}

/** The month a run's cap slot was claimed in, if it was. */
function capPeriodOf(actionResult: unknown): string | null {
  if (actionResult === null || typeof actionResult !== 'object') return null;
  const label = (actionResult as Record<string, unknown>)['capPeriod'];
  return typeof label === 'string' ? label : null;
}
