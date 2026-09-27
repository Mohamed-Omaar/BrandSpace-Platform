import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getPrisma, withoutTenantContext } from '@brandspace/database';
import { readPlanCatalogue } from '@brandspace/entitlements';
import { parseConfigPayload } from '@brandspace/config';
import { spacingTokens, typographyTokens, colorTokens } from '@brandspace/ui';
import {
  EGYPT_CITY_CODES,
  countryOptions,
  suggestedTimeZones,
  timeZoneOptions,
} from '@brandspace/shared';
import {
  currentEnvironment,
  getCustomerAuth,
  getSessionToken,
  requireCustomer,
} from '../../../../server/customer-context';
import { translator } from '../../../../i18n/messages';
import { businessSwitcherModel } from '../../../../server/business-switcher';
import { AuthCard } from '../../../../components/auth-card';
import { CreateWorkspaceForm } from './form';

export const dynamic = 'force-dynamic';

/**
 * The first workspace.
 *
 * WHAT THIS PAGE IS FOR: asking the customer for workspace identity facts we
 * must not guess — country, interface language and timezone. Country comes from
 * the complete ISO inventory, not the payment-market catalogue, because creating
 * a workspace must not depend on whether checkout has been configured there.
 *
 * Billing currency is intentionally absent from the form. Launch billing is USD
 * and the API owns that default; the billing engine remains multi-currency for a
 * future product decision. The only platform catalogue read here is the plan
 * snapshot, solely to state trial terms before a trial starts.
 */
export default async function CreateWorkspacePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = translator(locale);
  const customer = await requireCustomer(locale);

  /*
   * THE FIRST WORKSPACE, OR ANOTHER ONE FOR AN OWNER WITHIN THEIR ALLOWANCE
   * (Q1 / A2, D-326). Anybody already in a business is sent on, unless they
   * own one and their plans allow another — the same rule the server enforces
   * when the workspace is written, read from the same allowance the rail's
   * switcher shows. The server refuses regardless of what this page decided.
   */
  const token = await getSessionToken();
  const existing = token
    ? await getCustomerAuth()
        .listWorkspaces(token)
        .catch(() => [])
    : [];
  if (existing.length > 0) {
    const current = customer.activeWorkspaceId ?? existing[0]?.workspaceId ?? null;
    const switcher = current ? await businessSwitcherModel(locale, current) : null;
    if (switcher?.foot.kind !== 'create') redirect(`/${locale}/onboarding`);
  }

  const trial = await withoutTenantContext(
    async (db) => {
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
      return trialPlan ? { days: trialPlan.trialDays, credits: trialPlan.trialCredits } : null;
    },
    { prisma: getPrisma() },
  );

  const countries = countryOptions(locale);
  const timezones = timeZoneOptions(locale);

  return (
    <AuthCard locale={locale} heading={t('createWorkspace.title')}>
      {trial ? (
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
        defaultEmail={customer.email}
        countries={countries}
        timezones={timezones}
        suggestedZones={suggestedTimeZones()}
        cities={EGYPT_CITY_CODES.map((code) => ({ value: code, label: t(`geo.city.${code}`) }))}
        labels={{
          name: t('createWorkspace.name'),
          slug: t('createWorkspace.slug'),
          country: t('createWorkspace.country'),
          countryHint: t('createWorkspace.countryHint'),
          interfaceLocale: t('createWorkspace.locale'),
          timezone: t('createWorkspace.timezone'),
          billingEmail: t('createWorkspace.billingEmail'),
          legalName: t('createWorkspace.legalName'),
          choose: t('createWorkspace.choose'),
          submit: t('createWorkspace.submit'),
          submitting: t('createWorkspace.creating'),
          failed: t('createWorkspace.failed'),
          invalid: t('createWorkspace.invalid'),
          invalidFields: t('createWorkspace.invalidFields'),
          noResults: t('common.noResults'),
          conflict: t('createWorkspace.conflict'),
          forbidden: t('createWorkspace.forbidden'),
          limitReached: t('ws.limitReached'),
          localeAr: t('brandProfile.localeAr'),
          localeEn: t('brandProfile.localeEn'),
          city: t('settings.city'),
          cityNone: t('settings.cityNone'),
        }}
      />
      {/*
        G8 (D-335): A NEW WORKSPACE STARTED FROM INSIDE THE APP starts blank —
        nothing is copied from the current one — and has a way back to it.
      */}
      {existing.length > 0 ? (
        <Link
          href={`/${locale}/overview`}
          data-testid="create-workspace-back"
          style={{ display: 'inline-block', marginBlockStart: spacingTokens.md }}
        >
          {t('createWorkspace.back')}
        </Link>
      ) : null}
    </AuthCard>
  );
}
