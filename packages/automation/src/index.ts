/**
 * @brandspace/automation — trigger → condition → action, with no customer code
 * anywhere in it.
 *
 * A rule stores no authority: the creator's permissions, brand scope and
 * entitlement are re-resolved on every run. An external action never runs on its
 * own: it reaches AWAITING_CONFIRMATION and a permitted human confirms the exact
 * run — the same boundary the Copilot enforces, reached by a different door.
 */

export { contractedFieldsFor, gatherFacts } from './facts';
export { evaluateThresholdRule } from './threshold-producer';
export type { ThresholdOutcome, ThresholdRuleRow } from './threshold-producer';
export type { FactEvent, MetricWindowPort } from './facts';

export {
  AUTOMATION_ACTIONS,
  AUTOMATION_TRIGGERS,
  actionSupportsTrigger,
  CONDITION_FIELDS,
  CONDITION_OPERATORS,
  conditionSchema,
  conditionFieldsFor,
  conditionOperatorsFor,
  conditionRejection,
  conditionsSchema,
  CONDITION_FIELD_CONTRACTS,
  CONDITION_FIELD_TRIGGERS,
  evaluateCondition,
  evaluateConditions,
  findAction,
  findTrigger,
  isExternalAction,
} from './registry';
export type {
  ActionDefinition,
  AutomationCondition,
  ConditionField,
  ConditionFieldContract,
  ConditionOperator,
  ConditionRejection,
  ConditionValueKind,
  TriggerDefinition,
} from './registry';

export { AutomationEngine, runBucketFor, runIdempotencyKeyFor } from './engine';
export {
  localMomentFor,
  metricThresholdConfigSchema,
  nextTimedEvaluationAt,
  occurrenceKey,
  scheduledTimeConfigSchema,
  metricIsBreaching,
  thresholdOccurrenceKey,
  thresholdTransition,
  timedRuleIsDue,
} from './schedule';
export type { LocalMoment, ThresholdTransition } from './schedule';
export type {
  AutomationActor,
  AutomationDenialSink,
  AutomationEngineOptions,
  RunOutcome,
  TriggerEvent,
} from './engine';

export {
  AUTOMATIONS_CONFIG_DOMAIN,
  TenantAutomationPolicySource,
  parseAutomationPolicy,
  resolveAutomationPolicy,
} from './policy';
export type { AutomationCatalogueReader, AutomationPolicy } from './policy';

export type {
  ApprovalPort,
  AutomationPorts,
  CalendarPort,
  NotificationPort,
  PublishPort,
  TimezonePort,
} from './ports';

export {
  automationConfirmationRejected,
  automationRuleNotFound,
  automationRunNotFound,
  conditionFieldNotProduced,
  conditionOperatorNotAllowed,
  conditionValueInvalid,
  brandRuleLimitReached,
  creatorLacksAuthority,
  ruleLimitReached,
  tooManyConditions,
  triggerActionIncompatible,
  unknownTriggerOrAction,
} from './errors';
