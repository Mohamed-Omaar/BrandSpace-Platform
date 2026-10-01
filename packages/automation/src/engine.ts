import { createHash, randomUUID } from 'node:crypto';
import {
  writeAuditEvent,
  type AutomationActionType,
  type AutomationRule,
  type AutomationRun,
  type AutomationTrigger,
  type Prisma,
  type TenantScopedClient,
} from '@brandspace/database';
import {
  AppError,
  brandIdQueryFilter,
  brandInScope,
  systemClock,
  type Clock,
} from '@brandspace/shared';
import {
  automationConfirmationRejected,
  conditionFieldNotProduced,
  conditionOperatorNotAllowed,
  conditionValueInvalid,
  automationRuleNameTaken,
  automationRuleNotFound,
  automationRuleVersionConflict,
  brandRuleLimitReached,
  creatorLacksAuthority,
  ruleLimitReached,
  tooManyConditions,
  automationTargetNotFound,
  triggerActionIncompatible,
  unknownTriggerOrAction,
} from './errors';
import { CONDITION_VALUE_UNAVAILABLE, conditionValuesResolve } from './condition-values';
import { OCCURRENCE_STALE, occurrenceStillHolds } from './occurrence';
import { campaignTargetResolves, personTargetResolves } from './action-targets';
import { memberAuthority } from './authority';
import { triggerAvailable, type AutomationPolicy } from './policy';
import type { AutomationPorts } from './ports';
import {
  ACTION_OUTCOME_STATUS,
  AUTOMATION_ACTIONS,
  actionSupportsTrigger,
  conditionFieldsForRule,
  conditionRejection,
  conditionsSchema,
  evaluateConditions,
  findAction,
  findTrigger,
  isAuthorablePair,
  isAutomationNotifyTemplate,
  isExternalAction,
  NOTIFY_TEMPLATE_NOT_ALLOWED,
  RULE_DISABLED,
  satisfiesActionPermissions,
  type ActionDefinition,
  type ActionOutcomeCode,
  type AutomationCondition,
  type ConditionField,
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
  /** The row that fired it: a content item, a calendar slot, a publish job. */
  readonly refType: string | null;
  readonly refId: string | null;
  /**
   * ADDRESSED TO ONE RULE, for the triggers whose identity is READ OFF A RULE.
   *
   * A domain event belongs to the brand and every listening rule should see it,
   * so this is null there. A schedule and a threshold are different in kind:
   * both are computed from one rule's own configuration, and delivering rule A's
   * nine-o'clock occurrence to rule B — which asked for five — would fire a rule
   * at an hour its owner never chose.
   */
  readonly ruleId?: string | null;
  /**
   * The occurrence a timed event was created FOR (`YYYY-MM-DDTHH`, workspace
   * local).
   *
   * CARRIED, NOT RECOMPUTED, and that is the whole of P7-R5 applied to the
   * producer side. Recomputing the bucket from `now` at delivery means a message
   * that sat in the queue past the hour boundary lands in a DIFFERENT bucket
   * from the one it was created for, and the same occurrence runs twice.
   */
  readonly occurrence?: string | null;
  /**
   * THE OUTBOX EVENT'S OWN LOGICAL IDENTITY, carried from its `dedupeKey` (R6).
   *
   * WHY THE ENGINE NEEDS IT AT ALL. A run's identity used to be
   * `(rule, trigger, refId, bucket)` — and for a threshold event that is
   * `(rule, METRIC_THRESHOLD_CROSSED, observationId, 'event')`, which is NOT
   * the identity the producer used. The outbox identifies a threshold event by
   * the rule's ARMING CYCLE, because that is what makes a second crossing a
   * second event.
   *
   * THE TWO DISAGREED, AND A METRIC OBSERVATION IS UPDATED IN PLACE. Ingestion
   * is `INSERT … ON CONFLICT (workspaceId, observationKey) DO UPDATE`, so a
   * provider revising yesterday's figure moves the SAME ROW across the line
   * while its id stays put. Below the line, revised above (crossing, cycle 0),
   * revised below (re-arm, cycle 1), revised above again (crossing, cycle 1):
   * the outbox correctly writes two events, and the engine — seeing the same
   * refId and the same `'event'` bucket both times — derived one run key and
   * SUPPRESSED THE SECOND LEGITIMATE RUN. A real crossing, silently dropped.
   *
   * SO THE EVENT SAYS WHO IT IS, and the run key uses that. The reference stays
   * exactly where it was: it is PROVENANCE, the reading the crossing was seen
   * in, and it is no longer asked to be an identity it cannot carry.
   */
  readonly eventKey?: string | null;
  /**
   * PHASE 2B-3 PR 2 — WHEN THE EVENT HAPPENED: the outbox row's `createdAt`.
   *
   * Compared with the rule's `armedAt` (OD-21, no backfill): an event that
   * happened before the rule was created, switched on, or had its trigger
   * settings changed does not reach it. Absent for a caller that composed the
   * event itself, which keeps the behaviour it always had.
   */
  readonly occurredAt?: Date | null;
  /** The facts a condition may read. Gathered by the caller, never queried here. */
  readonly facts: Readonly<Record<string, unknown>>;
}

/**
 * What an internal action did: acted (with what it produced), or — for a G13
 * action — declined with a typed reason (`ACTION_OUTCOME_STATUS`).
 */
/** A canonical uuid: the only kind of id sent to a `::uuid` cast. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PerformResult =
  | {
      readonly metadata: Prisma.InputJsonValue;
      readonly resourceType?: string;
      readonly resourceId?: string;
    }
  | { readonly outcome: ActionOutcomeCode };

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
 * WHAT GOES IN THE BUCKET IS `runBucketFor`'s decision, and it is the whole of
 * P7-R5. Read that function next.
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

/** The bucket for an event-driven trigger: none, because the ref IS the identity. */
const EVENT_BUCKET = 'event';

/**
 * WHICH BUCKET, AND THE ANSWER IS "ONLY A TIMED TRIGGER GETS ONE" (P7-R5).
 *
 * THE DEFECT THIS REPLACES. Every trigger used the wall-clock hour, including
 * the six that carry a reference to the row that fired them. A `POST_PUBLISHED`
 * event delivered at 12:59 and redelivered at 13:01 — an ordinary BullMQ retry
 * after a worker restart, a backoff, or a queue drained after an incident —
 * hashed to two different keys, so the unique constraint that exists to make
 * redelivery safe never saw a duplicate and the rule ran a second time. For
 * `PROPOSE_PUBLISH` that is a second confirmation request for a post already
 * awaiting one; for `PLACE_ON_CALENDAR` it is a second slot.
 *
 * AN EVENT'S IDENTITY IS ITS REFERENCE, FOR EVER. `(rule, trigger, refId)`
 * identifies "this rule, reacting to that row" with no time in it at all, so a
 * redelivery converges on the original run a minute later or a week later. That
 * is what "idempotent and safe to retry" (CLAUDE.md §5) actually requires; an
 * expiring key is a retry window dressed as a guarantee.
 *
 * A TIMED TRIGGER HAS NO REFERENCE, so its identity must come from the clock —
 * and it comes from the OCCURRENCE THE RULE IS CONFIGURED FOR, not from the
 * instant the sweep happened to run. The bucket is the workspace-local DATE plus
 * the rule's own `hourLocal`, so however many sweeps pass through that
 * occurrence, and whenever their deliveries arrive, they are one run. Bucketing
 * by the sweep's own hour instead would split one scheduled occurrence in two
 * whenever a delivery slipped across the hour boundary.
 *
 * A TRIGGER THIS FUNCTION DOES NOT RECOGNISE gets the event bucket, which is the
 * conservative answer: it de-duplicates MORE, never less.
 */
