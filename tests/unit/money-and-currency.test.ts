import { describe, expect, it } from 'vitest';
import {
  Money,
  divideRounded,
  formatMoney,
  moneyScales,
  normaliseCurrency,
  sumMoney,
} from '@brandspace/shared';
import {
  activeCurrencies,
  commercePolicyFrom,
  currenciesForCountry,
  moneyOf,
  packOffers,
  planAvailability,
  priceOfPack,
  providerKeyFor,
  scalesOf,
  taxPolicyFor,
} from '@brandspace/billing';
import { CATALOGUE } from '../support/commerce-fixture';

/**
 * Exact money and the multi-currency catalogue.
 *
 * THE CATALOGUE LIVES IN `tests/support/commerce-fixture.ts` and is shared with
 * the billing suite, so both reason about the same configured world. None of it
 * is approved commercial data: the real catalogue is entered from Platform Admin
 * and this file only proves the SHAPE of the rules — that three-digit currencies
 * are not two-digit ones, that nothing converts, and that a missing price is
 * reported rather than filled in.
 */

const POLICY = commercePolicyFrom(CATALOGUE as unknown as Record<string, unknown>);

function fixturePlan(
  key: string,
  prices: Array<{ currency: string; monthlyMinor: number; annualMinor: number }>,
) {
  return { key, status: 'active', prices };
}

const STARTER = fixturePlan('fixture-starter', [
  { currency: 'SAR', monthlyMinor: 9900, annualMinor: 99000 },
  { currency: 'AED', monthlyMinor: 9500, annualMinor: 95000 },
  { currency: 'KWD', monthlyMinor: 7900, annualMinor: 79000 },
  { currency: 'QAR', monthlyMinor: 9600, annualMinor: 96000 },
  { currency: 'BHD', monthlyMinor: 9800, annualMinor: 98000 },
  { currency: 'OMR', monthlyMinor: 9700, annualMinor: 97000 },
  { currency: 'USD', monthlyMinor: 2600, annualMinor: 26000 },
]);

/** Deliberately priced in SAR only — the "no price in this currency" fixture. */
const SAR_ONLY = fixturePlan('fixture-sar-only', [
  { currency: 'SAR', monthlyMinor: 19900, annualMinor: 199000 },
]);

