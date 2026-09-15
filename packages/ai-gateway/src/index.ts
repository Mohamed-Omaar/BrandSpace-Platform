/**
 * Provider-agnostic AI Gateway — docs/AI-GATEWAY.md.
 *
 * The public surface of the package. No provider SDK may be imported outside
 * this package (lint-enforced), and nothing outside it may import a provider
 * adapter's module directly: callers work through the contracts exported here.
 */
export {
  AI_FAILURE_CLASSES,
  AiProviderError,
  customerMessageFor,
  gatewayError,
  isFallbackEligible,
  isRetryable,
} from './errors';
export type { AiFailureClass } from './errors';

export { AI_MODALITIES } from './adapter';
export type {
  AdapterContext,
  AdapterRegistry,
  AiModality,
  AiProviderAdapter,
  ConnectionTestResult,
  ImageRequest,
  ImageResult,
  ModerationRequest,
  ModerationResult,
  TextRequest,
  TextResult,
  UsageUnits,
} from './adapter';

export { MockProviderAdapter } from './adapters/mock';
export type { MockAdapterOptions, MockCall, MockDirective } from './adapters/mock';

export { AI_TASK_KEYS, AI_TASKS, findAiTask, isAiTaskKey, MVP_AI_TASK_KEYS } from './tasks';
export type { AiTaskDefinition, AiTaskKey } from './tasks';

export { resolveRoute, RoutingError } from './routing';
export type { RegisteredModel, ResolvedRoute, RoutingQuery, RoutingRule } from './routing';

export {
  assessMargin,
  billableMilliUnits,
  creditsChargedMilli,
  estimateReservationMilli,
  findCreditRule,
  PricingError,
  providerCostMicroMinor,
  requiredPriceMicroMinor,
} from './pricing';
export type { AiBillingUnit, CreditRule, MarginAssessment, ModelCostBasis } from './pricing';

export { purgeExpiredOutputs } from './gateway';
export { AiGateway } from './gateway';
export type {
  AiConfiguration,
  AiQuote,
  AiSweepResult,
  AiConfigurationSource,
  AiGatewayOptions,
  AiGatewayRequest,
  AiGatewayResult,
  AiImageInput,
  AiInput,
  AiOutput,
  AiProviderConfig,
  AiTextInput,
  ProviderCredentialSource,
} from './gateway';

export {
  assessBudget,
  budgetRefusal,
  BudgetExceededError,
  resolveBudget,
  withinRequestCostCap,
} from './budgets';
export type {
  AiBudgets,
  BudgetBreach,
  BudgetDecision,
  BudgetLimits,
  BudgetUsage,
  PlanBudgetLimits,
} from './budgets';

export { ConfigurationAiSource } from './config-source';

export {
  AI_PAGE_SIZES,
  AI_USAGE_READ_PERMISSION,
  AiUsageExplorer,
  DEFAULT_AI_PAGE_SIZE,
  MAX_AI_PAGE_SIZE,
} from './explorer';
export type {
  AiExplorerActor,
  AiLedgerEntry,
  AiPage,
  AiRequestDetail,
  AiRequestFilter,
  AiRequestListItem,
  AiUsageExplorerOptions,
  AiUsageRollupRow,
} from './explorer';
