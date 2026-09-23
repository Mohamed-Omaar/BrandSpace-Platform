import {
  Card,
  Field,
  SettingsSplit,
  StateMessage,
  buttonStyle,
  colorTokens,
  layoutTokens,
  inputStyle,
  radiusTokens,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import { requireWorkspace, inWorkspace } from '../../../../server/customer-context';
import { brandContextFor, requiredBrand } from '../../../../server/brand-context';
import { paletteFrom, typographyFrom } from '../../../../server/brand-profile';
import { settingsNavItems } from '../../../../server/settings-nav';
import { statusMessage, translator } from '../../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../../components/workspace-shell';
import { saveBrandProfileAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * BRAND PROFILE — a brand's canonical identity (D-189, D-193).
 *
 * WHAT IT IS NOT. It is not Brand Brain: that is the KNOWLEDGE the AI is
 * grounded in — audience, tone, offers, proof — and it is a working surface. This
 * is the brand's own description of itself: what it is called, what it does,
 * where it lives, which languages it speaks, what it looks like. Configuration.
 *
 * WHY IT IS NOT IN THE SIDEBAR. Configuration for the brand you are already
 * working in belongs beside the other configuration, reached from the Brand
 * Selector that names it and from Settings. A nineteenth rail entry pointing at
 * a settings form would sit beside the places people actually work.
 *
 * WHY IT LOOKS LIKE SETTINGS. It is Settings: the same `SettingsSplit`, the same
 * `Card`, the same `Field`, the same controls. Nothing here is a new visual
 * treatment, because a product page that invents one is how a product stops
 * looking like one product.
 *
 * ONE ASSET LIBRARY. The logo fields NAME an asset; they do not hold one. The
 * bytes live in the library, the reference is tenant-safe by construction
 * (composite key + trigger), and nothing here stamps a logo onto anything.
 */
export default async function BrandProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const t = translator(locale);
  const { customer, workspace } = await requireWorkspace(locale, 'brand.read');

  const error = typeof query['error'] === 'string' ? query['error'] : null;
  const ok = typeof query['ok'] === 'string' ? query['ok'] : null;
  const ref = typeof query['ref'] === 'string' ? query['ref'] : undefined;

  const brandContext = await brandContextFor(
    workspace,
    '/settings/brand',
    typeof query['brand'] === 'string' ? query['brand'] : null,
  );
  const selected = requiredBrand(brandContext);
  const mayManage = workspace.permissionKeys.includes('brand.manage');

  /*
   * THE PROFILE AND THE ASSETS THAT MAY BE ITS LOGO, IN ONE TRANSACTION.
   *
   * The candidate list is the brand's OWN assets plus the workspace-shared ones
   * — exactly what the trigger admits — so the picker cannot offer a file the
   * database will refuse. An offered option that is always rejected is the dead
   * control §20 forbids.
   *
   * READY ONLY. A quarantined, failed, processing or archived file has no
   * business being anybody's canonical logo, and a picker that listed one would
   * be inviting somebody to point their brand identity at a file the platform
   * has already refused to serve.
   */
  const data = selected
    ? await inWorkspace(workspace.workspaceId, async ({ db }) => {
        const brand = await db.brand.findFirst({
          where: { id: selected.id, deletedAt: null },
          select: {
            id: true,
            name: true,
            slug: true,
            industry: true,
            description: true,
            websiteUrl: true,
            defaultLocale: true,
            supportedLocales: true,
            colorPalette: true,
            typography: true,
            primaryLogoAssetId: true,
            secondaryLogoAssetId: true,
          },
        });
        if (!brand) return null;
        const assets = await db.asset.findMany({
          where: {
            deletedAt: null,
            status: 'READY',
            scanStatus: 'CLEAN',
            kind: 'IMAGE',
            OR: [{ brandId: selected.id }, { brandId: null }],
          },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          take: 200,
          select: { id: true, name: true, brandId: true },
        });
        return { brand, assets };
      })
    : null;

  /*
   * EVERY ROW LEADS SOMEWHERE THIS MEMBER CAN GO. `/settings` requires
   * `workspace.update` and this page requires only `brand.read`, so the two are
   * genuinely separable — a brand manager who is not a workspace administrator
   * belongs here and does not belong there. The shared table decides.
   */
  const nav = settingsNavItems({
    locale,
    permissionKeys: workspace.permissionKeys,
    selected: 'brand',
  }).map((item) => ({ href: item.href, label: t(item.labelKey), selected: item.selected }));

  const palette = paletteFrom(data?.brand.colorPalette);
  const fonts = typographyFrom(data?.brand.typography);

  return (
    <WorkspaceShell
      brandContext={brandContext}
      locale={locale}
      heading={t('brand.profile')}
      description={t('brandProfile.subtitle')}
      activePath="/settings"
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      {error && <CustomerBanner tone="error">{statusMessage(error, locale, ref)}</CustomerBanner>}
      {ok && statusMessage(ok, locale) && (
        <CustomerBanner tone="success">{statusMessage(ok, locale)}</CustomerBanner>
      )}

      <SettingsSplit navLabel={t('settings.navLabel')} items={nav}>
        {data === null ? (
          /*
           * THE TWO HONEST ABSENCES, told apart (D-191). "Choose one" and
           * "there are none" are different problems and get different words.
           */
          <StateMessage
            kind="empty"
            title={
              brandContext.resolution.kind === 'empty'
                ? t('brand.emptyTitle')
                : t('brand.chooseTitle')
            }
            description={
              brandContext.resolution.kind === 'empty'
                ? t('brand.emptyBody')
                : t('brand.chooseBody')
            }
            testId="brand-profile-no-brand"
          />
        ) : (
          <Card testId="brand-profile-card">
            <form
              action={saveBrandProfileAction}
              style={{ display: 'grid', gap: spacingTokens.md }}
              data-testid="brand-profile-form"
            >
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="brandId" value={data.brand.id} />

              <Field label={t('brandProfile.name')} htmlFor="brand-name">
                <input
                  className="bs-control"
                  id="brand-name"
                  name="name"
                  defaultValue={data.brand.name}
                  required
                  maxLength={120}
                  disabled={!mayManage}
                  data-testid="brand-profile-name"
                  style={inputStyle()}
                />
              </Field>

              <div className="bs-form-row">
                <Field label={t('brandProfile.industry')} htmlFor="brand-industry">
                  <input
                    className="bs-control"
                    id="brand-industry"
                    name="industry"
                    defaultValue={data.brand.industry ?? ''}
                    maxLength={120}
                    disabled={!mayManage}
                    style={inputStyle()}
                  />
                </Field>
                <Field label={t('brandProfile.website')} htmlFor="brand-website">
                  <input
                    className="bs-control"
                    id="brand-website"
                    name="websiteUrl"
                    type="url"
                    inputMode="url"
                    defaultValue={data.brand.websiteUrl ?? ''}
                    maxLength={2048}
                    disabled={!mayManage}
                    style={inputStyle()}
                  />
                </Field>
              </div>

              <Field label={t('brandProfile.description')} htmlFor="brand-description">
                <textarea
                  className="bs-control"
                  id="brand-description"
                  name="description"
                  rows={4}
                  maxLength={2000}
                  defaultValue={data.brand.description ?? ''}
                  disabled={!mayManage}
                  style={{ ...inputStyle(), resize: 'vertical' }}
                />
              </Field>

              <div className="bs-form-row">
                <Field label={t('brandProfile.defaultLocale')} htmlFor="brand-locale">
                  <select
                    className="bs-control"
                    id="brand-locale"
                    name="defaultLocale"
                    defaultValue={data.brand.defaultLocale}
                    disabled={!mayManage}
                    style={inputStyle()}
                  >
                    <option value="AR">{t('brandProfile.localeAr')}</option>
                    <option value="EN">{t('brandProfile.localeEn')}</option>
                  </select>
                </Field>
                <fieldset
                  style={{
                    border: 0,
                    margin: 0,
                    padding: 0,
                    display: 'grid',
                    gap: spacingTokens['2xs'],
                  }}
                >
                  <legend style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
                    {t('brandProfile.supportedLocales')}
                  </legend>
                  {(['AR', 'EN'] as const).map((value) => (
                    <label
                      key={value}
                      style={{
                        display: 'flex',
                        gap: spacingTokens.xs,
                        alignItems: 'center',
                        minBlockSize: layoutTokens.minTargetSize,
                      }}
                    >
                      {/* WCAG 2.5.8 target size, as the approvals checkboxes (P6-14). */}
                      <input
                        type="checkbox"
                        name="supportedLocales"
                        value={value}
                        defaultChecked={data.brand.supportedLocales.includes(value)}
                        disabled={!mayManage}
                        style={{ inlineSize: '20px', blockSize: '20px', margin: 0 }}
                      />
                      <span style={typographyTokens.bodySm}>
                        {value === 'AR' ? t('brandProfile.localeAr') : t('brandProfile.localeEn')}
                      </span>
                    </label>
                  ))}
                </fieldset>
              </div>

              <div className="bs-form-row">
                <Field label={t('brandProfile.headingFont')} htmlFor="brand-heading-font">
                  <input
                    className="bs-control"
                    id="brand-heading-font"
                    name="headingFont"
                    defaultValue={fonts.heading ?? ''}
                    maxLength={120}
                    disabled={!mayManage}
                    style={inputStyle()}
                  />
                </Field>
                <Field label={t('brandProfile.bodyFont')} htmlFor="brand-body-font">
                  <input
                    className="bs-control"
                    id="brand-body-font"
                    name="bodyFont"
                    defaultValue={fonts.body ?? ''}
                    maxLength={120}
                    disabled={!mayManage}
                    style={inputStyle()}
                  />
                </Field>
              </div>

              <Field
                label={t('brandProfile.palette')}
                htmlFor="brand-palette"
                hint={t('brandProfile.paletteHint')}
              >
                <input
                  className="bs-control"
                  id="brand-palette"
                  name="colorPalette"
                  defaultValue={palette.join(', ')}
                  disabled={!mayManage}
                  data-testid="brand-profile-palette"
                  style={inputStyle()}
                />
              </Field>
              {palette.length > 0 ? (
                <div
                  style={{ display: 'flex', gap: spacingTokens['2xs'], flexWrap: 'wrap' }}
                  data-testid="brand-profile-swatches"
                >
                  {palette.map((colour) => (
                    <span
                      key={colour}
                      // The swatch is not the only way to read the value: the
                      // hex is in the field above and in the title, so colour
                      // is never carrying information alone.
                      title={colour}
                      style={{
                        inlineSize: '1.5rem',
                        blockSize: '1.5rem',
                        borderRadius: radiusTokens.sm,
                        background: colour,
                        border: `1px solid ${colorTokens.border}`,
                      }}
                    >
                      <span
                        style={{
                          position: 'absolute',
                          inlineSize: 1,
                          blockSize: 1,
                          overflow: 'hidden',
                          clip: 'rect(0 0 0 0)',
                        }}
                      >
                        {colour}
                      </span>
                    </span>
                  ))}
                </div>
              ) : null}

              {/*
                THE CANONICAL IDENTITY ASSETS. A reference into the ONE library,
                chosen from the files this brand may actually use — its own and
                the workspace-shared shelf — so the picker and the database
                agree about what is admissible (D-193).
              */}
              <div className="bs-form-row">
                <Field
                  label={t('brandProfile.primaryLogo')}
                  htmlFor="brand-primary-logo"
                  hint={t('brandProfile.logoHint')}
                >
                  <select
                    className="bs-control"
                    id="brand-primary-logo"
                    name="primaryLogoAssetId"
                    defaultValue={data.brand.primaryLogoAssetId ?? ''}
                    disabled={!mayManage}
                    data-testid="brand-profile-primary-logo"
                    style={inputStyle()}
                  >
                    <option value="">{t('brandProfile.noLogo')}</option>
                    {data.assets.map((asset) => (
                      <option key={asset.id} value={asset.id}>
                        {asset.brandId === null
                          ? `${asset.name} · ${t('assets.filter.shared')}`
                          : asset.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('brandProfile.secondaryLogo')} htmlFor="brand-secondary-logo">
                  <select
                    className="bs-control"
                    id="brand-secondary-logo"
                    name="secondaryLogoAssetId"
                    defaultValue={data.brand.secondaryLogoAssetId ?? ''}
                    disabled={!mayManage}
                    style={inputStyle()}
                  >
                    <option value="">{t('brandProfile.noLogo')}</option>
                    {data.assets.map((asset) => (
                      <option key={asset.id} value={asset.id}>
                        {asset.brandId === null
                          ? `${asset.name} · ${t('assets.filter.shared')}`
                          : asset.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              {data.assets.length === 0 ? (
                /* HONEST ABOUT THE EMPTY CASE: no logo, and a reason, rather
                   than an empty dropdown that looks broken. */
                <p
                  style={{ ...typographyTokens.bodySm, color: colorTokens.textMuted, margin: 0 }}
                  data-testid="brand-profile-no-assets"
                >
                  {t('brandProfile.noAssets')}
                </p>
              ) : null}

              {mayManage ? (
                <div>
                  <button
                    type="submit"
                    style={buttonStyle('primary')}
                    data-testid="brand-profile-save"
                  >
                    {t('brandProfile.save')}
                  </button>
                </div>
              ) : null}
            </form>
          </Card>
        )}
      </SettingsSplit>
    </WorkspaceShell>
  );
}