describe('Money is exact', () => {
  it('refuses a fractional minor unit rather than rounding the caller’s bug away', () => {
    expect(() => Money.ofMinor('SAR', 10.5, 2)).toThrow(/whole minor unit/i);
  });

  it('never represents an amount as a float', () => {
    const a = Money.ofMinor('SAR', 10, 2);
    const b = Money.ofMinor('SAR', 20, 2);
    // 0.1 + 0.2 !== 0.3 in binary floating point. In minor units it is exact.
    expect(a.plus(b).minorUnits).toBe(30n);
    expect(a.plus(b).toDecimalString()).toBe('0.30');
  });

  it('adds a thousand small amounts without drift', () => {
    const zero = Money.zero('SAR', 2);
    const cents = Array.from({ length: 1000 }, () => Money.ofMinor('SAR', 1, 2));
    expect(sumMoney(cents, zero).toDecimalString()).toBe('10.00');
  });

  it('refuses to combine two currencies — there is no rate here', () => {
    const sar = Money.ofMinor('SAR', 100, 2);
    const aed = Money.ofMinor('AED', 100, 2);
    expect(() => sar.plus(aed)).toThrow(/cannot be combined/i);
    expect(() => sar.minus(aed)).toThrow(/cannot be combined/i);
    expect(() => sar.compare(aed)).toThrow(/cannot be combined/i);
  });

  it('refuses two amounts in one currency that disagree about its scale', () => {
    const two = Money.ofMinor('KWD', 1000, 2);
    const three = Money.ofMinor('KWD', 1000, 3);
    expect(() => two.plus(three)).toThrow(/scale/i);
  });

  it('splits exactly, with the remainder distributed rather than lost', () => {
    const parts = Money.ofMinor('SAR', 100, 2).allocateEvenly(3);
    expect(parts.map((p) => p.minorUnits)).toEqual([34n, 33n, 33n]);
    expect(sumMoney(parts, Money.zero('SAR', 2)).minorUnits).toBe(100n);
  });

  it('splits a negative amount exactly too', () => {
    const parts = Money.ofMinor('SAR', -100, 2).allocateEvenly(3);
    expect(sumMoney(parts, Money.zero('SAR', 2)).minorUnits).toBe(-100n);
  });

  it('prorates without passing through a float', () => {
    // 17 of 30 days of 99.00 SAR = 56.10
    expect(Money.ofMinor('SAR', 9900, 2).prorate(17, 30).toDecimalString()).toBe('56.10');
  });

  it('applies a tax rate in basis points, not a percentage float', () => {
    expect(Money.ofMinor('SAR', 9900, 2).rateBasisPoints(1500).toDecimalString()).toBe('14.85');
  });

  it('rounds half up on the magnitude, so a refund matches its charge', () => {
    const charge = Money.ofMinor('SAR', 333, 2).rateBasisPoints(1500);
    const refund = Money.ofMinor('SAR', -333, 2).rateBasisPoints(1500);
    expect(charge.minorUnits).toBe(-refund.minorUnits);
  });

  it('divides with an explicit rounding rule', () => {
    expect(divideRounded(5n, 2n, 'half-up')).toBe(3n);
    expect(divideRounded(5n, 2n, 'floor')).toBe(2n);
    expect(divideRounded(5n, 2n, 'ceil')).toBe(3n);
    expect(divideRounded(-5n, 2n, 'floor')).toBe(-3n);
    expect(divideRounded(-5n, 2n, 'ceil')).toBe(-2n);
  });

  it('survives a JSON round trip exactly', () => {
    const original = Money.ofMinor('KWD', 1234567, 3);
    const json = JSON.parse(JSON.stringify(original.toJson()));
    expect(Money.fromJson(json).equals(original)).toBe(true);
  });
});

describe('currencies with different minor-unit precision', () => {
  it('reads the same integer as different money in a 2- and a 3-digit currency', () => {
    expect(moneyOf(POLICY, 'SAR', 1000).toDecimalString()).toBe('10.00');
    expect(moneyOf(POLICY, 'KWD', 1000).toDecimalString()).toBe('1.000');
  });

  it('gives every launch currency the scale its own catalogue row declares', () => {
    const scales = scalesOf(POLICY);
    expect(scales.scaleOf('SAR')).toBe(2);
    expect(scales.scaleOf('AED')).toBe(2);
    expect(scales.scaleOf('KWD')).toBe(3);
    expect(scales.scaleOf('QAR')).toBe(2);
    expect(scales.scaleOf('BHD')).toBe(3);
    expect(scales.scaleOf('OMR')).toBe(3);
    expect(scales.scaleOf('USD')).toBe(2);
  });

  it('refuses a currency the catalogue does not carry rather than assuming two digits', () => {
    expect(() => moneyOf(POLICY, 'JOD', 1000)).toThrow(/not in the activated currency catalogue/i);
  });

  it('taxes a three-digit currency at its own precision', () => {
    // 9.900 KWD at 15% is 1.485 KWD — 1485 minor units, not 148.
    expect(moneyOf(POLICY, 'KWD', 9900).rateBasisPoints(1500).minorUnits).toBe(1485n);
  });

  it('carries the catalogue’s seven active currencies and omits an inactive one', () => {
    expect(activeCurrencies(POLICY).map((c) => c.code)).toEqual([
      'SAR',
      'AED',
      'KWD',
      'QAR',
      'BHD',
      'OMR',
      'USD',
    ]);
  });

  it('normalises a currency code without changing the amount', () => {
    expect(normaliseCurrency(' sar ')).toBe('SAR');
    expect(Money.ofMinor('sar', 100, 2).currency).toBe('SAR');
  });
});

