import { AppError } from '@brandspace/shared';

import type { AiModality } from './adapter';
import {
  capabilityRefusal,
  findAiCapability,
  NO_MODEL_FEATURES,
  type AiCapabilityDefinition,
  type ModelFeatureDeclaration,
} from './capabilities';
import { findAiTask } from './tasks';

/**
 * Routing resolution — docs/AI-GATEWAY.md §5.
 *
 * Resolution order is workspace rule → plan rule → global rule, and within a
 * scope the highest `priority` wins. If nothing resolves, the request FAILS.
 * That refusal is the point of this module: a gateway that fell back to "some
 * text model" when no rule matched would spend a customer's credits on a model
 * no operator chose, and the mistake would surface as a surprising invoice
 * rather than as an error.
 *
 * This module reads configuration and decides. It performs no I/O, holds no
 * state, and knows no provider names.
 */

/** The shape this module needs from the active `ai.routing` payload. */
export interface RoutingRule {
  readonly taskKey: string;
  readonly scope: 'global' | 'plan' | 'workspace';
  readonly planKey: string | null;
  readonly workspaceId: string | null;
  readonly primaryModelKey: string;
  readonly fallbackModelKeys: readonly string[];
  readonly timeoutMs: number;
  readonly maxCostPerRequestMinor: number | null;
  readonly priority: number;
  readonly parameters: {
    readonly temperature: number;
    readonly maxOutputTokens: number;
    readonly promptTemplateVersion: number;
    readonly persistOutput: boolean;
    /** Null when nothing is persisted; required by config when it is. */
    readonly outputRetentionDays: number | null;
  };
  readonly retryPolicy: {
    readonly maxAttempts: number;
    readonly backoff: 'none' | 'fixed' | 'exponential';
    readonly initialDelayMs: number;
    readonly jitter: boolean;
  };
  readonly moderateInput: boolean;
  readonly moderationModelKey: string | null;
}

/** The shape this module needs from the active `ai.models` payload. */
export interface RegisteredModel {
  readonly key: string;
  readonly providerKey: string;
  readonly modality: AiModality;
  readonly qualityTier: 'fast' | 'balanced' | 'premium';
  readonly status: 'available' | 'beta' | 'deprecated' | 'disabled';
  readonly disableSwitch: boolean;

  /*
   * PHASE 10. What the model is declared able to do, and what it costs —
   * the inputs a capability check and a profile ranking need.
   *
   * Every one is optional at the type level with a safe default below, so a
   * payload written before Phase 10 still resolves: it simply declares no
   * capabilities, which makes it unusable for capability routing and entirely
   * unchanged for the task rules that already name it. Silently treating an
   * undeclared model as capable is the one behaviour this must not have.
   */
  readonly capabilities?: readonly string[];
  readonly features?: ModelFeatureDeclaration;
  readonly latencyTier?: 'fast' | 'standard' | 'slow';
  /** Per-`costUnit` rates, in micro-minor units. Null when not yet entered. */
  readonly inputCostPerUnitMicroMinor?: number | null;
  readonly outputCostPerUnitMicroMinor?: number | null;
  readonly imageCostPerImageMicroMinor?: number | null;
}

/**
 * One capability's route — Phase 10 §7.
 *
 * The shape this module needs from the active `ai.capability-routing` payload.
 */
export interface CapabilityRoute {
  readonly capability: string;
  readonly enabled: boolean;
  readonly primaryModelKey: string | null;
  readonly fallbackModelKeys: readonly string[];
  readonly timeoutMs: number;
  readonly retryPolicy: RoutingRule['retryPolicy'];
  readonly maxCostPerRequestMinor: number | null;
  readonly maxOutputTokens: number | null;
  readonly minimumQualityTier: 'fast' | 'balanced' | 'premium' | null;
  readonly latencyPreference: 'fastest' | 'balanced' | 'cheapest' | null;
}

export type AiRoutingProfile = 'economy' | 'balanced' | 'premium' | 'custom';

export interface CapabilityRouting {
  readonly activeProfile: AiRoutingProfile;
  readonly routes: readonly CapabilityRoute[];
}

