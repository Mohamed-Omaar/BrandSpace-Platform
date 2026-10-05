import Link from 'next/link';
import { Card, DraftForm, spacingTokens } from '@brandspace/ui';
import { TenantOnboardingPolicySource } from '@brandspace/onboarding';
import {
  EGYPT_CITY_CODES,
  brandScopeFilter,
  countryOptions,
  suggestedTimeZones,
  timeZoneOptions,
} from '@brandspace/shared';
import {
  currentEnvironment,
  holdsPermission,
  inWorkspace,
  requireWorkspacePage,
} from '../../../server/customer-context';
import { multiBrandEnabled } from '../../../server/multi-brand';
import { saveBarLabels, weekdayNames } from '../../../server/save-bar-labels';
import { GeneralFields } from './general-fields';
import { NoAccessPage } from '../../../components/no-access-page';
import { brandContextFor } from '../../../server/brand-context';
import { SettingsFrame } from '../../../components/settings-frame';
import { inContentStudio } from '../../../server/content-context';
import { statusMessage, translator } from '../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../components/workspace-shell';
import { saveSettingsAction } from './actions';

export const dynamic = 'force-dynamic';

/** Workspace settings. Requires `workspace.update`; otherwise a 404. */
export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const access = await requireWorkspacePage(locale, '/settings');
  const { messageLocale } = access.session;
  const t = translator(messageLocale);
  if (!access.allowed) return <NoAccessPage locale={locale} access={access} />;
  const { customer, workspace } = access.session;

  const row = await inWorkspace(workspace.workspaceId, async ({ db }) =>
    db.workspace.findUniqueOrThrow({
      where: { id: workspace.workspaceId },
      select: {
        name: true,
        defaultLocale: true,
        timezone: true,
        country: true,
        city: true,
        weekStartsOn: true,
        slug: true,
        status: true,
        aiContentRetentionDays: true,
      },
    }),
  );

  /*
   * A9 (D-330) — the week start the calendar uses today (the workspace's own,
   * else the activated configuration's), the industry catalogue, and the SOLE
   * brand's industry and website. The brand is offered only while multi-brand
   * is off and only to a member who manages it; the action re-checks both.
   */
  const { configuredWeekStart, onboarding, soleBrand } = await inContentStudio(
    workspace.workspaceId,
    async (services) => {
      const [policy, onboardingPolicy, multiBrand] = await Promise.all([
        services.policy(),
        new TenantOnboardingPolicySource(services.db, currentEnvironment()).load(),
        multiBrandEnabled(services.entitlements, workspace.workspaceId),
      ]);
      const brand =
        !multiBrand && holdsPermission(workspace, 'brand.manage')
          ? await services.db.brand.findFirst({
              where: { deletedAt: null, ...brandScopeFilter(workspace.brandScope) },
              orderBy: { createdAt: 'asc' },
              select: { id: true, industry: true, websiteUrl: true },
            })
          : null;
      return {
        configuredWeekStart: policy.calendar.weekStartsOn,
        onboarding: onboardingPolicy,
        soleBrand: brand
          ? { brandId: brand.id, industry: brand.industry, websiteUrl: brand.websiteUrl }
          : null,
      };
    },
  );
  const saved = {
    name: row.name,
    defaultLocale: row.defaultLocale,
    country: row.country,
    timezone: row.timezone,
    city: row.city,
    weekStartsOn: row.weekStartsOn ?? configuredWeekStart,
    industry: soleBrand?.industry ?? null,
    websiteUrl: soleBrand?.websiteUrl ?? null,
  };

  const error = typeof query['error'] === 'string' ? query['error'] : null;
  const ok = typeof query['ok'] === 'string' ? query['ok'] : null;
  const ref = typeof query['ref'] === 'string' ? query['ref'] : undefined;

  const brandContext = await brandContextFor(workspace, '/settings');

  return (
    <WorkspaceShell
      brandContext={brandContext}
      locale={locale}
      heading={t('nav.settings')}
      description={t('settings.p.subtitle')}
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.name ?? customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      {error && <CustomerBanner tone="error">{statusMessage(error, locale, ref)}</CustomerBanner>}
      {ok && statusMessage(ok, locale) && (
        <CustomerBanner tone="success">{statusMessage(ok, locale)}</CustomerBanner>
      )}

      {/*
        `.settings-grid` — a 220px section nav beside the form (§25). Every row
        is a page this member can actually open: the demo's nav lists sections
        Phase 2C does not have, and a row that leads nowhere is a placeholder
        link, not fidelity.
      */}
      <SettingsFrame locale={locale} permissionKeys={workspace.permissionKeys} selected="settings">
        <Card testId="settings-card">
          {/*
            A9 / G1 (D-330) — THE GENERAL FIELDS, UNDER THE SAVE BAR.

            Keyed on the SAVED values, so a successful save re-renders a clean
            form. Each field says underneath what it changes. Industry and
            website are the sole brand's, shown only while multi-brand is off
            and only to a member who manages that brand.
          */}
          <DraftForm
            key={JSON.stringify(saved)}
            action={saveSettingsAction}
            testId="settings-form"
            barTestId="settings-bar"
            saveTestId="settings-save"
            labels={{
              ...saveBarLabels(t),
              // Round 3 — the prototype's own words for this bar.
              saved: t('settings.allSaved'),
              save: t('settings.saveChanges'),
            }}
            style={{ display: 'grid', gap: spacingTokens.md }}
          >
            <input type="hidden" name="locale" value={locale} />
            <GeneralFields
              saved={saved}
              countries={countryOptions(locale)}
              timezones={timeZoneOptions(locale)}
              cities={EGYPT_CITY_CODES.map((code) => ({
                value: code,
                label: t(`geo.city.${code}`),
              }))}
              weekdays={weekdayNames(locale)}
              industries={onboarding.industries.map((industry) => ({
                value: industry.key,
                label: locale === 'ar' ? industry.name.ar : industry.name.en,
              }))}
              suggestedZones={suggestedTimeZones()}
              brand={soleBrand}
              labels={{
                name: t('settings.name'),
                nameHint: t('settings.hint.name'),
                locale: t('settings.locale'),
                localeHint: t('settings.hint.locale'),
                localeAr: t('brandProfile.localeAr'),
                localeEn: t('brandProfile.localeEn'),
                more: t('studio.moreOptions'),
                country: t('settings.country'),
                countryHint: t('settings.hint.country'),
                timezone: t('settings.timezone'),
                timezoneHint: t('settings.hint.timezone'),
                city: t('settings.city'),
                cityHint: t('settings.hint.city'),
                cityNone: t('settings.cityNone'),
                weekStart: t('settings.weekStart'),
                weekStartHint: t('settings.hint.weekStart'),
                industry: t('settings.industry'),
                industryHint: t('settings.hint.industry'),
                industryNone: t('settings.industryNone'),
                industryOther: t('settings.industryOther'),
                industryOtherLabel: t('settings.industryOtherLabel'),
                industryList: t('settings.industryList'),
                website: t('settings.website'),
                websiteHint: t('settings.hint.website'),
                choose: t('createWorkspace.choose'),
                noResults: t('common.noResults'),
                timezoneKept: t('settings.timezoneKept'),
                timezoneUnplanned: t('settings.timezoneUnplanned'),
              }}
            />
          </DraftForm>
        </Card>

        {/*
          The prototype's note under General: what this name is for, and where
          the brand's look and voice live.
        */}
        <div className="bsp-sg-note" data-testid="settings-identity-note">
          <span>{t('settings.bizNote')}</span>
          <Link href={`/${locale}/brand-brain?tab=look`} className="bsp-btn bsp-sm bsp-sec">
            {t('settings.toIdentity')} →
          </Link>
        </div>
      </SettingsFrame>
    </WorkspaceShell>
  );
}
