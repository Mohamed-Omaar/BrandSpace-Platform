import { z } from 'zod';
import type {
  AutomationActionType,
  AutomationTrigger,
  CopilotActionClass,
} from '@brandspace/database';

/**
 * THE AUTOMATION REGISTRY — closed triggers, closed conditions, closed actions.
 *
 * WHAT IS DELIBERATELY IMPOSSIBLE HERE, and why each one is worth the narrower
 * product:
 *
 *   - NO CUSTOMER CODE, NO `eval`, NO EXPRESSION LANGUAGE. A rule engine that
 *     evaluates customer-authored expressions is a code-execution surface in a
 *     multi-tenant platform, and every sandbox for one is a CVE waiting to be
 *     written. A condition here is a declared FIELD, a declared OPERATOR and a
 *     literal — three things a schema can check.
 *   - NO ARBITRARY SQL. The fields a condition may read are named below and
 *     resolved by code; there is no path from a rule to a query the customer
 *     shaped.
 *   - NO WEBHOOK AND NO ARBITRARY URL ACTION. Customer-controlled outbound
 *     requests from a platform's own network is a server-side request forgery
 *     primitive handed over as a feature, and it is explicitly out of scope for
 *     this phase.
 *   - NO CONFIGURABLE ACTION LIST. The registry is CODE. A configurable one is
 *     one migration away from an action nobody reviewed.
 *
 * WHAT AN ACTION IS: a call into a domain service the platform already owns,
 * reached through an injected PORT (see `ports.ts`). The set of things an
 * automation can do is therefore visible at the wiring site, as a short list,
 * rather than being the whole surface of every package this one imports.
 */

/**
 * WHY `ANOMALY_DETECTED` IS NOT IN THIS LIST (A1).
 *
 * It was, and it could never have fired. The trigger declared an `Insight` as
 * its reference, and NOTHING IN THE PLATFORM EVER CREATES AN INSIGHT OF TYPE
 * `ANOMALY`: `detectAnomalies` is pure arithmetic that `StrategyService` and the
 * learning write-back call in-process and never persist a finding from. So the
 * product offered a customer a rule, let them name an action for it, stored it,
 * listed it — and there was no code path in the system that could ever deliver
 * it an event.
 *
 * A DEAD TRIGGER IS WORSE THAN A MISSING ONE. A missing feature is visibly
 * missing; a rule that is configured, enabled and silent teaches a customer that
 * automations do not work, and they are right. It is removed from the AUTHORABLE
 * registry rather than from the database enum: `findTrigger` now returns
 * undefined for it, so `createRule` refuses it and `actionSupportsTrigger` fails
 * closed, while any row that already names it keeps its meaning and its history.
 *
 * It comes back when an anomaly is a ROW somebody can point at — an `Insight`
 * with its baseline, window and deviation persisted — and not before.
 *
 * Which triggers a rule may fire on, and what each one carries.
 */
export interface TriggerDefinition {
  readonly type: AutomationTrigger;
  readonly config: z.ZodTypeAny;
  /** What the run's `triggerRefType` will be, or null for a timed trigger. */
  readonly refType: string | null;
  /**
   * HOW — IF AT ALL — A CONTENT ITEM IS REACHED FROM THIS TRIGGER'S REFERENCE.
   *
   * Three actions operate on a content item and used to take `event.refId` and
   * pass it straight through as one. That is only true for `CONTENT_APPROVED`.
   * For `METRIC_THRESHOLD_CROSSED` the reference is a MetricObservation, for
   * `ANALYTICS_REFRESHED` an ingestion run and for `SCHEDULED_TIME` nothing at
   * all — so a rule pairing one of those with "place it on the calendar" was
   * aiming a content operation at an id that is not a content item's.
   *
   * `null` MEANS THE PAIRING IS NOT AUTHORABLE, and `createRule` refuses it. The
   * other three name an EXPLICIT, SAFE MAPPING the engine resolves with a scoped
   * query rather than by assuming the ids interchange.
   */
  readonly contentItemVia: 'direct' | 'calendarSlot' | 'publishJob' | null;
  /**
   * Does this trigger's identity come from a CLOCK rather than from a row?
   *
   * Only the timed one. It is what decides whether a run's idempotency key
   * carries a time bucket (P7-R5): an event with a reference is identified by
   * that reference for ever, and bucketing it by the wall-clock hour made a
   * delayed redelivery look like a new event and run the rule twice.
   */
  readonly timeBucketed: boolean;
  readonly messageKey: string;
}