/** The document a payload that predates Phase 10 resolves to. */
export const NO_CAPABILITY_ROUTING: CapabilityRouting = { activeProfile: 'custom', routes: [] };

export interface RoutingQuery {
  readonly taskKey: string;
  readonly workspaceId: string;
  /** The workspace's current plan, or null when it has no subscription. */
  readonly planKey: string | null;
}

export interface ResolvedRoute {
  readonly taskKey: string;
  readonly modality: AiModality;
  /** Which scope the winning rule came from. Recorded for the operator. */
  readonly scope: RoutingRule['scope'];
  /** Primary first, then fallbacks, in the operator's order. Never empty. */
  readonly chain: readonly string[];
  readonly timeoutMs: number;
  readonly maxCostPerRequestMinor: number | null;
  readonly parameters: RoutingRule['parameters'];
  readonly retryPolicy: RoutingRule['retryPolicy'];
  readonly moderateInput: boolean;
  readonly moderationModelKey: string | null;
  /**
   * Models the rule names that the registry currently refuses — disabled,
   * killed, missing, or the wrong modality. Never routed to; surfaced so an
   * operator can see that a chain is thinner than they configured.
   */
  readonly excludedModelKeys: readonly string[];

  /*
   * PHASE 10 — which layer answered, and what it answered with.
   *
   * Recorded so an operator reading the AI usage explorer can tell a route
   * somebody wrote from one a profile derived. `'task'` is the pre-Phase-10
   * behaviour and remains the first thing tried.
   */
  readonly resolvedBy: 'task' | 'capability';
  /** The capability the task required. Present on both paths. */
  readonly capability: string;
  /** Which profile produced the chain, or null when a task rule did. */
  readonly profile: AiRoutingProfile | null;
}

/**
 * A request that could not be routed.
 *
 * `INTERNAL` rather than a 4xx because there is nothing the caller did wrong
 * and nothing they can do about it: the configuration is incomplete. The
 * message is operator-facing — `AppError.toPublicJSON` omits it — and
 * `reason` gives the alerting path something stable to group on.
 */
export class RoutingError extends AppError {
  readonly reason:
    | 'unknown_task'
    | 'not_in_mvp_scope'
    | 'no_rule'
    | 'no_usable_model'
    | 'modality_mismatch'
    /** The task names a capability nobody defined. A build error in practice. */
    | 'unknown_capability'
    /** A route exists for the capability and an operator switched it off. */
    | 'capability_disabled'
    /** Nothing in the catalogue declares the capability the task needs. */
    | 'capability_unsatisfied';

  constructor(reason: RoutingError['reason'], message: string) {
    super('INTERNAL', message);
    this.name = 'RoutingError';
    this.reason = reason;
  }
}

/** A model the gateway may route to right now. */
function isUsable(model: RegisteredModel): boolean {
  // `disableSwitch` is the kill switch of docs/AI-GATEWAY.md §4: it takes
  // effect the moment `ai.models` is activated, WITHOUT the routing rules being
  // re-validated or re-activated. Config validation refuses a rule that points
  // at a disabled model, but that check ran when the ROUTING version was
  // activated; a model killed afterwards would still be routed to unless the
  // resolver checks again here, at request time.
  return !model.disableSwitch && model.status !== 'disabled';
}

/** Scope precedence: a more specific rule wins outright, whatever its priority. */
const SCOPE_RANK: Record<RoutingRule['scope'], number> = {
  workspace: 3,
  plan: 2,
  global: 1,
};

function applies(rule: RoutingRule, query: RoutingQuery): boolean {
  if (rule.taskKey !== query.taskKey) return false;
  switch (rule.scope) {
    case 'workspace':
      // A workspace-scoped rule with no workspace is a configuration mistake
      // that would otherwise apply to EVERY tenant. Never match it.
      return rule.workspaceId !== null && rule.workspaceId === query.workspaceId;
    case 'plan':
      return rule.planKey !== null && rule.planKey === query.planKey;
    case 'global':
      return true;
  }
}

