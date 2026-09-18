/**
 * The commercial geography, read from activated configuration.
 *
 * WHAT THIS ANSWERS. Which currencies exist and what each one's minor unit is
 * worth; which currencies a country is offered; which plans are sellable there;
 * what a plan costs in the currency the customer chose; which tax policy
 * applies; which credit packs are on sale. Every answer comes from the
 * activated `commerce` document and nothing here invents one.
 *
 * THE TWO REFUSALS THIS FILE IS BUILT AROUND:
 *
 *   1. NO DEFAULT CURRENCY. There is no `defaultCurrency`, no "first active
 *      currency" fallback and no country-to-currency inference. A market may
 *      NARROW the list a customer picks from; the customer still picks
 *      (D-194, §4 of the Phase 9 brief).
 *
 *   2. NO CONVERSION. A plan with no price in the selected currency is
 *      UNAVAILABLE and says so. There is no rate in this package, and adding
 *      one would manufacture a price the owner never agreed to (D-08, §7).
 */

import { parseConfigPayload } from '@brandspace/config';
import {
  AppError,
  Money,
  moneyScales,
  normaliseCurrency,
  type MoneyScales,
} from '@brandspace/shared';

export const COMMERCE_CONFIG_DOMAIN = 'commerce' as const;

export type Environment = 'DEVELOPMENT' | 'STAGING' | 'PRODUCTION';

export interface LocalizedText {
  readonly ar: string;
  readonly en: string;
}

export interface CurrencyDetail {
  readonly code: string;
  readonly name: LocalizedText;
  readonly minorUnitDigits: number;
  readonly status: 'active' | 'inactive';
  readonly sortOrder: number;
}

export interface TaxPolicyDetail {
  readonly key: string;
  readonly name: LocalizedText;
  readonly mode: 'none' | 'exclusive' | 'inclusive';
  readonly rateBasisPoints: number;
  readonly taxIdLabel: LocalizedText | null;
  readonly taxIdRequired: boolean;
  readonly invoiceNote: LocalizedText | null;
}

export interface MarketDetail {
  readonly country: string;
  readonly name: LocalizedText;
  readonly currencies: readonly string[];
  readonly planKeys: readonly string[] | null;
  readonly taxPolicyKey: string | null;
  readonly status: 'active' | 'inactive';
}

export interface CreditPackDetail {
  readonly key: string;
  readonly name: LocalizedText;
  readonly description: LocalizedText | null;
  readonly credits: number;
  readonly prices: ReadonlyArray<{ readonly currency: string; readonly amountMinor: number }>;
  readonly countries: readonly string[] | null;
  readonly expiryDays: number | null;
  readonly status: 'draft' | 'active' | 'retired';
  readonly sortOrder: number;
}

export interface DunningPolicy {
  readonly retryOffsetDays: readonly number[];
  readonly graceDays: number;
  readonly cancelAfterSuspendedDays: number;
}

export interface InvoiceIdentity {
  readonly numberPrefix: string;
  readonly numberPadding: number;
  readonly legalName: LocalizedText | null;
  readonly address: LocalizedText | null;
  readonly taxRegistrationNumber: string | null;
  readonly footerNote: LocalizedText | null;
}

export interface ProviderRoute {
  readonly providerKey: string;
  readonly countries: readonly string[] | null;
  readonly currencies: readonly string[] | null;
  readonly priority: number;
}

export interface CommercePolicy {
  readonly currencies: readonly CurrencyDetail[];
  readonly markets: readonly MarketDetail[];
  readonly taxPolicies: readonly TaxPolicyDetail[];
  readonly creditPacks: readonly CreditPackDetail[];
  readonly providerRouting: readonly ProviderRoute[];
  readonly checkout: { readonly sessionTtlMinutes: number; readonly trustBrowserRedirect: false };
  readonly dunning: DunningPolicy;
  readonly invoice: InvoiceIdentity;
}

/** Parse one activated `commerce` document. Defaults come from the schema, not from here. */
export function commercePolicyFrom(payload: Record<string, unknown>): CommercePolicy {
  const doc = parseConfigPayload(COMMERCE_CONFIG_DOMAIN, payload) as unknown as CommercePolicy;
  return doc;
}

// --- Currency ----------------------------------------------------------------

export function activeCurrencies(policy: CommercePolicy): readonly CurrencyDetail[] {
  return [...policy.currencies]
    .filter((c) => c.status === 'active')
    .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
}

export function findCurrency(policy: CommercePolicy, code: string): CurrencyDetail | null {
  const wanted = normaliseCurrency(code);
  return policy.currencies.find((c) => normaliseCurrency(c.code) === wanted) ?? null;
}

