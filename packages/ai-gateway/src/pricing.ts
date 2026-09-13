import { AppError } from '@brandspace/shared';

import type { UsageUnits } from './adapter';

/**
 * Cost and credit arithmetic — docs/AI-GATEWAY.md §7.2.
 *
 *   providerCost   = Σ (usageUnits × unitCostFromModelRegistry)
 *   creditsCharged = ceil( creditCost(taskKey, modelKey, usageUnits) × workspaceMultiplier )
 *
 * EVERY INPUT IS CONFIGURATION. Not one rate, floor or multiplier appears in
 * this file; it contains the arithmetic and nothing else. CLAUDE.md §2.2 puts
 * AI credit costs among the values that must never be hard-coded, and a
 * "sensible default" here would be indistinguishable, on the margin screen,
 * from a number an operator actually entered.
 *
 * TWO SCALES, BOTH INTEGER, NEITHER FLOAT.
 *
 *   - Money is counted in MICRO-MINOR units: a millionth of a minor unit
 *     (so 10^-8 of a major unit). Providers price in fractions of a cent — a
 *     text model at $0.15 per million input tokens is 0.015 of a cent per
 *     thousand tokens — and an integer count of cents rounds every one of them
 *     to zero.
 *   - Credits are counted in MILLI-CREDITS (D-14), displayed as whole credits.
 *
 * Floating point is never used for either. A cent that drifts by 2^-52 per
 * request is a ledger that stops reconciling.
 */

export type AiBillingUnit = '1k_tokens' | 'image' | 'second' | 'character' | 'request';

/** A model's cost basis, from the `ai.models` registry. */
export interface ModelCostBasis {
  readonly modelKey: string;
  /** Null until an operator enters the provider's real rate. */
  readonly inputCostPerUnitMicroMinor: number | null;
  readonly outputCostPerUnitMicroMinor: number | null;
  readonly costUnit: AiBillingUnit;
  readonly costCurrency: string;
}

/** What BrandSpace charges for one task on one model, from `ai.credit-rules`. */
export interface CreditRule {
  readonly taskKey: string;
  readonly modelKey: string;
  readonly baseMilliCredits: number;
  readonly perUnitMilliCredits: number;
  readonly unit: AiBillingUnit;
}

export class PricingError extends AppError {
  readonly reason: 'no_credit_rule' | 'no_cost_basis' | 'unmeasurable_unit';

  constructor(reason: PricingError['reason'], message: string) {
    super('INTERNAL', message);
    this.name = 'PricingError';
    this.reason = reason;
  }
}

/**
 * Usage expressed in thousandths of a billing unit.
 *
 * Returned scaled by 1000 rather than as a fraction because the caller
 * multiplies it by a per-unit rate and must not lose the remainder: a request
 * using 1,500 tokens is 1.5 thousand-token units, and rounding that to 1 or 2
 * before multiplying changes the bill.
 */