export function resolveRoute(
  query: RoutingQuery,
  rules: readonly RoutingRule[],
  models: readonly RegisteredModel[],
  /**
   * The active `ai.capability-routing` document.
   *
   * OPTIONAL, so every existing caller and test compiles unchanged and keeps
   * exactly its old behaviour: with no capability document and no model
   * declaring a capability, an unmatched task still raises `no_rule`.
   */
  capabilityRouting: CapabilityRouting = NO_CAPABILITY_ROUTING,
): ResolvedRoute {
  const task = findAiTask(query.taskKey);
  if (!task) {
    // The caller named a task the platform does not have. Routing it to
    // anything at all would charge for work nobody defined.
    throw new RoutingError('unknown_task', `No AI task is defined for key "${query.taskKey}".`);
  }

  /*
   * D-16 (approved 2026-09-13): the MVP covers text and image generation.
   * Video is excluded and recorded as a Phase 7+ candidate; voice remains
   * post-MVP.
   *
   * Enforced HERE rather than in configuration validation because
   * `packages/config` cannot import this package — the dependency runs the
   * other way. Refusing at resolution means an out-of-scope task cannot be
   * served even if a routing rule for it were somehow activated, which is the
   * guarantee that actually matters.
   */
  if (!task.mvpApproved) {
    throw new RoutingError(
      'not_in_mvp_scope',
      `Task "${query.taskKey}" (${task.modality}) is outside the approved MVP scope (D-16).`,
    );
  }

  const candidates = rules.filter((rule) => applies(rule, query));
  if (candidates.length === 0) {
    /*
     * PHASE 10: NO TASK RULE IS NO LONGER THE END OF THE ROAD.
     *
     * A task rule is the specific answer and still wins outright. When nobody
     * wrote one, the question becomes the general one — what serves this
     * task's CAPABILITY — and `resolveCapabilityRoute` answers it or refuses
     * for a reason of its own. It never falls back to "some text model": every
     * model it considers has been declared for the capability by an operator.
     */
    if (
      capabilityRouting.routes.length > 0 ||
      models.some((m) => (m.capabilities ?? []).length > 0)
    ) {
      return resolveCapabilityRoute(query, capabilityRouting, models);
    }
    throw new RoutingError(
      'no_rule',
      `No routing rule matches task "${query.taskKey}" for workspace ${query.workspaceId} ` +
        `on plan ${query.planKey ?? '(none)'}, and no model declares capability ` +
        `"${task.capability}". Configure ai.routing or ai.capability-routing before this task is used.`,
    );
  }

  const registry = new Map(models.map((model) => [model.key, model]));

  // Ordered, not "found": scope first, then priority, then document order. The
  // last tie-break keeps resolution deterministic if a duplicate selector ever
  // reaches production — config validation rejects those, but a payload
  // activated before that check existed must still resolve the same way on
  // every node rather than depending on iteration order.
  const ordered = [...candidates].sort((a, b) => {
    const byScope = SCOPE_RANK[b.scope] - SCOPE_RANK[a.scope];
    if (byScope !== 0) return byScope;
    const byPriority = b.priority - a.priority;
    if (byPriority !== 0) return byPriority;
    return rules.indexOf(a) - rules.indexOf(b);
  });

  const winner = ordered[0];
  /* c8 ignore next -- `candidates.length === 0` already returned above. */
  if (!winner) throw new RoutingError('no_rule', 'No routing rule matched.');

  const declared = [winner.primaryModelKey, ...winner.fallbackModelKeys];
  const chain: string[] = [];
  const excluded: string[] = [];
  let sawModalityMismatch = false;

  for (const modelKey of declared) {
    if (chain.includes(modelKey) || excluded.includes(modelKey)) continue;
    const model = registry.get(modelKey);
    if (!model || !isUsable(model)) {
      excluded.push(modelKey);
      continue;
    }
    if (model.modality !== task.modality) {
      // Sending a caption task to an image model would fail at the provider
      // AFTER the credits were reserved. Refusing here costs nothing.
      sawModalityMismatch = true;
      excluded.push(modelKey);
      continue;
    }
    chain.push(modelKey);
  }

  if (chain.length === 0) {
    // Promoting a live fallback when the primary is killed is NOT guessing —
    // the chain is the order the operator declared. Inventing a model when the
    // whole chain is dead would be, so the request fails instead.
    const reason = sawModalityMismatch ? 'modality_mismatch' : 'no_usable_model';
    throw new RoutingError(
      reason,
      `Every model configured for task "${query.taskKey}" is unusable ` +
        `(${excluded.join(', ') || 'none declared'}). Expected a ${task.modality} model.`,
    );
  }

  return {
    taskKey: winner.taskKey,
    modality: task.modality,
    scope: winner.scope,
    chain,
    timeoutMs: winner.timeoutMs,
    maxCostPerRequestMinor: winner.maxCostPerRequestMinor,
    parameters: winner.parameters,
    retryPolicy: winner.retryPolicy,
    moderateInput: winner.moderateInput,
    moderationModelKey: winner.moderationModelKey,
    excludedModelKeys: excluded,
    resolvedBy: 'task',
    capability: task.capability,
    profile: null,
  };
}