/** The scale lookup `Money` needs, built from the activated catalogue. */
export function scalesOf(policy: CommercePolicy): MoneyScales {
  return moneyScales(
    policy.currencies.map((c) => ({ code: c.code, minorUnitDigits: c.minorUnitDigits })),
  );
}

/**
 * Build a `Money` from an amount the CONFIGURATION supplied.
 *
 * The scale comes from the catalogue rather than from the caller, so a price
 * written as `1500` is 1.500 KWD and 15.00 SAR without either call site
 * knowing which — which is the whole reason the scale is not a constant.
 */
export function moneyOf(
  policy: CommercePolicy,
  currency: string,
  minorUnits: bigint | number,
): Money {
  return Money.fromCatalogue(currency, minorUnits, scalesOf(policy));
}

// --- Markets -----------------------------------------------------------------

export function findMarket(policy: CommercePolicy, country: string): MarketDetail | null {
  const wanted = country.trim().toUpperCase();
  return (
    policy.markets.find(
      (m) => m.country.trim().toUpperCase() === wanted && m.status === 'active',
    ) ?? null
  );
}

/**
 * The currencies a customer in this country may CHOOSE BETWEEN.
 *
 * Intersected with the active catalogue, so retiring a currency removes it from
 * every market at once rather than leaving a market offering something that no
 * longer has a scale.
 *
 * AN UNKNOWN COUNTRY RETURNS NOTHING, and that is the honest answer: the
 * platform has not been configured to sell there. Falling back to "all
 * currencies" would sell into a market the owner never approved.
 */
export function currenciesForCountry(
  policy: CommercePolicy,
  country: string,
): readonly CurrencyDetail[] {
  const market = findMarket(policy, country);
  if (!market) return [];
  const offered = new Set(market.currencies.map(normaliseCurrency));
  return activeCurrencies(policy).filter((c) => offered.has(normaliseCurrency(c.code)));
}

/** Every country the platform is configured to sell in, for the onboarding picker. */
export function activeMarkets(policy: CommercePolicy): readonly MarketDetail[] {
  return [...policy.markets]
    .filter((m) => m.status === 'active')
    .sort((a, b) => a.country.localeCompare(b.country));
}

export function taxPolicyFor(policy: CommercePolicy, country: string): TaxPolicyDetail | null {
  const market = findMarket(policy, country);
  if (!market?.taxPolicyKey) return null;
  return policy.taxPolicies.find((t) => t.key === market.taxPolicyKey) ?? null;
}

// --- Plan availability -------------------------------------------------------

/**
 * Why a plan cannot be bought, when it cannot.
 *
 * A REASON RATHER THAN A BOOLEAN, because the two cases need different
 * sentences: "we do not sell this plan in your country" and "this plan has no
 * price in the currency you chose" are different facts, and collapsing them
 * into "unavailable" would leave the customer unable to act on either.
 */
export type PlanUnavailableReason = 'not_offered_in_market' | 'no_price_in_currency' | 'not_active';

export interface PlanAvailability {
  readonly planKey: string;
  readonly available: boolean;
  readonly reason: PlanUnavailableReason | null;
  /** Present only when `available`. */
  readonly monthly: Money | null;
  readonly annual: Money | null;
}

export interface PlanPriceLike {
  readonly key: string;
  readonly status: string;
  readonly prices: ReadonlyArray<{
    readonly currency: string;
    readonly monthlyMinor: number;
    readonly annualMinor: number;
  }>;
}

/**
 * Decide, for one plan, whether this customer can buy it — and at what price.
 *
 * NOTHING IS CONVERTED. If the plan's price table has no row for `currency`,
 * the answer is `no_price_in_currency` and both amounts are null. A rate would
 * turn a configuration gap into an invented commercial offer.
 */
export function planAvailability(
  policy: CommercePolicy,
  plan: PlanPriceLike,
  country: string,
  currency: string,
): PlanAvailability {
  const unavailable = (reason: PlanUnavailableReason): PlanAvailability => ({
    planKey: plan.key,
    available: false,
    reason,
    monthly: null,
    annual: null,
  });

  if (plan.status !== 'active') return unavailable('not_active');

  const market = findMarket(policy, country);
  if (!market) return unavailable('not_offered_in_market');
  if (market.planKeys !== null && !market.planKeys.includes(plan.key)) {
    return unavailable('not_offered_in_market');
  }

  const wanted = normaliseCurrency(currency);
  if (!market.currencies.map(normaliseCurrency).includes(wanted)) {
    return unavailable('not_offered_in_market');
  }

  const row = plan.prices.find((p) => normaliseCurrency(p.currency) === wanted);
  if (!row) return unavailable('no_price_in_currency');

  const currencyDetail = findCurrency(policy, wanted);
  if (!currencyDetail || currencyDetail.status !== 'active') {
    return unavailable('no_price_in_currency');
  }

  return {
    planKey: plan.key,
    available: true,
    reason: null,
    monthly: Money.ofMinor(wanted, row.monthlyMinor, currencyDetail.minorUnitDigits),
    annual: Money.ofMinor(wanted, row.annualMinor, currencyDetail.minorUnitDigits),
  };
}