const emptyConfig = z.object({}).default({});

export const AUTOMATION_TRIGGERS = [
  {
    type: 'CONTENT_APPROVED',
    config: emptyConfig,
    refType: 'ContentItem',
    contentItemVia: 'direct',
    timeBucketed: false,
    messageKey: 'contentApproved',
  },
  {
    type: 'CONTENT_SCHEDULED',
    config: emptyConfig,
    refType: 'CalendarSlot',
    contentItemVia: 'calendarSlot',
    timeBucketed: false,
    messageKey: 'contentScheduled',
  },
  {
    type: 'POST_PUBLISHED',
    config: emptyConfig,
    refType: 'PublishJob',
    contentItemVia: 'publishJob',
    timeBucketed: false,
    messageKey: 'postPublished',
  },
  {
    type: 'ANALYTICS_REFRESHED',
    config: emptyConfig,
    refType: 'AnalyticsIngestionRun',
    contentItemVia: null,
    timeBucketed: false,
    messageKey: 'analyticsRefreshed',
  },
  {
    type: 'METRIC_THRESHOLD_CROSSED',
    config: z.object({
      metricKey: z.string().min(1).max(60),
      direction: z.enum(['above', 'below']),
      /** An integer in the metric's own unit. Integers all the way down. */
      threshold: z.number().int(),
      /** How many days of the metric the threshold is evaluated over. */
      windowDays: z.number().int().min(1).max(90).default(7),
    }),
    refType: 'MetricObservation',
    contentItemVia: null,
    timeBucketed: false,
    messageKey: 'metricThreshold',
  },
  {
    type: 'SCHEDULED_TIME',
    config: z.object({
      /** 0 = Sunday. Empty means every day. */
      daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).default([]),
      /** Whole hour in the workspace's own zone. */
      hourLocal: z.number().int().min(0).max(23),
    }),
    refType: null,
    contentItemVia: null,
    timeBucketed: true,
    messageKey: 'scheduledTime',
  },
] as const satisfies readonly TriggerDefinition[];

/**
 * THE FIELDS A CONDITION MAY READ. A closed list, resolved by code.
 *
 * Each one is something the run's own context already carries, so evaluating a
 * condition never issues a query the customer shaped — it reads a value the
 * engine put there.
 */
export const CONDITION_FIELDS = [
  'content.status',
  'content.pillar',
  'content.platformCount',
  'content.hasCampaign',
  'publish.provider',
  'publish.failureClass',
  'metric.key',
  'metric.value',
  'metric.changeMilli',
  'brand.id',
] as const;
export type ConditionField = (typeof CONDITION_FIELDS)[number];

/**
 * WHICH TRIGGER CONTEXTS ACTUALLY PRODUCE EACH FIELD (R3-3).
 *
 * THE DEFECT THIS CLOSES. `CONDITION_FIELDS` is the list a customer may choose
 * from, and it was a list of NAMES with no stated relationship to the facts the
 * runtime gathers. `metric.changeMilli` was offered and never produced by
 * anything; `content.*` was offered on a trigger whose reference is an ingestion
 * run, where it can never resolve. A condition that always compares FALSE is
 * worse than a missing feature, because it looks configured: the rule is saved,
 * enabled, listed — and silent.
 *
 * SO THE MAPPING IS DECLARED, ONCE, HERE. The authoring UI offers a field only
 * where this says it is produced, `gatherFacts` produces exactly these, and a
 * parity test walks this table against the real gatherer on real PostgreSQL. A
 * field added without a producer fails the build; a producer removed without its
 * field fails it too.
 *
 * EXHAUSTIVE BY TYPE: every `ConditionField` must appear, and TypeScript refuses
 * the file if one is missing.
 */
