/**
 * Exact money — docs/BILLING-AND-CREDITS.md §2, CLAUDE.md §2.4.
 *
 * WHY THIS FILE EXISTS AT ALL. A `number` cannot hold money. `0.1 + 0.2` is
 * famously not `0.3`, and the error is not theoretical at this scale: a
 * fraction of a minor unit lost on every line of every invoice becomes a
 * reconciliation the platform cannot explain. Every amount in this system is
 * therefore an INTEGER COUNT OF MINOR UNITS carried in a `bigint`, and the only
 * place a float appears is the moment a formatted string is produced for a
 * human to read.
 *
 * WHY THE SCALE TRAVELS WITH THE AMOUNT. `1000` minor units is 10.00 in SAR and
 * 1.000 in KWD — the same integer, a tenfold difference in money. Kuwaiti,
 * Bahraini and Omani currencies have THREE decimal places, and code that
 * assumes two would overcharge or undercharge a customer in three of the seven
 * launch currencies. So a `Money` carries its `scale`, every operation checks
 * it, and a mismatch is a thrown error rather than a silently wrong total.
 *
 * WHERE THE SCALE COMES FROM. The activated `commerce` configuration's currency
 * catalogue, never a table in this file. Adding EUR, GBP, EGP or JOD is an
 * operator action (CLAUDE.md §2.2); if this module held the list, it would be a
 * deploy. `MoneyScales` is the narrow interface a caller passes in.
 *
 * WHAT THIS MODULE REFUSES TO DO. It will not convert between currencies. There
 * is no rate here, no `convert()`, and no arithmetic that accepts two
 * currencies — D-08 and §7 of the Phase 9 brief make per-currency prices
 * explicit commercial decisions, and a helpful conversion would quietly
 * manufacture a price the owner never set.
 */

import { AppError } from './errors';

/** The canonical wire/storage shape. `minorUnits` is a string so JSON keeps it exact. */
export interface MoneyJson {
  readonly currency: string;
  readonly minorUnits: string;
  readonly scale: number;
}

/**
 * How many decimal digits a currency's minor unit has.
 *
 * Deliberately a lookup the caller supplies rather than a constant: see the
 * file header. `null` means "this currency is not in the activated catalogue",
 * which is an error at the call site rather than a guess of 2.
 */
export interface MoneyScales {
  scaleOf(currency: string): number | null;
}

/** Build a `MoneyScales` from any currency catalogue rows. */
export function moneyScales(
  rows: ReadonlyArray<{ readonly code: string; readonly minorUnitDigits: number }>,
): MoneyScales {
  const map = new Map(rows.map((r) => [normaliseCurrency(r.code), r.minorUnitDigits]));
  return { scaleOf: (currency) => map.get(normaliseCurrency(currency)) ?? null };
}

/**
 * Customer-facing billing uses one product currency today.
 *
 * This is a presentation/onboarding default, not a removal of the platform's
 * multi-currency billing model. Plans and checkout can still carry explicit
 * per-currency prices; a future product decision can expose another currency
 * without changing the storage model.
 */
export const DEFAULT_BILLING_CURRENCY = 'USD' as const;

export function normaliseCurrency(currency: string): string {
  return currency.trim().toUpperCase();
}

const MAX_SCALE = 6;

/**
 * An exact monetary amount in one currency.
 *
 * Immutable. Every operation returns a new instance, so an amount that has been
 * written onto an invoice line cannot be edited by a later calculation holding
 * the same reference.
 */
export class Money {
  readonly currency: string;
  readonly minorUnits: bigint;
  readonly scale: number;

  private constructor(currency: string, minorUnits: bigint, scale: number) {
    this.currency = currency;
    this.minorUnits = minorUnits;
    this.scale = scale;
  }

  /** The canonical constructor: an integer count of minor units at a known scale. */
  static ofMinor(currency: string, minorUnits: bigint | number, scale: number): Money {
    const code = normaliseCurrency(currency);
    if (code.length !== 3) {
      throw new AppError('VALIDATION_FAILED', 'A currency is a three-letter ISO code.');
    }
    if (!Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE) {
      throw new AppError('VALIDATION_FAILED', 'That currency scale is not supported.');
    }
    if (typeof minorUnits === 'number' && !Number.isInteger(minorUnits)) {
      // A fractional minor unit is the exact defect this class exists to
      // prevent, and rounding it here would hide the caller's bug.
      throw new AppError('VALIDATION_FAILED', 'A money amount must be a whole minor unit.');
    }
    return new Money(code, BigInt(minorUnits), scale);
  }