// --- Credit packs ------------------------------------------------------------

export interface PackOffer {
  readonly pack: CreditPackDetail;
  readonly price: Money;
}

/**
 * The packs on sale in this country and currency, priced.
 *
 * A pack with no row for the currency is OMITTED rather than shown at a
 * converted price — the same refusal as `planAvailability`, for the same
 * reason.
 */
export function packOffers(
  policy: CommercePolicy,
  country: string,
  currency: string,
): readonly PackOffer[] {
  const wanted = normaliseCurrency(currency);
  const currencyDetail = findCurrency(policy, wanted);
  if (!currencyDetail || currencyDetail.status !== 'active') return [];
  const iso = country.trim().toUpperCase();

  return [...policy.creditPacks]
    .filter((p) => p.status === 'active')
    .filter((p) => p.countries === null || p.countries.map((c) => c.toUpperCase()).includes(iso))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.credits - b.credits)
    .flatMap((pack) => {
      const row = pack.prices.find((p) => normaliseCurrency(p.currency) === wanted);
      if (!row) return [];
      return [
        {
          pack,
          price: Money.ofMinor(wanted, row.amountMinor, currencyDetail.minorUnitDigits),
        },
      ];
    });
}

/**
 * Re-price a pack SERVER-SIDE at purchase time.
 *
 * THE POINT OF THIS FUNCTION IS THAT THE BROWSER DOES NOT SEND A PRICE. A
 * checkout request names a pack key, a country and a currency; the amount is
 * looked up here from the activated document. §37 of the Phase 9 brief requires
 * that a customer cannot alter a pack price through browser input, and the only
 * durable way to guarantee it is never to accept one.
 */
export function priceOfPack(
  policy: CommercePolicy,
  packKey: string,
  country: string,
  currency: string,
): PackOffer {
  const offer = packOffers(policy, country, currency).find((o) => o.pack.key === packKey);
  if (!offer) {
    throw new AppError('NOT_FOUND', 'That credit pack is not on sale here.');
  }
  return offer;
}

// --- Provider routing --------------------------------------------------------

/**
 * Which payment adapter serves this market.
 *
 * Returns null when nothing matches, and the caller REFUSES rather than picking
 * one — a fallback would silently route money through an adapter the owner did
 * not choose for that market (docs/BILLING-AND-CREDITS.md §1.1).
 */
export function providerKeyFor(
  policy: CommercePolicy,
  country: string,
  currency: string,
): string | null {
  const iso = country.trim().toUpperCase();
  const wanted = normaliseCurrency(currency);
  const matches = policy.providerRouting
    .filter((r) => r.countries === null || r.countries.map((c) => c.toUpperCase()).includes(iso))
    .filter((r) => r.currencies === null || r.currencies.map(normaliseCurrency).includes(wanted))
    .sort((a, b) => b.priority - a.priority);
  return matches[0]?.providerKey ?? null;
}

// --- The tenant-side reader --------------------------------------------------

/** The slice of a tenant-scoped Prisma client this source needs. */
export interface CatalogueReader {
  readonly entitlementCatalogueSnapshot: {
    findUnique(args: {
      where: { domain_environment: { domain: string; environment: Environment } };
    }): Promise<{ payload: unknown } | null>;
  };
}

/**
 * Reads the projection, so the customer application never touches
 * `configuration_version` — which stays platform-owned.
 *
 * No snapshot means nothing has been activated: parsing `{}` yields the
 * schema's defaults, which offer no currency, no market and no plan. That is
 * the correct answer before an owner has approved a commercial catalogue, and
 * onboarding says so rather than inventing a market.
 */
export class TenantCommercePolicySource {
  readonly #db: CatalogueReader;
  readonly #environment: Environment;

  constructor(db: CatalogueReader, environment: Environment) {
    this.#db = db;
    this.#environment = environment;
  }

  async load(): Promise<CommercePolicy> {
    const row = await this.#db.entitlementCatalogueSnapshot.findUnique({
      where: {
        domain_environment: { domain: COMMERCE_CONFIG_DOMAIN, environment: this.#environment },
      },
    });
    return commercePolicyFrom((row?.payload ?? {}) as Record<string, unknown>);
  }
}
