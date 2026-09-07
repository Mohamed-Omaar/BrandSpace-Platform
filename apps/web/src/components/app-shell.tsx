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
        <h1 style={{ color: colorTokens.brandBlueText }} data-testid="heading">
          {heading}
        </h1>
        <p data-testid="description">{description}</p>
        {children}
      </main>
    </>
  );
}
