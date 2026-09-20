/**
 * The commerce catalogue FIXTURE — not approved commercial data.
 *
 * Every currency, market, tax policy, pack and price below exists to prove the
 * SHAPE of a rule: that a three-digit currency is not a two-digit one, that a
 * market may narrow what it offers, that a missing price is reported rather than
 * converted. The real catalogue is entered from Platform Admin and no number
 * here reaches production (CLAUDE.md §2.2).
 *
 * Shared by the money, commerce and billing suites so that all three reason
 * about the SAME configured world — a fixture each suite writes for itself
 * drifts, and then two suites can both pass while disagreeing.
 */

export const CATALOGUE = {
  currencies: [
    {
      code: 'SAR',
      name: { ar: 'ريال سعودي', en: 'Saudi Riyal' },
      minorUnitDigits: 2,
      status: 'active',
      sortOrder: 1,
    },
    {
      code: 'AED',
      name: { ar: 'درهم إماراتي', en: 'UAE Dirham' },
      minorUnitDigits: 2,
      status: 'active',
      sortOrder: 2,
    },
    {
      code: 'KWD',
      name: { ar: 'دينار كويتي', en: 'Kuwaiti Dinar' },
      minorUnitDigits: 3,
      status: 'active',
      sortOrder: 3,
    },
    {
      code: 'QAR',
      name: { ar: 'ريال قطري', en: 'Qatari Riyal' },
      minorUnitDigits: 2,
      status: 'active',
      sortOrder: 4,
    },
    {
      code: 'BHD',
      name: { ar: 'دينار بحريني', en: 'Bahraini Dinar' },
      minorUnitDigits: 3,
      status: 'active',
      sortOrder: 5,
    },
    {
      code: 'OMR',
      name: { ar: 'ريال عماني', en: 'Omani Rial' },
      minorUnitDigits: 3,
      status: 'active',
      sortOrder: 6,
    },
    {
      code: 'USD',
      name: { ar: 'دولار أمريكي', en: 'US Dollar' },
      minorUnitDigits: 2,
      status: 'active',
      sortOrder: 7,
    },
    {
      code: 'EUR',
      name: { ar: 'يورو', en: 'Euro' },
      minorUnitDigits: 2,
      status: 'inactive',
      sortOrder: 8,
    },
  ],
  markets: [
    {
      country: 'SA',
      name: { ar: 'السعودية', en: 'Saudi Arabia' },
      currencies: ['SAR', 'USD'],
      planKeys: null,
      taxPolicyKey: 'standard-exclusive',
      status: 'active',
    },
    {
      country: 'AE',
      name: { ar: 'الإمارات', en: 'United Arab Emirates' },
      currencies: ['AED', 'USD'],
      // AE is deliberately offered a NARROWER plan list than SA — the fixture
      // for "available in one market, unavailable in another".
      planKeys: ['fixture-starter'],
      taxPolicyKey: 'standard-exclusive',
      status: 'active',
    },
    {
      country: 'KW',
      name: { ar: 'الكويت', en: 'Kuwait' },
      currencies: ['KWD', 'USD'],
      planKeys: null,
      taxPolicyKey: 'no-tax',
      status: 'active',
    },
    {
      country: 'BH',
      name: { ar: 'البحرين', en: 'Bahrain' },
      currencies: ['BHD'],
      planKeys: null,
      taxPolicyKey: null,
      status: 'active',
    },
    {
      country: 'OM',
      name: { ar: 'عُمان', en: 'Oman' },
      currencies: ['OMR'],
      planKeys: null,
      taxPolicyKey: null,
      status: 'active',
    },
    {
      country: 'QA',
      name: { ar: 'قطر', en: 'Qatar' },
      currencies: ['QAR'],
      planKeys: null,
      taxPolicyKey: null,
      status: 'active',
    },
    {
      country: 'US',
      name: { ar: 'الولايات المتحدة', en: 'United States' },
      currencies: ['USD'],
      planKeys: null,
      taxPolicyKey: 'no-tax',
      status: 'active',
    },
  ],
  taxPolicies: [
    {
      key: 'standard-exclusive',
      name: { ar: 'ضريبة مضافة', en: 'Value added tax' },
      mode: 'exclusive',
      rateBasisPoints: 1500,
      taxIdLabel: { ar: 'الرقم الضريبي', en: 'Tax registration number' },
      taxIdRequired: false,
      invoiceNote: null,
    },
    {
      key: 'no-tax',
      name: { ar: 'بدون ضريبة', en: 'No tax' },
      mode: 'none',
      rateBasisPoints: 0,
      taxIdLabel: null,
      taxIdRequired: false,
      invoiceNote: null,
    },
  ],
  creditPacks: [
    {
      key: 'fixture-pack-small',
      name: { ar: 'حزمة صغيرة', en: 'Small pack' },
      description: null,
      credits: 500,
      prices: [
        { currency: 'SAR', amountMinor: 9900 },
        { currency: 'KWD', amountMinor: 9900 },
        { currency: 'USD', amountMinor: 2600 },
      ],
      countries: null,
      expiryDays: 365,
      status: 'active',
      sortOrder: 1,
    },
  ],
  providerRouting: [
    { providerKey: 'development-mock', countries: null, currencies: null, priority: 0 },
  ],
} as const;