/**
 * ROUTING PROFILES — Phase 10 §8.
 *
 * A profile is a RANKING RULE over the catalogue the owner entered, never a
 * saved set of model keys: a list of vendors in source is precisely what
 * CLAUDE.md §2.2 forbids. Given the models that DECLARE a capability, each
 * profile orders them and the top three become primary and two fallbacks.
 *
 * It ranks; it never admits. A model that does not declare the capability is
 * filtered out before ranking, so no profile can promote a model that cannot
 * do the work.
 */

/** Cheapest first is meaningless when nobody has entered a price. */
const UNPRICED = Number.MAX_SAFE_INTEGER;

function unitPrice(model: RegisteredModel, capability: AiCapabilityDefinition): number {
  if (capability.executionModality === 'image') {
    return model.imageCostPerImageMicroMinor ?? UNPRICED;
  }
  const input = model.inputCostPerUnitMicroMinor;
  const output = model.outputCostPerUnitMicroMinor;
  if (input === null || input === undefined || output === null || output === undefined) {
    return UNPRICED;
  }
  /*
   * Weighted toward whichever side actually drives the bill for this kind of
   * work. Generating a caption is output-heavy; reading a picture is
   * input-heavy. A flat sum would rank a model with a cheap prompt price and a
   * ruinous completion price as the economical choice for writing.
   */
  return capability.outputDominatesCost ? input + output * 3 : input * 3 + output;
}

const QUALITY_RANK: Record<RegisteredModel['qualityTier'], number> = {
  premium: 3,
  balanced: 2,
  fast: 1,
};

const LATENCY_RANK: Record<NonNullable<RegisteredModel['latencyTier']>, number> = {
  fast: 3,
  standard: 2,
  slow: 1,
};

/**
 * Order the candidates a profile would choose from, best first.
 *
 * Ties break on the model key so the order is stable across nodes: two models
 * an operator entered with identical tiers and no prices must not resolve
 * differently depending on which node served the request.
 */
