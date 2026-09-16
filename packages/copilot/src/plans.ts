import { randomUUID } from 'node:crypto';
import {
  Prisma,
  writeAuditEvent,
  type CopilotActionClass,
  type CopilotActionPlan,
  type CopilotToolCall,
  type TenantScopedClient,
} from '@brandspace/database';
import { AppError, nullableBrandIdScopeFilter, systemClock, type Clock } from '@brandspace/shared';
import {
  confirmationRejected,
  copilotPlanNotFound,
  planAlreadyExecuted,
  planNotConfirmable,
  planNotConfirmed,
  planTooLarge,
  tooManyOpenPlans,
  unknownTool,
} from './errors';
import { resolveLiveAuthorization, holds, type LiveAuthorization } from './authorization';
import { stepBrandPermitted } from './brand-binding';
import {
  issueConfirmationToken,
  hashConfirmationToken,
  planHashOf,
  toolCallIdempotencyKey,
  type CanonicalStep,
} from './plan-hash';
import type { CopilotPolicy } from './policy';
import {
  buildPreview,
  TOOL_EXECUTORS,
  type ExecutorContext,
  type ExecutorResult,
} from './executors';
import { findTool, highestActionClass, requiresConfirmation, type ToolPreviewLine } from './tools';

/**
 * ACTION PLANS: propose, preview, confirm, execute.
 *
 * THE CONTRACT THIS FILE KEEPS, stated as the four things that must be true no
 * matter what a customer types or a model proposes:
 *
 *  1. A PREVIEW IS NEVER AUTHORIZATION. Permissions, BrandScope and entitlements
 *     are resolved from the LIVE membership at EXECUTION, by
 *     `resolveLiveAuthorization`, not carried forward from when the plan was
 *     built. A person whose role changed between the two is refused.
 *
 *  2. A CONFIRMATION IS SINGLE-USE AND BOUND TO ONE PLAN HASH. It is consumed by
 *     a conditional UPDATE — not a read-then-write — so a replay affects zero
 *     rows; and the caller must present the hash they were SHOWN, so a
 *     confirmation issued for an older version of the plan no longer matches.
 *     A database trigger refuses to let a confirmed plan's steps change at all.
 *
 *  3. AN EXTERNAL OR DESTRUCTIVE STEP CANNOT RUN WITHOUT ONE. The plan's
 *     `highestActionClass` is computed from the TOOLS, a CHECK constraint makes
 *     a plan that carries such a step and does not require confirmation
 *     unrepresentable, and execution refuses a plan that is not CONFIRMED.
 *
 *  4. A TOOL RUNS AT MOST ONCE. Its idempotency key is derived from the plan, the
 *     ordinal, the tool and the arguments, and is UNIQUE per workspace — so a
 *     retried execution finds the completed call rather than running the tool a
 *     second time.
 */

/**
 * Where a REFUSAL gets recorded.
 *
 * IT CANNOT BE THIS SERVICE'S OWN TRANSACTION, and that is the whole reason this
 * hook exists — the same reasoning `ApprovalOptions.denialSink` carries, reached
 * by the same door. Every caller reaches this service inside `withWorkspace`,
 * which is ONE transaction; a refusal throws, the transaction rolls back, and an
 * audit row written just before the throw rolls back with it. A refused
 * confirmation that leaves no trace is precisely the event a detection signal
 * exists for (docs/SECURITY.md §7): a replayed token is the shape an attempted
 * replay takes, and repeated refusals are how it becomes visible.
 *
 * The caller supplies the sink, because the caller is what owns connections.
 * When it is absent the service still writes on its own client — correct for a
 * caller that is not inside a transaction, and harmlessly discarded for one that
 * is.
 */
export interface CopilotDenialSink {
  (event: {
    action: 'copilot.confirmation_refused' | 'copilot.plan_refused';
    planId: string;
    userId: string;
    brandId: string | null;
    reason: string;
  }): Promise<void>;
}

export interface PlanServiceOptions {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
  readonly policy: CopilotPolicy;
  readonly clock?: Clock;
  readonly denialSink?: CopilotDenialSink | undefined;
}

/** One proposed step, as the orchestrator produces it. */
export interface ProposedStep {
  readonly toolKey: string;
  readonly arguments: Record<string, unknown>;
}

/** What is stored on the plan, and what the UI previews. */
export interface StoredStep {
  readonly ordinal: number;
  readonly toolKey: string;
  readonly actionClass: CopilotActionClass;
  readonly messageKey: string;
  readonly arguments: Record<string, unknown>;
  readonly preview: readonly ToolPreviewLine[];
  readonly spendsCredits: boolean;
  readonly undoable: boolean;
}

