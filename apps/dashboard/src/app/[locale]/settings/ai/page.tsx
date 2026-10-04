import {
  Card,
  DraftForm,
  Field,
  SectionHeader,
  colorTokens,
  inputStyle,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import { inWorkspace, requireWorkspacePage } from '../../../../server/customer-context';
import { NoAccessPage } from '../../../../components/no-access-page';
import { CheckboxRow } from '../../../../components/checkbox-row';
import { brandContextFor, listAccessibleBrands } from '../../../../server/brand-context';
import { SettingsFrame } from '../../../../components/settings-frame';
import { saveBarLabels } from '../../../../server/save-bar-labels';
import { statusMessage, translator, successFlash } from '../../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../../components/workspace-shell';
import { saveAiLanguageAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * SETTINGS → AI (G3, prototype v94 Phase 2B-1, D-331).
 *
 * The language AI writes new drafts in, per brand — `Brand.defaultLocale`, the
 * one field the composer already starts from — and (Phase 2B-2, owner answer
 * D7) whether Home shows the brand's "Recommended by BrandSpace" card, and (Phase 2C,
 * D9) whether Brand Brain grounds the brand's AI writing. `brand.manage`, one form per
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
  const access = await requireWorkspacePage(locale, '/settings/ai');
  const { messageLocale } = access.session;
  const t = translator(messageLocale);
  if (!access.allowed) return <NoAccessPage locale={locale} access={access} />;
  const { customer, workspace } = access.session;

  const accessible = await listAccessibleBrands(workspace);
  const brands = await inWorkspace(workspace.workspaceId, async ({ db }) =>
    db.brand.findMany({
      where: { id: { in: accessible.map((brand) => brand.id) }, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        defaultLocale: true,
        aiSuggestionsEnabled: true,
        useBrandBrain: true,
      },
    }),
  );

  const error = typeof query['error'] === 'string' ? query['error'] : null;
  const ok = typeof query['ok'] === 'string' ? query['ok'] : null;
  const ref = typeof query['ref'] === 'string' ? query['ref'] : undefined;
  const brandContext = await brandContextFor(workspace, '/settings');

  return (
    <WorkspaceShell
      flash={successFlash(ok, locale)}
      brandContext={brandContext}
      locale={locale}
      heading={t('settings.ai')}
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      {error && <CustomerBanner tone="error">{statusMessage(error, locale, ref)}</CustomerBanner>}
      <SettingsFrame locale={locale} permissionKeys={workspace.permissionKeys} selected="ai">
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
                    key={`${brand.defaultLocale}:${String(brand.aiSuggestionsEnabled)}:${String(brand.useBrandBrain)}`}
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
                    {/*
                      D7 (Phase 2B-2) — the Home "Recommended by BrandSpace"
                      card for this brand, and only that card.
                    */}
                    <CheckboxRow
                      name="aiSuggestionsEnabled"
                      label={t('aiSettings.suggestions')}
                      hint={t('aiSettings.suggestionsHint')}
                      checked={brand.aiSuggestionsEnabled}
                      testId={`ai-suggestions-${brand.id}`}
                    />
                    {/*
                      Phase 2C (D9) — "Use Brand Brain": whether this brand's
                      facts ground AI writing at all. The same CheckboxRow.
                    */}
                    <CheckboxRow
                      name="useBrandBrain"
                      label={t('aiSettings.useBrandBrain')}
                      hint={t('aiSettings.useBrandBrainHint')}
                      checked={brand.useBrandBrain}
                      testId={`ai-use-brand-brain-${brand.id}`}
                    />
                  </DraftForm>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </SettingsFrame>
    </WorkspaceShell>
  );
}