export function billableMilliUnits(usage: UsageUnits, unit: AiBillingUnit): number {
  switch (unit) {
    case '1k_tokens': {
      const tokens = (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
      return tokens;
    }
    case 'image':
      return (usage.imageCount ?? 0) * 1000;
    case 'second':
      return (usage.durationSeconds ?? 0) * 1000;
    case 'character':
      return (usage.characters ?? 0) * 1000;
    case 'request':
      return 1000;
  }
}

/** Integer division that rounds up. Negative inputs are a programming error. */
function divideRoundingUp(numerator: bigint, denominator: bigint): bigint {
  if (numerator <= 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
}

/**
 * What the PROVIDER charged, in micro-minor units of the model's currency.
 *
 * Input and output are priced separately because providers price them
 * separately, often by a factor of four or more. Units that have no
 * input/output distinction — an image, a second of video — are priced at the
 * OUTPUT rate, which is what those registry rows mean.
 *
 * Rounds UP. Under-recording our own cost inflates reported margin, which is
 * the direction that hides a loss-making model.
 */
export function providerCostMicroMinor(usage: UsageUnits, basis: ModelCostBasis): bigint {
  if (basis.inputCostPerUnitMicroMinor === null || basis.outputCostPerUnitMicroMinor === null) {
    throw new PricingError(
      'no_cost_basis',
      `Model "${basis.modelKey}" has no cost basis. Enter the provider rates before serving it.`,
    );
  }

  const inputRate = BigInt(basis.inputCostPerUnitMicroMinor);
  const outputRate = BigInt(basis.outputCostPerUnitMicroMinor);

  if (basis.costUnit === '1k_tokens') {
    const promptCost = BigInt(usage.promptTokens ?? 0) * inputRate;
    const completionCost = BigInt(usage.completionTokens ?? 0) * outputRate;
    // Rates are per 1,000 tokens and the counts are in tokens.
    return divideRoundingUp(promptCost + completionCost, 1000n);
  }

  const milliUnits = BigInt(billableMilliUnits(usage, basis.costUnit));
  return divideRoundingUp(milliUnits * outputRate, 1000n);
}

/**
 * What the CUSTOMER is charged, in milli-credits.
 *
 * `multiplierBasisPoints` is the workspace multiplier of §7.2 expressed in
 * basis points (10,000 = ×1). An integer keeps the arithmetic exact; a float
 * multiplier of 1.1 is not 1.1.
 *
 * Rounds UP at the end and only at the end — rounding the base and the per-unit
 * component separately would charge twice for the same fraction of a credit.
 */
export function creditsChargedMilli(
  usage: UsageUnits,
  rule: CreditRule,
  multiplierBasisPoints = 10_000,
): bigint {
  if (multiplierBasisPoints < 0) {
    throw new PricingError('no_credit_rule', 'A credit multiplier cannot be negative.');
  }

  const milliUnits = BigInt(billableMilliUnits(usage, rule.unit));
  const base = BigInt(rule.baseMilliCredits) * 1000n;
  const perUnit = milliUnits * BigInt(rule.perUnitMilliCredits);

  return divideRoundingUp((base + perUnit) * BigInt(multiplierBasisPoints), 1000n * 10_000n);
}

/** Find the rule for a task/model pair. There is no fallback rule by design. */
export function findCreditRule(
  rules: readonly CreditRule[],
  taskKey: string,
  modelKey: string,
): CreditRule {
  const rule = rules.find((r) => r.taskKey === taskKey && r.modelKey === modelKey);
  if (!rule) {
    // Serving a task with no price is serving it for free, permanently and
    // silently. An operator who has not priced a model has not finished
    // enabling it.
    throw new PricingError(
      'no_credit_rule',
      `No credit rule prices task "${taskKey}" on model "${modelKey}".`,
    );
  }
  return rule;
}

/**
 * The generous up-front estimate — §7.3 Reserve.
 *
 * Reservation is sized on the WORST case the route permits: the whole prompt
 * plus the full `maxOutputTokens` the rule allows. Settlement then narrows it
 * to the actual and releases the rest, so the customer never pays for the
 * over-estimate. Estimating tightly would be the dangerous direction — a
 * response longer than predicted would settle above its reservation, which the
 * `ai_request_charge_within_reservation` constraint refuses outright.
 */
export function estimateReservationMilli(
  rule: CreditRule,
  worstCase: UsageUnits,
  multiplierBasisPoints = 10_000,
): bigint {
  return creditsChargedMilli(worstCase, rule, multiplierBasisPoints);
}

/**
 * The price a charge must reach to hit a target gross margin — D-15.
 *
 *     customer price = provider cost / (1 - target gross margin)
 *
 * This is the DERIVATION direction, and it is the one people get wrong. A 65%
 * target is not "cost plus 65%": marking a cost of 100 up by 65% gives 165, on
 * which the margin is 65/165 ≈ 39.4%, not 65%. Dividing by (1 − 0.65) gives
 * ~285.7, and (285.7 − 100) / 285.7 = 65% exactly. The two differ by more than
 * a rounding error and the mistake compounds across every priced task.
 *
 * `targetBasisPoints` is the margin in basis points (6,500 = 65%), an integer
 * for the same reason every other rate here is one. The target itself is
 * configuration — no margin is named in this file.
 *
 * Rounds UP: pricing a fraction of a unit below the target would miss it.
 */
export function requiredPriceMicroMinor(costMicroMinor: bigint, targetBasisPoints: number): bigint {
  if (targetBasisPoints < 0 || targetBasisPoints >= 10_000) {
    // A target of 100% or more implies an infinite price: there is no finite
    // number a cost can be divided by zero-or-less to reach it.
    throw new PricingError(
      'no_credit_rule',
      'A target gross margin must be at least 0% and below 100%.',
    );
  }
  if (costMicroMinor <= 0n) return 0n;
  return divideRoundingUp(costMicroMinor * 10_000n, BigInt(10_000 - targetBasisPoints));
}

export interface MarginAssessment {
  /** Null when no credit value is configured — margin is UNKNOWN, not fine. */
  readonly grossMarginPercent: number | null;
  readonly revenueMicroMinor: bigint | null;
  readonly costMicroMinor: bigint;
  /** True only when a floor is configured AND the margin is known to breach it. */
  readonly belowFloor: boolean;
}

/**
 * Gross margin on one charge — the input to the §7.2 margin warning.
 *
 * Returns `null` margin when `creditValueMicroMinor` is unset. That is the
 * honest answer: revenue is denominated in credits and cost in money, and
 * nothing converts between them until the owner prices a credit (D-15/D-16).
 * Reporting 100% margin in that state, or quietly passing the floor check,
 * would make an unpriced platform look profitable.
 */
export function assessMargin(
  costMicroMinor: bigint,
  creditsMilli: bigint,
  creditValueMicroMinor: number | null,
  minimumGrossMarginPercent: number,
): MarginAssessment {
  if (creditValueMicroMinor === null) {
    return {
      grossMarginPercent: null,
      revenueMicroMinor: null,
      costMicroMinor,
      belowFloor: false,
    };
  }

  // creditsMilli is thousandths of a credit; creditValue is per whole credit.
  const revenue = (creditsMilli * BigInt(creditValueMicroMinor)) / 1000n;
  if (revenue <= 0n) {
    return {
      grossMarginPercent: costMicroMinor > 0n ? -100 : 0,
      revenueMicroMinor: revenue,
      costMicroMinor,
      belowFloor: minimumGrossMarginPercent > 0 && costMicroMinor > 0n,
    };
  }

  // Percent is a report, not money: a float is fine here and nowhere above.
  const margin = Number(((revenue - costMicroMinor) * 10_000n) / revenue) / 100;
  return {
    grossMarginPercent: margin,
    revenueMicroMinor: revenue,
    costMicroMinor,
    belowFloor: minimumGrossMarginPercent > 0 && margin < minimumGrossMarginPercent,
  };
}