describe('no global currency default', () => {
  it('offers a country its configured currencies and does not choose one', () => {
    const offered = currenciesForCountry(POLICY, 'AE').map((c) => c.code);
    expect(offered).toEqual(['AED', 'USD']);
    // The list is a CHOICE. Nothing in the policy names a default, and there is
    // no field that could carry one.
    expect(Object.keys(POLICY)).not.toContain('defaultCurrency');
  });

  it('offers nothing for a country the owner has not configured', () => {
    expect(currenciesForCountry(POLICY, 'ZZ')).toEqual([]);
  });

  it('never returns a currency the catalogue has retired', () => {
    expect(currenciesForCountry(POLICY, 'SA').map((c) => c.code)).not.toContain('EUR');
  });
});

describe('plan pricing comes from configuration, per currency', () => {
  const cases: Array<[string, string, string]> = [
    ['SA', 'SAR', '99.00'],
    ['AE', 'AED', '95.00'],
    ['KW', 'KWD', '7.900'],
    ['QA', 'QAR', '96.00'],
    ['BH', 'BHD', '9.800'],
    ['OM', 'OMR', '9.700'],
    ['US', 'USD', '26.00'],
  ];

  it.each(cases)(
    'prices the plan in %s/%s from the configured table',
    (country, currency, expected) => {
      const availability = planAvailability(POLICY, STARTER, country, currency);
      expect(availability.available).toBe(true);
      expect(availability.monthly?.currency).toBe(currency);
      expect(availability.monthly?.toDecimalString()).toBe(expected);
    },
  );

  it('does not derive one currency’s price from another', () => {
    const sar = planAvailability(POLICY, STARTER, 'SA', 'SAR').monthly!;
    const aed = planAvailability(POLICY, STARTER, 'AE', 'AED').monthly!;
    const usd = planAvailability(POLICY, STARTER, 'US', 'USD').monthly!;
    // Independent commercial numbers: no ratio between them is a rate, and no
    // arithmetic in the package can produce one from another.
    expect(sar.minorUnits).not.toBe(aed.minorUnits);
    expect(usd.minorUnits).not.toBe(aed.minorUnits);
  });

  it('reports a plan with no price in the chosen currency as unavailable, honestly', () => {
    const availability = planAvailability(POLICY, SAR_ONLY, 'SA', 'USD');
    expect(availability.available).toBe(false);
    expect(availability.reason).toBe('no_price_in_currency');
    expect(availability.monthly).toBeNull();
    expect(availability.annual).toBeNull();
  });

  it('lets a plan be available in one market and unavailable in another', () => {
    expect(planAvailability(POLICY, SAR_ONLY, 'SA', 'SAR').available).toBe(true);
    const inUae = planAvailability(POLICY, SAR_ONLY, 'AE', 'AED');
    expect(inUae.available).toBe(false);
    expect(inUae.reason).toBe('not_offered_in_market');
  });

  it('refuses a currency the market does not offer even when the plan has a price for it', () => {
    // BH offers only BHD; the plan does have a SAR price.
    const result = planAvailability(POLICY, STARTER, 'BH', 'SAR');
    expect(result.available).toBe(false);
    expect(result.reason).toBe('not_offered_in_market');
  });

  it('refuses a plan that is not active', () => {
    const draft = { ...STARTER, status: 'draft' };
    expect(planAvailability(POLICY, draft, 'SA', 'SAR').reason).toBe('not_active');
  });
});

describe('credit packs are configuration and are priced server-side', () => {
  it('prices a pack in the customer’s own currency at its own scale', () => {
    const sar = packOffers(POLICY, 'SA', 'SAR');
    expect(sar).toHaveLength(1);
    expect(sar[0]!.price.toDecimalString()).toBe('99.00');

    const kwd = packOffers(POLICY, 'KW', 'KWD');
    expect(kwd[0]!.price.toDecimalString()).toBe('9.900');
  });

  it('omits a pack with no price in the chosen currency rather than converting it', () => {
    expect(packOffers(POLICY, 'BH', 'BHD')).toEqual([]);
  });

  it('looks the price up from configuration, so a browser cannot supply one', () => {
    const offer = priceOfPack(POLICY, 'fixture-pack-small', 'SA', 'SAR');
    expect(offer.price.minorUnits).toBe(9900n);
    // There is no parameter through which a caller could pass an amount: the
    // signature takes a key, a country and a currency and nothing else.
    expect(priceOfPack.length).toBe(4);
  });

  it('refuses a pack that is not on sale here', () => {
    expect(() => priceOfPack(POLICY, 'fixture-pack-small', 'BH', 'BHD')).toThrow(/not on sale/i);
  });
});

