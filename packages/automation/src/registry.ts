import { z } from 'zod';
import type {
  AutomationActionType,
  AutomationTrigger,
  ContentStatus,
  ContentType,
  CopilotActionClass,
  PublishFailureClass,
  SocialProvider,
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
  readonly contentItemVia: 'direct' | 'calendarSlot' | 'publishJob' | 'publishAttempt' | null;
  /**
   * Does this trigger's identity come from a CLOCK rather than from a row?
   *
   * Only the timed one. It is what decides whether a run's idempotency key
   * carries a time bucket (P7-R5): an event with a reference is identified by
   * that reference for ever, and bucketing it by the wall-clock hour made a
   * delayed redelivery look like a new event and run the rule twice.
   */
  readonly timeBucketed: boolean;
  /**
   * PHASE 2B-3 (PR 1) — IS THIS EVENT ADDRESSED TO ONE RULE?
   *
   * A domain event belongs to the brand and every listening rule sees it; a
   * rule-derived event is computed from one rule's own configuration and goes
   * to that rule alone. The database says the same thing in
   * `automation_event_rule_addressed_when_derived`, and a unit test holds the
   * two to one list.
   */
  readonly ruleAddressed: boolean;
  /**
   * MAY A NEW RULE BE WRITTEN ON THIS TRIGGER? Asked by `createRule`, the
   * authoring screen and the Copilot's rule check. A stored rule on a trigger
   * that is not authorable keeps running, and the rule list captions it as an
   * older automation.
   */
  readonly authorable: boolean;
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
    ruleAddressed: false,
    authorable: true,
    messageKey: 'contentApproved',
  },
  {
    type: 'CONTENT_SCHEDULED',
    config: emptyConfig,
    refType: 'CalendarSlot',
    contentItemVia: 'calendarSlot',
    timeBucketed: false,
    ruleAddressed: false,
    authorable: true,
    messageKey: 'contentScheduled',
  },
  {
    type: 'POST_PUBLISHED',
    config: emptyConfig,
    refType: 'PublishJob',
    contentItemVia: 'publishJob',
    timeBucketed: false,
    ruleAddressed: false,
    authorable: true,
    messageKey: 'postPublished',
  },
  /*
   * PHASE 2B-3 PR 2 — ONE PUBLISH JOB REACHED FAILED. A domain event for every
   * listening rule on the brand, produced by the pipeline's one FAILED writer
   * and referencing the attempt that concluded the failure; the content item
   * is reached through that attempt's job.
   */
  {
    type: 'POST_FAILED',
    config: emptyConfig,
    refType: 'PublishAttempt',
    contentItemVia: 'publishAttempt',
    timeBucketed: false,
    ruleAddressed: false,
    authorable: true,
    messageKey: 'postFailed',
  },
  {
    type: 'ANALYTICS_REFRESHED',
    config: emptyConfig,
    refType: 'AnalyticsIngestionRun',
    contentItemVia: null,
    timeBucketed: false,
    ruleAddressed: false,
    authorable: true,
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
    ruleAddressed: true,
    authorable: true,
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
    ruleAddressed: true,
    authorable: true,
    messageKey: 'scheduledTime',
  },
] as const satisfies readonly TriggerDefinition[];

/**
 * PHASE 2B-3 (G13) — TRIGGERS THAT ARE DECLARED AND NOT YET AUTHORABLE.
 *
 * THE DATABASE ALREADY KNOWS THESE VALUES (M1a) AND THE OUTBOX CHECKS ALREADY
 * NAME THEIR REFERENCES (M1c). This table is the code's half of the same
 * statement: what each one references and whether it is addressed to one rule.
 *
 * NOT IN `AUTOMATION_TRIGGERS`, ON PURPOSE (D-173). A trigger with no producer
 * is one a customer could write a rule on and watch never fire, so `findTrigger`
 * does not return these: `createRule` refuses them, `actionSupportsTrigger`
 * fails closed on them and the authoring screen never lists them. Each one moves
 * into `AUTOMATION_TRIGGERS` in the pull request that ships its producer.
 */
export interface PlannedTriggerDefinition {
  readonly type: AutomationTrigger;
  readonly refType: string | null;
  readonly ruleAddressed: boolean;
  readonly authorable: false;
  readonly executable: false;
}

export const PLANNED_AUTOMATION_TRIGGERS = [
  {
    type: 'REVIEW_WAITING_24H',
    refType: 'Approval',
    ruleAddressed: true,
    authorable: false,
    executable: false,
  },
  {
    type: 'CAMPAIGN_STARTED',
    refType: 'Campaign',
    ruleAddressed: true,
    authorable: false,
    executable: false,
  },
  {
    type: 'CAMPAIGN_ENDED',
    refType: 'Campaign',
    ruleAddressed: true,
    authorable: false,
    executable: false,
  },
  // A change of a rule's own state, so there is no row to point at.
  {
    type: 'WEEKLY_ENGAGEMENT_DROPPED',
    refType: null,
    ruleAddressed: true,
    authorable: false,
    executable: false,
  },
  {
    type: 'SCHEDULE_GAP',
    refType: null,
    ruleAddressed: true,
    authorable: false,
    executable: false,
  },
  {
    type: 'POST_TOP_10_PERCENT',
    refType: 'ContentItem',
    ruleAddressed: true,
    authorable: false,
    executable: false,
  },
  {
    type: 'FACT_EXPIRING',
    refType: 'BrandKnowledgeItem',
    ruleAddressed: true,
    authorable: false,
    executable: false,
  },
] as const satisfies readonly PlannedTriggerDefinition[];