function rankForProfile(
  candidates: readonly RegisteredModel[],
  profile: AiRoutingProfile,
  capability: AiCapabilityDefinition,
  preference: CapabilityRoute['latencyPreference'],
): readonly RegisteredModel[] {
  const price = new Map(candidates.map((m) => [m.key, unitPrice(m, capability)]));
  const latency = (m: RegisteredModel) => LATENCY_RANK[m.latencyTier ?? 'standard'];

  const byKey = (a: RegisteredModel, b: RegisteredModel) => a.key.localeCompare(b.key);

  const sorted = [...candidates].sort((a, b) => {
    switch (profile) {
      case 'economy': {
        const byPrice = (price.get(a.key) ?? UNPRICED) - (price.get(b.key) ?? UNPRICED);
        if (byPrice !== 0) return byPrice;
        return QUALITY_RANK[b.qualityTier] - QUALITY_RANK[a.qualityTier] || byKey(a, b);
      }
      case 'premium': {
        const byQuality = QUALITY_RANK[b.qualityTier] - QUALITY_RANK[a.qualityTier];
        if (byQuality !== 0) return byQuality;
        const byPrice = (price.get(a.key) ?? UNPRICED) - (price.get(b.key) ?? UNPRICED);
        return byPrice !== 0 ? byPrice : byKey(a, b);
      }
      case 'balanced': {
        /*
         * The split the profile is named for: work that needs reasoning gets
         * the stronger model, everything else gets the cheaper one. Which side
         * a capability falls on is its own declaration — `REASONING_COMPLEX`
         * requires structured output — not a list of capability names here.
         */
        const wantsQuality = Object.keys(capability.requires).length > 0;
        if (wantsQuality) {
          const byQuality = QUALITY_RANK[b.qualityTier] - QUALITY_RANK[a.qualityTier];
          if (byQuality !== 0) return byQuality;
        }
        const byPrice = (price.get(a.key) ?? UNPRICED) - (price.get(b.key) ?? UNPRICED);
        if (byPrice !== 0) return byPrice;
        return QUALITY_RANK[b.qualityTier] - QUALITY_RANK[a.qualityTier] || byKey(a, b);
      }
      case 'custom':
        // Never reached: `custom` does not rank, it reads the explicit route.
        return byKey(a, b);
    }
  });

  if (preference === 'fastest') {
    return [...sorted].sort(
      (a, b) => latency(b) - latency(a) || sorted.indexOf(a) - sorted.indexOf(b),
    );
  }
  if (preference === 'cheapest') {
    return [...sorted].sort(
      (a, b) =>
        (price.get(a.key) ?? UNPRICED) - (price.get(b.key) ?? UNPRICED) ||
        sorted.indexOf(a) - sorted.indexOf(b),
    );
  }
  return sorted;
}

/** The feature declaration a model carries, with the safe default applied. */
function featuresOf(model: RegisteredModel): ModelFeatureDeclaration {
  return model.features ?? NO_MODEL_FEATURES;
}

/**
 * Whether a model may serve a capability — the check that makes §7 enforceable.
 *
 * Two conditions, and BOTH are required. The operator must have DECLARED the
 * capability on the model, AND the model feature flags must actually satisfy
 * what the capability needs. The first alone would let a tick box promote a
 * text model to image generation; the second alone would route to any model
 * that happened to carry the right flags, which is not the same as one an
 * operator chose.
 */
export interface CapabilityCandidate {
  readonly model: RegisteredModel;
  /** Null when the model may serve it; otherwise why it may not. */
  readonly refusal: string | null;
}

export function assessCapability(
  capability: AiCapabilityDefinition,
  model: RegisteredModel,
): CapabilityCandidate {
  if (!isUsable(model)) {
    return { model, refusal: 'is disabled' };
  }
  const declared = model.capabilities ?? [];
  if (!declared.includes(capability.key)) {
    return { model, refusal: `is not declared for ${capability.key}` };
  }
  const refusal = capabilityRefusal(capability, {
    modality: model.modality,
    features: featuresOf(model),
  });
  return { model, refusal };
}

/**
 * Resolve a task through its CAPABILITY, when no task rule matched.
 *
 * Returns the same `ResolvedRoute` the task path returns, so everything
 * downstream — the gateway pipeline, the credit reservation, the operator
 * record — is unchanged and does not know which layer answered.
 */