describe('tax and provider routing are configuration', () => {
  it('resolves the market’s own tax policy rather than a universal rate', () => {
    expect(taxPolicyFor(POLICY, 'SA')?.mode).toBe('exclusive');
    expect(taxPolicyFor(POLICY, 'KW')?.mode).toBe('none');
    // A market with no policy configured has none — not an assumed default.
    expect(taxPolicyFor(POLICY, 'BH')).toBeNull();
  });

  it('routes to the configured adapter key and names no production provider', () => {
    expect(providerKeyFor(POLICY, 'SA', 'SAR')).toBe('development-mock');
  });

  it('returns null when no route matches, so the caller refuses instead of guessing', () => {
    const narrowed = commercePolicyFrom({
      ...(CATALOGUE as unknown as Record<string, unknown>),
      providerRouting: [
        { providerKey: 'development-mock', countries: ['SA'], currencies: null, priority: 0 },
      ],
    });
    expect(providerKeyFor(narrowed, 'US', 'USD')).toBeNull();
  });
});

describe('localized display never changes the stored amount', () => {
  it('renders the same canonical amount differently in Arabic and English', () => {
    const amount = moneyOf(POLICY, 'SAR', 9900);
    const en = formatMoney(amount, 'en');
    const ar = formatMoney(amount, 'ar');
    expect(en).not.toBe(ar);
    // The canonical record is untouched by either rendering.
    expect(amount.minorUnits).toBe(9900n);
    expect(amount.toDecimalString()).toBe('99.00');
    expect(amount.currency).toBe('SAR');
  });

  it('prints a three-digit currency with three digits in both languages', () => {
    const amount = moneyOf(POLICY, 'KWD', 9900);
    for (const locale of ['en', 'ar']) {
      // Whatever the runtime's own currency table says, the digits come from
      // the catalogue — so the screen and the invoice cannot disagree.
      expect(formatMoney(amount, locale)).toMatch(/9[.,]900/);
    }
  });

  it('falls back to the canonical digits for a currency the runtime does not know', () => {
    const odd = Money.ofMinor('XTS', 1234, 2);
    expect(formatMoney(odd, 'en')).toContain('12.34');
  });

  it('is never parsed back — the canonical form is the decimal string', () => {
    const amount = moneyOf(POLICY, 'BHD', 1500);
    expect(amount.toDecimalString()).toBe('1.500');
    expect(amount.toString()).toBe('1.500 BHD');
  });
});

describe('a currency catalogue can be extended without code changes', () => {
  it('accepts a currency this test invented, with its own scale', () => {
    const extended = commercePolicyFrom({
      ...(CATALOGUE as unknown as Record<string, unknown>),
      currencies: [
        ...CATALOGUE.currencies,
        {
          code: 'JOD',
          name: { ar: 'دينار أردني', en: 'Jordanian Dinar' },
          minorUnitDigits: 3,
          status: 'active',
          sortOrder: 9,
        },
      ],
      markets: [
        ...CATALOGUE.markets,
        {
          country: 'JO',
          name: { ar: 'الأردن', en: 'Jordan' },
          currencies: ['JOD'],
          planKeys: null,
          taxPolicyKey: null,
          status: 'active',
        },
      ],
    });
    expect(currenciesForCountry(extended, 'JO').map((c) => c.code)).toEqual(['JOD']);
    expect(moneyOf(extended, 'JOD', 1000).toDecimalString()).toBe('1.000');
  });

  it('holds no list of currency codes in application source', () => {
    // The catalogue arrived as a fixture; nothing in the package enumerates
    // currencies. `moneyScales` is built from whatever rows it is handed.
    const empty = moneyScales([]);
    expect(empty.scaleOf('SAR')).toBeNull();
  });
});