  /** Resolve the scale from the activated catalogue, refusing an unknown currency. */
  static fromCatalogue(currency: string, minorUnits: bigint | number, scales: MoneyScales): Money {
    const code = normaliseCurrency(currency);
    const scale = scales.scaleOf(code);
    if (scale === null) {
      throw new AppError(
        'VALIDATION_FAILED',
        'That currency is not in the activated currency catalogue.',
      );
    }
    return Money.ofMinor(code, minorUnits, scale);
  }

  static zero(currency: string, scale: number): Money {
    return Money.ofMinor(currency, 0n, scale);
  }

  static fromJson(json: MoneyJson): Money {
    return Money.ofMinor(json.currency, BigInt(json.minorUnits), json.scale);
  }

  toJson(): MoneyJson {
    return {
      currency: this.currency,
      minorUnits: this.minorUnits.toString(),
      scale: this.scale,
    };
  }

  get isZero(): boolean {
    return this.minorUnits === 0n;
  }

  get isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  get isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  plus(other: Money): Money {
    this.#assertSameUnit(other, 'add');
    return new Money(this.currency, this.minorUnits + other.minorUnits, this.scale);
  }

  minus(other: Money): Money {
    this.#assertSameUnit(other, 'subtract');
    return new Money(this.currency, this.minorUnits - other.minorUnits, this.scale);
  }

  negated(): Money {
    return new Money(this.currency, -this.minorUnits, this.scale);
  }

  absolute(): Money {
    return this.minorUnits < 0n ? this.negated() : this;
  }

  /** Multiply by a whole quantity — an invoice line's `quantity`, never a rate. */
  times(quantity: bigint | number): Money {
    if (typeof quantity === 'number' && !Number.isInteger(quantity)) {
      throw new AppError('VALIDATION_FAILED', 'A quantity must be a whole number.');
    }
    return new Money(this.currency, this.minorUnits * BigInt(quantity), this.scale);
  }

  /**
   * Apply a rate given in BASIS POINTS — 1500 is 15%.
   *
   * Basis points rather than a percentage float, because `0.15` is not
   * representable and a tax total is not a place to discover that. The result
   * is rounded HALF UP on the absolute value, so a refund of a rounded charge
   * is the same magnitude as the charge.
   */
  rateBasisPoints(basisPoints: bigint | number, rounding: Rounding = 'half-up'): Money {
    if (typeof basisPoints === 'number' && !Number.isInteger(basisPoints)) {
      throw new AppError('VALIDATION_FAILED', 'A rate must be a whole number of basis points.');
    }
    const bp = BigInt(basisPoints);
    if (bp < 0n) {
      throw new AppError('VALIDATION_FAILED', 'A rate cannot be negative.');
    }
    return new Money(
      this.currency,
      divideRounded(this.minorUnits * bp, 10_000n, rounding),
      this.scale,
    );
  }

  /**
   * Split into `parts` as evenly as exact arithmetic allows.
   *
   * The remainder is distributed one minor unit at a time from the first part,
   * so the parts always sum EXACTLY back to the original. Proration that loses
   * a minor unit is a credit note nobody can explain.
   */
  allocateEvenly(parts: number): Money[] {
    if (!Number.isInteger(parts) || parts <= 0) {
      throw new AppError('VALIDATION_FAILED', 'A split needs a positive whole number of parts.');
    }
    const n = BigInt(parts);
    const sign = this.minorUnits < 0n ? -1n : 1n;
    const magnitude = this.minorUnits * sign;
    const base = magnitude / n;
    let remainder = magnitude % n;

    const out: Money[] = [];
    for (let i = 0; i < parts; i += 1) {
      const extra = remainder > 0n ? 1n : 0n;
      remainder -= extra;
      out.push(new Money(this.currency, (base + extra) * sign, this.scale));
    }
    return out;
  }

  /**
   * Prorate by a ratio of whole units — `elapsed / total` days, for instance.
   *
   * Exact: the multiplication happens before the division, so the result never
   * passes through a float.
   */
  prorate(
    numerator: bigint | number,
    denominator: bigint | number,
    rounding: Rounding = 'half-up',
  ): Money {
    const num = BigInt(numerator);
    const den = BigInt(denominator);
    if (den === 0n) {
      throw new AppError('VALIDATION_FAILED', 'A proration cannot divide by zero.');
    }
    return new Money(
      this.currency,
      divideRounded(this.minorUnits * num, den, rounding),
      this.scale,
    );
  }

