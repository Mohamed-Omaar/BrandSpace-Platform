/**
 * @brandspace/automation — trigger → condition → action, with no customer code
 * anywhere in it.
 *
 * A rule stores no authority: the creator's permissions, brand scope and
 * entitlement are re-resolved on every run. An external action never runs on its
 * own: it reaches AWAITING_CONFIRMATION and a permitted human confirms the exact
 * run — the same boundary the Copilot enforces, reached by a different door.
 */

export { channelForPlatformKey, contractedFieldsFor, gatherFacts } from './facts';
export {
  CONDITION_VALUE_UNAVAILABLE,
  conditionValuesResolve,
  memberCatalogueFor,
} from './condition-values';
export type { MemberChoice } from './condition-values';
export { evaluateThresholdRule } from './threshold-producer';
export type { ThresholdOutcome, ThresholdRuleRow } from './threshold-producer';
export type { FactEvent, MetricWindowPort } from './facts';

export {
  AUTOMATION_ACTIONS,
  AUTOMATION_NOTIFY_TEMPLATES,
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
  actionPermissionKeys,
  findAction,
  findPlannedAction,
  findTrigger,
  isAuthorablePair,
  isAutomationNotifyTemplate,
  isExternalAction,
  isOlderAutomation,
  NOTIFY_TEMPLATE_NOT_ALLOWED,
  PLANNED_AUTOMATION_ACTIONS,
  PLANNED_AUTOMATION_TRIGGERS,
  RETIRED_AUTOMATION_TRIGGERS,
  satisfiesActionPermissions,
} from './registry';
export type {
  ActionDefinition,
  ActionPermissions,
  AutomationNotificationTemplate,
  AutomationNotifyTemplate,
  PlannedActionDefinition,
  PlannedTriggerDefinition,
  AutomationCondition,
  ConditionField,
  ConditionFieldContract,
  ConditionOperator,
  ConditionRejection,
  ConditionValueKind,
  TriggerDefinition,
} from './registry';

export {
  AutomationEngine,
  WORKSPACE_PENDING_DELETION_FAILURE,
  runBucketFor,
  runIdempotencyKeyFor,
} from './engine';
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
  EntitlementPort,
  NotificationPort,
  PublishPort,
  TimezonePort,
} from './ports';

export {
  AUTOMATION_RULE_NAME_TAKEN_REASON,
  AUTOMATION_RULE_VERSION_CONFLICT_REASON,
  automationConfirmationRejected,
  automationRuleNameTaken,
  automationRuleNotFound,
  automationRuleVersionConflict,
  automationRunNotFound,
  conditionFieldMissing,
  conditionFieldNotProduced,
  conditionFieldUnknown,
  conditionOperatorNotAllowed,
  conditionValueInvalid,
  brandRuleLimitReached,
  creatorLacksAuthority,
  ruleLimitReached,
  tooManyConditions,
  triggerActionIncompatible,
  triggerConfigInvalid,
  unknownTriggerOrAction,
} from './errors';