export interface CreatedPlan {
  readonly plan: CopilotActionPlan;
  readonly steps: readonly StoredStep[];
  /**
   * The raw confirmation token. RETURNED EXACTLY ONCE and never stored — only
   * its hash is written down, so a database read cannot be replayed as a
   * confirmation (the D-141 discipline).
   */
  readonly confirmationToken: string | null;
}

export interface ExecutionResult {
  readonly plan: CopilotActionPlan;
  readonly toolCalls: readonly CopilotToolCall[];
  readonly creditsChargedMilli: bigint;
}

export class CopilotPlanService {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;
  readonly #policy: CopilotPolicy;
  readonly #clock: Clock;
  readonly #denialSink: CopilotDenialSink | undefined;

  constructor(options: PlanServiceOptions) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#policy = options.policy;
    this.#clock = options.clock ?? systemClock;
    this.#denialSink = options.denialSink;
  }

  /**
   * Record a refusal somewhere it will SURVIVE the throw that follows it.
   *
   * A REFUSAL THAT CANNOT BE RECORDED IS STILL A REFUSAL. The sink's own failure
   * is swallowed deliberately: a customer must not receive a 500 because the
   * audit connection was unavailable, and turning a correct denial into a server
   * error would be the worse of the two outcomes.
   */
  async #auditRefusal(event: {
    action: 'copilot.confirmation_refused' | 'copilot.plan_refused';
    planId: string;
    userId: string;
    brandId: string | null;
    reason: string;
    actorType: 'USER' | 'SYSTEM';
  }): Promise<void> {
    if (this.#denialSink) {
      await this.#denialSink({
        action: event.action,
        planId: event.planId,
        userId: event.userId,
        brandId: event.brandId,
        reason: event.reason,
      }).catch(() => undefined);
      return;
    }
    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: event.action,
      actorType: event.actorType,
      actorId: event.userId,
      resourceType: 'CopilotActionPlan',
      resourceId: event.planId,
      ...(event.brandId ? { brandId: event.brandId } : {}),
      severity: 'WARNING',
      outcome: 'DENIED',
      reason: event.reason,
    });
  }

  /**
   * Build a plan from proposed steps, and issue the confirmation it needs.
   *
   * THE STEPS ARE PARSED, NOT TRUSTED. Every argument goes through the tool's own
   * Zod schema here, at the boundary, so a model that invented a field or a
   * caller that forwarded one cannot get it as far as a domain service.
   *
   * A STEP THE CALLER MAY NOT TAKE IS REFUSED AT BUILD TIME TOO. That is not the
   * control — execution re-checks against the live membership, which is — but
   * building a plan somebody cannot run would be a preview that exists only to
   * fail, and the model would keep proposing it.
   */
  async createPlan(input: {
    sessionId: string;
    brandId: string | null;
    authorization: LiveAuthorization;
    steps: readonly ProposedStep[];
    summary: { ar: string; en: string };
    estimatedCreditsMilli: bigint;
    idempotencyKey?: string | undefined;
    /** When the plan record may be purged (D-116/D-117). */
    expiresAt: Date | null;
  }): Promise<CreatedPlan> {
    if (input.steps.length > this.#policy.plans.maxSteps) {
      throw planTooLarge(this.#policy.plans.maxSteps);
    }
    if (input.idempotencyKey) {
      /*
       * A REPLAY LOOKUP IS NOT AN AUTHORIZATION CHECK, AND THIS ONE USED TO BE
       * BOTH (P7-R2).
       *
       * It matched on `workspaceId + idempotencyKey` alone. The key is chosen by
       * the CLIENT, so any member of the workspace who guessed or observed
       * another member's key was handed that member's plan — its summary, its
       * steps, its previewed ids — by a lookup that never asked whose plan it
       * was. A user-controlled idempotency key is a de-duplication token, never a
       * credential.
       *
       * FOUR MORE PREDICATES, ALL IN THE WHERE: the person, the session, the
       * exact brand this plan is for, and — separately — that the brand is still
       * inside the caller's LIVE scope. The last is not redundant with the
       * fourth: `brandId` pins which plan, `nullableBrandIdScopeFilter` decides
       * whether this caller may still be given it at all, so a narrowed scope
       * stops replaying a plan it would now refuse to create.
       *
       * A MISS FALLS THROUGH TO CREATION rather than erroring, which is the same
       * behaviour a genuinely new key gets — and creation is authorized on its
       * own terms below.
       *
       * AND THE DATABASE NOW AGREES WITH THIS LOOKUP (R2-A). The unique index
       * used to be `(workspaceId, idempotencyKey)` — the very scope this WHERE
       * had just stopped trusting. So the narrowing fixed the leak and left a
       * liveness bug behind it: a second member of the workspace who reached for
       * the same key was correctly NOT given the first member's plan, fell
       * through to creation, and had their own perfectly legitimate plan killed
       * by a unique violation on a key they had every right to choose. The index
       * is `(workspaceId, sessionId, idempotencyKey)` now — the same shape
       * `copilot_message` already used, and the identity this lookup actually
       * matches on, since a session pins both the person and the brand.
       */
      const existing = await this.#db.copilotActionPlan.findFirst({
        where: {
          workspaceId: this.#workspaceId,
          idempotencyKey: input.idempotencyKey,
          userId: input.authorization.userId,
          sessionId: input.sessionId,
          AND: [
            { brandId: input.brandId },
            nullableBrandIdScopeFilter(input.authorization.brandScope),
          ],
        },
      });
      if (existing) {
        const rotated = await this.#reissueConfirmation(existing);
        return {
          plan: rotated.plan,
          steps: (rotated.plan.steps as unknown as StoredStep[]) ?? [],
          confirmationToken: rotated.token,
        };
      }
    }

    const open = await this.#db.copilotActionPlan.count({
      where: {
        workspaceId: this.#workspaceId,
        userId: input.authorization.userId,
        status: 'AWAITING_CONFIRMATION',
        confirmationExpiresAt: { gt: this.#clock.now() },
      },
    });
    if (open >= this.#policy.plans.maxOpenPlansPerUser) {
      throw tooManyOpenPlans(this.#policy.plans.maxOpenPlansPerUser);
    }

    const stored: StoredStep[] = [];
    const canonical: CanonicalStep[] = [];

    for (const [index, proposed] of input.steps.entries()) {
      const tool = findTool(proposed.toolKey);
      if (!tool) throw unknownTool();

      // PARSE, DO NOT VALIDATE. The parsed value is what is stored and what is
      // hashed, so the plan records exactly what would run.
      const parsed = tool.input.parse(proposed.arguments) as Record<string, unknown>;

      if (!holds(input.authorization, tool.permission)) throw copilotPlanNotFound();
      if (tool.brandScope === 'required') {
        const brandId = String(parsed['brandId'] ?? '');
        /*
         * THE SESSION'S BRAND, NOT MERELY ONE OF THE CALLER'S (A2).
         *
         * A 404-shaped refusal, exactly as `assertBrandInScope` produces: an
         * out-of-scope brand, another of the caller's OWN brands and a
         * fabricated one must all be indistinguishable here, and a model can be
         * talked into naming any of the three.
         *
         * AND IT IS REFUSED BEFORE THE PREVIEW BELOW RUNS. `buildPreview` reads
         * the named rows; running it first would answer "does this campaign
         * exist?" for a brand this conversation is not about, and would do it
         * before anything had decided the step was permitted at all.
         */
        if (
          !stepBrandPermitted({
            sessionBrandId: input.brandId,
            stepBrandId: brandId,
            brandScope: input.authorization.brandScope,
          })
        ) {
          throw copilotPlanNotFound();
        }
      }

      const ordinal = index + 1;
      stored.push({
        ordinal,
        toolKey: tool.key,
        actionClass: tool.actionClass,
        messageKey: tool.messageKey,
        arguments: parsed,
        preview: await buildPreview(
          {
            db: this.#db,
            workspaceId: this.#workspaceId,
            authorization: input.authorization,
          },
          tool.key,
          parsed,
        ),
        spendsCredits: tool.spendsCredits,
        undoable: tool.undoable,
      });
      canonical.push({
        ordinal,
        toolKey: tool.key,
        actionClass: tool.actionClass,
        arguments: parsed,
      });
    }

    const actionClass = highestActionClass(stored.map((step) => step.toolKey));
    const needsConfirmation = requiresConfirmation(actionClass);
    const planHash = planHashOf(canonical);
    const now = this.#clock.now();

    const confirmation = needsConfirmation ? issueConfirmationToken() : null;

    // The next version within this session. A revision is a NEW ROW rather than
    // an edit, so the thing a customer confirmed stays readable afterwards.
    const latest = await this.#db.copilotActionPlan.findFirst({
      where: { workspaceId: this.#workspaceId, sessionId: input.sessionId },
      orderBy: { planVersion: 'desc' },
      select: { planVersion: true },
    });

    const plan = await this.#db.copilotActionPlan.create({
      data: {
        workspaceId: this.#workspaceId,
        sessionId: input.sessionId,
        brandId: input.brandId,
        userId: input.authorization.userId,
        status: needsConfirmation ? 'AWAITING_CONFIRMATION' : 'CONFIRMED',
        planVersion: (latest?.planVersion ?? 0) + 1,
        planHash,
        summary: input.summary as Prisma.InputJsonValue,
        steps: stored as unknown as Prisma.InputJsonValue,
        highestActionClass: actionClass,
        requiresConfirmation: needsConfirmation,
        estimatedCreditsMilli: input.estimatedCreditsMilli,
        ...(confirmation
          ? {
              confirmationTokenHash: confirmation.hash,
              confirmationExpiresAt: new Date(
                now.getTime() + this.#policy.plans.confirmationTtlSeconds * 1_000,
              ),
            }
          : {}),
        undoStatus: stored.some((step) => step.undoable) ? 'AVAILABLE' : 'NOT_APPLICABLE',
        correlationId: randomUUID(),
        idempotencyKey: input.idempotencyKey ?? null,
        expiresAt: input.expiresAt,
      },
    });

    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'copilot.plan_created',
      actorType: 'USER',
      actorId: input.authorization.userId,
      resourceType: 'CopilotActionPlan',
      resourceId: plan.id,
      ...(input.brandId ? { brandId: input.brandId } : {}),
      traceId: plan.correlationId,
      // TOOL KEYS AND COUNTS, never arguments — which carry a customer's brief.
      after: {
        steps: stored.length,
        tools: stored.map((step) => step.toolKey).join(','),
        highestActionClass: actionClass,
        requiresConfirmation: needsConfirmation,
        planHash,
      },
    });

    return { plan, steps: stored, confirmationToken: confirmation?.token ?? null };
  }

  /**
   * Consume a confirmation.
   *
   * ONE CONDITIONAL UPDATE, AND EVERY GUARD IS IN ITS `WHERE`:
   *
   *   - the plan belongs to this workspace and to this user,
   *   - it is still AWAITING_CONFIRMATION,
   *   - it has not already been confirmed (`confirmedAt IS NULL`) — THE REPLAY
   *     GUARD, and the reason this is an UPDATE rather than a read-then-write,
   *   - the token hash matches,
   *   - the window has not closed,
   *   - AND the plan hash is the one the customer was shown.
   *
   * Zero rows affected is a refusal, and all six reasons produce the SAME
   * refusal: telling a caller which half they got right is exactly the feedback
   * an attacker needs and exactly the feedback a legitimate user does not.
   */
  /**
   * A LOST RESPONSE MUST NOT COST THE CUSTOMER THEIR PLAN (R2-B).
   *
   * THE SHAPE OF THE BUG. `/v1/copilot/turn` succeeds, writes an
   * AWAITING_CONFIRMATION plan and returns the one and only confirmation token
   * — and the response never arrives. The client retries with the same
   * idempotency key, which is precisely what an idempotency key is for, and the
   * replay branch handed back the plan with `confirmationToken: null`. The plan
   * was real, it was the customer's, it was waiting for them, and there was no
   * longer any credential in the world that could confirm it. It sat there until
   * it expired.
   *
   * WHY NOT SIMPLY STORE THE TOKEN. Because the rule that makes the confirmation
   * worth anything is that a database read cannot be replayed as a confirmation
   * (D-141). Only the digest is written down, and that does not change here.
   *
   * SO THE RETRY GETS A NEW TOKEN, AND THE OLD ONE DIES. One conditional UPDATE
   * does both: the new digest and a fresh window are written only if the row is
   * still awaiting confirmation, still unconfirmed, still unexpired AND still
   * carrying the EXACT digest this caller just read. That last predicate is what
   * makes concurrent retries safe — two of them race, one wins, and the loser
   * finds the digest already moved and is handed NO token rather than a second
   * live one. At every instant at most one credential can confirm this plan.
   *
   * WHAT IS NEVER REISSUED: a plan that is CONFIRMED, EXECUTING, COMPLETED,
   * FAILED or CANCELLED, and a plan whose window has already closed. A retry of
   * any of those returns the plan and no token, because reissuing there would
   * resurrect a decision the customer or the clock has already made.
   *
   * THE PLAN HASH IS UNTOUCHED, so the confirmation stays bound to the steps the
   * customer was shown, and `confirm` still demands it.
   */
  async #reissueConfirmation(
    plan: CopilotActionPlan,
  ): Promise<{ plan: CopilotActionPlan; token: string | null }> {
    const now = this.#clock.now();
    if (
      !plan.requiresConfirmation ||
      plan.status !== 'AWAITING_CONFIRMATION' ||
      plan.confirmedAt !== null ||
      plan.confirmationTokenHash === null ||
      plan.confirmationExpiresAt === null ||
      plan.confirmationExpiresAt.getTime() <= now.getTime()
    ) {
      return { plan, token: null };
    }

    const replacement = issueConfirmationToken();
    const expiresAt = new Date(now.getTime() + this.#policy.plans.confirmationTtlSeconds * 1_000);

    const affected = await this.#db.copilotActionPlan.updateMany({
      where: {
        id: plan.id,
        workspaceId: this.#workspaceId,
        userId: plan.userId,
        status: 'AWAITING_CONFIRMATION',
        confirmedAt: null,
        // THE COMPARE-AND-SWAP. Whoever still sees the digest they read is the
        // one allowed to replace it.
        confirmationTokenHash: plan.confirmationTokenHash,
        confirmationExpiresAt: { gt: now },
      },
      data: {
        confirmationTokenHash: replacement.hash,
        confirmationExpiresAt: expiresAt,
      },
    });

    if (affected.count === 0) {
      // A concurrent retry rotated it first. The plan is returned as it now
      // stands, and this caller gets no credential — the other one holds it.
      const current = await this.#requirePlan(plan.id, plan.userId);
      return { plan: current, token: null };
    }

    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'copilot.confirmation_reissued',
      actorType: 'USER',
      actorId: plan.userId,
      resourceType: 'CopilotActionPlan',
      resourceId: plan.id,
      ...(plan.brandId ? { brandId: plan.brandId } : {}),
      traceId: plan.correlationId,
      // THE FACT, NOT THE SECRET. That a token was replaced is the auditable
      // event; neither the old nor the new one appears anywhere.
      after: { planHash: plan.planHash, reason: 'idempotent_retry' },
    });

    return { plan: await this.#requirePlan(plan.id, plan.userId), token: replacement.token };
  }

  async confirm(input: {
    planId: string;
    /** The hash the customer was SHOWN. A stale one no longer matches. */
    planHash: string;
    token: string;
    userId: string;
  }): Promise<CopilotActionPlan> {
    const now = this.#clock.now();
    const tokenHash = hashConfirmationToken(input.token);

    const affected = await this.#db.copilotActionPlan.updateMany({
      where: {
        id: input.planId,
        workspaceId: this.#workspaceId,
        userId: input.userId,
        status: 'AWAITING_CONFIRMATION',
        confirmedAt: null,
        confirmationTokenHash: tokenHash,
        confirmationExpiresAt: { gt: now },
        planHash: input.planHash,
      },
      data: {
        status: 'CONFIRMED',
        confirmedAt: now,
        confirmedByUserId: input.userId,
      },
    });

    if (affected.count === 0) {
      /*
       * A REFUSED CONFIRMATION IS AUDITED. Repeated refusals are a detection
       * signal (docs/SECURITY.md §7), and a replayed token is precisely the shape
       * an attempted replay takes. The plan id is recorded; the token is not, for
       * the obvious reason.
       */
      await this.#auditRefusal({
        action: 'copilot.confirmation_refused',
        planId: input.planId,
        userId: input.userId,
        brandId: null,
        reason: 'confirmation_not_valid',
        actorType: 'USER',
      });
      throw confirmationRejected();
    }

    const plan = await this.#requirePlan(input.planId, input.userId);
    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'copilot.plan_confirmed',
      actorType: 'USER',
      actorId: input.userId,
      resourceType: 'CopilotActionPlan',
      resourceId: plan.id,
      ...(plan.brandId ? { brandId: plan.brandId } : {}),
      traceId: plan.correlationId,
      after: { planHash: plan.planHash, highestActionClass: plan.highestActionClass },
    });
    return plan;
  }

  /** Cancel a plan the customer rejected, or that a revision superseded. */
  async cancel(input: { planId: string; userId: string; reason: string }): Promise<void> {
    const affected = await this.#db.copilotActionPlan.updateMany({
      where: {
        id: input.planId,
        workspaceId: this.#workspaceId,
        userId: input.userId,
        status: { in: ['DRAFT', 'AWAITING_CONFIRMATION'] },
      },
      data: {
        status: 'CANCELLED',
        // THE TOKEN IS CLEARED, so a confirmation issued for a cancelled plan
        // cannot be presented afterwards. Without this a customer who said "no"
        // would still be holding a live credential for the plan they rejected.
        confirmationTokenHash: null,
        confirmationExpiresAt: null,
        undoStatus: 'NOT_APPLICABLE',
      },
    });
    if (affected.count === 0) throw planNotConfirmable();

    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'copilot.plan_cancelled',
      actorType: 'USER',
      actorId: input.userId,
      resourceType: 'CopilotActionPlan',
      resourceId: input.planId,
      reason: input.reason,
    });
  }

  /**
   * Execute a confirmed plan, step by step, in order.
   *
   * WHAT HAPPENS BEFORE EVERY SINGLE STEP, and why each one is here and not at
   * plan time:
   *
   *   - THE LIVE MEMBERSHIP IS RE-READ. A role change, a narrowed BrandScope or a
   *     removal between the preview and now takes effect immediately.
   *   - THE PERMISSION IS RE-CHECKED against that live authorization.
   *   - THE BRAND SCOPE IS RE-CHECKED against it too.
   *   - THE ENTITLEMENT GATE IS ASKED, so a plan that was affordable when it was
   *     shown is refused if the plan changed underneath it.
   *
   * A REFUSED STEP STOPS THE PLAN. Later steps are recorded as SKIPPED rather
   * than attempted, because a plan is a sequence: placing a draft on the calendar
   * after failing to create it would be acting on a state that does not exist.
   */
  async execute(input: {
    planId: string;
    userId: string;
    /** Assembles the collaborators a tool may reach. Called once per execution. */
    context: (authorization: LiveAuthorization, plan: CopilotActionPlan) => ExecutorContext;
    /** Asked before every step that spends credits or changes state. */
    entitlements?: EntitlementGate | undefined;
  }): Promise<ExecutionResult> {
    const plan = await this.#requirePlan(input.planId, input.userId);

    if (plan.status === 'COMPLETED' || plan.status === 'EXECUTING') throw planAlreadyExecuted();
    if (plan.requiresConfirmation && plan.status !== 'CONFIRMED') throw planNotConfirmed();
    if (!plan.requiresConfirmation && plan.status !== 'CONFIRMED') throw planNotConfirmed();

    /*
     * THE LIVE AUTHORIZATION, RESOLVED NOW. The whole point of this line is that
     * it is not the one the plan was built with.
     */
    const authorization = await resolveLiveAuthorization(this.#db, this.#workspaceId, input.userId);
    if (!authorization) {
      /*
       * THE REFUSAL IS WHAT MATTERS, AND IT IS WHAT SURVIVES. `#failPlan` marks
       * the plan FAILED, but the throw on the next line rolls this transaction
       * back and takes that mark with it — so the status write here is
       * best-effort and is NOT the control. The control is that this check runs
       * on EVERY execution, so a plan whose author lost their membership is
       * refused every time it is tried, whatever its stored status says; and the
       * audit record goes through `denialSink`, on a connection this rollback
       * cannot reach.
       */
      await this.#failPlan(plan, 'membership_revoked');
      throw copilotPlanNotFound();
    }

    const claimed = await this.#db.copilotActionPlan.updateMany({
      // A CONDITIONAL CLAIM, so two concurrent executions of one plan cannot both
      // proceed: the second finds the status already EXECUTING and affects zero
      // rows. Pressing "run" twice is an ordinary thing for a person to do.
      where: { id: plan.id, workspaceId: this.#workspaceId, status: 'CONFIRMED' },
      data: { status: 'EXECUTING', startedAt: this.#clock.now() },
    });
    if (claimed.count === 0) throw planAlreadyExecuted();

    const steps = (plan.steps as unknown as StoredStep[]) ?? [];
    const context = input.context(authorization, plan);
    const toolCalls: CopilotToolCall[] = [];
    let creditsChargedMilli = 0n;
    let failed = false;

    for (const step of steps) {
      if (failed) {
        toolCalls.push(await this.#recordCall(plan, step, { status: 'SKIPPED' }));
        continue;
      }

      const tool = findTool(step.toolKey);
      if (!tool) {
        failed = true;
        toolCalls.push(
          await this.#recordCall(plan, step, { status: 'FAILED', failureCode: 'unknown_tool' }),
        );
        continue;
      }

      // (1) THE PERMISSION, AGAINST THE LIVE MEMBERSHIP.
      if (!holds(authorization, tool.permission)) {
        failed = true;
        toolCalls.push(
          await this.#recordCall(plan, step, {
            status: 'REFUSED',
            failureCode: 'permission_denied',
          }),
        );
        continue;
      }

      /*
       * (2) THE BRAND: THE PLAN'S OWN, AND STILL INSIDE THE LIVE MEMBERSHIP.
       *
       * ASKED AGAIN HERE, and not because the build-time check is unreliable. It
       * is asked again for the same reason the permission is: the two checks
       * answer the question at two different moments, and the only one that can
       * govern what actually happens is the one nearest the action. A plan built
       * before an administrator narrowed this person's BrandScope is refused
       * here, by `stepBrandPermitted`'s scope half; a step whose stored
       * arguments name a brand other than the plan's — which nothing can produce
       * today and which a future writer of these rows could — is refused by its
       * equality half.
       */
      if (tool.brandScope === 'required') {
        const brandId = String(step.arguments['brandId'] ?? '');
        if (
          !stepBrandPermitted({
            sessionBrandId: plan.brandId,
            stepBrandId: brandId,
            brandScope: authorization.brandScope,
          })
        ) {
          failed = true;
          toolCalls.push(
            await this.#recordCall(plan, step, {
              status: 'REFUSED',
              failureCode: 'brand_out_of_scope',
            }),
          );
          continue;
        }
      }

      // (3) THE ENTITLEMENT, for anything that spends or changes.
      if (input.entitlements && tool.entitlementKey !== undefined) {
        const allowed = await input.entitlements.allows(tool.entitlementKey);
        if (!allowed) {
          failed = true;
          toolCalls.push(
            await this.#recordCall(plan, step, {
              status: 'REFUSED',
              failureCode: 'entitlement_denied',
            }),
          );
          continue;
        }
      }

      const idempotencyKey = toolCallIdempotencyKey({
        planId: plan.id,
        ordinal: step.ordinal,
        toolKey: step.toolKey,
        arguments: step.arguments,
      });

      /*
       * A COMPLETED CALL WITH THIS KEY IS REPLAYED, NEVER RE-RUN. The duplicate
       * execution guard, and the reason the key is DERIVED rather than minted per
       * attempt: a fresh key would de-duplicate nothing.
       */
      const existing = await this.#db.copilotToolCall.findFirst({
        where: { workspaceId: this.#workspaceId, idempotencyKey },
      });
      if (existing && existing.status === 'SUCCEEDED') {
        toolCalls.push(existing);
        continue;
      }

      const startedAt = this.#clock.now();
      const call = await this.#recordCall(plan, step, {
        status: 'RUNNING',
        idempotencyKey,
        startedAt,
      });

      try {
        const executor = TOOL_EXECUTORS[step.toolKey];
        /* c8 ignore next -- every registry key has an executor; asserted by a test. */
        if (!executor) throw unknownTool();

        const result: ExecutorResult = await executor(
          { ...context, idempotencyKey },
          step.arguments,
        );
        creditsChargedMilli += result.creditsChargedMilli ?? 0n;

        const updated = await this.#db.copilotToolCall.update({
          where: { id: call.id },
          data: {
            status: 'SUCCEEDED',
            resultJson: result.result,
            resourceType: result.resourceType ?? null,
            resourceId: result.resourceId ?? null,
            resourceVersionBefore: result.resourceVersionBefore ?? null,
            resourceVersionAfter: result.resourceVersionAfter ?? null,
            compensation: result.compensation ?? Prisma.DbNull,
            aiRequestId: result.aiRequestId ?? null,
            finishedAt: this.#clock.now(),
            durationMs: Math.max(0, this.#clock.now().getTime() - startedAt.getTime()),
          },
        });
        toolCalls.push(updated);

        await writeAuditEvent(this.#db, this.#workspaceId, {
          action: `copilot.tool.${step.toolKey}`,
          actorType: 'COPILOT',
          actorId: authorization.userId,
          resourceType: result.resourceType ?? 'CopilotToolCall',
          resourceId: result.resourceId ?? updated.id,
          ...(plan.brandId ? { brandId: plan.brandId } : {}),
          traceId: plan.correlationId,
          after: { planId: plan.id, ordinal: step.ordinal, actionClass: step.actionClass },
        });
      } catch (error: unknown) {
        failed = true;
        /*
         * A STABLE CODE, NEVER THE MESSAGE. An `AppError` already carries one; an
         * unexpected throw becomes `internal`, because the message could carry a
         * provider string, a hostname or a fragment of customer content, and this
         * row is read back into a conversation.
         */
        const failureCode = error instanceof AppError ? error.code.toLowerCase() : 'internal';
        const updated = await this.#db.copilotToolCall.update({
          where: { id: call.id },
          data: {
            status: 'FAILED',
            failureCode,
            finishedAt: this.#clock.now(),
            durationMs: Math.max(0, this.#clock.now().getTime() - startedAt.getTime()),
          },
        });
        toolCalls.push(updated);
      }
    }

    const now = this.#clock.now();
    const completed = await this.#db.copilotActionPlan.update({
      where: { id: plan.id },
      data: {
        status: failed ? 'FAILED' : 'COMPLETED',
        completedAt: now,
        ...(failed ? { failureCode: 'step_failed' } : {}),
        // THE UNDO WINDOW OPENS AT COMPLETION, not at confirmation: it is a
        // window on the CHANGE, and the change has only just happened.
        ...(toolCalls.some((call) => call.compensation !== null && call.status === 'SUCCEEDED')
          ? {
              undoStatus: 'AVAILABLE',
              undoExpiresAt: new Date(now.getTime() + this.#policy.plans.undoWindowSeconds * 1_000),
            }
          : { undoStatus: 'NOT_APPLICABLE' }),
      },
    });

    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: failed ? 'copilot.plan_failed' : 'copilot.plan_executed',
      actorType: 'COPILOT',
      actorId: authorization.userId,
      resourceType: 'CopilotActionPlan',
      resourceId: plan.id,
      ...(plan.brandId ? { brandId: plan.brandId } : {}),
      traceId: plan.correlationId,
      outcome: failed ? 'ERROR' : 'SUCCESS',
      after: {
        steps: steps.length,
        succeeded: toolCalls.filter((call) => call.status === 'SUCCEEDED').length,
        refused: toolCalls.filter((call) => call.status === 'REFUSED').length,
        creditsChargedMilli: creditsChargedMilli.toString(),
      },
    });

    return { plan: completed, toolCalls, creditsChargedMilli };
  }

  /** The plan and its tool calls, for the history surface. Scope-filtered. */
  async get(
    planId: string,
    userId: string,
  ): Promise<{ plan: CopilotActionPlan; toolCalls: readonly CopilotToolCall[] }> {
    const plan = await this.#requirePlan(planId, userId);
    const toolCalls = await this.#db.copilotToolCall.findMany({
      where: { workspaceId: this.#workspaceId, planId: plan.id },
      orderBy: { ordinal: 'asc' },
    });
    return { plan, toolCalls };
  }

  async #recordCall(
    plan: CopilotActionPlan,
    step: StoredStep,
    input: {
      status: CopilotToolCall['status'];
      failureCode?: string;
      idempotencyKey?: string;
      startedAt?: Date;
    },
  ): Promise<CopilotToolCall> {
    const idempotencyKey =
      input.idempotencyKey ??
      toolCallIdempotencyKey({
        planId: plan.id,
        ordinal: step.ordinal,
        toolKey: step.toolKey,
        arguments: step.arguments,
      });

    /*
     * UPSERT ON THE PLAN AND ORDINAL, so a re-entered execution updates the row
     * it already wrote rather than colliding on the unique constraint. The
     * constraint is what makes two concurrent executions converge on one row per
     * step instead of writing two.
     */
    return this.#db.copilotToolCall.upsert({
      where: {
        workspaceId_planId_ordinal: {
          workspaceId: this.#workspaceId,
          planId: plan.id,
          ordinal: step.ordinal,
        },
      },
      create: {
        workspaceId: this.#workspaceId,
        planId: plan.id,
        sessionId: plan.sessionId,
        ordinal: step.ordinal,
        toolKey: step.toolKey,
        actionClass: step.actionClass,
        status: input.status,
        // REDACTED ARGUMENTS. Ids and enums travel; free text does not, because a
        // brief is customer content and a tool-call row is read back into later
        // turns and into support.
        argumentsJson: redactArguments(step.arguments),
        idempotencyKey,
        ...(input.failureCode ? { failureCode: input.failureCode } : {}),
        ...(input.startedAt ? { startedAt: input.startedAt } : {}),
      },
      update: {
        status: input.status,
        ...(input.failureCode ? { failureCode: input.failureCode } : {}),
        ...(input.startedAt ? { startedAt: input.startedAt } : {}),
      },
    });
  }

  async #failPlan(plan: CopilotActionPlan, failureCode: string): Promise<void> {
    await this.#db.copilotActionPlan.update({
      where: { id: plan.id },
      data: { status: 'FAILED', failureCode, completedAt: this.#clock.now() },
    });
    await this.#auditRefusal({
      action: 'copilot.plan_refused',
      planId: plan.id,
      userId: plan.userId,
      brandId: plan.brandId,
      reason: failureCode,
      actorType: 'SYSTEM',
    });
  }

  /**
   * D-132 AND MORE: a plan belongs to ONE PERSON.
   *
   * The `userId` predicate is in the WHERE, so another member of the same
   * workspace cannot confirm, execute or undo somebody else's plan — and cannot
   * learn that it exists either. A Copilot conversation carries what one person
   * asked and what they were shown; it is not workspace-shared data.
   */
  async #requirePlan(planId: string, userId: string): Promise<CopilotActionPlan> {
    const plan = await this.#db.copilotActionPlan.findFirst({
      where: { id: planId, workspaceId: this.#workspaceId, userId },
    });
    if (!plan) throw copilotPlanNotFound();
    return plan;
  }
}

