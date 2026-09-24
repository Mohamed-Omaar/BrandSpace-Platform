/**
 * @brandspace/copilot — the AI Copilot's real implementation.
 *
 * AN ORCHESTRATOR OVER DOMAIN SERVICES, NOT A PRIVILEGED SHORTCUT. Every tool in
 * the closed registry calls a service that performs its own authorization; the
 * model never holds a database handle; and permission, BrandScope and entitlement
 * are re-resolved from the LIVE membership at execution time, because a preview
 * is never authorization.
 *
 * The visual shell is `packages/ui`'s `CopilotPanel`, which already existed and
 * is not replaced.
 */

export {
  COPILOT_ENTITLEMENT_KEYS,
  COPILOT_TOOLS,
  COPILOT_TOOL_KEYS,
  availableTools,
  findTool,
  highestActionClass,
  isToolKey,
  requiresConfirmation,
} from './tools';
export type { CopilotToolKey, ToolDefinition, ToolPreviewLine } from './tools';

export { holds, resolveLiveAuthorization } from './authorization';
export { stepBrandPermitted } from './brand-binding';
export type { LiveAuthorization } from './authorization';

export {
  canonicalJson,
  digestsMatch,
  hashConfirmationToken,
  issueConfirmationToken,
  planHashOf,
  toolCallIdempotencyKey,
} from './plan-hash';
export type { CanonicalStep } from './plan-hash';

export {
  COPILOT_CONFIG_DOMAIN,
  TenantCopilotPolicySource,
  parseCopilotPolicy,
  resolveCopilotPolicy,
} from './policy';
export type { CopilotCatalogueReader, CopilotPolicy } from './policy';

export { TOOL_EXECUTORS, buildPreview } from './executors';
export type {
  ExecutorContext,
  ExecutorResult,
  ExternalActionPort,
  AutomationRuleCheck,
  AutomationRulePort,
  PreviewContext,
  ToolExecutor,
} from './executors';

export { CopilotPlanService } from './plans';
export type {
  CopilotDenialSink,
  CreatedPlan,
  EntitlementGate,
  ExecutionResult,
  PlanServiceOptions,
  ProposedStep,
  StoredStep,
} from './plans';

export { CopilotUndoService } from './undo';
export type { CompensationKind, UndoCollaborators, UndoOutcome, UndoServiceOptions } from './undo';

export { CopilotOrchestrator } from './orchestrator';
export type { OrchestratorOptions, TurnInput, TurnResult } from './orchestrator';

export {
  confirmationRejected,
  copilotGenerationFailed,
  copilotPlanNotFound,
  copilotSessionNotFound,
  externalActionUnavailable,
  planAlreadyExecuted,
  planChangedSinceConfirmation,
  planNotConfirmable,
  planNotConfirmed,
  planTooLarge,
  requestTooLong,
  tooManyOpenPlans,
  undoUnsafe,
  undoWindowClosed,
  unknownTool,
} from './errors';

export { pruneCopilot } from './retention';
export type { CopilotPruneResult } from './retention';

export { COPILOT_SURFACES, COPILOT_SURFACE_KEYS, copilotSurface } from './surfaces';
export type { CopilotSurface } from './surfaces';
export { COPILOT_SUBJECT_TYPES, copilotSubjectType } from './subject';
export type { CopilotSubject, CopilotSubjectType } from './subject';
