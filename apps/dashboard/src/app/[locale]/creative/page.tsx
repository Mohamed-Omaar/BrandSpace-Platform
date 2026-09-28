import Link from 'next/link';
import { CREDIT_SPENDING_PERMISSION, fontFamilyValue, maySpendCredits } from '@brandspace/shared';
import {
  Card,
  StateMessage,
  colorTokens,
  radiusTokens,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import { writingFactsInAreas } from '@brandspace/brand-brain';
import {
  CREATIVE_FORMATS,
  CREATIVE_KNOWLEDGE_AREAS,
  CREATIVE_KNOWLEDGE_LINES,
  brandTypography,
} from '@brandspace/creative';
import '@brandspace/ui/content-studio.css';
import { inWorkspace, requireWorkspacePage } from '../../../server/customer-context';
import { NoAccessPage } from '../../../components/no-access-page';
import { brandContextFor, requiredBrand } from '../../../server/brand-context';
import { brandTypographyFor } from '../../../server/brand-fonts';
import { translator, type MessageKey } from '../../../i18n/messages';
import { WorkspaceShell } from '../../../components/workspace-shell';
import { CreativeStudioView, type CreativeStudioLabels } from './creative-studio-view';

import { EmptyAction } from '../../../components/empty-action';

export const dynamic = 'force-dynamic';

/**
 * THE AI CREATIVE STUDIO (D-195, AC-28).
 *
 * BRAND-SCOPED, AND IT ASKS RATHER THAN GUESSING (D-191). An image is generated
 * on ONE brand's identity — its palette, its description, its approved
 * knowledge — so a studio that picked a brand for the author would produce
 * something that looks like a brand they did not choose.
 *
 * THE SCREEN IS BUILT FROM THE DESIGN SYSTEM, NOT DRAWN (CLAUDE.md §4.2). The
 * approved demo carries a `DesignStudio` shell for a canvas editor, which this
 * is not: this is a brief, a format and a result. So it composes `Card`,
 * `Field` and the existing control tokens, the same way the Brand Profile
 * screen does, and introduces no new visual language.
 *
 * `assets.upload` GATES IT, matching the API route exactly, because a
 * generation writes a file into the library. A member who may only read the
 * library sees no entry and gets a 404 if they type the path.
 */
const FORMAT_KEYS: Readonly<Record<string, MessageKey>> = {
  square: 'creative.format.square',
  portrait: 'creative.format.portrait',
  story: 'creative.format.story',
  landscape: 'creative.format.landscape',
};

export default async function CreativeStudioPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const t = translator(locale);
  const access = await requireWorkspacePage(locale, '/creative');
  if (!access.allowed) return <NoAccessPage locale={locale} access={access} />;
  const { customer, workspace } = access.session;
  // Q18 — the Studio exists to spend credits on images, so it also needs
  // `copilot.use`; without it the member gets the same no-access screen,
  // naming that permission.
  if (!maySpendCredits(workspace.permissionKeys, 'assets.upload')) {
    return (
      <NoAccessPage
        locale={locale}
        access={{
          allowed: false,
          session: access.session,
          route: '/creative',
          permissionKey: CREDIT_SPENDING_PERMISSION,
        }}
      />
    );
  }

  const single = (key: string): string | undefined => {
    const value = query[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  };

  const brandContext = await brandContextFor(workspace, '/creative', single('brand'));
  const brand = requiredBrand(brandContext);

  /*
   * D-301 (§26) — WHAT THE IMAGE WILL DRAW ON, shown before it is asked for:
   * the brand's own palette and type from its profile, and how many approved
   * identity / voice notes Brand Brain contributes — the same selection the
   * generation route reads, through the same grounding-layer call
   * (`writingFactsInAreas`: usable facts, the workspace's day, the brand's "Use
   * Brand Brain" switch; IDENTITY or TONE_OF_VOICE, at most six). Counted,
   * never scored; nothing here is sent anywhere.
   */
  const identity = brand
    ? await inWorkspace(workspace.workspaceId, async ({ db }) => {
        const row = await db.brand.findFirst({
          where: { id: brand.id, deletedAt: null },
          select: { colorPalette: true, typography: true },
        });
        const notes = (
          await writingFactsInAreas(db, {
            brandId: brand.id,
            areas: CREATIVE_KNOWLEDGE_AREAS,
            maxItems: CREATIVE_KNOWLEDGE_LINES,
          })
        ).length;
        const strings = (value: unknown): string[] =>
          Array.isArray(value)
            ? value.filter((entry): entry is string => typeof entry === 'string')
            : [];
        return {
          palette: strings(row?.colorPalette).slice(0, 8),
          typography: brandTypography(row?.typography),
          notes,
        };
      })
    : null;

  /*
   * PHASE 2C-2 — the four typography slots as THIS reader sees them, with the
   * @font-face rules for exactly those fonts (catalogue files from /fonts, an
   * uploaded font only through the authenticated font route and only for a
   * reader who may read it).
   */
  const fontView = brand
    ? await brandTypographyFor({ session: access.session, locale, brandId: brand.id })
    : null;
  const mayProfile = workspace.permissionKeys.includes('brand.read');

  const labels: CreativeStudioLabels = {
    brief: t('creative.brief'),
    briefHint: t('creative.briefHint'),
    briefPlaceholder: t('creative.briefPlaceholder'),
    format: t('creative.format'),
    formatHint: t('creative.formatHint'),
    generate: t('creative.generate'),
    generating: t('creative.generating'),
    cost: t('creative.cost'),
    costUnit: t('creative.costUnit'),
    result: t('creative.result'),
    resultEmpty: t('creative.resultEmpty'),
    saved: t('creative.saved'),
    openInLibrary: t('creative.openInLibrary'),
    useInContent: t('creative.useInContent'),
    regenerate: t('creative.regenerate'),
    adapt: t('creative.adapt'),
    adaptHint: t('creative.adaptHint'),
    noLogoNotice: t('creative.noLogoNotice'),
    generatedBadge: t('creative.generatedBadge'),
    scanning: t('creative.scanning'),
    failed: t('creative.failed'),
    insufficientCredits: t('creative.insufficientCredits'),
  };

  return (
    <WorkspaceShell
      brandContext={brandContext}
      locale={locale}
      heading={t('creative.title')}
      description={t('creative.subtitle')}
      activePath="/creative"
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      {brand === null ? (
        <StateMessage
          kind="empty"
          title={
            brandContext.resolution.kind === 'empty'
              ? t('brand.emptyTitle')
              : t('creative.noBrandTitle')
          }
          description={
            brandContext.resolution.kind === 'empty'
              ? t('brand.emptyBody')
              : t('creative.noBrandBody')
          }
          testId="creative-no-brand"
          action={
            brandContext.resolution.kind === 'empty' &&
            workspace.permissionKeys.includes('brand.manage') ? (
              <EmptyAction
                href={`/${locale}/brand-brain`}
                label={t('bb.createBrand')}
                testId="no-brand-create"
              />
            ) : undefined
          }
        />
      ) : (
        <>
          {fontView?.css ? (
            <style
              data-testid="creative-identity-font-faces"
              dangerouslySetInnerHTML={{ __html: fontView.css }}
            />
          ) : null}
          {identity ? (
            <Card testId="creative-identity">
              <div style={{ display: 'grid', gap: spacingTokens.xs }}>
                <strong style={typographyTokens.bodySm}>
                  {t('creative.identity.title').replace('{brand}', brand.name)}
                </strong>
                {identity.palette.length > 0 ? (
                  <ul
                    data-testid="creative-identity-palette"
                    aria-label={t('assets.kit.palette')}
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: spacingTokens.xs,
                      margin: 0,
                      padding: 0,
                      listStyle: 'none',
                    }}
                  >
                    {identity.palette.map((colour) => (
                      <li
                        key={colour}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}
                      >
                        <span
                          aria-hidden="true"
                          style={{
                            inlineSize: '1.25rem',
                            blockSize: '1.25rem',
                            borderRadius: radiusTokens.full,
                            // The brand's OWN colour, as data — not a design literal.
                            background: colour,
                            border: `1px solid ${colorTokens.cardBorder}`,
                          }}
                        />
                        <span style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
                          {colour}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {/*
                  PHASE 2C-2 (owner decision C) — THE FOUR TYPOGRAPHY SLOTS, each
                  a short sample drawn in its own font, independent of the
                  interface language: this card has no content language to
                  choose by, so it shows both. An uploaded font this reader
                  cannot load is drawn in the language's default.
                */}
                {fontView ? (
                  <ul
                    data-testid="creative-identity-fonts"
                    style={{
                      display: 'grid',
                      gap: spacingTokens.xs,
                      margin: 0,
                      padding: 0,
                      listStyle: 'none',
                    }}
                  >
                    {(['en', 'ar'] as const).flatMap((language) =>
                      (['heading', 'body'] as const).map((role) => {
                        const slot = fontView.resolved[language][role];
                        return (
                          <li
                            key={`${language}-${role}`}
                            data-testid={`creative-identity-font-${language}-${role}`}
                            data-font-family={slot.cssFamily}
                            style={{ display: 'grid', gap: '0.125rem' }}
                          >
                            <span
                              style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}
                            >
                              {t(`bb.look.slot.${language}.${role}` as MessageKey)} · {slot.name}
                            </span>
                            <span
                              dir={language === 'ar' ? 'rtl' : 'ltr'}
                              lang={language}
                              style={{
                                fontFamily: fontFamilyValue(slot, language),
                                fontWeight: role === 'heading' ? 700 : 400,
                                fontSynthesis: 'none',
                                fontSize:
                                  role === 'heading'
                                    ? typographyTokens.h3.fontSize
                                    : typographyTokens.bodySm.fontSize,
                                lineHeight: 1.4,
                              }}
                            >
                              {translator(language)(`bb.look.sample.${role}` as MessageKey)}
                            </span>
                          </li>
                        );
                      }),
                    )}
                  </ul>
                ) : null}
                <span
                  data-testid="creative-identity-summary"
                  style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}
                >
                  {[
                    identity.typography.length > 0
                      ? t('creative.identity.type').replace(
                          '{fonts}',
                          identity.typography.join(' · '),
                        )
                      : null,
                    identity.notes > 0
                      ? t('creative.identity.notes').replace('{count}', String(identity.notes))
                      : t('creative.identity.noNotes'),
                    identity.palette.length === 0 ? t('creative.identity.noPalette') : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                {mayProfile ? (
                  <Link
                    href={`/${locale}/settings/brand?brand=${brand.id}`}
                    data-testid="creative-identity-profile"
                    style={{ ...typographyTokens.caption, justifySelf: 'start' }}
                  >
                    {t('creative.identity.edit')}
                  </Link>
                ) : null}
              </div>
            </Card>
          ) : null}
          <CreativeStudioView
            locale={locale}
            brandId={brand.id}
            formats={CREATIVE_FORMATS.map((format) => ({
              key: format.key,
              label: t(FORMAT_KEYS[format.key] ?? 'creative.format.square'),
              size: format.size,
              aspect: format.aspect,
            }))}
            labels={labels}
            initialResult={null}
          />
        </>
      )}
    </WorkspaceShell>
  );
}