/**
 * Asked before any step whose tool declares an entitlement key.
 *
 * TAKES THE FEATURE KEY, NOT THE TOOL KEY. The gate is a thin adapter over
 * `EntitlementService.can`, and handing it a tool key would force every caller to
 * re-implement the tool-to-feature mapping the registry already holds.
 */
export interface EntitlementGate {
  allows(featureKey: string): Promise<boolean>;
}

/**
 * The arguments, minus anything free-text.
 *
 * IDS, ENUMS, NUMBERS AND BOOLEANS TRAVEL; PROSE DOES NOT. A brief, a question
 * and a campaign name are customer content, and a tool-call row is read back into
 * later conversation turns, rendered in a history screen and shown to support.
 * Keeping the shape and dropping the words means the record still answers "what
 * was done" without becoming a second copy of what was written.
 */
function redactArguments(args: Record<string, unknown>): Prisma.InputJsonValue {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.length;
      continue;
    }
    if (typeof value !== 'string') continue;
    // A uuid, an enum value or a short machine-shaped token is an identifier and
    // is kept; anything else is measured rather than copied.
    if (/^[0-9a-f-]{36}$/i.test(value) || /^[A-Z_]{2,40}$/.test(value)) {
      out[key] = value;
      continue;
    }
    out[key] = { redactedLength: value.length };
  }
  return out as Prisma.InputJsonValue;
}
