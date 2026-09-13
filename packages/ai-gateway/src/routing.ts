import { AppError } from '@brandspace/shared';

import type { AiModality } from './adapter';
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
}

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
    'unknown_task' | 'not_in_mvp_scope' | 'no_rule' | 'no_usable_model' | 'modality_mismatch';

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
    throw new RoutingError(
      'no_rule',
      `No routing rule matches task "${query.taskKey}" for workspace ${query.workspaceId} ` +
        `on plan ${query.planKey ?? '(none)'}. Configure ai.routing before this task is used.`,
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
  };
}