/**
 * TRIGGERS THE DATABASE ENUM KEEPS AND THE REGISTRY RETIRED. Named so the
 * parity test can say every enum value is accounted for exactly once.
 */
export const RETIRED_AUTOMATION_TRIGGERS = [
  'ANOMALY_DETECTED',
] as const satisfies readonly AutomationTrigger[];

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
  // B12 + G13 option (a), Phase 2B-2b — the values a rule can name.
  'content.campaignId',
  'content.type',
  'content.authorUserId',
  // Phase 2B-3 (PR 1) — the post's channels, as a SET of providers.
  'content.channels',
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
    'POST_FAILED',
    'ANALYTICS_REFRESHED',
    'METRIC_THRESHOLD_CROSSED',
    'SCHEDULED_TIME',
  ],
  // Reachable wherever a content item is reachable — which is exactly where
  // `contentItemVia` is not null.
  'content.status': ['CONTENT_APPROVED', 'CONTENT_SCHEDULED', 'POST_PUBLISHED', 'POST_FAILED'],
  'content.pillar': ['CONTENT_APPROVED', 'CONTENT_SCHEDULED', 'POST_PUBLISHED', 'POST_FAILED'],
  'content.platformCount': [
    'CONTENT_APPROVED',
    'CONTENT_SCHEDULED',
    'POST_PUBLISHED',
    'POST_FAILED',
  ],
  'content.hasCampaign': ['CONTENT_APPROVED', 'CONTENT_SCHEDULED', 'POST_PUBLISHED', 'POST_FAILED'],
  'content.campaignId': ['CONTENT_APPROVED', 'CONTENT_SCHEDULED', 'POST_PUBLISHED', 'POST_FAILED'],
  'content.type': ['CONTENT_APPROVED', 'CONTENT_SCHEDULED', 'POST_PUBLISHED', 'POST_FAILED'],
  'content.authorUserId': [
    'CONTENT_APPROVED',
    'CONTENT_SCHEDULED',
    'POST_PUBLISHED',
    'POST_FAILED',
  ],
  'content.channels': ['CONTENT_APPROVED', 'CONTENT_SCHEDULED', 'POST_PUBLISHED', 'POST_FAILED'],
  // Only the publish job carries these. A failed post carries its class.
  'publish.provider': ['POST_PUBLISHED'],
  'publish.failureClass': ['POST_PUBLISHED', 'POST_FAILED'],
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

/**
 * PHASE 2B-3 PR 2 — THE CONDITIONS A NEW G13 RULE MAY NAME, PER TRIGGER.
 *
 * NARROWER THAN WHAT THE TRIGGER PRODUCES, ON PURPOSE. A G13 rule reads the
 * post's channels, campaign, format and author; a failed post also its failure
 * class. `content.status`, `content.pillar`, `content.platformCount`,
 * `brand.id` and `publish.provider` are still produced — stored rules that name
 * them keep evaluating — but a new rule is not offered them.
 *
 * Every list is a subset of the produced table (a unit test holds it), so a
 * field offered here is always a field the gatherer emits.
 */
const G13_CONTENT_CONDITION_FIELDS = [
  'content.channels',
  'content.campaignId',
  'content.hasCampaign',
  'content.type',
  'content.authorUserId',
] as const satisfies readonly ConditionField[];

export const AUTHORING_CONDITION_FIELDS: Partial<
  Record<AutomationTrigger, readonly ConditionField[]>
> = {
  CONTENT_APPROVED: G13_CONTENT_CONDITION_FIELDS,
  POST_PUBLISHED: G13_CONTENT_CONDITION_FIELDS,
  POST_FAILED: [...G13_CONTENT_CONDITION_FIELDS, 'publish.failureClass'],
};

/**
 * The fields a NEW G13 rule on this trigger may name. A trigger without its own
 * list offers what it produces, as before.
 */
export function authorableConditionFieldsFor(
  trigger: AutomationTrigger,
): readonly ConditionField[] {
  return AUTHORING_CONDITION_FIELDS[trigger] ?? conditionFieldsFor(trigger);
}

/**
 * THE FIELDS THIS RULE MAY NAME — on create and on every edit.
 *
 * A G13 rule is held to the G13 list for its trigger. A rule on a pre-G13
 * action keeps the whole produced table, so a stored rule (and, before the
 * catalogue flip, a new one on the old catalogue) can keep every condition it
 * could always name. After the flip every new rule is a G13 rule, so this is
 * the per-trigger list for everything a person can write.
 */
