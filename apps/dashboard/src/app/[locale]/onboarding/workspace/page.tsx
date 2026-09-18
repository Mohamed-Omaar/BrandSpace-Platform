import { redirect } from 'next/navigation';
import { getPrisma, withoutTenantContext } from '@brandspace/database';
import {
  TenantCommercePolicySource,
  activeMarkets,
  currenciesForCountry,
} from '@brandspace/billing';
import { readPlanCatalogue } from '@brandspace/entitlements';
import { parseConfigPayload } from '@brandspace/config';
import { spacingTokens, typographyTokens, colorTokens } from '@brandspace/ui';
import {
  currentEnvironment,
  getCustomerAuth,
  getSessionToken,
  requireCustomer,
} from '../../../../server/customer-context';
import { translator } from '../../../../i18n/messages';
import { AuthCard } from '../../../../components/auth-card';
import { CreateWorkspaceForm, type MarketOption } from './form';

export const dynamic = 'force-dynamic';

/**
 * The first workspace.
 *
 * WHAT THIS PAGE IS FOR: asking the four questions D-194 refuses to answer on a
 * customer's behalf — country, interface language, timezone and billing
 * currency — and offering the configured markets to choose between.
 *
 * NO WORKSPACE CONTEXT EXISTS YET, so the commercial catalogue is read with none
 * set. The projection is readable that way; every tenant-owned table stays
 * empty, which is exactly right for a person who is not yet in a workspace.
 *
 * AN EMPTY MARKET LIST IS STATED, NOT PAPERED OVER. Before an owner activates a
 * commerce document there is nowhere to sell, and the page says so rather than
 * offering a country nobody approved.
 */
export default async function CreateWorkspacePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = translator(locale);
  await requireCustomer(locale);

  // Already a member of something: this page is for the first one.
  const token = await getSessionToken();
  const existing = token
    ? await getCustomerAuth()
        .listWorkspaces(token)
        .catch(() => [])
    : [];
  if (existing.length > 0) redirect(`/${locale}/onboarding`);

  const { markets, trial } = await withoutTenantContext(
    async (db) => {
      const policy = await new TenantCommercePolicySource(db, currentEnvironment()).load();
      const snapshot = await db.entitlementCatalogueSnapshot.findUnique({
        where: {
          domain_environment: { domain: 'plans', environment: currentEnvironment() },
        },
      });
      const plans = readPlanCatalogue(
        parseConfigPayload('plans', snapshot?.payload ?? {}) as unknown as Record<string, unknown>,
      );
      const trialPlan =
        [...plans]
          .filter((plan) => plan.status === 'active' && plan.trialDays > 0)
          .sort((a, b) => a.tier - b.tier)[0] ?? null;
      return {
        markets: activeMarkets(policy).map((market): MarketOption => ({
          country: market.country,
          name: locale === 'ar' ? market.name.ar : market.name.en,
          currencies: currenciesForCountry(policy, market.country).map((currency) => ({
            code: currency.code,
            name: locale === 'ar' ? currency.name.ar : currency.name.en,
          })),
        })),
        trial: trialPlan ? { days: trialPlan.trialDays, credits: trialPlan.trialCredits } : null,
      };
    },
    { prisma: getPrisma() },
  );

  return (
    <AuthCard locale={locale} heading={t('createWorkspace.title')}>
      {markets.length === 0 ? (
        <p data-testid="no-markets">{t('createWorkspace.noMarkets')}</p>
      ) : (
        <>
          {trial ? (
            /* THE TRIAL'S TERMS BEFORE IT STARTS (§14) — how long, how many
               credits, no card, and what happens when it ends. */
            <p
              data-testid="trial-terms"
              style={{
                marginBlockEnd: spacingTokens.md,
                ...typographyTokens.caption,
                color: colorTokens.textMuted,
              }}
            >
              {t('createWorkspace.trialNotice')
                .replace('{days}', String(trial.days))
                .replace('{credits}', String(trial.credits))}
            </p>
          ) : null}
          <CreateWorkspaceForm
            locale={locale}
            markets={markets}
            labels={{
              name: t('createWorkspace.name'),
              slug: t('createWorkspace.slug'),
              country: t('createWorkspace.country'),
              countryHint: t('createWorkspace.countryHint'),
              currency: t('createWorkspace.currency'),
              currencyHint: t('createWorkspace.currencyHint'),
              interfaceLocale: t('createWorkspace.locale'),
              timezone: t('createWorkspace.timezone'),
              billingEmail: t('createWorkspace.billingEmail'),
              legalName: t('createWorkspace.legalName'),
              choose: t('createWorkspace.choose'),
              submit: t('createWorkspace.submit'),
              submitting: t('createWorkspace.creating'),
              failed: t('createWorkspace.failed'),
              localeAr: t('brandProfile.localeAr'),
              localeEn: t('brandProfile.localeEn'),
            }}
          />
        </>
      )}
    </AuthCard>
  );
}