export function resolveCapabilityRoute(
  query: RoutingQuery,
  routing: CapabilityRouting,
  models: readonly RegisteredModel[],
): ResolvedRoute {
  const task = findAiTask(query.taskKey);
  /* c8 ignore next -- the caller checked; this keeps the type honest. */
  if (!task)
    throw new RoutingError('unknown_task', `No AI task is defined for "${query.taskKey}".`);

  const capability = findAiCapability(task.capability);
  if (!capability) {
    throw new RoutingError(
      'unknown_capability',
      `Task "${task.key}" requires capability "${task.capability}", which is not defined.`,
    );
  }

  const route = routing.routes.find((r) => r.capability === capability.key);
  if (route && !route.enabled) {
    /*
     * An operator switched this capability off. That is a DECISION, not a gap,
     * and it gets its own reason so the customer-facing message can say the
     * feature is unavailable rather than implying something is broken.
     */
    throw new RoutingError(
      'capability_disabled',
      `Capability "${capability.key}" is switched off in ai.capability-routing.`,
    );
  }

  const assessed = models.map((model) => assessCapability(capability, model));
  const eligible = assessed.filter((a) => a.refusal === null).map((a) => a.model);
  const excluded: string[] = [];

  const minimum = route?.minimumQualityTier ?? null;
  const admissible = minimum
    ? eligible.filter((m) => {
        if (QUALITY_RANK[m.qualityTier] >= QUALITY_RANK[minimum]) return true;
        excluded.push(m.key);
        return false;
      })
    : eligible;

  let chain: string[];
  if (routing.activeProfile === 'custom' || route?.primaryModelKey) {
    /*
     * EXPLICIT WINS, under every profile. A primary named on the route is the
     * owner overriding the strategy for one capability, and an override that a
     * ranking could quietly outvote would not be one.
     */
    const declared = [route?.primaryModelKey, ...(route?.fallbackModelKeys ?? [])].filter(
      (key): key is string => typeof key === 'string' && key.length > 0,
    );
    chain = [];
    for (const key of declared) {
      if (chain.includes(key)) continue;
      const model = admissible.find((m) => m.key === key);
      if (!model) {
        // Named but ineligible — the exact case §7 forbids serving silently.
        excluded.push(key);
        continue;
      }
      chain.push(key);
    }
  } else {
    chain = rankForProfile(
      admissible,
      routing.activeProfile,
      capability,
      route?.latencyPreference ?? null,
    )
      .slice(0, 3)
      .map((m) => m.key);
  }

  if (chain.length === 0) {
    for (const a of assessed) {
      if (a.refusal !== null && !excluded.includes(a.model.key)) excluded.push(a.model.key);
    }
    throw new RoutingError(
      'capability_unsatisfied',
      `No model in the catalogue can serve capability "${capability.key}" for task ` +
        `"${task.key}". Declare the capability on a model, or configure a route for it.`,
    );
  }

  const retry = route?.retryPolicy ?? DEFAULT_RETRY_POLICY;
  return {
    taskKey: task.key,
    modality: task.modality,
    // The capability layer is global by construction: a workspace or plan that
    // needs something different writes a task rule, which wins before this
    // function is ever called.
    scope: 'global',
    chain,
    timeoutMs: route?.timeoutMs ?? 30_000,
    maxCostPerRequestMinor: route?.maxCostPerRequestMinor ?? null,
    parameters: {
      ...DEFAULT_ROUTE_PARAMETERS,
      ...(route?.maxOutputTokens ? { maxOutputTokens: route.maxOutputTokens } : {}),
    },
    retryPolicy: retry,
    // Moderation is a TASK-level decision about a specific product surface, so
    // the capability layer never turns it on. A rule that wants it says so.
    moderateInput: false,
    moderationModelKey: null,
    excludedModelKeys: excluded,
    resolvedBy: 'capability',
    capability: capability.key,
    profile: routing.activeProfile,
  };
}

/**
 * Defaults for a capability route the operator has not written a row for.
 *
 * They mirror the zod defaults in `packages/config` rather than inventing a
 * second set. Nothing commercial is in here: a timeout and a retry count are
 * operational, and both are overridable per capability.
 */
const DEFAULT_RETRY_POLICY: RoutingRule['retryPolicy'] = {
  maxAttempts: 3,
  backoff: 'exponential',
  initialDelayMs: 250,
  jitter: true,
};

const DEFAULT_ROUTE_PARAMETERS: RoutingRule['parameters'] = {
  temperature: 0.7,
  maxOutputTokens: 800,
  promptTemplateVersion: 1,
  persistOutput: false,
  outputRetentionDays: null,
};