export function conditionFieldsForRule(rule: {
  readonly triggerType: AutomationTrigger;
  readonly actionType: AutomationActionType;
}): readonly ConditionField[] {
  return findAction(rule.actionType)?.catalogue === 'g13'
    ? authorableConditionFieldsFor(rule.triggerType)
    : conditionFieldsFor(rule.triggerType);
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
  // Phase 2B-3 (PR 1) — membership of ONE value in a SET-valued fact.
  'includes',
  'excludes',
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

/**
 * WHAT EACH FIELD'S VALUE ACTUALLY IS (R4-1).
 *
 * THE DEFECT THIS CLOSES. `CONDITION_FIELD_TRIGGERS` made "offered", "accepted"
 * and "produced" one list for FIELDS, and the operator half was left exactly as
 * it had always been: the authoring screen rendered every operator for every
 * field, and the server accepted every pair a schema could parse. So a customer
 * could save `brand.id greater_than 5`, `publish.provider is_true`, or
 * `metric.value in [...]` — each one stored, listed, enabled, and each one
 * FALSE for ever, because `evaluateCondition` refuses a mixed comparison by
 * design. And `content.hasCampaign equals true` was worse than false: the form
 * posted the STRING `"true"` against a real boolean fact, so the one condition
 * a person would most expect to work never did.
 *
 * That is the same product defect class as the field one: a control that is
 * selectable, stored, and looks valid, and can never behave as the customer
 * expects.
 *
 * SO THE VALUE CONTRACT IS DECLARED, ONCE, HERE, beside the trigger table. The
 * authoring screen derives its operator list, its value control AND its parsing
 * from it; the engine validates against it INDEPENDENTLY, on create and on
 * update, because a server that trusts a form is a server with no validation.
 */
export type ConditionValueKind = 'string' | 'number' | 'boolean' | 'stringSet';

export interface ConditionFieldContract {
  /** The runtime type of the fact, and therefore of any literal compared to it. */
  readonly kind: ConditionValueKind;
  /**
   * The operators that can be SATISFIED for this field — not merely parsed.
   * Every one of them has a value the UI can really produce and a fact the
   * gatherer really emits, and a test walks the whole table proving it.
   */
  readonly operators: readonly ConditionOperator[];
  /**
   * A CLOSED SET THE ENGINE ENFORCES, or `null` when the legal values are not
   * knowable in code. A closed set is checked server-side: a condition naming a
   * status that does not exist is refused rather than stored as a rule that can
   * never match.
   */
  readonly options: readonly string[] | null;
  /**
   * For a field whose legal values are TENANT DATA or CONFIGURATION rather than
   * a code enum, which catalogue the authoring screen should offer.
   *
   * IT IS AN AFFORDANCE, NEVER A CHECK. A brand id is authorised by the
   * BrandScope predicate on the query that uses it and a metric key by the
   * analytics catalogue; this only decides which list a person picks from.
   */
  readonly catalogue: 'brands' | 'metricKeys' | 'campaigns' | 'members' | null;
  /**
   * B12 (Phase 2B-2b) — WHEN THE FACT CANNOT BE RESOLVED, NO OPERATOR MATCHES.
   *
   * Every existing field keeps its behaviour: a missing fact compares as a
   * missing value, so `not_equals` can hold. For a field that names a PERSON
   * that would widen a rule the moment the person leaves — "not written by
   * Sara" would suddenly match everything Sara ever wrote. So a field marked
   * here FAILS CLOSED instead: an unresolved fact makes every condition on it
   * false, whatever the operator. The value stored in the rule is never
   * dropped or rewritten; the rule simply stops matching on it.
   */
  readonly failsClosedWhenUnresolved?: true;
}

/**
 * COMPILE-TIME EXHAUSTIVENESS FOR A CLOSED ENUM.
 *
 * `satisfies readonly ContentStatus[]` would catch a value that is not a status
 * and miss a status that is not a value — which is the direction that actually
 * hurts: a new status shipped in a migration would silently become unselectable
 * AND unstorable, and the rule refusing it would blame the customer. This makes
 * the omission a build failure naming the missing member.
 */
const closedEnum =
  <Enum extends string>() =>
  <const T extends readonly Enum[]>(
    values: [Enum] extends [T[number]] ? T : { readonly missing: Exclude<Enum, T[number]> },
  ): T =>
    values as T;

const CONTENT_STATUS_OPTIONS = closedEnum<ContentStatus>()([
  'DRAFT',
  'IN_REVIEW',
  'CHANGES_REQUESTED',
  'APPROVED',
  'SCHEDULED',
  'PUBLISHING',
  'PUBLISHED',
  'PARTIALLY_PUBLISHED',
  'FAILED',
  'ARCHIVED',
]);

const CONTENT_TYPE_OPTIONS = closedEnum<ContentType>()([
  'POST',
  'CAROUSEL',
  'STORY',
  'REEL',
  'VIDEO',
  'ARTICLE',
  'THREAD',
]);

const SOCIAL_PROVIDER_OPTIONS = closedEnum<SocialProvider>()([
  'FACEBOOK',
  'INSTAGRAM',
  'TIKTOK',
  'LINKEDIN',
  'X',
]);

const PUBLISH_FAILURE_CLASS_OPTIONS = closedEnum<PublishFailureClass>()([
  'AUTH_EXPIRED',
  'AUTH_REVOKED',
  'INSUFFICIENT_SCOPE',
  'RATE_LIMITED',
  'CONTENT_REJECTED',
  'MEDIA_INVALID',
  'DUPLICATE_CONTENT',
  'TARGET_UNAVAILABLE',
  'PLATFORM_UNAVAILABLE',
  'TIMEOUT',
  'APPROVAL_REVOKED',
  'NOT_CONNECTED',
  'UNSUPPORTED',
  'UNKNOWN',
]);

/**
 * A STRING FACT compares for identity and membership, and never by magnitude:
 * `brand.id greater_than` has no meaning, and offering it only invites a rule
 * that never fires.
 */
const STRING_OPERATORS = ['equals', 'not_equals', 'in', 'not_in'] as const;

/**
 * A NUMBER FACT compares by magnitude and identity. `in` is deliberately absent:
 * the value union carries a list of STRINGS, so a numeric membership test could
 * be authored and could never match — which is precisely the class of defect
 * this table exists to end.
 */
const NUMBER_OPERATORS = ['equals', 'not_equals', 'greater_than', 'less_than'] as const;

/**
 * A BOOLEAN FACT is asked about with `is_true` / `is_false`, and with nothing
 * else.
 *
 * NO `equals true`, ON PURPOSE. An HTML form posts strings; a typed boolean
 * equality would therefore have been one careless `String(...)` away from
 * comparing `"true"` against `true` for ever — which is exactly what the screen
 * used to do. Two operators that take NO VALUE AT ALL cannot be got wrong, and
 * the value control simply does not render beside them.
 */
const BOOLEAN_OPERATORS = ['is_true', 'is_false'] as const;

/**
 * PHASE 2B-3 (PR 1) — A SET FACT is asked whether it contains ONE value.
 *
 * `content.channels` is every provider a post has a variant for, so "equals
 * INSTAGRAM" has no meaning for a post on three channels, and `in` would ask
 * the wrong way round (is the fact one of these?). `includes` / `excludes`
 * take a single value from the field's closed set. A fact that is not a set —
 * missing, null, or anything else — makes BOTH false: fail closed, never
 * widened.
 */
const STRING_SET_OPERATORS = ['includes', 'excludes'] as const;

/** EXHAUSTIVE BY TYPE: TypeScript refuses the file if a field is missing. */
export const CONDITION_FIELD_CONTRACTS: Record<ConditionField, ConditionFieldContract> = {
  'brand.id': {
    kind: 'string',
    operators: STRING_OPERATORS,
    options: null,
    catalogue: 'brands',
  },
  'content.status': {
    kind: 'string',
    operators: STRING_OPERATORS,
    options: CONTENT_STATUS_OPTIONS,
    catalogue: null,
  },
  // A pillar is the brand's own word for a theme. There is no enum to close it
  // against, so the value stays free text and the length cap in the schema is
  // the whole of the constraint.
  'content.pillar': {
    kind: 'string',
    operators: STRING_OPERATORS,
    options: null,
    catalogue: null,
  },
  'content.platformCount': {
    kind: 'number',
    operators: NUMBER_OPERATORS,
    options: null,
    catalogue: null,
  },
  'content.hasCampaign': {
    kind: 'boolean',
    operators: BOOLEAN_OPERATORS,
    options: null,
    catalogue: null,
  },
  /*
   * B12 + G13 option (a) — CAMPAIGN, FORMAT AND PERSON (Phase 2B-2b).
   *
   * A campaign is tenant data: the screen offers the brand's campaigns and the
   * query that runs the rule is what authorises them. A post with no campaign
   * has no campaign value, exactly as a post with no pillar has none.
   * The format is the closed `ContentType` enum. The PERSON is the post's
   * AUTHOR — its creator, never a reviewer, approver or actor — and only while
   * they are an active member; otherwise the condition fails closed.
   */
  'content.campaignId': {
    kind: 'string',
    operators: STRING_OPERATORS,
    options: null,
    catalogue: 'campaigns',
  },
  'content.type': {
    kind: 'string',
    operators: STRING_OPERATORS,
    options: CONTENT_TYPE_OPTIONS,
    catalogue: null,
  },
  'content.authorUserId': {
    kind: 'string',
    operators: STRING_OPERATORS,
    options: null,
    catalogue: 'members',
    failsClosedWhenUnresolved: true,
  },
  /*
   * PHASE 2B-3 (PR 1) — THE G13 CHANNEL CONDITION. Every channel the post has
   * a variant for, as providers. `publish.provider` stays for the rules that
   * already use it; a new G13 rule names channels here.
   */
  'content.channels': {
    kind: 'stringSet',
    operators: STRING_SET_OPERATORS,
    options: SOCIAL_PROVIDER_OPTIONS,
    catalogue: null,
  },
  'publish.provider': {
    kind: 'string',
    operators: STRING_OPERATORS,
    options: SOCIAL_PROVIDER_OPTIONS,
    catalogue: null,
  },
  'publish.failureClass': {
    kind: 'string',
    operators: STRING_OPERATORS,
    options: PUBLISH_FAILURE_CLASS_OPTIONS,
    catalogue: null,
  },
  'metric.key': {
    kind: 'string',
    operators: STRING_OPERATORS,
    options: null,
    catalogue: 'metricKeys',
  },
  'metric.value': {
    kind: 'number',
    operators: NUMBER_OPERATORS,
    options: null,
    catalogue: null,
  },
  'metric.changeMilli': {
    kind: 'number',
    operators: NUMBER_OPERATORS,
    options: null,
    catalogue: null,
  },
};

/** The operators a customer may choose for THIS field. */
export function conditionOperatorsFor(field: ConditionField): readonly ConditionOperator[] {
  return CONDITION_FIELD_CONTRACTS[field].operators;
}

/**
 * WHY A CONDITION CANNOT BE STORED — or `null` when it can.
 *
 * ONE ANSWER, ASKED BY EVERY DOOR. `createRule` asks it, `updateRule` asks it
 * (it did not, which is how an update could introduce a condition a create
 * would have refused), and a test walks every authorable combination through
 * it. The authoring screen narrows its controls from the same table, so the two
 * cannot disagree — but the screen is tidiness and THIS is the control.
 */
export type ConditionRejection = 'field' | 'operator' | 'value';

export function conditionRejection(
  condition: AutomationCondition,
  trigger: AutomationTrigger,
  /**
   * Phase 2B-3 PR 2 — the fields this door accepts: a new or current rule is
   * held to `authorableConditionFieldsFor`, an older one to what its trigger
   * produces (the default).
   */
  fields: readonly ConditionField[] = conditionFieldsFor(trigger),
): ConditionRejection | null {
  if (!fields.includes(condition.field)) return 'field';
  const contract = CONDITION_FIELD_CONTRACTS[condition.field];
  if (!contract.operators.includes(condition.operator)) return 'operator';
  return conditionValueRejected(contract, condition) ? 'value' : null;
}

function conditionValueRejected(
  contract: ConditionFieldContract,
  condition: AutomationCondition,
): boolean {
  const value = condition.value;

  switch (condition.operator) {
    // THESE TAKE NO VALUE. A value beside them is not harmless: it is a rule
    // whose text says one thing and whose behaviour does another.
    case 'is_true':
    case 'is_false':
      return value !== undefined;

    // A REAL LIST, AND NEVER AN EMPTY ONE. `in []` is false for ever, and
    // `evaluateCondition` requires an array — a lone string here would have
    // compared false whatever the fact was.
    case 'in':
    case 'not_in': {
      if (!Array.isArray(value) || value.length === 0) return true;
      const options = contract.options;
      return options !== null && value.some((member) => !options.includes(member));
    }

    case 'greater_than':
    case 'less_than':
      return contract.kind !== 'number' || typeof value !== 'number' || !Number.isFinite(value);

    // ONE value, from the closed set, against a SET-valued field and no other.
    case 'includes':
    case 'excludes':
      if (contract.kind !== 'stringSet') return true;
      if (typeof value !== 'string' || value.length === 0) return true;
      return contract.options !== null && !contract.options.includes(value);

    case 'equals':
    case 'not_equals':
      if (contract.kind === 'number') return typeof value !== 'number' || !Number.isFinite(value);
      if (contract.kind !== 'string') return true;
      if (typeof value !== 'string' || value.length === 0) return true;
      return contract.options !== null && !contract.options.includes(value);
  }
}

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

/**
 * PHASE 2B-3 (PR 1, Correction 1) — A TYPED PERMISSION REQUIREMENT.
 *
 * `allOf`: every key must be held. `anyOf`: at least one must be held, when the
 * list is not empty. Both halves apply together.
 *
 * ONLY `ADD_TO_CAMPAIGN` NEEDS `anyOf` — attaching a post to a campaign is the
 * content author's act or the campaign manager's (D-318). Every other action,
 * shipped or planned, is `allOf`, and every shipped action lists exactly the
 * one permission it has always required.
 */
export interface ActionPermissions {
  readonly allOf: readonly string[];
  readonly anyOf: readonly string[];
}

/**
 * DOES THIS PERSON HOLD WHAT THE ACTION REQUIRES?
 *
 * ONE ANSWER, asked by every door: authoring, enabling, re-configuring, every
 * run, the "needs you" queue, skipping, confirming. A requirement that names no
 * permission at all is a declaration mistake, and it FAILS CLOSED rather than
 * admitting everybody.
 */
export function satisfiesActionPermissions(
  permissionKeys: readonly string[],
  permissions: ActionPermissions,
): boolean {
  if (permissions.allOf.length === 0 && permissions.anyOf.length === 0) return false;
  if (!permissions.allOf.every((key) => permissionKeys.includes(key))) return false;
  return (
    permissions.anyOf.length === 0 || permissions.anyOf.some((key) => permissionKeys.includes(key))
  );
}

/** Every permission key an action's requirement names, for parity tests. */
export function actionPermissionKeys(permissions: ActionPermissions): readonly string[] {
  return [...permissions.allOf, ...permissions.anyOf];
}

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
  /**
   * PHASE 2B-3 (PR 1) — WHAT THE ACTION REQUIRES, DECLARED ONCE.
   *
   * The permissions the rule's author needs to write, enable or re-configure
   * it, and the rule's CREATOR must still hold, live, on every run. Held to
   * `satisfiesActionPermissions`, the only reader.
   */
  readonly permissions: ActionPermissions;
  /**
   * The plan features the WORKSPACE must be entitled to, re-resolved on every
   * run through the `EntitlementPort`. Empty for every action that ships
   * today: the only plan control on them is the scheduled-post quota, which is
   * consumed inside the calendar's own `schedule()` and is not declared here a
   * second time.
   */
  readonly entitlements: readonly string[];
  /** Does performing it spend AI credits? */
  readonly spendsCredits: boolean;
  /**
   * DOES A PERSON DECIDE FIRST? True exactly where `actionClass` is
   * `EXTERNAL_OR_DESTRUCTIVE`, and the CHECK
   * `automation_rule_external_requires_confirmation` names the same set.
   */
  readonly asksFirst: boolean;
  /** May a NEW rule be written with it? See `TriggerDefinition.authorable`. */
  readonly authorable: boolean;
  /**
   * PHASE 2B-3 PR 2 — THE TRIGGERS A NEW RULE MAY PAIR IT WITH. The authoring
   * compatibility table, declared per action: `isAuthorablePair` asks it, and
   * nothing else does. A stored rule on any other supported pair keeps running
   * (`actionSupportsTrigger` is the executability half).
   */
  readonly authoringTriggers: readonly AutomationTrigger[];
  /**
   * PHASE 2B-3 PR 2 — WHICH CATALOGUE IT BELONGS TO: the four actions that
   * shipped before G13, or a G13 action. A G13 rule names the G13 conditions
   * (`conditionFieldsForRule`).
   */
  readonly catalogue: 'legacy' | 'g13';
  /** Is there code that performs it? A run of one that is not fails closed. */
  readonly executable: boolean;
  /**
   * Does this action operate on a CONTENT ITEM?
   *
   * When it does, it may only be paired with a trigger that declares a
   * `contentItemVia` mapping. See `actionSupportsTrigger`.
   */
  readonly needsContentItem: boolean;
  readonly messageKey: string;
}

