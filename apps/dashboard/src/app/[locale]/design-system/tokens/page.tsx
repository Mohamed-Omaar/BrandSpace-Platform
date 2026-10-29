import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import {
  BrandMark,
  LanguageSwitcher,
  PageHeader,
  colorTokens,
  colorValues,
  fontTokens,
  layoutTokens,
  motionMs,
  motionValues,
  radiusTokens,
  shadowValues,
  spacingTokens,
  typographyTokens,
  zIndexTokens,
} from '@brandspace/ui';
import { showcaseEnabled } from '../showcase-enabled';

export const dynamic = 'force-dynamic';

/**
 * The token gallery — NOT PART OF THE PRODUCT. Same guard and same four
 * properties as `../page.tsx`: refused in production, opt-in elsewhere, no
 * database, no session, no navigation links to it.
 *
 * Every colour in `colorTokens` as a swatch with its name, its CSS variable,
 * its value and its WCAG contrast against white and against `textPrimary`;
 * then shadows, radius, spacing, motion, z-index and font stacks.
 *
 * THE CONTRAST MATHS is the WCAG 2.x relative-luminance formula, the same one
 * `tests/unit/contrast.test.ts` uses. That helper lives in a test file (which
 * pulls in vitest) so an application route cannot import it; it is repeated
 * here, ten lines, and the ratios on this page can be checked against that
 * test's.
 */

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): string | null {
  const isHex = (value: string) => /^#[0-9a-fA-F]{6}$/.test(value);
  if (!isHex(a) || !isHex(b)) return null;
  const la = luminance(a);
  const lb = luminance(b);
  return ((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)).toFixed(2);
}