export const CONDITION_FIELD_TRIGGERS: Record<ConditionField, readonly AutomationTrigger[]> = {
  // The brand is on every event, because `deliver` selects rules BY brand.
  'brand.id': [
    'CONTENT_APPROVED',
    'CONTENT_SCHEDULED',
    'POST_PUBLISHED',
    'ANALYTICS_REFRESHED',
    'METRIC_THRESHOLD_CROSSED',
    'SCHEDULED_TIME',
  ],
  // Reachable wherever a content item is reachable — which is exactly where
  // `contentItemVia` is not null.
  'content.status': ['CONTENT_APPROVED', 'CONTENT_SCHEDULED', 'POST_PUBLISHED'],
  'content.pillar': ['CONTENT_APPROVED', 'CONTENT_SCHEDULED', 'POST_PUBLISHED'],
  'content.platformCount': ['CONTENT_APPROVED', 'CONTENT_SCHEDULED', 'POST_PUBLISHED'],
  'content.hasCampaign': ['CONTENT_APPROVED', 'CONTENT_SCHEDULED', 'POST_PUBLISHED'],
  // Only the publish job carries these.
  'publish.provider': ['POST_PUBLISHED'],
  'publish.failureClass': ['POST_PUBLISHED'],
  // Only the threshold trigger, because only it names the metric and the window
  // the numbers are measured over.
  'metric.key': ['METRIC_THRESHOLD_CROSSED'],
  'metric.value': ['METRIC_THRESHOLD_CROSSED'],
  'metric.changeMilli': ['METRIC_THRESHOLD_CROSSED'],
};

/**
 * The fields a customer may choose for THIS trigger.
 *
 * The authoring screen calls this, so a picker can never offer a field that
 * would compare false for ever on the rule being written.
 */
export function conditionFieldsFor(trigger: AutomationTrigger): readonly ConditionField[] {
  return CONDITION_FIELDS.filter((field) => CONDITION_FIELD_TRIGGERS[field].includes(trigger));
}