/**
 * WHAT A NOTIFY RULE MAY SEND — exactly one template (Fix PR 1 · F5, D-412).
 *
 * The rule's `templateKey` used to be any string up to 60 characters. The
 * Automations screen always wrote `automation.notice`, but the Copilot's rule
 * tool could store any key, and at run time an unknown one made the mute
 * filter lose its category, so everyone who had switched ANY category off was
 * muted — while a known one outside this set let a rule send a notice nobody
 * can switch off (a workspace deletion, say) to every publisher.
 *
 * `automation.notice` is the one template written for this action (P6-12),
 * and people mute it with Settings → Notifications → Automations.
 * `tests/unit/fix-pr1-notify-templates.test.ts` holds each key here to a
 * non-null category in the notifications catalogue.
 */
export const AUTOMATION_NOTIFY_TEMPLATES = ['automation.notice'] as const;
export type AutomationNotifyTemplate = (typeof AUTOMATION_NOTIFY_TEMPLATES)[number];

/**
 * Every template the automation engine sends: what a NOTIFY rule may name,
 * and the engine's own confirmation request for an asks-first run, which no
 * rule chooses.
 */
export type AutomationNotificationTemplate =
  AutomationNotifyTemplate | 'automation.confirmation_required';

export function isAutomationNotifyTemplate(value: unknown): value is AutomationNotifyTemplate {
  return (AUTOMATION_NOTIFY_TEMPLATES as readonly unknown[]).includes(value);
}

