import { DraftForm } from '@brandspace/ui';
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
      heading={t('nav.settings')}
      description={t('settings.p.subtitle')}
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.name ?? customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      {error && <CustomerBanner tone="error">{statusMessage(error, locale, ref)}</CustomerBanner>}
      <SettingsFrame
        brandSource={workspace}
        locale={locale}
        permissionKeys={workspace.permissionKeys}
        selected="ai"
      >
        {/*
          ROUND 4, GATE 2b — THE PROTOTYPE'S AI SETTINGS (`Main.dc.html` lines
          1369–1374): "Writing language" as chips in an `xcard`, then the
          switches as rows. The product's languages are the brand's two content
          languages (`defaultLocale`), so two chips, each a radio posting the
          same field as the select did. Left out, with nothing behind them: the
          prototype's dialect chips (Egyptian / Modern Standard / mixed), "AI
          drafts go to review" and the credit alert (owner decision, Gate 2).
        */}
        <div className="bsp-ai" data-testid="ai-settings">
          {brands.length === 0 ? (
            <section className="bsp-xcard">
              <p className="bsp-ai-empty">{t('aiSettings.noBrand')}</p>
            </section>
          ) : (
            brands.map((brand) => (
              <DraftForm
                key={`${brand.id}:${brand.defaultLocale}:${String(brand.aiSuggestionsEnabled)}:${String(brand.useBrandBrain)}`}
                action={saveAiLanguageAction}
                className="bsp-ai-form"
                testId={`ai-form-${brand.id}`}
                barTestId={`ai-bar-${brand.id}`}
                saveTestId={`ai-save-${brand.id}`}
                labels={saveBarLabels(t)}
              >
                <input type="hidden" name="locale" value={locale} />
                <input type="hidden" name="brandId" value={brand.id} />
                <section className="bsp-xcard bsp-ai-lang">
                  {brands.length > 1 ? (
                    <strong className="bsp-ai-brand">{brand.name}</strong>
                  ) : null}
                  <span className="bsp-lbl" id={`ai-language-label-${brand.id}`}>
                    {t('aiSettings.language')}
                  </span>
                  <div
                    className="bsp-ai-chips"
                    role="radiogroup"
                    aria-labelledby={`ai-language-label-${brand.id}`}
                    data-testid={`ai-language-${brand.id}`}
                  >
                    {(['EN', 'AR'] as const).map((value) => (
                      <label key={value} className="bsp-chip bsp-ai-chip">
                        <input
                          type="radio"
                          name="defaultLocale"
                          value={value}
                          defaultChecked={brand.defaultLocale === value}
                          className="bsp-ai-radio"
                          data-testid={`ai-language-${brand.id}-${value}`}
                        />
                        {value === 'EN' ? t('brandProfile.localeEn') : t('brandProfile.localeAr')}
                      </label>
                    ))}
                  </div>
                  <span className="bsp-ai-hint">{t('aiSettings.languageHint')}</span>
                </section>
                <section className="bsp-xcard bsp-ai-tgls">
                  {/*
                    Phase 2C (D9) — "Use Brand Brain": whether this brand's facts
                    ground AI writing at all.
                  */}
                  <CheckboxRow
                    name="useBrandBrain"
                    label={t('aiSettings.useBrandBrain')}
                    hint={t('aiSettings.useBrandBrainHint')}
                    checked={brand.useBrandBrain}
                    testId={`ai-use-brand-brain-${brand.id}`}
                  />
                  {/*
                    D7 (Phase 2B-2) — the Home "Recommended by BrandSpace" card
                    for this brand, and only that card.
                  */}
                  <CheckboxRow
                    name="aiSuggestionsEnabled"
                    label={t('aiSettings.suggestions')}
                    hint={t('aiSettings.suggestionsHint')}
                    checked={brand.aiSuggestionsEnabled}
                    testId={`ai-suggestions-${brand.id}`}
                  />
                </section>
              </DraftForm>
            ))
          )}
        </div>
      </SettingsFrame>
    </WorkspaceShell>
  );
}
