import { notFound } from 'next/navigation';
import {
  Banner,
  BrandMark,
  Card,
  LanguageSwitcher,
  PageHeader,
  Stack,
  SupportModeBanner,
  colorTokens,
  layoutTokens,
  radiusTokens,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import { showcaseEnabled } from './showcase-enabled';
import { ShowcaseInteractive } from './showcase-client';

export const dynamic = 'force-dynamic';

/**
 * The design showcase — NOT PART OF THE PRODUCT.
 *
 * A gallery of every component, state and preview in the design system, for
 * visual review before the direction is applied to the remaining pages in
 * Phase 2C-B.
 *
 * FOUR PROPERTIES that make this safe to have in the repository:
 *
 *   1. It is refused in production, unconditionally, and additionally requires
 *      `BRANDSPACE_DESIGN_SHOWCASE=1` anywhere else (`showcaseEnabled()`).
 *   2. It reads NO database, resolves NO session and takes NO parameter that
 *      reaches a query. There is nothing here to authorise.
 *   3. It is linked from no navigation in either application.
 *   4. Every value on the page is a fixture from `fixtures.ts` — obviously
 *      fictional, `example.test` addresses, no credential, deterministic so a
 *      screenshot means the same thing twice.
 *
 * The refusal is `notFound()`, so a probe cannot distinguish a disabled
 * showcase from a route that does not exist.
 */
export default async function DesignSystemPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  if (!showcaseEnabled()) notFound();
  const { locale } = await params;
  const ar = locale === 'ar';
  const other = ar ? 'en' : 'ar';

  return (
    <div style={{ minBlockSize: '100vh', background: colorTokens.appBackground }}>
      {/*
        The Support Mode banner, shown here so its persistence and its
        unmistakable treatment can be reviewed without entering a real support
        session. It is the one place a yellow SURFACE is correct, and it still
        carries near-black ink rather than white.
      */}
      <SupportModeBanner
        testId="showcase-support-banner"
        text={
          ar
            ? 'وضع الدعم — قراءة فقط · أنت موظف منصة ولستَ العميل'
            : 'SUPPORT MODE — read only · you are platform staff, not the customer'
        }
        detail={ar ? 'متجر نموذجي · تبقّى ٢٤ دقيقة' : 'Sample Brand · 24 min left'}
      />

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
        <BrandMark title="BrandSpace" subtitle={ar ? 'نظام التصميم' : 'Design system'} />
        <LanguageSwitcher
          href={`/${other}/design-system`}
          targetLocale={other}
          targetLabel={other === 'ar' ? 'العربية' : 'English'}
          ariaLabel={ar ? 'تغيير اللغة' : 'Change language'}
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
        <PageHeader
          title={ar ? 'نظام تصميم براندسبيس' : 'BrandSpace design system'}
          description={
            ar
              ? 'معرض داخلي للمراجعة البصرية. لا يظهر في التنقل ولا يعمل في بيئة الإنتاج.'
              : 'An internal gallery for visual review. It appears in no navigation and does not run in production.'
          }
        />

        <Stack gap={spacingTokens.xl}>
          <Banner tone="info" testId="showcase-notice">
            {ar
              ? 'كل ما في هذه الصفحة بيانات عرض ثابتة. لا يوجد اتصال بقاعدة بيانات أو بأي منصة خارجية، ولا يُنفَّذ أي إجراء حقيقي.'
              : 'Everything on this page is fixed showcase data. Nothing connects to a database or an external platform, and no control performs a real action.'}
          </Banner>

          {/* ------------------------------------------------- Tokens --- */}
          <Card title={ar ? 'الألوان' : 'Colour tokens'} testId="showcase-colors">
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(min(9rem, 100%), 1fr))',
                gap: spacingTokens.sm,
              }}
            >
              {SWATCHES.map((swatch) => (
                <div
                  key={swatch.token}
                  style={{
                    border: `1px solid ${colorTokens.cardBorder}`,
                    borderRadius: radiusTokens.md,
                    overflow: 'hidden',
                  }}
                >
                  <div style={{ blockSize: '3rem', background: swatch.value }} />
                  <div style={{ padding: spacingTokens.sm }}>
                    <div style={{ ...typographyTokens.label }}>{swatch.token}</div>
                    <div style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
                      {swatch.value}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card title={ar ? 'التدرّج الطباعي' : 'Type scale'} testId="showcase-typography">
            <Stack gap={spacingTokens.sm}>
              {(
                [
                  ['display', ar ? 'عنوان كبير' : 'Display'],
                  ['h1', ar ? 'عنوان الصفحة' : 'Page title'],
                  ['h2', ar ? 'عنوان قسم' : 'Section title'],
                  ['h3', ar ? 'عنوان فرعي' : 'Subsection'],
                  ['body', ar ? 'نص أساسي' : 'Body text'],
                  ['bodySm', ar ? 'نص صغير' : 'Small body'],
                  ['label', ar ? 'تسمية' : 'Label'],
                  ['caption', ar ? 'تعليق' : 'Caption'],
                  ['overline', ar ? 'فوق السطر' : 'Overline'],
                ] as const
              ).map(([token, sample]) => (
                <div
                  key={token}
                  style={{
                    display: 'flex',
                    gap: spacingTokens.md,
                    alignItems: 'baseline',
                    flexWrap: 'wrap',
                  }}
                >
                  <code
                    style={{
                      ...typographyTokens.caption,
                      color: colorTokens.textSecondary,
                      minInlineSize: '5rem',
                    }}
                  >
                    {token}
                  </code>
                  <span style={typographyTokens[token]}>{sample}</span>
                </div>
              ))}
            </Stack>
          </Card>

          <ShowcaseInteractive locale={locale} />
        </Stack>
      </main>
    </div>
  );
}

const SWATCHES = [
  { token: 'brandPurple', value: colorTokens.brandPurple },
  { token: 'brandPurpleHover', value: colorTokens.brandPurpleHover },
  { token: 'brandPurpleTint', value: colorTokens.brandPurpleTint },
  { token: 'brandYellow', value: colorTokens.brandYellow },
  { token: 'brandYellowTint', value: colorTokens.brandYellowTint },
  { token: 'surface', value: colorTokens.surface },
  { token: 'surfaceMuted', value: colorTokens.surfaceMuted },
  { token: 'border', value: colorTokens.border },
  { token: 'borderStrong', value: colorTokens.borderStrong },
  { token: 'textPrimary', value: colorTokens.textPrimary },
  { token: 'textSecondary', value: colorTokens.textSecondary },
  { token: 'success', value: colorTokens.success },
  { token: 'warning', value: colorTokens.warning },
  { token: 'danger', value: colorTokens.danger },
  { token: 'info', value: colorTokens.info },
] as const;