/**
 * A stored NOTIFY rule whose template is outside the set ends FAILED with this
 * code before anything is sent (D-412); Run history says why in the reader's
 * language.
 */
export const NOTIFY_TEMPLATE_NOT_ALLOWED = 'notify_template_not_allowed';

/** The triggers the four pre-G13 actions were authored with. */
const LEGACY_AUTHORING_TRIGGERS = [
  'CONTENT_APPROVED',
  'CONTENT_SCHEDULED',
  'POST_PUBLISHED',
  'ANALYTICS_REFRESHED',
  'METRIC_THRESHOLD_CROSSED',
  'SCHEDULED_TIME',
] as const satisfies readonly AutomationTrigger[];

export const AUTOMATION_ACTIONS = [
  {
    type: 'NOTIFY',
    config: z.object({
      /** One of `AUTOMATION_NOTIFY_TEMPLATES` — a closed set, refused otherwise. */
      templateKey: z.enum(AUTOMATION_NOTIFY_TEMPLATES),
    }),
    actionClass: 'READ_ONLY',
    // Notifying members about their own workspace's events needs no more than
    // being able to see the workspace; the notification carries a pointer, and
    // following it applies the ordinary permission checks.
    permissions: { allOf: ['workspace.read'], anyOf: [] },
    entitlements: [],
    spendsCredits: false,
    asksFirst: false,
    authorable: true,
    // The catalogue it was authored in before G13; never POST_FAILED.
    authoringTriggers: LEGACY_AUTHORING_TRIGGERS,
    catalogue: 'legacy',
    executable: true,
    // A notification points at whatever fired the rule, whatever that is.
    needsContentItem: false,
    messageKey: 'notify',
  },
  {
    type: 'SUBMIT_FOR_APPROVAL',
    config: emptyConfig,
    actionClass: 'INTERNAL_REVERSIBLE',
    permissions: { allOf: ['content.submit'], anyOf: [] },
    entitlements: [],
    spendsCredits: false,
    asksFirst: false,
    authorable: true,
    // The catalogue it was authored in before G13; never POST_FAILED.
    authoringTriggers: LEGACY_AUTHORING_TRIGGERS,
    catalogue: 'legacy',
    executable: true,
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
    permissions: { allOf: ['content.schedule'], anyOf: [] },
    entitlements: [],
    spendsCredits: false,
    asksFirst: false,
    authorable: true,
    // The catalogue it was authored in before G13; never POST_FAILED.
    authoringTriggers: LEGACY_AUTHORING_TRIGGERS,
    catalogue: 'legacy',
    executable: true,
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
    permissions: { allOf: ['publishing.manage'], anyOf: [] },
    entitlements: [],
    spendsCredits: false,
    asksFirst: true,
    authorable: true,
    // The catalogue it was authored in before G13; never POST_FAILED.
    authoringTriggers: LEGACY_AUTHORING_TRIGGERS,
    catalogue: 'legacy',
    executable: true,
    needsContentItem: true,
    messageKey: 'proposePublish',
  },
  /*
   * PHASE 2B-3 PR 2 — THE G13 ACTIONS, with their settings and their pairing.
   * Each becomes executable and authorable in the commit that ships its
   * executor; the requirements are the ones PR 1 declared and pinned.
   */
  {
    type: 'SCHEDULE_NEXT_FREE_SLOT',
    config: emptyConfig,
    actionClass: 'INTERNAL_REVERSIBLE',
    permissions: { allOf: ['content.schedule'], anyOf: [] },
    // The scheduled-post quota is consumed inside the calendar's `schedule()`.
    entitlements: [],
    spendsCredits: false,
    asksFirst: false,
    authorable: true,
    authoringTriggers: ['CONTENT_APPROVED'],
    catalogue: 'g13',
    executable: true,
    needsContentItem: true,
    messageKey: 'scheduleNextFreeSlot',
  },
  {
    type: 'NOTIFY_PERSON',
    config: z.object({
      /** One member, chosen by the author; validated on save and on every run. */
      userId: z.string().uuid(),
    }),
    actionClass: 'READ_ONLY',
    permissions: { allOf: ['workspace.read'], anyOf: [] },
    entitlements: [],
    spendsCredits: false,
    asksFirst: false,
    authorable: false,
    authoringTriggers: ['CONTENT_APPROVED', 'POST_PUBLISHED', 'POST_FAILED'],
    catalogue: 'g13',
    executable: false,
    needsContentItem: false,
    messageKey: 'notifyPerson',
  },
  {
    type: 'ADD_TO_CAMPAIGN',
    config: z.object({
      /** One campaign of the rule's brand; validated on save and on every run. */
      campaignId: z.string().uuid(),
    }),
    actionClass: 'INTERNAL_REVERSIBLE',
    /*
     * THE ONE `anyOf` (Correction 1). Attaching a post to a campaign is an act
     * of the post's author or of the campaign's manager (D-318), and either
     * permission is enough. It attaches only; it never detaches or moves.
     */
    permissions: { allOf: [], anyOf: ['content.create', 'campaigns.manage'] },
    entitlements: [],
    spendsCredits: false,
    asksFirst: false,
    authorable: false,
    authoringTriggers: ['CONTENT_APPROVED'],
    catalogue: 'g13',
    executable: false,
    needsContentItem: true,
    messageKey: 'addToCampaign',
  },
  {
    type: 'MAKE_DRAFT_COPY',
    config: emptyConfig,
    actionClass: 'INTERNAL_REVERSIBLE',
    permissions: { allOf: ['content.create'], anyOf: [] },
    entitlements: [],
    spendsCredits: false,
    asksFirst: false,
    authorable: false,
    authoringTriggers: ['CONTENT_APPROVED', 'POST_PUBLISHED', 'POST_FAILED'],
    catalogue: 'g13',
    executable: false,
    needsContentItem: true,
    messageKey: 'makeDraftCopy',
  },
] as const satisfies readonly ActionDefinition[];

