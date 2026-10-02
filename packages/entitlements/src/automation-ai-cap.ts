import type { EntitlementDecision, PlanEntitlementRule } from './precedence';

/**
 * PHASE 2B-3 PR 6 — THE MONTHLY CAP ON AI AUTOMATION ACTIONS (Q18, D-458, D-459).
 *
 * The plan carries two optional fields, `quotas.automationAiActionsPerMonth`
 * and `quotas.trialAutomationAiActionsPerMonth`, each `{ kind: 'limited',
 * value }` or `{ kind: 'unlimited' }`. Absent is OFF. Both project into the one
 * feature `limit.automation_ai_actions`, whose declared default is `false`, so
 * a workspace on a plan that does not set the field — or on no plan — is not
 * entitled at all.
 *
 * THE TRIAL VALUE APPLIES ONLY WHERE THE PLAN DECIDED. A kill switch, a
 * workspace override or a flag that decided the feature is the owner speaking
 * about THIS workspace and wins exactly as for every other feature; only when
 * the plan rung decided, and the subscription is TRIALING, does the trial field
 * replace the plan's value. `can()`, `limit()`, `explain()` and `resolveAll()`
 * all go through it, so the engine's yes/no and the executor's number never
 * disagree.
 */

export const AUTOMATION_AI_ACTIONS_FEATURE = 'limit.automation_ai_actions';

/** The plan field, and its trial counterpart, that project into the feature. */
export const AUTOMATION_AI_CAP_FIELDS = {
  plan: 'automationAiActionsPerMonth',
  trial: 'trialAutomationAiActionsPerMonth',
} as const;

/**
 * Read one cap field. `null` when not set (off), otherwise the limit:
 * a number, or `null` limitValue for unlimited.
 */
export function readAutomationAiCap(raw: unknown): { readonly limitValue: number | null } | null {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  const cap = raw as { kind?: unknown; value?: unknown };
  if (cap.kind === 'unlimited') return { limitValue: null };
  if (
    cap.kind === 'limited' &&
    typeof cap.value === 'number' &&
    Number.isInteger(cap.value) &&
    cap.value >= 1
  ) {
    return { limitValue: cap.value };
  }
  return null;
}

/** The plan entitlement rows one cap field projects to, one per plan that sets it. */
export function projectAutomationAiCap(
  plans: ReadonlyArray<Record<string, unknown>>,
  field: string,
): PlanEntitlementRule[] {
  const rows: PlanEntitlementRule[] = [];
  for (const plan of plans) {
    const planKey = String(plan['key'] ?? '');
    if (!planKey) continue;
    const quotas = (plan['quotas'] ?? {}) as Record<string, unknown>;
    const cap = readAutomationAiCap(quotas[field]);
    if (!cap) continue;
    rows.push({
      planKey,
      featureKey: AUTOMATION_AI_ACTIONS_FEATURE,
      enabled: true,
      limitValue: cap.limitValue,
      enumValue: null,
      limitPeriod: 'month',
    });
  }
  return rows;
}

/**
 * Replace a plan-decided decision with the trial's value while TRIALING.
 *
 * Only for the feature the trial field projects to; any other decision, and
 * any decision another rung made, is returned unchanged.
 */
export function applyTrialQuota(
  decision: EntitlementDecision,
  trialRules: readonly PlanEntitlementRule[],
  context: { readonly planKey: string | null; readonly trialing?: boolean },
): EntitlementDecision {
  if (decision.featureKey !== AUTOMATION_AI_ACTIONS_FEATURE) return decision;
  if (context.trialing !== true || context.planKey === null) return decision;
  if (decision.source !== 'plan_entitlement') return decision;

  const trial = trialRules.find(
    (rule) => rule.planKey === context.planKey && rule.featureKey === decision.featureKey,
  );
  return {
    ...decision,
    enabled: trial !== undefined,
    limitValue: trial ? trial.limitValue : null,
    trace: [
      ...decision.trace,
      {
        source: 'plan_entitlement',
        decided: true,
        detail: trial
          ? `trial: ${trial.limitValue === null ? 'unlimited' : String(trial.limitValue)}`
          : 'trial: not set (off)',
      },
    ],
  };
}