  compare(other: Money): number {
    this.#assertSameUnit(other, 'compare');
    if (this.minorUnits === other.minorUnits) return 0;
    return this.minorUnits < other.minorUnits ? -1 : 1;
  }

  equals(other: Money): boolean {
    return (
      this.currency === other.currency &&
      this.scale === other.scale &&
      this.minorUnits === other.minorUnits
    );
  }

  /**
   * The amount as a plain decimal string — `10.00`, `1.000`, `-2.50`.
   *
   * This is the canonical TEXT form and is locale-independent on purpose: it is
   * what a PDF's machine-readable field and a test assertion compare against.
   * Human presentation is `formatMoney`.
   */
  toDecimalString(): string {
    const negative = this.minorUnits < 0n;
    const digits = (negative ? -this.minorUnits : this.minorUnits).toString();
    if (this.scale === 0) return `${negative ? '-' : ''}${digits}`;
    const padded = digits.padStart(this.scale + 1, '0');
    const whole = padded.slice(0, padded.length - this.scale);
    const fraction = padded.slice(padded.length - this.scale);
    return `${negative ? '-' : ''}${whole}.${fraction}`;
  }

  toString(): string {
    return `${this.toDecimalString()} ${this.currency}`;
  }

  #assertSameUnit(other: Money, operation: string): void {
    if (this.currency !== other.currency) {
      // THE RULE THE WHOLE PHASE RESTS ON. Two currencies are not two numbers;
      // there is no rate here and there must never be one (§6 of the brief).
      throw new AppError(
        'VALIDATION_FAILED',
        `Amounts in ${this.currency} and ${other.currency} cannot be combined.`,
      );
    }
    if (this.scale !== other.scale) {
      // Same code, different scale means one of them was built against a stale
      // catalogue. Combining them would be off by a factor of ten.
      throw new AppError(
        'VALIDATION_FAILED',
        `Two ${this.currency} amounts disagree about the currency's scale and cannot ${operation}.`,
      );
    }
  }
}

export type Rounding = 'half-up' | 'floor' | 'ceil';

/** Exact integer division with an explicit rounding rule. Never a float. */
export function divideRounded(numerator: bigint, denominator: bigint, rounding: Rounding): bigint {
  if (denominator === 0n) {
    throw new AppError('VALIDATION_FAILED', 'Division by zero.');
  }
  const negative = numerator < 0n !== denominator < 0n;
  const absNum = numerator < 0n ? -numerator : numerator;
  const absDen = denominator < 0n ? -denominator : denominator;
  const quotient = absNum / absDen;
  const remainder = absNum % absDen;

  let magnitude: bigint;
  switch (rounding) {
    case 'half-up':
      magnitude = remainder * 2n >= absDen ? quotient + 1n : quotient;
      break;
    case 'floor':
      magnitude = negative && remainder > 0n ? quotient + 1n : quotient;
      break;
    case 'ceil':
      magnitude = !negative && remainder > 0n ? quotient + 1n : quotient;
      break;
  }
  return negative ? -magnitude : magnitude;
}

/** Sum amounts that must already share a currency. An empty list needs an explicit zero. */
export function sumMoney(amounts: readonly Money[], zero: Money): Money {
  return amounts.reduce((total, next) => total.plus(next), zero);
}

/**
 * Format for a human, in their language.
 *
 * PRESENTATION ONLY. The canonical record keeps `minorUnits`, `scale` and the
 * ISO code; this produces a string and changes nothing. Arabic and English
 * render the same stored amount differently and both are correct — which is
 * exactly why the formatted string is never parsed back.
 *
 * `minimumFractionDigits` is forced to the currency's own scale rather than
 * left to the runtime's currency table: a runtime that disagrees about KWD
 * would otherwise print a different number from the one on the invoice.
 */
export function formatMoney(
  money: Money,
  locale: string,
  options?: { readonly display?: 'symbol' | 'code' | 'name' },
): string {
  const value = Number(money.minorUnits) / 10 ** money.scale;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: money.currency,
      currencyDisplay: options?.display ?? 'code',
      minimumFractionDigits: money.scale,
      maximumFractionDigits: money.scale,
    }).format(value);
  } catch {
    // An unknown-to-the-runtime currency still has to render. The exact digits
    // come from `toDecimalString`, so the fallback is never a different number.
    return `${money.toDecimalString()} ${money.currency}`;
  }
}
