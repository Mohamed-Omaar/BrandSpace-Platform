/**
 * A plan catalogue FIXTURE — not approved commercial data.
 *
 * Two plans, priced in every launch currency except one deliberate gap: the
 * higher tier has no KWD price, which is the "no price in this currency" case
 * the availability rules exist to report honestly rather than convert away.
 *
 * Every number here exists to prove the SHAPE of a rule. Real plans and real
 * prices are entered from Platform Admin (CLAUDE.md §2.2).
 */

export const PLANS_FIXTURE = {
  plans: [
    {
      key: 'fixture-starter',
      name: { ar: 'الباقة الأساسية', en: 'Fixture Starter' },
      description: { ar: 'باقة اختبارية', en: 'A fixture plan' },
      tier: 1,
      visibility: 'public',
      status: 'active',
      prices: [
        { currency: 'SAR', monthlyMinor: 9900, annualMinor: 99000 },
        { currency: 'AED', monthlyMinor: 9500, annualMinor: 95000 },
        { currency: 'KWD', monthlyMinor: 7900, annualMinor: 79000 },
        { currency: 'QAR', monthlyMinor: 9600, annualMinor: 96000 },
        { currency: 'BHD', monthlyMinor: 9800, annualMinor: 98000 },
        { currency: 'OMR', monthlyMinor: 9700, annualMinor: 97000 },
        { currency: 'USD', monthlyMinor: 2600, annualMinor: 26000 },
      ],
      taxBehavior: 'exclusive',
      trialDays: 14,
      trialRequiresCard: false,
      trialCredits: 200,
      monthlyCredits: 500,
      sortOrder: 1,
    },
    {
      key: 'fixture-growth',
      name: { ar: 'باقة النمو', en: 'Fixture Growth' },
      description: { ar: 'باقة اختبارية أعلى', en: 'A higher fixture plan' },
      tier: 2,
      visibility: 'public',
      status: 'active',
      /** NO KWD ROW, on purpose. Nothing converts one into existence. */
      prices: [
        { currency: 'SAR', monthlyMinor: 29900, annualMinor: 299000 },
        { currency: 'AED', monthlyMinor: 28500, annualMinor: 285000 },
        { currency: 'QAR', monthlyMinor: 28800, annualMinor: 288000 },
        { currency: 'BHD', monthlyMinor: 29400, annualMinor: 294000 },
        { currency: 'OMR', monthlyMinor: 29100, annualMinor: 291000 },
        { currency: 'USD', monthlyMinor: 7900, annualMinor: 79000 },
      ],
      taxBehavior: 'exclusive',
      trialDays: 0,
      trialCredits: 0,
      monthlyCredits: 2000,
      sortOrder: 2,
    },
  ],
} as const;
