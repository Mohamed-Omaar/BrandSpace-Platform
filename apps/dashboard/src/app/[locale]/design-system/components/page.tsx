import { notFound } from 'next/navigation';
import {
  BrandMark,
  LanguageSwitcher,
  PageHeader,
  colorTokens,
  layoutTokens,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import '@brandspace/ui/gallery-console.css';
import { showcaseEnabled } from '../showcase-enabled';
import { ComponentsGallery } from './components-client';
import { FAMILIES, galleryCopy } from './components-fixtures';

export const dynamic = 'force-dynamic';

/**
 * The component gallery — NOT PART OF THE PRODUCT.
 *
 * Every shared control, in every static state, in BOTH looks: the customer
 * app's (`.bsp-frame`, no shell and so no blur) and the Control Center's
 * (`.bs-gallery-console`). It exists so a styling change can be compared
 * family by family against a committed screenshot (the S1 ratchet).
 *
 * Same four properties as `../page.tsx`: refused in production and opt-in
 * elsewhere (`showcaseEnabled()`), reads no database and no session, linked
 * from no navigation, and every value is a fixture.
 */
export default async function ComponentGalleryPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  if (!showcaseEnabled()) notFound();
  const { locale } = await params;
  const ar = locale === 'ar';
  const other = ar ? 'en' : 'ar';
  const copy = galleryCopy(locale);

  return (
    <div style={{ minBlockSize: '100vh', background: colorTokens.appBackground }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: spacingTokens.md,
          minBlockSize: layoutTokens.headerHeight,
          paddingInline: spacingTokens.lg,
          borderBlockEnd: `1px solid ${colorTokens.cardBorder}`,
          background: colorTokens.surface,
        }}
      >
        <BrandMark title="Brandspace" subtitle={copy.pageSubtitle} />
        <LanguageSwitcher
          href={`/${other}/design-system/components`}
          targetLocale={other}
          targetLabel={other === 'ar' ? 'العربية' : 'English'}
          ariaLabel={copy.changeLanguage}
        />
      </header>
      <main
        id="main"
        style={{
          padding: spacingTokens.lg,
          paddingBlockEnd: spacingTokens['3xl'],
          maxInlineSize: layoutTokens.contentMaxWidth,
          marginInline: 'auto',
        }}
      >
        <PageHeader title={copy.pageTitle} description={copy.pageDescription} />
        <nav
          aria-label={copy.indexLabel}
          data-testid="gallery-index"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: spacingTokens.sm,
            marginBlockEnd: spacingTokens.lg,
            ...typographyTokens.bodySm,
          }}
        >
          {FAMILIES.map((family) => (
            <a key={family} href={`#gallery-${family}`} style={{ color: colorTokens.brandPurple }}>
              {copy.families[family]}
            </a>
          ))}
        </nav>
        <ComponentsGallery locale={locale} />
      </main>
    </div>
  );
}
