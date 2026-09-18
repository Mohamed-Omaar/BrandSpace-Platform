/**
 * Tax, applied from the market's configured policy — never from a rule in code.
 *
 * NO JURISDICTION IS NAMED HERE. There is no `if (country === 'SA')`, no rate
 * constant and no list of countries that charge VAT. A market points at a tax
 * policy key, the policy carries the mode and the rate in basis points, and this
 * file applies it. Adding a country, changing a rate, or moving a market from
 * exclusive to inclusive is an owner action in Platform Admin (§32) — it is not
 * a deployment.
 *
 * BASIS POINTS, NOT PERCENT. 15% is 1500, and 7.5% is 750. A percentage held as
 * a float would reintroduce exactly the inexactness `Money` exists to remove.
 *
 * THE THREE MODES ARE GENUINELY DIFFERENT DOCUMENTS:
 *
 *   NONE       the price is the total, and the invoice says no tax was charged.
 *   EXCLUSIVE  tax is added on top. Subtotal is what was advertised.
 *   INCLUSIVE  the advertised price ALREADY contains the tax, so the subtotal is
 *              derived backwards out of it. A customer who was shown 115.00 pays
 *              115.00 — showing them 115.00 and charging 132.25 is the bug this
 *              mode exists to prevent.
 */

import { Money, divideRounded } from '@brandspace/shared';
import type { TaxPolicyDetail } from './commerce';

export type TaxMode = 'NONE' | 'EXCLUSIVE' | 'INCLUSIVE';

export interface TaxAssessment {
  readonly mode: TaxMode;
  readonly rateBasisPoints: number;
  readonly policyKey: string | null;
  /** The net amount, before tax. */
  readonly subtotal: Money;
  readonly tax: Money;
  /** What the customer actually pays. */
  readonly total: Money;
}

const BASIS_POINT_SCALE = 10_000n;

/**
 * Assess tax on an amount that was quoted to the customer.
 *
 * `quoted` is what the catalogue says the thing costs. Whether that number is
 * the subtotal or the total depends on the MODE, which is the entire reason this
 * function takes the policy rather than a rate.
 */
export function assessTax(quoted: Money, policy: TaxPolicyDetail | null): TaxAssessment {
  const zero = Money.zero(quoted.currency, quoted.scale);

  if (!policy || policy.mode === 'none' || policy.rateBasisPoints === 0) {
    return {
      mode: 'NONE',
      rateBasisPoints: 0,
      policyKey: policy?.key ?? null,
      subtotal: quoted,
      tax: zero,
      total: quoted,
    };
  }

  const rate = BigInt(policy.rateBasisPoints);

  if (policy.mode === 'exclusive') {
    const tax = quoted.rateBasisPoints(rate);
    return {
      mode: 'EXCLUSIVE',
      rateBasisPoints: policy.rateBasisPoints,
      policyKey: policy.key,
      subtotal: quoted,
      tax,
      total: quoted.plus(tax),
    };
  }

  /*
   * INCLUSIVE. net = gross * 10000 / (10000 + rate), and the tax is the
   * REMAINDER rather than a second rounded multiplication. Rounding both halves
   * independently is how an invoice ends up one minor unit short of its own
   * total — and a CHECK constraint in the database refuses that row, which is
   * the correct outcome but a poor way to find out.
   */
  const netMinor = divideRounded(
    quoted.minorUnits * BASIS_POINT_SCALE,
    BASIS_POINT_SCALE + rate,
    'half-up',
  );
  const subtotal = Money.ofMinor(quoted.currency, netMinor, quoted.scale);
  return {
    mode: 'INCLUSIVE',
    rateBasisPoints: policy.rateBasisPoints,
    policyKey: policy.key,
    subtotal,
    tax: quoted.minus(subtotal),
    total: quoted,
  };
}

/**
 * Whether the market requires a tax registration number from the buyer.
 *
 * Asked of the policy, so a market that starts requiring one is a configuration
 * change and the UI follows without being rebuilt.
 */
export function taxIdRequired(policy: TaxPolicyDetail | null): boolean {
  return policy?.taxIdRequired === true;
}
