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

/*
 * D-573 — THE PLATFORM-WIDE CEILING.
 *
 * The workspace budgets above protect one customer's credits. This one protects
 * the platform's own money: what the AI providers will invoice, across every
 * workspace, per UTC day and per UTC month. It is in PROVIDER cost (micro-minor
 * units of `ai.budgets.platform.currency`, which validation pins to every
 * model's `costCurrency`), never in credits, because a provider's invoice does
 * not know what a credit is.
 *
 * THE SUM, for one period, is:
 *
 *   the actual provider cost of every SUCCEEDED request
 *   + the provider cost ESTIMATE of every request still in flight
 *     (PENDING, RESERVED, RUNNING)
 *
 * and a released, failed, refused or filtered request counts ZERO: it was never
 * charged to the customer, and an attempt the provider refused before doing work
 * is not on the invoice either. In-flight requests count at their estimate so
 * that twenty requests admitted at once cannot each see the same headroom.
 */

/** The active `ai.budgets.platform` payload. `null` means no ceiling. */
export interface PlatformBudgetLimits {
  readonly providerCostPerDayMicroMinor: number | null;
  readonly providerCostPerMonthMicroMinor: number | null;
  readonly currency: string;
}

/** The platform's spend so far, measured by the gateway (see the sum above). */
export interface PlatformSpend {
  readonly todayMicroMinor: bigint;
  readonly thisMonthMicroMinor: bigint;
}

export type PlatformPeriod = 'day' | 'month';

export interface PlatformBudgetDecision {
  readonly allowed: boolean;
  /** The period whose ceiling the request would break, when refused. */
  readonly breached: PlatformPeriod | null;
}

/** The share of a ceiling at which the owner is told, in percent, lowest first. */
export const PLATFORM_ALERT_THRESHOLDS = [80, 100] as const;
export type PlatformAlertThreshold = (typeof PLATFORM_ALERT_THRESHOLDS)[number];

/**
 * Would admitting a request with this worst-case provider cost take the
 * platform past a ceiling? A request that would land exactly ON the ceiling is
 * admitted; one that would cross it is not.
 */
export function assessPlatformBudget(
  limits: PlatformBudgetLimits,
  spend: PlatformSpend,
  estimateMicroMinor: bigint,
): PlatformBudgetDecision {
  const day = limits.providerCostPerDayMicroMinor;
  if (day !== null && spend.todayMicroMinor + estimateMicroMinor > BigInt(day)) {
    return { allowed: false, breached: 'day' };
  }
  const month = limits.providerCostPerMonthMicroMinor;
  if (month !== null && spend.thisMonthMicroMinor + estimateMicroMinor > BigInt(month)) {
    return { allowed: false, breached: 'month' };
  }
  return { allowed: true, breached: null };
}

/** One threshold crossed in one period, for the owner's notice and email. */
export interface PlatformThresholdCrossing {
  readonly period: PlatformPeriod;
  /** The UTC start of the period, so a crossing is reported once per period. */
  readonly periodStart: Date;
  readonly thresholdPercent: PlatformAlertThreshold;
  readonly ceilingMicroMinor: number;
  readonly spentMicroMinor: bigint;
  readonly currency: string;
}

/**
 * Which thresholds does this spend sit at or above? The caller reports each one
 * at most once per period; this function only measures. A refusal at the
 * ceiling counts as reaching 100% even when the admitted sum is below it,
 * because the owner needs to know that customers are being turned away.
 */
export function platformThresholdsReached(
  limits: PlatformBudgetLimits,
  spend: PlatformSpend,
  periodStarts: { readonly day: Date; readonly month: Date },
  refused: PlatformPeriod | null = null,
): PlatformThresholdCrossing[] {
  const crossings: PlatformThresholdCrossing[] = [];
  const periods: [PlatformPeriod, number | null, bigint][] = [
    ['day', limits.providerCostPerDayMicroMinor, spend.todayMicroMinor],
    ['month', limits.providerCostPerMonthMicroMinor, spend.thisMonthMicroMinor],
  ];
  for (const [period, ceiling, spent] of periods) {
    if (ceiling === null || ceiling <= 0) continue;
    for (const threshold of PLATFORM_ALERT_THRESHOLDS) {
      const reached =
        spent * 100n >= BigInt(ceiling) * BigInt(threshold) ||
        (threshold === 100 && refused === period);
      if (!reached) continue;
      crossings.push({
        period,
        periodStart: periodStarts[period],
        thresholdPercent: threshold,
        ceilingMicroMinor: ceiling,
        spentMicroMinor: spent,
        currency: limits.currency,
      });
    }
  }
  return crossings;
}

/** The UTC starts of the day and the month containing `now`. */
export function platformPeriodStarts(now: Date): { day: Date; month: Date } {
  return {
    day: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
    month: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
  };
}

/**
 * AI is paused for everyone. The customer is told only that, in the owner's
 * words (D-573): it is not their wall, so no plan, limit, price or provider is
 * named, and "try again later" is true — the period rolls or the owner acts.
 */
export class PlatformAiPausedError extends AppError {
  readonly period: PlatformPeriod;

  constructor(period: PlatformPeriod) {
    super('AI_PAUSED', 'AI is paused right now. Please try again later.');
    this.name = 'PlatformAiPausedError';
    this.period = period;
  }
}
