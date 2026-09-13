import { AppError } from '@brandspace/shared';

/**
 * Budgets and limits — docs/AI-GATEWAY.md §8.
 *
 * Every check here runs BEFORE the provider is called and before the wallet is
 * touched. That ordering is the whole value: a budget enforced after the fact
 * is an invoice, not a budget. A request refused here has cost the customer
 * nothing and cost BrandSpace nothing.
 *
 * The module is pure. It is given the limits and the observed usage and it
 * decides; reading either is the gateway's job, so the decision can be unit
 * tested without a database and reused by Admin to explain a refusal.
 */

/** The ceilings that apply to one workspace. `null` means no ceiling. */
export interface BudgetLimits {
  readonly creditsPerDayMilli: number | null;
  readonly creditsPerMonthMilli: number | null;
  readonly maxConcurrentRequests: number | null;
}

export interface PlanBudgetLimits extends BudgetLimits {
  readonly planKey: string;
}

/** The active `ai.budgets` payload. */
export interface AiBudgets {
  readonly defaults: BudgetLimits;
  readonly perPlan: readonly PlanBudgetLimits[];
}

/** What the workspace has actually used, as the gateway measured it. */
export interface BudgetUsage {
  readonly creditsTodayMilli: bigint;
  readonly creditsThisMonthMilli: bigint;
  /** Requests of this workspace that have not reached a terminal status. */
  readonly concurrentRequests: number;
}

export type BudgetBreach = 'credits_per_day' | 'credits_per_month' | 'concurrency' | 'request_cost';

export interface BudgetDecision {
  readonly allowed: boolean;
  readonly breached: BudgetBreach | null;
  /** The ceiling that was hit, for the operator and for the customer message. */
  readonly limit: number | null;
  /** What was observed against it. */
  readonly observed: number;
}

/**
 * A refusal that the CALLER can act on, unlike a routing or pricing failure.
 *
 * Concurrency maps to `RATE_LIMITED` (429) because waiting genuinely helps —
 * §8 asks for retry guidance. A spent credit budget maps to `QUOTA_EXCEEDED`
 * (402) because waiting does not help until the window rolls or the plan
 * changes, and telling a customer to retry would be a lie.
 */
export class BudgetExceededError extends AppError {
  readonly breach: BudgetBreach;
  readonly limit: number | null;
  readonly observed: number;

  constructor(breach: BudgetBreach, message: string, limit: number | null, observed: number) {
    super(breach === 'concurrency' ? 'RATE_LIMITED' : 'QUOTA_EXCEEDED', message);
    this.name = 'BudgetExceededError';
    this.breach = breach;
    this.limit = limit;
    this.observed = observed;
  }
}

/**
 * The ceilings for one workspace: its plan's, or the platform defaults.
 *
 * A plan entry overrides a default field by field, so a plan that raises only
 * the daily credit ceiling still inherits the concurrency limit rather than
 * silently becoming unlimited — which is what a whole-object override would
 * have meant.
 */
export function resolveBudget(budgets: AiBudgets, planKey: string | null): BudgetLimits {
  const plan = planKey ? budgets.perPlan.find((entry) => entry.planKey === planKey) : undefined;
  if (!plan) return budgets.defaults;
  return {
    creditsPerDayMilli: plan.creditsPerDayMilli ?? budgets.defaults.creditsPerDayMilli,
    creditsPerMonthMilli: plan.creditsPerMonthMilli ?? budgets.defaults.creditsPerMonthMilli,
    maxConcurrentRequests: plan.maxConcurrentRequests ?? budgets.defaults.maxConcurrentRequests,
  };
}

/**
 * Would this request, at its estimated cost, break a ceiling?
 *
 * The ESTIMATE is what is tested, not the amount eventually charged. Admitting
 * a request because its final cost might come in under the line would mean the
 * ceiling is only enforced in hindsight.
 *
 * Concurrency is checked first: it is the cheapest signal, the most likely to
 * clear on its own, and the only one whose answer is "try again shortly".
 */
export function assessBudget(
  limits: BudgetLimits,
  usage: BudgetUsage,
  estimateMilliCredits: bigint,
): BudgetDecision {
  if (
    limits.maxConcurrentRequests !== null &&
    usage.concurrentRequests >= limits.maxConcurrentRequests
  ) {
    return {
      allowed: false,
      breached: 'concurrency',
      limit: limits.maxConcurrentRequests,
      observed: usage.concurrentRequests,
    };
  }

  const projectedToday = usage.creditsTodayMilli + estimateMilliCredits;
  if (limits.creditsPerDayMilli !== null && projectedToday > BigInt(limits.creditsPerDayMilli)) {
    return {
      allowed: false,
      breached: 'credits_per_day',
      limit: limits.creditsPerDayMilli,
      observed: Number(projectedToday),
    };
  }

  const projectedMonth = usage.creditsThisMonthMilli + estimateMilliCredits;
  if (
    limits.creditsPerMonthMilli !== null &&
    projectedMonth > BigInt(limits.creditsPerMonthMilli)
  ) {
    return {
      allowed: false,
      breached: 'credits_per_month',
      limit: limits.creditsPerMonthMilli,
      observed: Number(projectedMonth),
    };
  }

  return { allowed: true, breached: null, limit: null, observed: usage.concurrentRequests };
}

/** Turn a refused decision into the error the caller sees. */
export function budgetRefusal(decision: BudgetDecision): BudgetExceededError {
  /* c8 ignore next -- callers only reach here for a refusal. */
  const breach = decision.breached ?? 'credits_per_day';
  const message =
    breach === 'concurrency'
      ? 'This workspace already has as many AI requests running as its plan allows. Try again shortly.'
      : 'This workspace has reached its AI budget for this period.';
  return new BudgetExceededError(breach, message, decision.limit, decision.observed);
}

/**
 * A per-request cost ceiling — §8's first row, "reject before calling the
 * provider".
 *
 * `maxCostPerRequestMinor` is in MINOR units because that is the unit an
 * operator types; provider cost is measured in micro-minor because a minor
 * unit cannot hold a token price. The conversion happens here, once, rather
 * than in a config screen where a factor of a million is easy to get wrong.
 */
export function withinRequestCostCap(
  worstCaseCostMicroMinor: bigint,
  maxCostPerRequestMinor: number | null,
): boolean {
  if (maxCostPerRequestMinor === null) return true;
  return worstCaseCostMicroMinor <= BigInt(maxCostPerRequestMinor) * 1_000_000n;
}
