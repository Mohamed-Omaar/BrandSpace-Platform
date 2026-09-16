import { createHash, randomUUID } from 'node:crypto';
import {
  Prisma,
  writeAuditEvent,
  type AutomationActionType,
  type AutomationRule,
  type AutomationRun,
  type AutomationTrigger,
  type TenantScopedClient,
} from '@brandspace/database';
import { AppError, brandInScope, systemClock, type Clock } from '@brandspace/shared';
import {
  automationConfirmationRejected,
  automationRuleNotFound,
  brandRuleLimitReached,
  creatorLacksAuthority,
  ruleLimitReached,
  tooManyConditions,
  unknownTriggerOrAction,
} from './errors';
import type { AutomationPolicy } from './policy';
import type { AutomationPorts } from './ports';
import {
  AUTOMATION_ACTIONS,
  conditionsSchema,
  evaluateConditions,
  findAction,
  findTrigger,
  isExternalAction,
  type AutomationCondition,
} from './registry';

/**
 * THE AUTOMATION ENGINE — trigger → condition → action.
 *
 * THE RULE THIS FILE EXISTS TO KEEP, and the one that makes an automation engine
 * safe rather than merely useful:
 *
 *   A RULE STORES NO AUTHORITY.
 *
 * It records who created it and which brand it acts on. Whether that person may
 * still do what it asks is RE-RESOLVED FROM THE LIVE MEMBERSHIP on every single
 * run. A rule written by a Marketing Manager who has since become a Viewer does
 * nothing, and the run history says `BLOCKED_BY_AUTHORIZATION` so a person can
 * see why. The alternative — a rule that keeps working because it was legitimate
 * when it was written — is a privilege that outlives the person who held it, and
 * it is the single most likely way an automation engine becomes an escalation
 * path.
 *
 * AND THE SECOND RULE:
 *
 *   AN EXTERNAL ACTION NEVER RUNS ON ITS OWN.
 *
 * `PROPOSE_PUBLISH` reaches `AWAITING_CONFIRMATION`, notifies the workspace, and
 * stops. A permitted human confirms the exact run, with a single-use token bound
 * to it, and only then does the publish port get called. An automation is not a
 * way around the Copilot's confirmation boundary; it is the same boundary reached
 * by a different door, and a CHECK constraint on `automation_rule` makes a rule
 * that claims otherwise unrepresentable.
 *
 * EVERY RUN IS IDEMPOTENT. The run's key is derived from the rule, the trigger
 * type, the thing that triggered it and a time bucket — so a duplicate delivery
 * of the same event finds the existing run and produces no second action. That is
 * the only way "every run is idempotent" survives a queue that promises
 * at-least-once.
 */

/**
 * Where a REFUSED CONFIRMATION gets recorded.
 *
 * THE SAME REASON `ApprovalOptions.denialSink` AND `CopilotDenialSink` EXIST. The
 * engine is called inside `withWorkspace`, which is one transaction; a refusal
 * throws, the transaction rolls back, and an audit row written just before the
 * throw goes with it. A refused confirmation on an EXTERNAL action is exactly
 * the event a detection signal is for (docs/SECURITY.md §7), so it is written on
 * a connection the rollback cannot reach.
 *
 * Absent, the engine writes on its own client — correct for a caller that is not
 * inside a transaction, harmlessly discarded for one that is.
 */
export interface AutomationDenialSink {
  (event: { runId: string; brandId: string; actorUserId: string; reason: string }): Promise<void>;
}

export interface AutomationEngineOptions {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
  readonly policy: AutomationPolicy;
  readonly ports: AutomationPorts;
  readonly clock?: Clock;
  readonly denialSink?: AutomationDenialSink | undefined;
}

/** Who is acting, resolved LIVE by the caller before every run. */
export interface AutomationActor {
  readonly userId: string;
  readonly roleKey: string;
  readonly permissionKeys: readonly string[];
  readonly brandScope: readonly string[];
}

export interface TriggerEvent {
  readonly type: AutomationTrigger;
  readonly brandId: string;
  /** The row that fired it: a content item, a publish job, an insight. */
  readonly refType: string | null;
  readonly refId: string | null;
  /** The facts a condition may read. Gathered by the caller, never queried here. */
  readonly facts: Readonly<Record<string, unknown>>;
}