/**
 * PHASE 2B-3 (G13) — ACTIONS THAT ARE DECLARED AND NOT YET AUTHORABLE OR
 * EXECUTABLE.
 *
 * WHAT IS DECIDED NOW is what each one will REQUIRE: its permissions, its
 * entitlements, whether it spends credits and whether a person decides first.
 * Declaring that before the code exists means the pull request that implements
 * an action cannot quietly choose a weaker requirement — the declaration is
 * already reviewed, and a unit test pins it.
 *
 * NOT IN `AUTOMATION_ACTIONS`, ON PURPOSE. `findAction` does not return these,
 * so a rule naming one cannot be created, the Copilot cannot propose one, and a
 * stored row naming one (which only direct SQL could produce) fails closed at
 * run time exactly as an unknown action does.
 */
export interface PlannedActionDefinition {
  readonly type: AutomationActionType;
  readonly actionClass: CopilotActionClass;
  readonly permissions: ActionPermissions;
  readonly entitlements: readonly string[];
  readonly spendsCredits: boolean;
  readonly asksFirst: boolean;
  readonly authorable: false;
  readonly executable: false;
}

export const PLANNED_AUTOMATION_ACTIONS = [
  {
    type: 'REMIND_REVIEWER',
    actionClass: 'READ_ONLY',
    permissions: { allOf: ['content.submit'], anyOf: [] },
    entitlements: [],
    spendsCredits: false,
    asksFirst: false,
    authorable: false,
    executable: false,
  },
  {
    type: 'DRAFT_IDEAS',
    actionClass: 'INTERNAL_REVERSIBLE',
    // STRICT: both. A designer holds `copilot.use` and not `content.create`.
    permissions: { allOf: ['content.create', 'copilot.use'], anyOf: [] },
    entitlements: ['limit.automation_ai_actions'],
    spendsCredits: true,
    asksFirst: false,
    authorable: false,
    executable: false,
  },
  {
    type: 'RETRY_PUBLISH',
    actionClass: 'EXTERNAL_OR_DESTRUCTIVE',
    permissions: { allOf: ['publishing.manage'], anyOf: [] },
    entitlements: [],
    spendsCredits: false,
    asksFirst: true,
    authorable: false,
    executable: false,
  },
  {
    type: 'PAUSE_CAMPAIGN',
    actionClass: 'EXTERNAL_OR_DESTRUCTIVE',
    permissions: { allOf: ['campaigns.manage'], anyOf: [] },
    entitlements: [],
    spendsCredits: false,
    asksFirst: true,
    authorable: false,
    executable: false,
  },
] as const satisfies readonly PlannedActionDefinition[];