/** `brandPurpleTint` -> `--bs-brand-purple-tint`. The `*Alpha` tokens exist only in TypeScript. */
function cssVariable(token: string): string | null {
  if (token.endsWith('Alpha')) return null;
  return `--bs-${token.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
}

const mono = { ...typographyTokens.caption, fontFamily: fontTokens.mono } as const;

function Group({
  id,
  title,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section
      id={`gallery-tokens-${id}`}
      data-testid={`gallery-tokens-${id}`}
      style={{
        padding: spacingTokens.md,
        marginBlockEnd: spacingTokens.xl,
        background: colorTokens.appBackground,
      }}
    >
      <h2 style={{ ...typographyTokens.h2, margin: 0, marginBlockEnd: spacingTokens.md }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

const grid = (min: string) =>
  ({
    display: 'grid',
    gridTemplateColumns: `repeat(auto-fill, minmax(min(${min}, 100%), 1fr))`,
    gap: spacingTokens.sm,
  }) as const;

const tile = {
  background: colorTokens.surface,
  border: `1px solid ${colorTokens.cardBorder}`,
  borderRadius: radiusTokens.md,
  overflow: 'hidden',
  minInlineSize: 0,
} as const;

export default async function TokenGalleryPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  if (!showcaseEnabled()) notFound();
  const { locale } = await params;
  const ar = locale === 'ar';
  const c = (en: string, arabic: string) => (ar ? arabic : en);
  const other = ar ? 'en' : 'ar';

  const groups = [
    ['colors', c('Colour', 'الألوان')],
    ['shadows', c('Shadow', 'الظلال')],
    ['radius', c('Radius', 'الزوايا')],
    ['spacing', c('Spacing', 'التباعد')],
    ['motion', c('Motion', 'الحركة')],
    ['zindex', c('Z-index', 'ترتيب الطبقات')],
    ['fonts', c('Font stacks', 'الخطوط')],
  ] as const;

  const sampleText = ar ? 'نص تجريبي بالعربية 1234' : 'The quick brown fox 1234';

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
        <BrandMark title="Brandspace" subtitle={c('Token gallery', 'معرض الرموز')} />
        <LanguageSwitcher
          href={`/${other}/design-system/tokens`}
          targetLocale={other}
          targetLabel={other === 'ar' ? 'العربية' : 'English'}
          ariaLabel={c('Change language', 'تغيير اللغة')}
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
          title={c('Token gallery', 'معرض الرموز')}
          description={c(
            'Every design token with its value. Fixed showcase data only.',
            'كل رمز تصميم مع قيمته. بيانات عرض ثابتة فقط.',
          )}
        />
        <nav
          aria-label={c('Token groups', 'مجموعات الرموز')}
          data-testid="gallery-tokens-index"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: spacingTokens.sm,
            marginBlockEnd: spacingTokens.lg,
            ...typographyTokens.bodySm,
          }}
        >
          {groups.map(([id, title]) => (
            <a key={id} href={`#gallery-tokens-${id}`} style={{ color: colorTokens.brandPurple }}>
              {title}
            </a>
          ))}
        </nav>

        <Group id="colors" title={groups[0][1]}>
          <div style={grid('15rem')}>
            {Object.entries(colorValues)
              .filter(([name]) => !/^brand[B]lue/.test(name))
              .map(([name, value]) => {
                const variable = cssVariable(name);
                const onWhite = contrast(value, colorValues.surface);
                const onInk = contrast(value, colorValues.textPrimary);
                return (
                  <div key={name} style={tile}>
                    <div
                      style={{
                        blockSize: 'var(--bsp-rem-3)',
                        background: value,
                        borderBlockEnd: `1px solid ${colorTokens.cardBorder}`,
                      }}
                    />
                    <div style={{ padding: spacingTokens.sm, display: 'grid', gap: '2px' }}>
                      <div style={{ ...typographyTokens.label, overflowWrap: 'anywhere' }}>
                        {name}
                      </div>
                      <div
                        style={{
                          ...mono,
                          color: colorTokens.textSecondary,
                          overflowWrap: 'anywhere',
                        }}
                      >
                        {variable ?? c('(no CSS variable)', '(بلا متغير CSS)')}
                      </div>
                      <div
                        style={{
                          ...mono,
                          color: colorTokens.textSecondary,
                          overflowWrap: 'anywhere',
                        }}
                      >
                        {value}
                      </div>
                      <div style={{ ...mono, color: colorTokens.textSecondary }}>
                        {c('vs white', 'مقابل الأبيض')}: {onWhite ?? '—'}
                      </div>
                      <div style={{ ...mono, color: colorTokens.textSecondary }}>
                        {c('vs textPrimary', 'مقابل textPrimary')}: {onInk ?? '—'}
                      </div>
                    </div>
                  </div>
                );
              })}
          </div>
        </Group>

        <Group id="shadows" title={groups[1][1]}>
          <div style={grid('14rem')}>
            {Object.entries(shadowValues).map(([name, value]) => (
              <div key={name} style={{ padding: spacingTokens.md }}>
                <div
                  style={{
                    blockSize: 'var(--bsp-rem-5)',
                    borderRadius: radiusTokens.card,
                    background: colorTokens.surface,
                    boxShadow: value,
                    marginBlockEnd: spacingTokens.sm,
                  }}
                />
                <div style={typographyTokens.label}>{name}</div>
                <div
                  style={{ ...mono, color: colorTokens.textSecondary, overflowWrap: 'anywhere' }}
                >
                  {value}
                </div>
              </div>
            ))}
          </div>
        </Group>

        <Group id="radius" title={groups[2][1]}>
          <div style={grid('9rem')}>
            {Object.entries(radiusTokens).map(([name, value]) => (
              <div key={name} style={{ padding: spacingTokens.xs }}>
                <div
                  style={{
                    blockSize: 'var(--bsp-rem-4)',
                    background: colorTokens.brandPurpleTint,
                    border: `1px solid ${colorTokens.brandPurpleBorder}`,
                    borderRadius: value,
                    marginBlockEnd: spacingTokens.xs,
                  }}
                />
                <div style={typographyTokens.label}>{name}</div>
                <div style={{ ...mono, color: colorTokens.textSecondary }}>{value}</div>
              </div>
            ))}
          </div>
        </Group>

        <Group id="spacing" title={groups[3][1]}>
          <div style={{ display: 'grid', gap: spacingTokens.xs }}>
            {Object.entries(spacingTokens).map(([name, value]) => (
              <div
                key={name}
                style={{ display: 'flex', alignItems: 'center', gap: spacingTokens.md }}
              >
                <code style={{ ...mono, minInlineSize: '4rem' }}>{name}</code>
                <div
                  style={{
                    inlineSize: value,
                    blockSize: spacingTokens.md,
                    background: colorTokens.brandPurple,
                    borderRadius: radiusTokens.xs,
                  }}
                />
                <code style={{ ...mono, color: colorTokens.textSecondary }}>{value}</code>
              </div>
            ))}
          </div>
        </Group>

        <Group id="motion" title={groups[4][1]}>
          <div style={grid('18rem')}>
            <div style={tile}>
              <div style={{ padding: spacingTokens.sm }}>
                {Object.entries(motionValues).map(([name, value]) => (
                  <div
                    key={name}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: spacingTokens.sm,
                      ...mono,
                    }}
                  >
                    <span>{name}</span>
                    <span style={{ color: colorTokens.textSecondary, textAlign: 'end' }}>
                      {value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <div style={tile}>
              <div style={{ padding: spacingTokens.sm }}>
                {Object.entries(motionMs).map(([name, value]) => (
                  <div
                    key={name}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: spacingTokens.sm,
                      ...mono,
                    }}
                  >
                    <span>{name}</span>
                    <span style={{ color: colorTokens.textSecondary }}>{value} ms</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Group>

        <Group id="zindex" title={groups[5][1]}>
          <div style={grid('10rem')}>
            {Object.entries(zIndexTokens).map(([name, value]) => (
              <div key={name} style={{ ...tile, padding: spacingTokens.sm }}>
                <div style={typographyTokens.label}>{name}</div>
                <div style={{ ...mono, color: colorTokens.textSecondary }}>{value}</div>
              </div>
            ))}
          </div>
        </Group>

        <Group id="fonts" title={groups[6][1]}>
          <div style={{ display: 'grid', gap: spacingTokens.sm }}>
            {Object.entries(fontTokens).map(([name, value]) => (
              <div key={name} style={{ ...tile, padding: spacingTokens.md }}>
                <div style={typographyTokens.label}>{name}</div>
                <div
                  style={{ ...mono, color: colorTokens.textSecondary, overflowWrap: 'anywhere' }}
                >
                  {value}
                </div>
                <div
                  style={{
                    fontFamily: value,
                    ...typographyTokens.h3,
                    marginBlockStart: spacingTokens.xs,
                  }}
                >
                  {sampleText}
                </div>
              </div>
            ))}
          </div>
        </Group>
      </main>
    </div>
  );
}
