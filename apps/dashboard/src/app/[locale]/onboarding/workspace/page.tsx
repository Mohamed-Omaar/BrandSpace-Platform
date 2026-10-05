import { redirect } from 'next/navigation';
import { spacingTokens, typographyTokens, colorTokens } from '@brandspace/ui';
import {
  EGYPT_CITY_CODES,
  countryOptions,
  suggestedTimeZones,
  timeZoneOptions,
} from '@brandspace/shared';
import {
  getCustomerAuth,
  getSessionToken,
  requireCustomer,
} from '../../../../server/customer-context';
import { translator } from '../../../../i18n/messages';
import { businessSwitcherModel } from '../../../../server/business-switcher';
import { SetupFrame } from '../../../../components/setup-frame';
import { trialTerms } from '../../../../server/trial-terms';
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

  const trial = await trialTerms();

  const countries = countryOptions(locale);
  const timezones = timeZoneOptions(locale);

  return (
    /*
     * Review of #67 — step 1 of the prototype's five, Business: the workspace
     * form in the standalone setup card. The other steps are the wizard's.
     */
    <SetupFrame
      locale={locale}
      languageHref={`/${locale === 'ar' ? 'en' : 'ar'}/onboarding/workspace`}
      stepsLabel={t('setup.stepsLabel')}
      doneLabel={t('setup.stepDone')}
      steps={(['workspace', 'brand', 'teach', 'connect', 'goal'] as const).map((key) => ({
        key,
        label: t(`setup.step.${key}`),
        complete: false,
        current: key === 'workspace',
        href: null,
      }))}
      heading={t('setup.wz.business.title')}
      description={t('setup.wz.business.body')}
      stepText={t('setup.wz.stepOf').replace('{n}', '1')}
      testId="create-workspace-card"
    >
      <>
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
            more: t('setup.wz.more'),
            zoneLine: t('setup.wz.business.zoneFromCountry'),
            saved: t('setup.wz.saved'),
          }}
          back={
            existing.length > 0
              ? // G8 (D-335): a new workspace started from inside the app starts
                // blank, and has a way back to the one this person came from.
                { href: `/${locale}/overview`, label: t('createWorkspace.back') }
              : null
          }
        />
      </>
    </SetupFrame>
  );
}