const PLANNED_ACTIONS_BY_TYPE = new Map<string, PlannedActionDefinition>(
  PLANNED_AUTOMATION_ACTIONS.map((action) => [action.type, action]),
);

/** A declared, not-yet-executable action's requirement, or undefined. */
export function findPlannedAction(type: string): PlannedActionDefinition | undefined {
  return PLANNED_ACTIONS_BY_TYPE.get(type);
}

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

/**
 * Does this action leave the platform, and therefore need a person?
 *
 * Read from the declared `asksFirst`, which a unit test holds equal to
 * `actionClass === 'EXTERNAL_OR_DESTRUCTIVE'` — so for every action that ships
 * the answer is the one it has always been.
 */
export function isExternalAction(type: AutomationActionType): boolean {
  return findAction(type)?.asksFirst === true;
}

/**
 * IS THIS STORED RULE AN OLDER AUTOMATION — one a new rule could not be
 * written as any more?
 *
 * True when its trigger or its action is not in the authorable registry, or is
 * there and marked `authorable: false`. The rule still exists, still lists, and
 * runs exactly as far as its trigger and action allow; the rule list captions it
 * so a person is not left wondering why they cannot make another one.
 */
export function isOlderAutomation(input: {
  readonly triggerType: string;
  readonly actionType: string;
}): boolean {
  const trigger = findTrigger(input.triggerType);
  const action = findAction(input.actionType);
  return !trigger?.authorable || !action?.authorable;
}