export interface RunOutcome {
  readonly run: AutomationRun | null;
  readonly status: AutomationRun['status'] | 'NOT_RUN';
  /** Returned exactly once when an external action needs a person. */
  readonly confirmationToken: string | null;
}

/**
 * The deterministic identity of one run.
 *
 * DERIVED FROM THE TRIGGER, NOT MINTED PER DELIVERY. hash(rule, trigger, the
 * thing that fired it, the bucket) — so the same event delivered twice collides
 * on the unique constraint and the second delivery does nothing.
 *
 * THE BUCKET IS WHAT MAKES A TIMED RULE IDEMPOTENT. A scheduled rule has no
 * triggering row, so without a bucket every sweep would look like a new event; the
 * local hour is the bucket, and a rule fires once per hour it is scheduled for
 * however many sweeps pass through that hour.
 */
export function runIdempotencyKeyFor(input: {
  ruleId: string;
  triggerType: AutomationTrigger;
  refId: string | null;
  bucket: string;
}): string {
  return createHash('sha256')
    .update([input.ruleId, input.triggerType, input.refId ?? '-', input.bucket].join('|'))
    .digest('hex');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class AutomationEngine {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;
  readonly #policy: AutomationPolicy;
  readonly #ports: AutomationPorts;
  readonly #clock: Clock;
  readonly #denialSink: AutomationDenialSink | undefined;

  constructor(options: AutomationEngineOptions) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#policy = options.policy;
    this.#ports = options.ports;
    this.#clock = options.clock ?? systemClock;
    this.#denialSink = options.denialSink;
  }

  /**
   * Record a refused confirmation somewhere it SURVIVES the throw after it.
   *
   * The sink's own failure is swallowed: a refusal must not become a 500 because
   * the audit connection was unavailable.
   */
  async #auditRefusal(event: {
    runId: string;
    brandId: string;
    actorUserId: string;
    reason: string;
  }): Promise<void> {
    if (this.#denialSink) {
      await this.#denialSink(event).catch(() => undefined);
      return;
    }
    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'automation.confirmation_refused',
      actorType: 'USER',
      actorId: event.actorUserId,
      resourceType: 'AutomationRun',
      resourceId: event.runId,
      brandId: event.brandId,
      severity: 'WARNING',
      outcome: 'DENIED',
      reason: event.reason,
    });
  }

  // -------------------------------------------------------------------------
  // Authoring
  // -------------------------------------------------------------------------

  /**
   * Create a rule.
   *
   * THE CREATOR'S AUTHORITY IS VALIDATED HERE, and re-validated on every run.
   * Checking only at creation would let a rule outlive its author's authority;
   * checking only at run time would let somebody write a rule they could never
   * have run, which is a confusing product and a pointless queue entry.
   */
  async createRule(input: {
    brandId: string;
    name: string;
    description?: string | undefined;
    triggerType: AutomationTrigger;
    triggerConfig: unknown;
    conditions: unknown;
    actionType: AutomationActionType;
    actionConfig: unknown;
    maxRunsPerDay?: number | undefined;
    enabled?: boolean | undefined;
    actor: AutomationActor;
  }): Promise<AutomationRule> {
    // D-132: an out-of-scope brand is a 404 shaped like a genuine miss.
    if (!brandInScope(input.actor.brandScope, input.brandId)) throw automationRuleNotFound();

    const trigger = findTrigger(input.triggerType);
    const action = findAction(input.actionType);
    if (!trigger || !action) throw unknownTriggerOrAction();

    // The creator must hold BOTH the authoring permission and the permission the
    // ACTION needs. Holding `automation.manage` is not a way to acquire
    // `publishing.manage` by writing a rule that uses it.
    if (!input.actor.permissionKeys.includes('automation.manage')) throw creatorLacksAuthority();
    if (!input.actor.permissionKeys.includes(action.permission)) throw creatorLacksAuthority();

    const conditions = conditionsSchema.parse(input.conditions);
    if (conditions.length > this.#policy.limits.maxConditionsPerRule) {
      throw tooManyConditions(this.#policy.limits.maxConditionsPerRule);
    }

    const triggerConfig = trigger.config.parse(input.triggerConfig) as Prisma.InputJsonValue;
    const actionConfig = action.config.parse(input.actionConfig) as Prisma.InputJsonValue;

    const workspaceCount = await this.#db.automationRule.count({
      where: { workspaceId: this.#workspaceId, deletedAt: null },
    });
    if (workspaceCount >= this.#policy.limits.maxRulesPerWorkspace) {
      throw ruleLimitReached(this.#policy.limits.maxRulesPerWorkspace);
    }
    const brandCount = await this.#db.automationRule.count({
      where: { workspaceId: this.#workspaceId, brandId: input.brandId, deletedAt: null },
    });
    if (brandCount >= this.#policy.limits.maxRulesPerBrand) {
      throw brandRuleLimitReached(this.#policy.limits.maxRulesPerBrand);
    }

    const rule = await this.#db.automationRule.create({
      data: {
        workspaceId: this.#workspaceId,
        brandId: input.brandId,
        name: input.name.trim().slice(0, 120),
        description: input.description ?? null,
        enabled: input.enabled ?? false,
        triggerType: input.triggerType,
        triggerConfig,
        conditions: conditions as unknown as Prisma.InputJsonValue,
        actionType: input.actionType,
        actionConfig,
        maxRunsPerDay: Math.min(
          input.maxRunsPerDay ?? this.#policy.limits.maxRunsPerRulePerDay,
          this.#policy.limits.maxRunsPerRulePerDay,
        ),
        // ALWAYS TRUE, and the CHECK constraint refuses anything else for an
        // external action. Written explicitly so the row states the rule rather
        // than relying on a default.
        requiresConfirmationForExternal: true,
        createdByUserId: input.actor.userId,
      },
    });

    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'automation.created',
      actorType: 'USER',
      actorId: input.actor.userId,
      resourceType: 'AutomationRule',
      resourceId: rule.id,
      brandId: input.brandId,
      after: {
        trigger: input.triggerType,
        action: input.actionType,
        conditions: conditions.length,
        enabled: rule.enabled,
      },
    });

    return rule;
  }

  /** Enable, disable or edit a rule. */
  async updateRule(input: {
    ruleId: string;
    enabled?: boolean | undefined;
    name?: string | undefined;
    conditions?: unknown;
    maxRunsPerDay?: number | undefined;
    actor: AutomationActor;
  }): Promise<AutomationRule> {
    const existing = await this.#requireRule(input.ruleId, input.actor.brandScope);
    if (!input.actor.permissionKeys.includes('automation.manage')) throw creatorLacksAuthority();

    const action = findAction(existing.actionType);
    /* c8 ignore next -- a stored rule always names a registry action. */
    if (!action) throw unknownTriggerOrAction();
    /*
     * ENABLING IS THE HEAVY HALF. A person who may not perform the action may not
     * switch on a rule that performs it either — otherwise "enable" would be a way
     * to exercise somebody else's authority through a rule they wrote.
     */
    if (input.enabled === true && !input.actor.permissionKeys.includes(action.permission)) {
      throw creatorLacksAuthority();
    }

    const conditions =
      input.conditions === undefined ? undefined : conditionsSchema.parse(input.conditions);
    if (conditions && conditions.length > this.#policy.limits.maxConditionsPerRule) {
      throw tooManyConditions(this.#policy.limits.maxConditionsPerRule);
    }

    const rule = await this.#db.automationRule.update({
      where: { id: existing.id },
      data: {
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.name === undefined ? {} : { name: input.name.trim().slice(0, 120) }),
        ...(conditions === undefined
          ? {}
          : { conditions: conditions as unknown as Prisma.InputJsonValue }),
        ...(input.maxRunsPerDay === undefined
          ? {}
          : {
              maxRunsPerDay: Math.min(
                input.maxRunsPerDay,
                this.#policy.limits.maxRunsPerRulePerDay,
              ),
            }),
        updatedByUserId: input.actor.userId,
        version: { increment: 1 },
      },
    });

    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: input.enabled === true ? 'automation.enabled' : 'automation.updated',
      actorType: 'USER',
      actorId: input.actor.userId,
      resourceType: 'AutomationRule',
      resourceId: rule.id,
      brandId: rule.brandId,
      before: { enabled: existing.enabled, version: existing.version },
      after: { enabled: rule.enabled, version: rule.version },
    });
    return rule;
  }

  async deleteRule(input: { ruleId: string; actor: AutomationActor }): Promise<void> {
    const existing = await this.#requireRule(input.ruleId, input.actor.brandScope);
    if (!input.actor.permissionKeys.includes('automation.manage')) throw creatorLacksAuthority();
    await this.#db.automationRule.update({
      where: { id: existing.id },
      data: { deletedAt: this.#clock.now(), enabled: false, version: { increment: 1 } },
    });
    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'automation.deleted',
      actorType: 'USER',
      actorId: input.actor.userId,
      resourceType: 'AutomationRule',
      resourceId: existing.id,
      brandId: existing.brandId,
    });
  }

  async listRules(input: {
    brandId?: string | undefined;
    brandScope: readonly string[];
  }): Promise<readonly AutomationRule[]> {
    return this.#db.automationRule.findMany({
      where: {
        workspaceId: this.#workspaceId,
        deletedAt: null,
        ...(input.brandId ? { brandId: input.brandId } : {}),
        ...(input.brandScope.length > 0 ? { brandId: { in: [...input.brandScope] } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async listRuns(input: {
    ruleId?: string | undefined;
    brandScope: readonly string[];
    take?: number | undefined;
  }): Promise<readonly AutomationRun[]> {
    return this.#db.automationRun.findMany({
      where: {
        workspaceId: this.#workspaceId,
        ...(input.ruleId ? { ruleId: input.ruleId } : {}),
        ...(input.brandScope.length > 0 ? { brandId: { in: [...input.brandScope] } } : {}),
      },
      orderBy: { startedAt: 'desc' },
      take: Math.max(1, Math.min(input.take ?? 50, 200)),
    });
  }

  // -------------------------------------------------------------------------
  // Running
  // -------------------------------------------------------------------------

  /**
   * Deliver one event to every rule that listens for it.
   *
   * THE ACTOR IS RESOLVED BY THE CALLER, LIVE, FOR THE RULE'S CREATOR. It is
   * passed in rather than resolved here because the caller already holds the
   * membership lookup and because passing it makes the dependency visible: a run
   * cannot happen without somebody having answered "what may this person do,
   * right now?".
   */
  async deliver(input: {
    event: TriggerEvent;
    /** Resolves the CURRENT authority of a rule's creator, or null if removed. */
    resolveActor: (userId: string) => Promise<AutomationActor | null>;
  }): Promise<readonly RunOutcome[]> {
    const rules = await this.#db.automationRule.findMany({
      where: {
        workspaceId: this.#workspaceId,
        brandId: input.event.brandId,
        triggerType: input.event.type,
        enabled: true,
        deletedAt: null,
      },
    });

    const outcomes: RunOutcome[] = [];
    for (const rule of rules) {
      outcomes.push(await this.run({ rule, event: input.event, resolveActor: input.resolveActor }));
    }
    return outcomes;
  }

  /** One rule, one event. The unit of automation. */
  async run(input: {
    rule: AutomationRule;
    event: TriggerEvent;
    resolveActor: (userId: string) => Promise<AutomationActor | null>;
  }): Promise<RunOutcome> {
    const { rule, event } = input;
    const now = this.#clock.now();

    // A DISABLED OR DELETED RULE DOES NOTHING, checked here as well as in the
    // query above: a rule disabled between the read and the run must not fire.
    if (!rule.enabled || rule.deletedAt)
      return { run: null, status: 'NOT_RUN', confirmationToken: null };

    const idempotencyKey = runIdempotencyKeyFor({
      ruleId: rule.id,
      triggerType: event.type,
      refId: event.refId,
      // The hour is the bucket. See `runIdempotencyKeyFor`.
      bucket: now.toISOString().slice(0, 13),
    });

    /*
     * THE UNIQUE CONSTRAINT IS THE DE-DUPLICATION, not this read. The read is a
     * fast path that avoids a pointless insert; the `catch` below is what actually
     * makes a concurrent duplicate delivery safe.
     */
    const existing = await this.#db.automationRun.findFirst({
      where: { workspaceId: this.#workspaceId, idempotencyKey },
    });
    if (existing) {
      return { run: existing, status: existing.status, confirmationToken: null };
    }

    let run: AutomationRun;
    try {
      run = await this.#db.automationRun.create({
        data: {
          workspaceId: this.#workspaceId,
          brandId: rule.brandId,
          ruleId: rule.id,
          status: 'RUNNING',
          triggerType: event.type,
          triggerRefType: event.refType,
          triggerRefId: event.refId,
          idempotencyKey,
          actionType: rule.actionType,
          correlationId: randomUUID(),
        },
      });
    } catch (error: unknown) {
      /*
       * TWO DELIVERIES RACED AND THE OTHER ONE WON. The unique constraint refused
       * this insert, which is exactly the outcome that makes duplicate delivery
       * safe — the winner is running, and this one returns what it finds.
       */
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await this.#db.automationRun.findFirst({
          where: { workspaceId: this.#workspaceId, idempotencyKey },
        });
        return winner
          ? { run: winner, status: winner.status, confirmationToken: null }
          : { run: null, status: 'NOT_RUN', confirmationToken: null };
      }
      throw error;
    }

    // --- The daily ceiling ---------------------------------------------------
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1_000);
    const today = await this.#db.automationRun.count({
      where: {
        workspaceId: this.#workspaceId,
        ruleId: rule.id,
        startedAt: { gte: since },
        status: { notIn: ['SKIPPED', 'BLOCKED_BY_POLICY'] },
      },
    });
    if (rule.maxRunsPerDay > 0 && today > rule.maxRunsPerDay) {
      return this.#finish(rule, run, 'BLOCKED_BY_POLICY', { failureCode: 'daily_ceiling_reached' });
    }

    // --- The conditions ------------------------------------------------------
    const conditions = (rule.conditions as unknown as AutomationCondition[]) ?? [];
    const held = evaluateConditions(conditions, event.facts);
    if (!held) {
      // A CONDITION THAT DID NOT HOLD IS A COMPLETE, SUCCESSFUL EVALUATION.
      // `SKIPPED`, not `FAILED`: most runs of most rules end here, and calling
      // them failures would make a run history unreadable.
      return this.#finish(rule, run, 'SKIPPED', { conditionsHeld: false });
    }

    // --- THE AUTHORITY, RE-RESOLVED, EVERY TIME ------------------------------
    const actor = await input.resolveActor(rule.createdByUserId);
    const action = findAction(rule.actionType);
    /* c8 ignore next -- a stored rule always names a registry action. */
    if (!action) return this.#finish(rule, run, 'FAILED', { failureCode: 'unknown_action' });

    if (!actor) {
      return this.#finish(rule, run, 'BLOCKED_BY_AUTHORIZATION', {
        conditionsHeld: true,
        failureCode: 'creator_no_longer_a_member',
      });
    }
    if (!actor.permissionKeys.includes(action.permission)) {
      return this.#finish(rule, run, 'BLOCKED_BY_AUTHORIZATION', {
        conditionsHeld: true,
        failureCode: 'creator_lost_permission',
      });
    }
    /*
     * AND THE BRAND BOUNDARY THE RULE STORED. A creator whose BrandScope has since
     * narrowed cannot keep acting on a brand they no longer have, through a rule
     * they wrote when they did.
     */
    if (!brandInScope(actor.brandScope, rule.brandId)) {
      return this.#finish(rule, run, 'BLOCKED_BY_AUTHORIZATION', {
        conditionsHeld: true,
        failureCode: 'creator_lost_brand_scope',
      });
    }

    // --- EXTERNAL ACTIONS STOP HERE ------------------------------------------
    if (isExternalAction(rule.actionType)) {
      return this.#awaitConfirmation(rule, run, event);
    }

    // --- Internal actions run ------------------------------------------------
    try {
      const result = await this.#performInternal(rule, run, event, actor);
      return this.#finish(rule, run, 'SUCCEEDED', {
        conditionsHeld: true,
        actionResult: result.metadata,
        ...(result.resourceType ? { resourceType: result.resourceType } : {}),
        ...(result.resourceId ? { resourceId: result.resourceId } : {}),
      });
    } catch (error: unknown) {
      const failureCode = error instanceof AppError ? error.code.toLowerCase() : 'internal';
      return this.#finish(rule, run, 'FAILED', { conditionsHeld: true, failureCode });
    }
  }

  /**
   * An external action, proposed and waiting.
   *
   * THE RUN STOPS, A TOKEN IS ISSUED, AND THE WORKSPACE IS TOLD. The token is
   * single-use and stored hashed, exactly as the Copilot's confirmation is; the
   * raw value is returned once, to whoever is going to put it in front of a
   * person, and is never written down.
   */
  async #awaitConfirmation(
    rule: AutomationRule,
    run: AutomationRun,
    event: TriggerEvent,
  ): Promise<RunOutcome> {
    const token = randomUUID() + randomUUID();
    const expiresAt = new Date(
      this.#clock.now().getTime() + this.#policy.execution.confirmationTtlSeconds * 1_000,
    );

    const updated = await this.#db.automationRun.update({
      where: { id: run.id },
      data: {
        status: 'AWAITING_CONFIRMATION',
        conditionsHeld: true,
        confirmationTokenHash: hashToken(token),
        confirmationExpiresAt: expiresAt,
        resourceType: event.refType,
        resourceId: event.refId,
      },
    });

    if (this.#ports.notifications) {
      await this.#ports.notifications.notify({
        workspaceId: this.#workspaceId,
        brandId: rule.brandId,
        // A dedicated template: "an automation wants to publish something" is not
        // the same message as "something was published", and reusing one would
        // teach people to ignore both.
        templateKey: 'automation.confirmation_required',
        resourceType: 'AutomationRun',
        resourceId: run.id,
        idempotencyKey: `automation-confirm:${run.id}`,
      });
    }

    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'automation.awaiting_confirmation',
      actorType: 'AUTOMATION',
      resourceType: 'AutomationRun',
      resourceId: run.id,
      brandId: rule.brandId,
      traceId: run.correlationId,
      severity: 'NOTICE',
      after: { ruleId: rule.id, actionType: rule.actionType },
    });

    return { run: updated, status: 'AWAITING_CONFIRMATION', confirmationToken: token };
  }

  /**
   * A permitted human confirms the exact run.
   *
   * ONE CONDITIONAL UPDATE WITH EVERY GUARD IN ITS `WHERE`, exactly as the
   * Copilot's confirmation is: the run is still awaiting, has not already been
   * confirmed, the token matches, and the window is open. Zero rows is a refusal,
   * and every reason produces the same one.
   *
   * AND THE CONFIRMER'S OWN AUTHORITY IS CHECKED, not the creator's. The person
   * agreeing to publish must be someone who may publish — otherwise a rule
   * written by an admin would let anyone with a link authorize an external action.
   */
  async confirmRun(input: {
    runId: string;
    token: string;
    actor: AutomationActor;
  }): Promise<AutomationRun> {
    const run = await this.#db.automationRun.findFirst({
      where: { id: input.runId, workspaceId: this.#workspaceId },
    });
    if (!run) throw automationConfirmationRejected();

    const rule = await this.#db.automationRule.findFirst({
      where: { id: run.ruleId, workspaceId: this.#workspaceId },
    });
    if (!rule) throw automationConfirmationRejected();

    const action = findAction(rule.actionType);
    if (!action) throw automationConfirmationRejected();
    if (!input.actor.permissionKeys.includes(action.permission)) {
      await this.#auditRefusal({
        runId: run.id,
        brandId: run.brandId,
        actorUserId: input.actor.userId,
        reason: 'confirmer_lacks_permission',
      });
      throw automationConfirmationRejected();
    }
    if (!brandInScope(input.actor.brandScope, run.brandId)) throw automationConfirmationRejected();

    const now = this.#clock.now();
    const claimed = await this.#db.automationRun.updateMany({
      where: {
        id: run.id,
        workspaceId: this.#workspaceId,
        status: 'AWAITING_CONFIRMATION',
        confirmedAt: null,
        confirmationTokenHash: hashToken(input.token),
        confirmationExpiresAt: { gt: now },
      },
      data: { confirmedAt: now, confirmedByUserId: input.actor.userId, status: 'RUNNING' },
    });
    if (claimed.count === 0) {
      await this.#auditRefusal({
        runId: run.id,
        brandId: run.brandId,
        actorUserId: input.actor.userId,
        reason: 'confirmation_not_valid',
      });
      throw automationConfirmationRejected();
    }

    // THE ONLY CALL SITE OF THE PUBLISH PORT IN THIS FILE, and it is downstream
    // of the confirmation by construction.
    if (!this.#ports.publishing || !run.triggerRefId) {
      const finished = await this.#finish(rule, run, 'BLOCKED_BY_POLICY', {
        failureCode: 'external_action_unavailable',
      });
      /* c8 ignore next -- `#finish` always returns a run here. */
      return finished.run ?? run;
    }

    try {
      const outcome = await this.#ports.publishing.publishNow({
        workspaceId: this.#workspaceId,
        brandId: run.brandId,
        contentItemId: run.triggerRefId,
        actorUserId: input.actor.userId,
        // THE RUN'S OWN KEY. A retried confirmation cannot publish twice.
        idempotencyKey: `automation-run:${run.id}`,
      });
      /*
       * `resourceId` IS NOT TOUCHED HERE, AND THAT IS DELIBERATE. It holds the
       * thing a human confirmed — the content item they looked at before saying
       * yes — and a confirmed run may not be re-aimed at anything else; a
       * database trigger says so. What the confirmed action PRODUCED is a
       * different fact, so it goes in `actionResult`, where re-reading it later
       * cannot be mistaken for what was agreed to.
       */
      const finished = await this.#finish(rule, run, 'SUCCEEDED', {
        conditionsHeld: true,
        actionResult: { jobsCreated: outcome.jobsCreated, slotId: outcome.slotId },
      });
      /* c8 ignore next -- `#finish` always returns a run here. */
      return finished.run ?? run;
    } catch (error: unknown) {
      const failureCode = error instanceof AppError ? error.code.toLowerCase() : 'internal';
      const finished = await this.#finish(rule, run, 'FAILED', { failureCode });
      /* c8 ignore next -- `#finish` always returns a run here. */
      return finished.run ?? run;
    }
  }

  /** Perform an internal action through its port. */
  async #performInternal(
    rule: AutomationRule,
    run: AutomationRun,
    event: TriggerEvent,
    actor: AutomationActor,
  ): Promise<{
    metadata: Prisma.InputJsonValue;
    resourceType?: string;
    resourceId?: string;
  }> {
    const config = (rule.actionConfig ?? {}) as Record<string, unknown>;
    const idempotencyKey = `automation-run:${run.id}`;

    switch (rule.actionType) {
      case 'NOTIFY': {
        if (!this.#ports.notifications) throw unknownTriggerOrAction();
        const result = await this.#ports.notifications.notify({
          workspaceId: this.#workspaceId,
          brandId: rule.brandId,
          templateKey: String(config['templateKey']),
          resourceType: event.refType ?? 'AutomationRun',
          resourceId: event.refId ?? run.id,
          idempotencyKey,
        });
        return { metadata: { recipients: result.recipients } };
      }

      case 'SUBMIT_FOR_APPROVAL': {
        if (!this.#ports.approvals || !event.refId) throw unknownTriggerOrAction();
        const result = await this.#ports.approvals.submitForApproval({
          workspaceId: this.#workspaceId,
          contentItemId: event.refId,
          actorUserId: actor.userId,
          // THE CREATOR'S LIVE AUTHORITY, passed straight through so the approval
          // service authorizes against what they actually hold right now.
          actorPermissionKeys: actor.permissionKeys,
          actorRoleKey: actor.roleKey,
          actorBrandScope: actor.brandScope,
          idempotencyKey,
        });
        return {
          metadata: { approvalId: result.approvalId },
          resourceType: 'Approval',
          resourceId: result.approvalId,
        };
      }

      case 'PLACE_ON_CALENDAR': {
        if (!this.#ports.calendar || !event.refId) throw unknownTriggerOrAction();
        const timezone = this.#ports.timezone
          ? await this.#ports.timezone.timezoneFor(this.#workspaceId)
          : 'UTC';
        const localTime = this.#localTimeFor(
          Number(config['offsetHours'] ?? 24),
          config['hourLocal'] === undefined ? null : Number(config['hourLocal']),
          timezone,
        );
        const result = await this.#ports.calendar.placeOnCalendar({
          workspaceId: this.#workspaceId,
          contentItemId: event.refId,
          localTime,
          actorUserId: actor.userId,
          actorBrandScope: actor.brandScope,
          idempotencyKey,
        });
        return {
          metadata: { slotId: result.slotId, localTime },
          resourceType: 'CalendarSlot',
          resourceId: result.slotId,
        };
      }

      /* c8 ignore next 3 -- the external action never reaches this switch. */
      case 'PROPOSE_PUBLISH':
        throw unknownTriggerOrAction();
    }
  }

  /**
   * The local wall-clock string an action schedules for.
   *
   * COMPUTED IN THE WORKSPACE'S OWN ZONE via `Intl`, not by adding milliseconds to
   * a UTC instant and hoping. "Tomorrow at 09:00" is a wall clock, and a
   * daylight-saving boundary between now and then would make the arithmetic
   * version an hour wrong on exactly the days a customer would notice.
   */
  #localTimeFor(offsetHours: number, hourLocal: number | null, timezone: string): string {
    const instant = new Date(this.#clock.now().getTime() + offsetHours * 3_600_000);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(instant);
    const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '00';
    const hour = hourLocal === null ? get('hour') : String(hourLocal).padStart(2, '0');
    return `${get('year')}-${get('month')}-${get('day')}T${hour}:${hourLocal === null ? get('minute') : '00'}`;
  }

  async #finish(
    rule: AutomationRule,
    run: AutomationRun,
    status: AutomationRun['status'],
    input: {
      conditionsHeld?: boolean;
      failureCode?: string;
      actionResult?: Prisma.InputJsonValue;
      resourceType?: string;
      resourceId?: string;
    },
  ): Promise<RunOutcome> {
    const now = this.#clock.now();
    const updated = await this.#db.automationRun.update({
      where: { id: run.id },
      data: {
        status,
        conditionsHeld: input.conditionsHeld ?? null,
        failureCode: input.failureCode ?? null,
        ...(input.actionResult === undefined ? {} : { actionResult: input.actionResult }),
        resourceType: input.resourceType ?? run.resourceType,
        resourceId: input.resourceId ?? run.resourceId,
        finishedAt: now,
        durationMs: Math.max(0, now.getTime() - run.startedAt.getTime()),
      },
    });

    await this.#db.automationRule.update({
      where: { id: rule.id },
      data: { lastRunAt: now, lastRunStatus: status, runCount: { increment: 1 } },
    });

    /*
     * ONLY OUTCOMES WORTH AN AUDIT ROW. A `SKIPPED` run is the ordinary case —
     * most runs of most rules are — and auditing every one would drown the log
     * that matters in the noise of rules that did nothing.
     */
    if (status !== 'SKIPPED') {
      await writeAuditEvent(this.#db, this.#workspaceId, {
        action: 'automation.run',
        actorType: 'AUTOMATION',
        resourceType: 'AutomationRun',
        resourceId: run.id,
        brandId: rule.brandId,
        traceId: run.correlationId,
        outcome: status === 'SUCCEEDED' ? 'SUCCESS' : status === 'FAILED' ? 'ERROR' : 'DENIED',
        severity: status === 'BLOCKED_BY_AUTHORIZATION' ? 'WARNING' : 'INFO',
        ...(input.failureCode ? { reason: input.failureCode } : {}),
        after: { ruleId: rule.id, status, actionType: rule.actionType },
      });
    }

    return { run: updated, status, confirmationToken: null };
  }

  async #requireRule(ruleId: string, brandScope: readonly string[]): Promise<AutomationRule> {
    const rule = await this.#db.automationRule.findFirst({
      where: {
        id: ruleId,
        workspaceId: this.#workspaceId,
        deletedAt: null,
        ...(brandScope.length > 0 ? { brandId: { in: [...brandScope] } } : {}),
      },
    });
    if (!rule) throw automationRuleNotFound();
    return rule;
  }

  /** Every action type, for the rule editor. Copy comes from the message keys. */
  static actionTypes(): readonly AutomationActionType[] {
    return AUTOMATION_ACTIONS.map((action) => action.type);
  }
}
