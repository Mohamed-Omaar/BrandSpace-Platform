import type { ReactNode } from 'react';
import { colorTokens, spacingTokens } from '@brandspace/ui';

/**
 * Minimal accessible page shell shared by the Phase 1 scaffold pages.
 *
 * Provides the landmarks and focus behaviour the accessibility smoke tests
 * assert: a banner, a single main landmark with a matching skip-link target,
 * one h1, and a visible focus ring that is never removed.
 */
export function AppShell({
  locale,
  heading,
  description,
  children,
}: {
  locale: string;
  heading: string;
  description: string;
  children?: ReactNode;
}) {
  const other = locale === 'ar' ? 'en' : 'ar';
  return (
    <>
      <header
        style={{
          borderBlockEnd: `1px solid ${colorTokens.hairline}`,
          padding: spacingTokens.md,
        }}
      >
        <nav aria-label={locale === 'ar' ? 'التنقل الرئيسي' : 'Main navigation'}>
          <a href={`/${other}`} data-testid="locale-switch" hrefLang={other}>
            {other === 'ar' ? 'العربية' : 'English'}
          </a>
        </nav>
      </header>

      <main
        id="main"
        style={{
          padding: spacingTokens.lg,
          maxInlineSize: '48rem',
          marginInline: 'auto',
        }}
      >
        {/*
         * D-61 retired the legacy blue and extended the purple identity to the
         * public marketing site, closing the carve-out D-42 had left open. The
         * heading carries the identity colour here exactly as it did before;
         * only the colour changed. `brandPurple` reaches 5.60:1 on the surface,
         * which `brandBlue` never did — that is why `brandBlueText` existed.
         */}
        <h1 style={{ color: colorTokens.brandPurple }} data-testid="heading">
          {heading}
        </h1>
        <p data-testid="description">{description}</p>
        {children}
      </main>
    </>
  );
}