/** May a NEW rule be written on this trigger with this action? */
export function isAuthorablePair(triggerType: string, actionType: string): boolean {
  const trigger = findTrigger(triggerType);
  const action = findAction(actionType);
  return (
    trigger?.authorable === true &&
    action?.authorable === true &&
    action.authoringTriggers.includes(trigger.type) &&
    actionSupportsTrigger(action.type, trigger.type)
  );
}

/**
 * PHASE 2B-3 PR 2 — WHY AN ACTION ENDED WITHOUT ACTING, and how the run reads.
 *
 * A G13 executor that finds nothing to do, or a reason it may not, returns one
 * of these codes instead of throwing: `SKIPPED` when there was nothing to do
 * (the post already has a time, is already in a campaign, is under review),
 * `BLOCKED_BY_POLICY` when something stands in the way that a person can fix.
 * Run history localizes every one of them.
 */
export const ACTION_OUTCOME_STATUS = {
  already_has_time: 'SKIPPED',
  no_free_day: 'BLOCKED_BY_POLICY',
  approval_required: 'BLOCKED_BY_POLICY',
  schedule_quota_reached: 'BLOCKED_BY_POLICY',
  channel_disconnected: 'BLOCKED_BY_POLICY',
  not_schedulable: 'BLOCKED_BY_POLICY',
  recipient_unavailable: 'BLOCKED_BY_POLICY',
  campaign_unavailable: 'BLOCKED_BY_POLICY',
  already_in_campaign: 'SKIPPED',
  content_in_review: 'SKIPPED',
  content_not_editable: 'SKIPPED',
  content_unavailable: 'SKIPPED',
  source_campaign_unavailable: 'BLOCKED_BY_POLICY',
  draft_limit_reached: 'BLOCKED_BY_POLICY',
} as const satisfies Record<string, 'SKIPPED' | 'BLOCKED_BY_POLICY'>;
export type ActionOutcomeCode = keyof typeof ACTION_OUTCOME_STATUS;

export function isActionOutcomeCode(value: unknown): value is ActionOutcomeCode {
  return typeof value === 'string' && Object.hasOwn(ACTION_OUTCOME_STATUS, value);
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

  // B12 — a person the rule names who can no longer be resolved matches
  // NOTHING, under every operator (see `failsClosedWhenUnresolved`).
  if (
    (actual === undefined || actual === null) &&
    CONDITION_FIELD_CONTRACTS[condition.field].failsClosedWhenUnresolved
  ) {
    return false;
  }

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
    // A fact that is not a set answers neither: fail closed, never widened.
    case 'includes':
      return Array.isArray(actual) && typeof condition.value === 'string'
        ? actual.includes(condition.value)
        : false;
    case 'excludes':
      return Array.isArray(actual) && typeof condition.value === 'string'
        ? !actual.includes(condition.value)
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