export const CONDITION_OPERATORS = [
  'equals',
  'not_equals',
  'greater_than',
  'less_than',
  'in',
  'not_in',
  'is_true',
  'is_false',
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export const conditionSchema = z.object({
  field: z.enum(CONDITION_FIELDS),
  operator: z.enum(CONDITION_OPERATORS),
  /**
   * A LITERAL, and only a literal: a string, a number, a boolean or a short list
   * of strings. Not an object, not a nested condition, not a reference to another
   * field — every one of which is the first step toward an expression language.
   */
  value: z
    .union([z.string().max(200), z.number(), z.boolean(), z.array(z.string().max(80)).max(20)])
    .optional(),
});
export type AutomationCondition = z.infer<typeof conditionSchema>;

export const conditionsSchema = z.array(conditionSchema).max(20).default([]);

export interface ActionDefinition {
  readonly type: AutomationActionType;
  readonly config: z.ZodTypeAny;
  /**
   * THE ACTION CLASS, shared with the Copilot's vocabulary on purpose.
   *
   * An automation is not a second answer to "is this dangerous?" — it is the same
   * question reached by a different door, and the same three classes answer it.
   * `EXTERNAL_OR_DESTRUCTIVE` here means the run stops at AWAITING_CONFIRMATION
   * and a person decides, exactly as a Copilot plan does.
   */
  readonly actionClass: CopilotActionClass;
  /** The workspace permission the rule's CREATOR must still hold at RUN time. */
  readonly permission: string;
  /**
   * Does this action operate on a CONTENT ITEM?
   *
   * When it does, it may only be paired with a trigger that declares a
   * `contentItemVia` mapping. See `actionSupportsTrigger`.
   */
  readonly needsContentItem: boolean;
  readonly messageKey: string;
}

export const AUTOMATION_ACTIONS = [
  {
    type: 'NOTIFY',
    config: z.object({
      /** A notification template key. A closed set in `@brandspace/notifications`. */
      templateKey: z.string().min(1).max(60),
    }),
    actionClass: 'READ_ONLY',
    // Notifying members about their own workspace's events needs no more than
    // being able to see the workspace; the notification carries a pointer, and
    // following it applies the ordinary permission checks.
    permission: 'workspace.read',
    // A notification points at whatever fired the rule, whatever that is.
    needsContentItem: false,
    messageKey: 'notify',
  },
  {
    type: 'SUBMIT_FOR_APPROVAL',
    config: emptyConfig,
    actionClass: 'INTERNAL_REVERSIBLE',
    permission: 'content.submit',
    needsContentItem: true,
    messageKey: 'submitForApproval',
  },
  {
    type: 'PLACE_ON_CALENDAR',
    config: z.object({
      /** Hours from the trigger. A rule places content relative to its event. */
      offsetHours: z
        .number()
        .int()
        .min(0)
        .max(24 * 30),
      hourLocal: z.number().int().min(0).max(23).optional(),
    }),
    actionClass: 'INTERNAL_REVERSIBLE',
    permission: 'content.schedule',
    needsContentItem: true,
    messageKey: 'placeOnCalendar',
  },
  {
    type: 'PROPOSE_PUBLISH',
    config: emptyConfig,
    /*
     * THE EXTERNAL ONE, AND THE ONLY ONE.
     *
     * It never executes on its own. The run reaches AWAITING_CONFIRMATION, the
     * workspace is notified, and a permitted human confirms the exact action — the
     * same boundary the Copilot enforces, reached by a different door. A CHECK
     * constraint on `automation_rule` refuses a rule of this type that does not
     * require confirmation, so no future editor can switch it off.
     */
    actionClass: 'EXTERNAL_OR_DESTRUCTIVE',
    permission: 'publishing.manage',
    needsContentItem: true,
    messageKey: 'proposePublish',
  },
] as const satisfies readonly ActionDefinition[];

const TRIGGERS_BY_TYPE = new Map<string, TriggerDefinition>(
  AUTOMATION_TRIGGERS.map((trigger) => [trigger.type, trigger]),
);
const ACTIONS_BY_TYPE = new Map<string, ActionDefinition>(
  AUTOMATION_ACTIONS.map((action) => [action.type, action]),
);

export function findTrigger(type: string): TriggerDefinition | undefined {
  return TRIGGERS_BY_TYPE.get(type);
}

export function findAction(type: string): ActionDefinition | undefined {
  return ACTIONS_BY_TYPE.get(type);
}

/**
 * MAY THIS ACTION BE AUTHORED AGAINST THIS TRIGGER?
 *
 * The compatibility rule, in one place, asked at authoring time so an impossible
 * rule cannot be stored — and asked again at run time by the resolution that
 * needs the mapping, so a rule stored before this existed fails closed rather
 * than acting on the wrong id.
 *
 * An unknown trigger or action is NOT compatible: failing closed is the only
 * safe answer for a pair nobody has reasoned about.
 */
export function actionSupportsTrigger(
  actionType: AutomationActionType,
  triggerType: AutomationTrigger,
): boolean {
  const action = findAction(actionType);
  const trigger = findTrigger(triggerType);
  if (!action || !trigger) return false;
  if (!action.needsContentItem) return true;
  return trigger.contentItemVia !== null;
}

/** Does this action leave the platform, and therefore need a person? */
export function isExternalAction(type: AutomationActionType): boolean {
  return findAction(type)?.actionClass === 'EXTERNAL_OR_DESTRUCTIVE';
}

/**
 * Evaluate one condition against the facts the engine gathered.
 *
 * NO COERCION SURPRISES. A comparison between a number and a string is FALSE
 * rather than NaN-ish or truthy: a rule whose condition silently became "always
 * true" because of a type mismatch would publish things nobody asked for, and
 * that is the worst failure mode this engine has.
 */
export function evaluateCondition(
  condition: AutomationCondition,
  facts: Readonly<Record<string, unknown>>,
): boolean {
  const actual = facts[condition.field];

  switch (condition.operator) {
    case 'is_true':
      return actual === true;
    case 'is_false':
      return actual === false;
    case 'equals':
      return actual === condition.value;
    case 'not_equals':
      return actual !== condition.value;
    case 'greater_than':
      return typeof actual === 'number' && typeof condition.value === 'number'
        ? actual > condition.value
        : false;
    case 'less_than':
      return typeof actual === 'number' && typeof condition.value === 'number'
        ? actual < condition.value
        : false;
    case 'in':
      return Array.isArray(condition.value) && typeof actual === 'string'
        ? condition.value.includes(actual)
        : false;
    case 'not_in':
      return Array.isArray(condition.value) && typeof actual === 'string'
        ? !condition.value.includes(actual)
        : false;
  }
}

/** ALL conditions must hold. There is no `OR`, and that is deliberate. */
export function evaluateConditions(
  conditions: readonly AutomationCondition[],
  facts: Readonly<Record<string, unknown>>,
): boolean {
  /*
   * NO BOOLEAN ALGEBRA, ON PURPOSE. `AND` over a flat list is the whole grammar:
   * it is trivially readable in a rule editor, trivially testable, and cannot
   * express the kind of nested condition a person writes at 6pm and misreads at
   * 9am. A rule that needs `OR` is two rules, and two rules are two run histories
   * a person can actually audit.
   */
  return conditions.every((condition) => evaluateCondition(condition, facts));
}