export function runBucketFor(input: {
  triggerType: AutomationTrigger;
  /** The workspace-local date, `YYYY-MM-DD`, for a timed trigger. */
  localDate: string;
  /** The hour the RULE is configured to fire at, for a timed trigger. */
  hourLocal: number;
}): string {
  const trigger = findTrigger(input.triggerType);
  if (!trigger?.timeBucketed) return EVENT_BUCKET;
  const hour = Number.isFinite(input.hourLocal)
    ? Math.min(23, Math.max(0, Math.trunc(input.hourLocal)))
    : 0;
  return `${input.localDate}T${String(hour).padStart(2, '0')}`;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * The failure code of a run refused because its workspace is pending deletion
 * (D-328). Lower-case like every other run failure code; the same reason the
 * credit ledger records as `WORKSPACE_PENDING_DELETION`.
 */
export const WORKSPACE_PENDING_DELETION_FAILURE = 'workspace_pending_deletion';

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
  /**
   * PHASE 2B-3 PR 5 — THE REQUEST STILL HAS SOMEBODY BEHIND IT (owner
   * decisions D1 and D2; the carried "creator authority at confirm" defect and
   * F7's disabled-rule slice).
   *
   * Approving checks the APPROVER — they must hold the action's permission and
   * the brand — and that used to be all. But the request was proposed by a RULE
   * on behalf of its CREATOR, and both can change while it waits: the rule
   * switched off or deleted, the creator removed, their role narrowed, their
   * brands taken away. An approval is a person agreeing to what the rule
   * proposed; it is not a way for the rule to act with authority its creator
   * no longer has, or after its owner turned it off.
   *
   * So the same checks a run makes are made again here, with the same codes:
   * the rule is enabled and not deleted (`rule_disabled`), and the creator is
   * an ACTIVE member who holds the action's permissions and the rule's brand
   * (`creator_no_longer_a_member`, `creator_lost_permission`,
   * `creator_lost_brand_scope`). Any one failing ENDS the request — BLOCKED,
   * audited, gone from Needs you — rather than leaving it waiting for a lapse;
   * nothing is performed.
   *
   * The end is a COMPARE-AND-SWAP on the waiting state, so it never lands on a
   * run that was approved, skipped or lapsed in between; losing that race is
   * an ordinary refusal.
   */
  async #endIfNoLongerAuthorized(
    rule: AutomationRule,
    run: AutomationRun,
    action: ActionDefinition,
    approverUserId: string,
  ): Promise<AutomationRun | null> {
    const refusal = await this.#requestRefusal(rule, action);
    if (!refusal) return null;

    const now = this.#clock.now();
    const ended = await this.#db.automationRun.updateMany({
      where: {
        id: run.id,
        workspaceId: this.#workspaceId,
        status: 'AWAITING_CONFIRMATION',
        confirmedAt: null,
        confirmationExpiresAt: { gt: now },
      },
      data: {
        status: refusal.status,
        failureCode: refusal.code,
        confirmationTokenHash: null,
        finishedAt: now,
        durationMs: Math.max(0, now.getTime() - run.startedAt.getTime()),
      },
    });
    if (ended.count === 0) throw automationConfirmationRejected();

    await this.#db.automationRule.update({
      where: { id: rule.id },
      data: { lastRunAt: now, lastRunStatus: refusal.status, runCount: { increment: 1 } },
    });
    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'automation.run',
      actorType: 'AUTOMATION',
      resourceType: 'AutomationRun',
      resourceId: run.id,
      brandId: rule.brandId,
      traceId: run.correlationId,
      outcome: 'DENIED',
      severity: refusal.status === 'BLOCKED_BY_AUTHORIZATION' ? 'WARNING' : 'INFO',
      reason: refusal.code,
      after: { ruleId: rule.id, status: refusal.status, actionType: rule.actionType },
    });
    await this.#auditRefusal({
      runId: run.id,
      brandId: run.brandId,
      actorUserId: approverUserId,
      reason: refusal.code,
    });
    return this.#db.automationRun.findFirstOrThrow({ where: { id: run.id } });
  }

  /** The first reason this rule may no longer act through its creator, or null. */
  async #requestRefusal(
    rule: AutomationRule,
    action: ActionDefinition,
  ): Promise<{
    readonly status: 'BLOCKED_BY_AUTHORIZATION' | 'BLOCKED_BY_POLICY';
    readonly code: string;
  } | null> {
    const live = await this.#db.automationRule.findFirst({
      where: { id: rule.id, workspaceId: this.#workspaceId },
      select: { enabled: true, deletedAt: true },
    });
    if (!live || !live.enabled || live.deletedAt) {
      return { status: 'BLOCKED_BY_POLICY', code: RULE_DISABLED };
    }
    const creator = await memberAuthority(this.#db, this.#workspaceId, rule.createdByUserId);
    if (!creator) {
      return { status: 'BLOCKED_BY_AUTHORIZATION', code: 'creator_no_longer_a_member' };
    }
    if (!satisfiesActionPermissions(creator.permissionKeys, action.permissions)) {
      return { status: 'BLOCKED_BY_AUTHORIZATION', code: 'creator_lost_permission' };
    }
    if (!brandInScope(creator.brandScope, rule.brandId)) {
      return { status: 'BLOCKED_BY_AUTHORIZATION', code: 'creator_lost_brand_scope' };
    }
    return null;
  }

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
    /*
     * PHASE 2B-3 (PR 1) — ONLY WHAT IS AUTHORABLE MAY BE WRITTEN. A trigger or
     * action that is registered but not authorable is refused with the same
     * error an unknown one gets: to a person writing a new rule, it does not
     * exist. Stored rules that already use one are untouched.
     */
    if (!trigger.authorable || !action.authorable) throw unknownTriggerOrAction();
    /*
     * PHASE 2B-3 PR 4 — AN EVENT THE PLATFORM HAS NOT SET UP CANNOT BE WRITTEN.
     * The analytics events need operator thresholds with no default; a rule
     * written before they exist would be enabled and silent (report §30).
     */
    if (!triggerAvailable(this.#policy, trigger.type)) throw unknownTriggerOrAction();

    /*
     * THE PAIR MUST BE REACHABLE. An action that operates on a content item
     * cannot be authored against a trigger whose reference is an Insight, a
     * MetricObservation, an ingestion run, or nothing at all — the id would be
     * passed to a content operation as if it were a content item's. Refused
     * here, where a person is looking at the screen.
     */
    if (!actionSupportsTrigger(input.actionType, input.triggerType)) {
      throw triggerActionIncompatible();
    }
    // PHASE 2B-3 PR 2 — AND THE PAIR MUST BE ONE THE CATALOGUE OFFERS
    // (`authoringTriggers`, the compatibility table).
    if (!isAuthorablePair(input.triggerType, input.actionType)) {
      throw triggerActionIncompatible();
    }

    // The creator must hold BOTH the authoring permission and the permission the
    // ACTION needs. Holding `automation.manage` is not a way to acquire
    // `publishing.manage` by writing a rule that uses it.
    if (!input.actor.permissionKeys.includes('automation.manage')) throw creatorLacksAuthority();
    if (!satisfiesActionPermissions(input.actor.permissionKeys, action.permissions)) {
      throw creatorLacksAuthority();
    }

    const conditions = conditionsSchema.parse(input.conditions);
    if (conditions.length > this.#policy.limits.maxConditionsPerRule) {
      throw tooManyConditions(this.#policy.limits.maxConditionsPerRule);
    }

    /*
     * A CONDITION MUST READ A FIELD THIS TRIGGER ACTUALLY PRODUCES (R3-3).
     *
     * `conditionsSchema` checks the SHAPE — a declared field, a declared
     * operator, a literal — and a shape can be perfectly valid and still mean
     * nothing: `content.status equals APPROVED` on a scheduled rule names a
     * field no scheduled event ever carries, so it compares FALSE for ever and
     * the rule never fires. The authoring screen no longer offers those
     * combinations, and this is why it cannot be reached by going around it.
     *
     * The table is `CONDITION_FIELD_TRIGGERS`, which is also what the runtime
     * gatherer is held to by the parity test — so "offered", "accepted" and
     * "produced" are one list rather than three.
     */
    this.#requireEvaluableConditions(conditions, input.triggerType, conditionFieldsForRule(input));

    const triggerConfig = trigger.config.parse(input.triggerConfig) as Prisma.InputJsonValue;
    const actionConfig = action.config.parse(input.actionConfig) as Prisma.InputJsonValue;
    await this.#requireActionTargets(action.type, actionConfig, input.brandId);

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
        // Phase 2B-3 PR 2 — listening from now on, never for what came before.
        armedAt: this.#clock.now(),
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
    if (
      input.enabled === true &&
      !satisfiesActionPermissions(input.actor.permissionKeys, action.permissions)
    ) {
      throw creatorLacksAuthority();
    }

    const conditions =
      input.conditions === undefined ? undefined : conditionsSchema.parse(input.conditions);
    if (conditions && conditions.length > this.#policy.limits.maxConditionsPerRule) {
      throw tooManyConditions(this.#policy.limits.maxConditionsPerRule);
    }
    /*
     * THE UPDATE PATH IS THE CREATE PATH'S EQUAL (R4-1).
     *
     * It used to schema-parse the supplied conditions and store them, and that
     * is all — so every rule `createRule` refused could be reached in two calls
     * instead of one: create a rule with no conditions, then update it with the
     * conditions that were never authorable. A field this trigger never
     * produces, an operator this field cannot answer, a value of the wrong
     * kind: all three were a PATCH away.
     *
     * THE TRIGGER IS THE STORED ONE, NEVER A SUPPLIED ONE. A rule's trigger is
     * fixed at creation and this method does not change it, so validating
     * against `existing.triggerType` is validating against the trigger the
     * conditions will actually be evaluated under.
     */
    if (conditions) {
      this.#requireEvaluableConditions(
        conditions,
        existing.triggerType,
        conditionFieldsForRule(existing),
      );
    }

    // Phase 2B-3 PR 2 — switching a rule ON re-arms it: while it was off it
    // was not listening, and what happened then is not replayed into it.
    const switchedOn = input.enabled === true && !existing.enabled;
    // Phase 2B-3 PR 4 — nor switched on while its event is not set up.
    if (switchedOn && !triggerAvailable(this.#policy, existing.triggerType)) {
      throw unknownTriggerOrAction();
    }
    const rule = await this.#db.automationRule.update({
      where: { id: existing.id },
      data: {
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(switchedOn ? { armedAt: this.#clock.now() } : {}),
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

  /**
   * B12 (Phase 2B-2b) — EDIT AN EXISTING RULE: name, description, conditions,
   * and the trigger's and the action's settings.
   *
   * NOT `updateRule`, AND NOT A WAY TO SWITCH A RULE ON. `enabled` is not an
   * input here: enabling stays the separate, action-permission-gated act it has
   * always been, so an edit can never start a rule running. The TYPES of the
   * trigger and the action are fixed at creation and are not inputs either.
   *
   * EVERY FIELD PASSES THE CREATE PATH'S CHECKS. Conditions are schema-parsed,
   * counted and held to the STORED trigger (`#requireEvaluableConditions`);
   * the trigger's and the action's settings are parsed by the registry's own
   * schemas, exactly as `createRule` parses them. A field left `undefined` is
   * left as it is.
   *
   * THE ACTION'S OWN PERMISSION IS RE-CHECKED WHENEVER ITS SETTINGS CHANGE. The
   * settings are part of what the rule does on its creator's authority; holding
   * `automation.manage` is not a way to change what a `content.schedule` action
   * does without holding `content.schedule`.
   *
   * FAIL CLOSED ON A STALE EDIT. The caller names the version it read; the write
   * is conditional on that version, so an edit racing another edit (or a
   * toggle, which also bumps the version) is refused and nothing is stored.
   *
   * A CHANGED TRIGGER SETTING RE-ARMS THE RULE LIKE A NEW ONE: it is due for
   * evaluation now, and a threshold's stored breach state is cleared so the new
   * threshold establishes its baseline before it can fire — the same first
   * evaluation a freshly created rule gets. The threshold cycle is kept, so no
   * run key is ever reused.
   */
  async updateEditableRule(input: {
    ruleId: string;
    expectedVersion: number;
    name?: string | undefined;
    description?: string | null | undefined;
    conditions?: unknown;
    triggerConfig?: unknown;
    actionConfig?: unknown;
    actor: AutomationActor;
  }): Promise<AutomationRule> {
    const existing = await this.#requireRule(input.ruleId, input.actor.brandScope);
    if (!input.actor.permissionKeys.includes('automation.manage')) throw creatorLacksAuthority();
    if (existing.version !== input.expectedVersion) throw automationRuleVersionConflict();

    const trigger = findTrigger(existing.triggerType);
    const action = findAction(existing.actionType);
    /* c8 ignore next -- a stored rule always names registry entries. */
    if (!trigger || !action) throw unknownTriggerOrAction();

    const conditions =
      input.conditions === undefined ? undefined : conditionsSchema.parse(input.conditions);
    if (conditions && conditions.length > this.#policy.limits.maxConditionsPerRule) {
      throw tooManyConditions(this.#policy.limits.maxConditionsPerRule);
    }
    if (conditions) {
      this.#requireEvaluableConditions(
        conditions,
        existing.triggerType,
        conditionFieldsForRule(existing),
      );
    }

    const triggerConfig =
      input.triggerConfig === undefined
        ? undefined
        : (trigger.config.parse(input.triggerConfig) as Prisma.InputJsonValue);
    const actionConfig =
      input.actionConfig === undefined
        ? undefined
        : (action.config.parse(input.actionConfig) as Prisma.InputJsonValue);
    const triggerConfigChanged =
      triggerConfig !== undefined && !sameJson(triggerConfig, existing.triggerConfig);
    const actionConfigChanged =
      actionConfig !== undefined && !sameJson(actionConfig, existing.actionConfig);
    if (
      actionConfigChanged &&
      !satisfiesActionPermissions(input.actor.permissionKeys, action.permissions)
    ) {
      throw creatorLacksAuthority();
    }
    // PHASE 2B-3 PR 2 — a new person or campaign is validated like a new rule's.
    if (actionConfigChanged && actionConfig !== undefined) {
      await this.#requireActionTargets(action.type, actionConfig, existing.brandId);
    }

    const name = input.name === undefined ? undefined : input.name.trim().slice(0, 120);
    if (name !== undefined && name.length === 0) {
      throw new AppError('VALIDATION_FAILED', 'A rule needs a name.');
    }
    if (name !== undefined && name !== existing.name) {
      // Checked here rather than left to the unique index: a violated index
      // aborts the caller's transaction, and the person deserves the reason.
      const clash = await this.#db.automationRule.findFirst({
        where: {
          workspaceId: this.#workspaceId,
          brandId: existing.brandId,
          name,
          id: { not: existing.id },
        },
        select: { id: true },
      });
      if (clash) throw automationRuleNameTaken();
    }
    const description =
      input.description === undefined
        ? undefined
        : input.description === null || input.description.trim() === ''
          ? null
          : input.description.trim().slice(0, 500);

    const changed = [
      ...(name !== undefined && name !== existing.name ? ['name'] : []),
      ...(description !== undefined && description !== existing.description ? ['description'] : []),
      ...(conditions !== undefined && !sameJson(conditions, existing.conditions)
        ? ['conditions']
        : []),
      ...(triggerConfigChanged ? ['triggerConfig'] : []),
      ...(actionConfigChanged ? ['actionConfig'] : []),
    ];

    const now = this.#clock.now();
    const written = await this.#db.automationRule.updateMany({
      where: {
        id: existing.id,
        workspaceId: this.#workspaceId,
        version: input.expectedVersion,
        deletedAt: null,
      },
      data: {
        ...(name === undefined ? {} : { name }),
        ...(description === undefined ? {} : { description }),
        ...(conditions === undefined
          ? {}
          : { conditions: conditions as unknown as Prisma.InputJsonValue }),
        ...(triggerConfig === undefined ? {} : { triggerConfig }),
        ...(actionConfig === undefined ? {} : { actionConfig }),
        ...(triggerConfigChanged
          ? {
              nextEvaluationAt: now,
              thresholdBreached: null,
              thresholdEvaluatedAt: null,
              // Phase 2B-3 PR 2 — a new trigger setting listens from now on.
              armedAt: now,
            }
          : {}),
        updatedByUserId: input.actor.userId,
        version: { increment: 1 },
      },
    });
    if (written.count !== 1) throw automationRuleVersionConflict();
    const rule = await this.#db.automationRule.findUniqueOrThrow({ where: { id: existing.id } });

    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'automation.updated',
      actorType: 'USER',
      actorId: input.actor.userId,
      resourceType: 'AutomationRule',
      resourceId: rule.id,
      brandId: rule.brandId,
      // WHICH fields changed, never their values: a condition can name a person.
      before: { enabled: existing.enabled, version: existing.version },
      after: { enabled: rule.enabled, version: rule.version, changed },
    });
    return rule;
  }

  /** One live rule, through the caller's brand scope; NOT_FOUND otherwise. */
  async getRule(ruleId: string, brandScope: readonly string[]): Promise<AutomationRule> {
    return this.#requireRule(ruleId, brandScope);
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
        /*
         * INTERSECTED, NOT OVERWRITTEN (P6-12). This spread `{ brandId }` and
         * then `{ brandId: { in: scope } }` into the same object, so for any
         * brand-scoped member the later key won and the brand the caller asked
         * for was silently discarded — every in-scope brand's rules came back.
         * The D-267 shape again; `brandIdQueryFilter` ANDs the two.
         */
        ...brandIdQueryFilter({ brandId: input.brandId, brandScope: input.brandScope }),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async listRuns(input: {
    ruleId?: string | undefined;
    /** P6-12 — the brand the screen is showing, intersected with the scope. */
    brandId?: string | undefined;
    brandScope: readonly string[];
    take?: number | undefined;
  }): Promise<readonly AutomationRun[]> {
    return this.#db.automationRun.findMany({
      where: {
        workspaceId: this.#workspaceId,
        ...(input.ruleId ? { ruleId: input.ruleId } : {}),
        ...brandIdQueryFilter({ brandId: input.brandId, brandScope: input.brandScope }),
      },
      orderBy: { startedAt: 'desc' },
      take: Math.max(1, Math.min(input.take ?? 50, 200)),
    });
  }

  /**
   * B12 (Phase 2B-2b) — "NEEDS YOU": the asks-first runs this person may act on.
   *
   * A run waiting for confirmation is shown ONLY to a member who holds the
   * permission the automation's ACTION requires — the same permission `confirmRun`
   * and `skipRun` check — so nobody is offered a decision they could not make.
   * Brand scope is in the WHERE, and a run whose window has closed is not
   * waiting for anybody any more.
   */
  async awaitingRuns(input: {
    brandId?: string | undefined;
    brandScope: readonly string[];
    permissionKeys: readonly string[];
    take?: number | undefined;
  }): Promise<readonly AutomationRun[]> {
    const actionable = AUTOMATION_ACTIONS.filter((action) =>
      satisfiesActionPermissions(input.permissionKeys, action.permissions),
    ).map((action) => action.type);
    if (actionable.length === 0) return [];
    return this.#db.automationRun.findMany({
      where: {
        workspaceId: this.#workspaceId,
        status: 'AWAITING_CONFIRMATION',
        confirmedAt: null,
        confirmationExpiresAt: { gt: this.#clock.now() },
        actionType: { in: actionable },
        ...brandIdQueryFilter({ brandId: input.brandId, brandScope: input.brandScope }),
      },
      orderBy: [{ confirmationExpiresAt: 'asc' }, { id: 'asc' }],
      take: Math.max(1, Math.min(input.take ?? 50, 200)),
    });
  }

  /**
   * B12 (Phase 2B-2b) — SKIP an asks-first run: the person decided NOT to do it.
   *
   * THE SAME GATE AS CONFIRMING, deliberately. The action's own permission,
   * checked against the person skipping (a refusal is audited exactly as a
   * refused confirmation is), and the run's brand against their live scope. A
   * member who could not have confirmed the run cannot dismiss it either — a
   * skip is a decision about the action, not housekeeping.
   *
   * `CANCELLED`, NOT `SKIPPED`. `SKIPPED` already means "the condition did not
   * hold", which is the engine's decision; `CANCELLED` is reserved in the schema
   * for "a decision somebody made", which this is. The run row stays as history
   * with its outcome, and the audit event names who decided.
   *
   * A COMPARE-AND-SWAP on the waiting state: a run confirmed, skipped or expired
   * in between is refused, so a skip never lands on a run that already acted.
   */
  async skipRun(input: { runId: string; actor: AutomationActor }): Promise<AutomationRun> {
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
    if (!satisfiesActionPermissions(input.actor.permissionKeys, action.permissions)) {
      await this.#auditRefusal({
        runId: run.id,
        brandId: run.brandId,
        actorUserId: input.actor.userId,
        reason: 'skipper_lacks_permission',
      });
      throw automationConfirmationRejected();
    }
    if (!brandInScope(input.actor.brandScope, run.brandId)) throw automationConfirmationRejected();

    const now = this.#clock.now();
    const skipped = await this.#db.automationRun.updateMany({
      where: {
        id: run.id,
        workspaceId: this.#workspaceId,
        status: 'AWAITING_CONFIRMATION',
        confirmedAt: null,
        confirmationExpiresAt: { gt: now },
      },
      data: {
        status: 'CANCELLED',
        failureCode: 'skipped_by_member',
        confirmationTokenHash: null,
        finishedAt: now,
      },
    });
    if (skipped.count === 0) throw automationConfirmationRejected();

    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'automation.run_skipped',
      actorType: 'USER',
      actorId: input.actor.userId,
      resourceType: 'AutomationRun',
      resourceId: run.id,
      brandId: run.brandId,
      traceId: run.correlationId,
      after: { ruleId: rule.id, actionType: rule.actionType, status: 'CANCELLED' },
    });
    return this.#db.automationRun.findFirstOrThrow({ where: { id: run.id } });
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
        // A RULE-DERIVED EVENT GOES TO ITS OWN RULE AND NO OTHER. See
        // `TriggerEvent.ruleId`.
        ...(input.event.ruleId ? { id: input.event.ruleId } : {}),
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

    /*
     * PHASE 2B-3 PR 2 — NO BACKFILL (OD-21). A rule reacts to what happens
     * after it is armed: created, switched on, or given new trigger settings.
     * An event older than that is not a run the rule skipped — the rule was
     * not listening — so nothing is recorded, exactly like a disabled rule. A
     * rule stored before PR 2 has no `armedAt` and keeps its behaviour.
     */
    if (rule.armedAt && event.occurredAt && event.occurredAt < rule.armedAt) {
      return { run: null, status: 'NOT_RUN', confirmationToken: null };
    }

    const triggerConfig = (rule.triggerConfig ?? {}) as Record<string, unknown>;
    const idempotencyKey = runIdempotencyKeyFor({
      ruleId: rule.id,
      triggerType: event.type,
      refId: event.refId,
      /*
       * THE EVENT'S OWN IDENTITY, IN THE ORDER THE PRODUCERS ESTABLISH IT.
       *
       * 1. THE OCCURRENCE A TIMED EVENT WAS CREATED FOR. Re-deriving it from
       *    `now` is right for a caller that has just observed the occurrence and
       *    wrong for a message that has been sitting in a queue: a delivery that
       *    slips past the hour boundary would re-derive the NEXT bucket and run
       *    the same schedule a second time (P7-R5). The producer knows which
       *    occurrence it created the event for, so when it says so, that is the
       *    answer.
       *
       * 2. THE OUTBOX EVENT'S OWN KEY, which is what makes the engine and the
       *    producer agree about what "the same event" means (R6). For a
       *    threshold that is the rule's ARMING CYCLE, so a second crossing of an
       *    observation that was revised in place is a second run — and a
       *    redelivery of either event is still one. For a domain event it is
       *    `<trigger>:<refId>`, which is the reference this key already carried,
       *    so nothing about their identity changes.
       *
       * 3. `runBucketFor`, for a caller that composed the event itself rather
       *    than reading it out of the outbox. It answers `'event'` for every
       *    trigger that carries a reference, because there the reference IS the
       *    identity.
       */
      bucket:
        event.occurrence ??
        event.eventKey ??
        runBucketFor({
          triggerType: event.type,
          localDate: await this.#localDateFor(now),
          hourLocal: Number(triggerConfig['hourLocal'] ?? 0),
        }),
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

    /*
     * DO NOT CATCH A UNIQUE-VIOLATION INSIDE THIS TENANT TRANSACTION.
     *
     * PostgreSQL marks a transaction failed after a constraint error. Catching
     * Prisma P2002 in application code does not make that transaction usable
     * again, so the follow-up SELECT for the winning row would fail with 25P02.
     *
     * createMany(..., skipDuplicates: true) maps the de-duplication to
     * INSERT ... ON CONFLICT DO NOTHING instead. That preserves the same
     * database-enforced uniqueness guarantee without poisoning the surrounding
     * withWorkspace transaction when two queue deliveries race.
     */
    const runId = randomUUID();
    const inserted = await this.#db.automationRun.createMany({
      data: [
        {
          id: runId,
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
      ],
      skipDuplicates: true,
    });

    if (inserted.count === 0) {
      const winner = await this.#db.automationRun.findFirst({
        where: { workspaceId: this.#workspaceId, idempotencyKey },
      });
      return winner
        ? { run: winner, status: winner.status, confirmationToken: null }
        : { run: null, status: 'NOT_RUN', confirmationToken: null };
    }

    const run: AutomationRun = await this.#db.automationRun.findFirstOrThrow({
      where: { id: runId, workspaceId: this.#workspaceId },
    });

    /*
     * --- A WORKSPACE PENDING DELETION RUNS NOTHING (D-328, review item 2) ---
     *
     * Read HERE, in the transaction that would perform the action, not taken
     * from whoever enqueued the event: a deletion requested after the
     * scheduler read the rule, or while the event sat in the queue, still
     * stops it. The row is read FOR SHARE, so a deletion request committing
     * concurrently waits for this run rather than slipping in beside it.
     * Not silent: the run ends BLOCKED_BY_POLICY with a stable reason and is
     * audited like every other refusal.
     */
    const closed = await this.#db.$queryRaw<{ pending: boolean }[]>`
      SELECT ("deletionScheduledFor" IS NOT NULL) AS "pending"
        FROM "workspace" WHERE "id" = ${this.#workspaceId}::uuid FOR SHARE`;
    if (closed[0]?.pending === true) {
      return this.#finish(rule, run, 'BLOCKED_BY_POLICY', {
        failureCode: WORKSPACE_PENDING_DELETION_FAILURE,
      });
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

    // --- Phase 2B-3 PR 3: the occurrence still holds -------------------------
    // A timed event is about a row that can change before the event is run: a
    // review decided, a campaign archived, the empty days filled. Re-read, and
    // skip — before any condition or action — when it no longer holds.
    const holds = await occurrenceStillHolds(this.#db, {
      workspaceId: this.#workspaceId,
      brandId: rule.brandId,
      triggerType: event.type,
      ruleId: rule.id,
      refId: event.refId,
      eventKey: event.eventKey ?? null,
      now,
      timezone: () =>
        this.#ports.timezone
          ? this.#ports.timezone.timezoneFor(this.#workspaceId)
          : Promise.resolve('UTC'),
      calendar: this.#ports.calendarDays,
      knowledge: this.#ports.knowledge,
    });
    if (!holds) {
      return this.#finish(rule, run, 'SKIPPED', { failureCode: OCCURRENCE_STALE });
    }

    // --- The conditions ------------------------------------------------------
    const conditions = (rule.conditions as unknown as AutomationCondition[]) ?? [];
    /*
     * PHASE 2B-3 (PR 1) — A VALUE THE RULE NAMES MUST STILL RESOLVE. A deleted
     * campaign, an archived brand, or a person who left or lost this brand
     * would otherwise make a negative condition match everything. The run does
     * not evaluate; it says why. See `conditionValuesResolve`.
     */
    const resolvable = await conditionValuesResolve(this.#db, {
      workspaceId: this.#workspaceId,
      brandId: rule.brandId,
      conditions,
    });
    if (!resolvable) {
      return this.#finish(rule, run, 'SKIPPED', { failureCode: CONDITION_VALUE_UNAVAILABLE });
    }
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
    /*
     * A stored rule always names a registry action unless a row was written
     * around the engine; a registered action that is not executable has no code
     * behind it. Both fail closed, with the same code, BEFORE an asks-first
     * action could reach AWAITING_CONFIRMATION.
     */
    if (!action?.executable) {
      return this.#finish(rule, run, 'FAILED', { failureCode: 'unknown_action' });
    }
    /*
     * A NOTIFY RULE SENDS ONLY `automation.notice` (Fix PR 1 · F5, D-412). The
     * set is enforced when a rule is written; this is the stored rule written
     * before that, or around it, and it fails CLOSED — nothing is sent — rather
     * than reaching a mute filter that cannot classify its template.
     */
    if (
      rule.actionType === 'NOTIFY' &&
      !isAutomationNotifyTemplate(
        (rule.actionConfig as Record<string, unknown> | null)?.['templateKey'],
      )
    ) {
      return this.#finish(rule, run, 'FAILED', { failureCode: NOTIFY_TEMPLATE_NOT_ALLOWED });
    }

    if (!actor) {
      return this.#finish(rule, run, 'BLOCKED_BY_AUTHORIZATION', {
        conditionsHeld: true,
        failureCode: 'creator_no_longer_a_member',
      });
    }
    if (!satisfiesActionPermissions(actor.permissionKeys, action.permissions)) {
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

    // --- AND THE WORKSPACE'S ENTITLEMENT, RE-RESOLVED, EVERY TIME ------------
    const notEntitled = await this.#entitlementRefusal(action);
    if (notEntitled) {
      return this.#finish(rule, run, 'BLOCKED_BY_POLICY', {
        conditionsHeld: true,
        failureCode: notEntitled,
      });
    }

    // --- EXTERNAL ACTIONS STOP HERE ------------------------------------------
    if (isExternalAction(rule.actionType)) {
      return this.#awaitConfirmation(rule, run, event);
    }

    // --- Internal actions run ------------------------------------------------
    try {
      const result = await this.#performInternal(rule, run, event, actor);
      /*
       * PHASE 2B-3 PR 2 — AN ACTION THAT DID NOT ACT SAYS WHY. A G13 executor
       * returns a typed outcome rather than throwing: SKIPPED when there was
       * nothing to do, BLOCKED_BY_POLICY when something a person can fix
       * stood in the way. Either way nothing was changed.
       */
      if ('outcome' in result) {
        return this.#finish(rule, run, ACTION_OUTCOME_STATUS[result.outcome], {
          conditionsHeld: true,
          failureCode: result.outcome,
        });
      }
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
    /*
     * NO CREDENTIAL IS MINTED HERE (R3-4).
     *
     * THE DEFECT THIS CLOSES. This used to mint a raw token, store its digest
     * and RETURN the raw value — to the WORKER, which logs a status and drops
     * it. The notification that tells a permitted person to come and look
     * carries no payload, deliberately, because a live publish credential does
     * not belong in a notification row. So the credential existed for
     * microseconds inside a background process and then nowhere, and every
     * external proposal was unconfirmable.
     *
     * THE CONTRACT IS MINT-ON-DEMAND. The run records that a person is needed
     * and how long they have; `reissueRunConfirmation` mints the live token when
     * an authorized person actually asks for it, and rotates it under a
     * compare-and-swap so two people asking at once leave exactly one.
     *
     * `confirmationExpiresAt` IS THE PROPOSAL'S WINDOW, not a token's. When it
     * closes, the run becomes EXPIRED and the screen stops offering to confirm
     * something that is now days stale.
     */
    const expiresAt = new Date(
      this.#clock.now().getTime() + this.#policy.execution.confirmationTtlSeconds * 1_000,
    );

    const updated = await this.#db.automationRun.update({
      where: { id: run.id },
      data: {
        status: 'AWAITING_CONFIRMATION',
        conditionsHeld: true,
        confirmationTokenHash: null,
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

    return { run: updated, status: 'AWAITING_CONFIRMATION', confirmationToken: null };
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
  /**
   * ISSUE A CONFIRMATION CREDENTIAL TO A PERMITTED HUMAN, ON DEMAND.
   *
   * THE DEFECT THIS CLOSES, FOUND SWEEPING FOR R2-B's CLASS. A run that proposes
   * an external action mints a single-use token, stores its HASH, notifies the
   * people who could act on it — and returns the raw token to its caller, which
   * is the WORKER. The worker logs statuses and drops it. The notification
   * deliberately carries no payload, because a notification is a pointer and a
   * live publish credential does not belong in one.
   *
   * So the token existed for a few microseconds inside a background process and
   * then ceased to exist anywhere. NOBODY COULD EVER CONFIRM AN AUTOMATION'S
   * EXTERNAL ACTION. `PROPOSE_PUBLISH` was authorable, storable, listable — and
   * unreachable, which is the same shape as a trigger with no producer.
   *
   * THE FIX IS NOT TO CARRY THE TOKEN ANYWHERE. It is to mint a fresh one when
   * an authorized person actually asks, which is strictly safer than delivering
   * the original: the credential exists only between this call and the confirm
   * that follows it, and it is bound to a person who holds the action's
   * permission and the brand AT THAT MOMENT rather than to whoever happened to
   * read a notification.
   *
   * EVERY GUARD `confirmRun` APPLIES, APPLIED HERE TOO — the action's own
   * permission against the CONFIRMER, the brand against their live scope — so
   * this is not a side door around the confirmation, it is the front door to it.
   *
   * THE ROTATION IS A COMPARE-AND-SWAP on the digest in flight, so two people
   * asking at once leave exactly one live credential rather than two.
   */
  async reissueRunConfirmation(input: {
    runId: string;
    actor: AutomationActor;
  }): Promise<{ run: AutomationRun; token: string | null }> {
    const run = await this.#db.automationRun.findFirst({
      where: { id: input.runId, workspaceId: this.#workspaceId },
    });
    if (!run) throw automationConfirmationRejected();

    const rule = await this.#db.automationRule.findFirst({
      where: { id: run.ruleId, workspaceId: this.#workspaceId },
    });
    if (!rule) throw automationConfirmationRejected();

    const action = findAction(rule.actionType);
    // A registered action with no code behind it has nothing to confirm.
    if (!action?.executable) throw automationConfirmationRejected();
    if (!satisfiesActionPermissions(input.actor.permissionKeys, action.permissions)) {
      await this.#auditRefusal({
        runId: run.id,
        brandId: run.brandId,
        actorUserId: input.actor.userId,
        reason: 'confirmer_lacks_permission',
      });
      throw automationConfirmationRejected();
    }
    if (!brandInScope(input.actor.brandScope, run.brandId)) throw automationConfirmationRejected();
    // D1 / D2 — the rule and its creator, re-checked before a credential exists.
    const ended = await this.#endIfNoLongerAuthorized(rule, run, action, input.actor.userId);
    if (ended) return { run: ended, token: null };

    const now = this.#clock.now();
    const token = randomUUID() + randomUUID();

    const rotated = await this.#db.automationRun.updateMany({
      where: {
        id: run.id,
        workspaceId: this.#workspaceId,
        status: 'AWAITING_CONFIRMATION',
        confirmedAt: null,
        /*
         * THE RUN MUST STILL BE THE ONE THIS CALLER READ. A run confirmed,
         * cancelled or re-issued in between affects zero rows here.
         *
         * NULL IS THE ORDINARY FIRST CASE, not an edge one: the worker mints
         * nothing, so the first person to ask finds no digest at all. Prisma
         * renders a null here as `IS NULL`, which is exactly the compare-and-swap
         * this needs.
         */
        confirmationTokenHash: run.confirmationTokenHash,
        // THE PROPOSAL'S OWN WINDOW, and the reason this refuses after it closes.
        confirmationExpiresAt: { gt: now },
      },
      /*
       * THE WINDOW IS NOT EXTENDED. Rotating the digest re-issues a credential
       * WITHIN the window the proposal already had; pushing the expiry out on
       * every request would let anybody keep a stale proposal alive indefinitely
       * by asking for a token they never spend.
       */
      data: { confirmationTokenHash: hashToken(token) },
    });
    if (rotated.count === 0) throw automationConfirmationRejected();

    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'automation.confirmation_issued',
      actorType: 'USER',
      actorId: input.actor.userId,
      resourceType: 'AutomationRun',
      resourceId: run.id,
      brandId: run.brandId,
      traceId: run.correlationId,
      severity: 'NOTICE',
      // THE FACT, NEVER THE SECRET.
      after: { ruleId: rule.id, actionType: rule.actionType },
    });

    const updated = await this.#db.automationRun.findFirstOrThrow({ where: { id: run.id } });
    return { run: updated, token };
  }

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
    // A registered action with no code behind it has nothing to confirm.
    if (!action?.executable) throw automationConfirmationRejected();
    if (!satisfiesActionPermissions(input.actor.permissionKeys, action.permissions)) {
      await this.#auditRefusal({
        runId: run.id,
        brandId: run.brandId,
        actorUserId: input.actor.userId,
        reason: 'confirmer_lacks_permission',
      });
      throw automationConfirmationRejected();
    }
    if (!brandInScope(input.actor.brandScope, run.brandId)) throw automationConfirmationRejected();
    /*
     * THE WORKSPACE'S ENTITLEMENT, AGAIN, AT THE MOMENT THE ACTION HAPPENS. A
     * plan that lost the feature while the run waited does not perform it.
     */
    if (await this.#entitlementRefusal(action)) {
      await this.#auditRefusal({
        runId: run.id,
        brandId: run.brandId,
        actorUserId: input.actor.userId,
        reason: 'workspace_not_entitled',
      });
      throw automationConfirmationRejected();
    }
    // D1 / D2 — the rule and its creator, re-checked at the moment of approval.
    const ended = await this.#endIfNoLongerAuthorized(rule, run, action, input.actor.userId);
    if (ended) return ended;

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

    /*
     * THE ITEM IS RESOLVED AGAINST THE CONFIRMER, NOT ASSUMED FROM THE RUN.
     *
     * `run.triggerRefId` is whatever the trigger referenced — a calendar slot, a
     * publish job, or a content item — and it used to be handed to the publish
     * port as a content item id whichever it was. It is resolved here through
     * the registry's declared mapping, with the run's brand and the CONFIRMING
     * PERSON'S live BrandScope in the predicate, so a confirmer who may not act
     * on this brand cannot publish through a rule somebody else wrote.
     */
    const contentItemId = await this.#resolveContentItem(
      rule,
      {
        type: run.triggerType,
        brandId: run.brandId,
        refType: run.triggerRefType,
        refId: run.triggerRefId,
        facts: {},
      },
      input.actor,
    );
    if (!contentItemId) {
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
        contentItemId,
        actorUserId: input.actor.userId,
        // THE CONFIRMER'S LIVE SCOPE, never `[]`. See `PublishPort` (P7-R3).
        actorBrandScope: input.actor.brandScope,
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
  ): Promise<PerformResult> {
    const config = (rule.actionConfig ?? {}) as Record<string, unknown>;
    const idempotencyKey = `automation-run:${run.id}`;

    switch (rule.actionType) {
      case 'NOTIFY': {
        if (!this.#ports.notifications) throw unknownTriggerOrAction();
        // Checked before any action runs (D-412); re-checked so the type is proven here.
        const templateKey = config['templateKey'];
        if (!isAutomationNotifyTemplate(templateKey)) throw unknownTriggerOrAction();
        const result = await this.#ports.notifications.notify({
          workspaceId: this.#workspaceId,
          brandId: rule.brandId,
          templateKey,
          resourceType: event.refType ?? 'AutomationRun',
          resourceId: event.refId ?? run.id,
          idempotencyKey,
        });
        return { metadata: { recipients: result.recipients } };
      }

      case 'SUBMIT_FOR_APPROVAL': {
        if (!this.#ports.approvals) throw unknownTriggerOrAction();
        // RESOLVED AND BOUND, never `event.refId` assumed to be an item id.
        const contentItemId = await this.#resolveContentItem(rule, event, actor);
        if (!contentItemId) throw unknownTriggerOrAction();
        const result = await this.#ports.approvals.submitForApproval({
          workspaceId: this.#workspaceId,
          contentItemId,
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
        if (!this.#ports.calendar) throw unknownTriggerOrAction();
        const contentItemId = await this.#resolveContentItem(rule, event, actor);
        if (!contentItemId) throw unknownTriggerOrAction();
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
          contentItemId,
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

      /*
       * PHASE 2B-3 (G13) — DECLARED, NOT EXECUTABLE. The values exist so the
       * database and the client agree about the enum; each action is wired in
       * the PR that implements it. Until then a stored rule naming one fails
       * closed here, exactly as an unknown action would.
       */
      /*
       * PHASE 2B-3 PR 2 — SCHEDULE IN THE NEXT FREE SLOT. The post the event
       * names, resolved and bound like every content action; a post that is
       * gone, out of the brand, or out of the creator's scope is SKIPPED
       * rather than failed. Every reason the calendar gives not to schedule is
       * a typed outcome.
       */
      case 'SCHEDULE_NEXT_FREE_SLOT': {
        const scheduleNextFreeSlot = this.#ports.calendar?.scheduleNextFreeSlot;
        if (!scheduleNextFreeSlot) throw unknownTriggerOrAction();
        const contentItemId = await this.#resolveContentItem(rule, event, actor);
        if (!contentItemId) return { outcome: 'content_unavailable' };
        const result = await scheduleNextFreeSlot.call(this.#ports.calendar, {
          workspaceId: this.#workspaceId,
          contentItemId,
          actorUserId: actor.userId,
          actorBrandScope: actor.brandScope,
          idempotencyKey,
        });
        if (result.kind === 'refused') return { outcome: result.reason };
        return {
          metadata: { slotId: result.slotId, localTime: result.localTime },
          resourceType: 'CalendarSlot',
          resourceId: result.slotId,
        };
      }

      /*
       * PHASE 2B-3 PR 2 (D4) — NOTIFY A CHOSEN PERSON. The member the rule names
       * is re-checked on every run with the predicate the save used: still
       * ACTIVE, and still able to see this brand. Anyone else ends the run
       * BLOCKED `recipient_unavailable` and nobody is told anything.
       */
      case 'NOTIFY_PERSON': {
        const notifyPerson = this.#ports.notifications?.notifyPerson;
        if (!notifyPerson) throw unknownTriggerOrAction();
        const userId = config['userId'];
        const resolves = await personTargetResolves(this.#db, {
          workspaceId: this.#workspaceId,
          brandId: rule.brandId,
          userId,
        });
        if (!resolves || typeof userId !== 'string') return { outcome: 'recipient_unavailable' };
        const result = await notifyPerson.call(this.#ports.notifications, {
          workspaceId: this.#workspaceId,
          brandId: rule.brandId,
          userId,
          resourceType: event.refType ?? 'AutomationRun',
          resourceId: event.refId ?? run.id,
          idempotencyKey,
        });
        return { metadata: { recipients: result.recipients } };
      }

      /*
       * PHASE 2B-3 PR 2 (D8) — ADD TO A CAMPAIGN, attach-only. The campaign is
       * the rule's own setting, never anything the event names; the port
       * applies the automation's precondition before the campaign service is
       * asked, and a post in review is SKIPPED, never withdrawn.
       */
      case 'ADD_TO_CAMPAIGN': {
        if (!this.#ports.campaigns) throw unknownTriggerOrAction();
        const contentItemId = await this.#resolveContentItem(rule, event, actor);
        if (!contentItemId) return { outcome: 'content_unavailable' };
        const campaignId = config['campaignId'];
        if (typeof campaignId !== 'string') return { outcome: 'campaign_unavailable' };
        const result = await this.#ports.campaigns.addToCampaign({
          workspaceId: this.#workspaceId,
          contentItemId,
          campaignId,
          actorUserId: actor.userId,
          actorBrandScope: actor.brandScope,
          actorPermissionKeys: actor.permissionKeys,
          idempotencyKey,
        });
        if (result.kind === 'refused') return { outcome: result.reason };
        return {
          metadata: { campaignId },
          resourceType: 'ContentItem',
          resourceId: contentItemId,
        };
      }

      /*
       * PHASE 2B-3 PR 2 — MAKE A DRAFT COPY of the post the event names. One
       * copy per run: the run's key is the copy's idempotency key.
       */
      case 'MAKE_DRAFT_COPY': {
        if (!this.#ports.content) throw unknownTriggerOrAction();
        const contentItemId = await this.#resolveContentItem(rule, event, actor);
        if (!contentItemId) return { outcome: 'content_unavailable' };
        const result = await this.#ports.content.makeDraftCopy({
          workspaceId: this.#workspaceId,
          contentItemId,
          actorUserId: actor.userId,
          actorBrandScope: actor.brandScope,
          actorPermissionKeys: actor.permissionKeys,
          idempotencyKey: `duplicate:${idempotencyKey}`,
        });
        if (result.kind === 'refused') return { outcome: result.reason };
        return {
          metadata: { sourceItemId: contentItemId },
          resourceType: 'ContentItem',
          resourceId: result.contentItemId,
        };
      }

      /*
       * PHASE 2B-3 PR 3 — REMIND THE REVIEWER. The review the event names is
       * read FOR SHARE, bound to the workspace and the RULE'S brand, so a
       * verdict (`decide` takes the row FOR UPDATE) waits for this run rather
       * than landing beside it. Decided or withdrawn: SKIPPED
       * `occurrence_stale`. Nobody who may decide it: BLOCKED
       * `no_eligible_reviewer`, and nothing is sent.
       */
      case 'REMIND_REVIEWER': {
        const remindReviewers = this.#ports.approvals?.remindReviewers;
        if (!remindReviewers) throw unknownTriggerOrAction();
        const approvalId = event.refType === 'Approval' ? event.refId : null;
        // Never sent to the database unless it is a uuid: a malformed id would
        // abort the run's whole transaction rather than end one run.
        if (!approvalId || !UUID_PATTERN.test(approvalId)) return { outcome: 'occurrence_stale' };
        const open = await this.#db.$queryRaw<{ pending: boolean }[]>`
          SELECT ("status" = 'PENDING') AS "pending"
            FROM "approval"
           WHERE "id" = ${approvalId}::uuid
             AND "workspaceId" = ${this.#workspaceId}::uuid
             AND "brandId" = ${rule.brandId}::uuid
             FOR SHARE`;
        if (open[0]?.pending !== true) return { outcome: 'occurrence_stale' };
        const result = await remindReviewers.call(this.#ports.approvals, {
          workspaceId: this.#workspaceId,
          brandId: rule.brandId,
          approvalId,
          idempotencyKey,
        });
        if (result.kind === 'refused') return { outcome: result.reason };
        return {
          metadata: { recipients: result.recipients },
          resourceType: 'Approval',
          resourceId: approvalId,
        };
      }

      case 'DRAFT_IDEAS':
      case 'RETRY_PUBLISH':
      case 'PAUSE_CAMPAIGN':
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

  /**
   * The workspace-local date, `YYYY-MM-DD`.
   *
   * IN THE WORKSPACE'S OWN ZONE, via `Intl`, for the same reason
   * `#localTimeFor` is: "the day a rule is scheduled for" is a wall-clock fact,
   * and a UTC slice would put a Sydney customer's 09:00 rule on the previous
   * day's bucket for most of the year. Without a timezone port the zone is UTC,
   * which is stable — the bucket only has to be CONSISTENT, not correct in some
   * absolute sense.
   */
  async #localDateFor(instant: Date): Promise<string> {
    const timezone = this.#ports.timezone
      ? await this.#ports.timezone.timezoneFor(this.#workspaceId)
      : 'UTC';
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(instant);
    const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '00';
    return `${get('year')}-${get('month')}-${get('day')}`;
  }

  /**
   * THE CONTENT ITEM AN ACTION OPERATES ON — resolved, never assumed.
   *
   * WHAT IT REPLACES. `#performInternal` passed `event.refId` straight through as
   * a `contentItemId`, and `confirmRun` did the same with `run.triggerRefId`.
   * That is only correct for `CONTENT_APPROVED`. For `CONTENT_SCHEDULED` the
   * reference is a calendar slot, for `POST_PUBLISHED` a publish job, and for the
   * analytics triggers an Insight, a MetricObservation or an ingestion run — ids
   * that are not content items and must never be used as one.
   *
   * THE MAPPING IS DECLARED IN THE REGISTRY (`contentItemVia`) AND RESOLVED HERE
   * WITH A SCOPED QUERY. Three predicates in every branch's WHERE: the workspace,
   * the RULE'S OWN BRAND, and the actor's LIVE BrandScope. So the item is bound
   * to the brand the rule is for — a slot or a job belonging to another brand
   * resolves to nothing — and an actor whose scope no longer covers that brand
   * resolves to nothing either.
   *
   * NULL IS A REFUSAL, and the caller turns it into a recorded, blocked run
   * rather than an action aimed at the wrong row.
   */
  async #resolveContentItem(
    rule: AutomationRule,
    event: TriggerEvent,
    actor: AutomationActor,
  ): Promise<string | null> {
    const trigger = findTrigger(event.type);
    if (!trigger?.contentItemVia || !event.refId) return null;

    const scoped = {
      workspaceId: this.#workspaceId,
      ...brandIdQueryFilter({ brandId: rule.brandId, brandScope: actor.brandScope }),
    };

    switch (trigger.contentItemVia) {
      case 'direct': {
        const item = await this.#db.contentItem.findFirst({
          where: { id: event.refId, ...scoped },
          select: { id: true },
        });
        return item?.id ?? null;
      }
      case 'calendarSlot': {
        const slot = await this.#db.calendarSlot.findFirst({
          where: { id: event.refId, ...scoped },
          select: { contentItemId: true },
        });
        return slot?.contentItemId ?? null;
      }
      case 'publishJob': {
        const job = await this.#db.publishJob.findFirst({
          where: { id: event.refId, ...scoped },
          select: { contentItemId: true },
        });
        return job?.contentItemId ?? null;
      }
      // Phase 2B-3 PR 2 — POST_FAILED: the attempt, then its job, which carries
      // the brand the scope predicate is asked about.
      case 'publishAttempt': {
        const attempt = await this.#db.publishAttempt.findFirst({
          where: { id: event.refId, workspaceId: this.#workspaceId },
          select: { publishJobId: true },
        });
        if (!attempt) return null;
        const job = await this.#db.publishJob.findFirst({
          where: { id: attempt.publishJobId, ...scoped },
          select: { contentItemId: true },
        });
        return job?.contentItemId ?? null;
      }
      // Phase 2B-3 PR 3 — REVIEW_WAITING_24H: the review cycle carries the brand
      // the scope predicate is asked about, and names its post.
      case 'approval': {
        const approval = await this.#db.approval.findFirst({
          where: { id: event.refId, ...scoped },
          select: { contentItemId: true },
        });
        return approval?.contentItemId ?? null;
      }
    }
  }

  /**
   * WHY THE WORKSPACE MAY NOT PERFORM THIS ACTION NOW — or null when it may.
   *
   * Every key the action declares, asked live. An action that declares none
   * (every action that ships today) is never refused here and never asks the
   * port. One that declares some and finds no port wired is refused: a surface
   * that cannot answer the question does not get to assume the answer is yes.
   */
  async #entitlementRefusal(action: ActionDefinition): Promise<string | null> {
    if (action.entitlements.length === 0) return null;
    const port = this.#ports.entitlements;
    if (!port) return 'entitlement_unavailable';
    for (const key of action.entitlements) {
      if (!(await port.allows(key))) return 'not_entitled';
    }
    return null;
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

  /**
   * A CONDITION MUST BE EVALUABLE, OR IT IS NOT STORED (R3-3, R4-1).
   *
   * `conditionsSchema` checks the SHAPE — a declared field, a declared
   * operator, a literal — and a shape can be perfectly valid and still mean
   * nothing. Three separate ways, each of which used to be storable:
   *
   *   THE FIELD IS NOT PRODUCED by this trigger. `content.status equals
   *   APPROVED` on a scheduled rule names a fact no scheduled event carries.
   *   THE OPERATOR CANNOT ANSWER this field. `brand.id greater_than 5`,
   *   `publish.provider is_true` — `evaluateCondition` refuses a mixed
   *   comparison by design, so both are false for ever.
   *   THE VALUE IS OF THE WRONG KIND. `content.hasCampaign equals "true"`,
   *   which is what an HTML form posts unless somebody stops it.
   *
   * All three look configured. That is what makes them worse than a missing
   * feature: the rule is saved, enabled, listed — and silent.
   *
   * THE TABLES ARE THE REGISTRY'S, so "offered", "accepted" and "produced" stay
   * one list rather than three, and the authoring screen narrows its controls
   * from the same declaration this refuses against.
   */
  #requireEvaluableConditions(
    conditions: readonly AutomationCondition[],
    triggerType: AutomationTrigger,
    fields: readonly ConditionField[],
  ): void {
    for (const condition of conditions) {
      switch (conditionRejection(condition, triggerType, fields)) {
        case 'field':
          throw conditionFieldNotProduced(condition.field);
        case 'operator':
          throw conditionOperatorNotAllowed(condition.field, condition.operator);
        case 'value':
          throw conditionValueInvalid(condition.field, condition.operator);
        case null:
          break;
      }
    }
  }

  /**
   * PHASE 2B-3 PR 2 — SAVE-TIME VALIDATION OF WHAT AN ACTION NAMES. The same
   * predicate every run applies (`action-targets.ts`); a refusal is shaped like
   * a genuine miss (D-132).
   */
  async #requireActionTargets(
    actionType: AutomationActionType,
    actionConfig: Prisma.InputJsonValue,
    brandId: string,
  ): Promise<void> {
    const config = (actionConfig ?? {}) as Record<string, unknown>;
    if (actionType === 'NOTIFY_PERSON') {
      const ok = await personTargetResolves(this.#db, {
        workspaceId: this.#workspaceId,
        brandId,
        userId: config['userId'],
      });
      if (!ok) throw automationTargetNotFound();
    }
    if (actionType === 'ADD_TO_CAMPAIGN') {
      const ok = await campaignTargetResolves(this.#db, {
        workspaceId: this.#workspaceId,
        brandId,
        campaignId: config['campaignId'],
      });
      if (!ok) throw automationTargetNotFound();
    }
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

/**
 * Two stored JSON values mean the same thing. Key order is not meaning: a
 * config parsed by Zod and the same config read back from `jsonb` may list
 * their keys differently.
 */
function sameJson(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value as Record<string, unknown>)
          .sort()
          .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
      );
    }
    return value;
  };
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}
