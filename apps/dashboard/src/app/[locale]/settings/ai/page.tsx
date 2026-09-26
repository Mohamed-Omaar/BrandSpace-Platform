import {
  Card,
  DraftForm,
  Field,
  SectionHeader,
  SettingsSplit,
  colorTokens,
  inputStyle,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import { inWorkspace, requireWorkspacePage } from '../../../../server/customer-context';
import { NoAccessPage } from '../../../../components/no-access-page';
import { brandContextFor, listAccessibleBrands } from '../../../../server/brand-context';
import { settingsNavItems } from '../../../../server/settings-nav';
import { saveBarLabels } from '../../../../server/save-bar-labels';
import { statusMessage, translator } from '../../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../../components/workspace-shell';
import { saveAiLanguageAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * SETTINGS → AI (G3, prototype v94 Phase 2B-1, D-331).
 *
 * The language AI writes new drafts in, per brand — `Brand.defaultLocale`, the
 * one field the composer already starts from. `brand.manage`, one form per
 * brand the member may see (one while multi-brand is off, D-327), under the
 * save bar (G1).
 *
 * DESIGN-SYSTEM EXTENSION (CLAUDE.md §4.2): `SettingsSplit`, `Card`,
 * `SectionHeader`, `Field` and the native `bs-select`.
 */
export default async function AiSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const t = translator(locale);
  const access = await requireWorkspacePage(locale, '/settings/ai');
  if (!access.allowed) return <NoAccessPage locale={locale} access={access} />;
  const { customer, workspace } = access.session;

  const accessible = await listAccessibleBrands(workspace);
  const brands = await inWorkspace(workspace.workspaceId, async ({ db }) =>
    db.brand.findMany({
      where: { id: { in: accessible.map((brand) => brand.id) }, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, defaultLocale: true },
    }),
  );

  const error = typeof query['error'] === 'string' ? query['error'] : null;
  const ok = typeof query['ok'] === 'string' ? query['ok'] : null;
  const ref = typeof query['ref'] === 'string' ? query['ref'] : undefined;
  const brandContext = await brandContextFor(workspace, '/settings');

  return (
    <WorkspaceShell
      brandContext={brandContext}
      locale={locale}
      heading={t('settings.ai')}
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      {error && <CustomerBanner tone="error">{statusMessage(error, locale, ref)}</CustomerBanner>}
      {ok && statusMessage(ok, locale) && (
        <CustomerBanner tone="success">{statusMessage(ok, locale)}</CustomerBanner>
      )}
      <SettingsSplit
        navLabel={t('settings.navLabel')}
        items={settingsNavItems({
          locale,
          permissionKeys: workspace.permissionKeys,
          selected: 'ai',
        }).map((item) => ({ href: item.href, label: t(item.labelKey), selected: item.selected }))}
      >
        <Card testId="ai-settings">
          <SectionHeader title={t('aiSettings.title')} description={t('aiSettings.body')} />
          {brands.length === 0 ? (
            <p style={{ ...typographyTokens.bodySm, color: colorTokens.textSecondary, margin: 0 }}>
              {t('aiSettings.noBrand')}
            </p>
          ) : (
            <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                display: 'grid',
                gap: spacingTokens.md,
              }}
            >
              {brands.map((brand) => (
                <li key={brand.id}>
                  <DraftForm
                    key={brand.defaultLocale}
                    action={saveAiLanguageAction}
                    style={{ display: 'grid', gap: spacingTokens.sm }}
                    testId={`ai-form-${brand.id}`}
                    barTestId={`ai-bar-${brand.id}`}
                    saveTestId={`ai-save-${brand.id}`}
                    labels={saveBarLabels(t)}
                  >
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="brandId" value={brand.id} />
                    {brands.length > 1 ? (
                      <strong style={typographyTokens.bodySm}>{brand.name}</strong>
                    ) : null}
                    <Field
                      label={t('aiSettings.language')}
                      htmlFor={`ai-language-${brand.id}`}
                      hint={t('aiSettings.languageHint')}
                    >
                      <select
                        className="bs-control bs-select"
                        id={`ai-language-${brand.id}`}
                        name="defaultLocale"
                        data-testid={`ai-language-${brand.id}`}
                        defaultValue={brand.defaultLocale}
                        style={inputStyle()}
                      >
                        <option value="EN">{t('brandProfile.localeEn')}</option>
                        <option value="AR">{t('brandProfile.localeAr')}</option>
                      </select>
                    </Field>
                  </DraftForm>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </SettingsSplit>
    </WorkspaceShell>
  );
}
