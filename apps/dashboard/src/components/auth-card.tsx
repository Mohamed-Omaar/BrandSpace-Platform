import type { CSSProperties, ReactNode } from 'react';
import { colorTokens, radiusTokens, shadowTokens, spacingTokens } from '@brandspace/ui';

/**
 * The unauthenticated shell: sign-in, password reset, invitation acceptance.
 *
 * One white card centred on the `#FAFAFA` application ground (D-42), with the
 * landmarks the accessibility suite asserts: a single `main` that the skip link
 * targets, exactly one `h1`, and a visible focus ring that is never removed.
 *
 * All layout properties are logical, so Arabic RTL mirrors with no second
 * stylesheet.
 */
export function AuthCard({
  locale,
  heading,
  children,
}: {
  locale: string;
  heading: string;
  children: ReactNode;
}) {
  const other = locale === 'ar' ? 'en' : 'ar';
  return (
    <div
      style={{
        minBlockSize: '100vh',
        background: colorTokens.appBackground,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <header style={{ padding: spacingTokens.md }}>
        <nav aria-label={locale === 'ar' ? 'التنقل الرئيسي' : 'Main navigation'}>
          <a href={`/${other}/sign-in`} data-testid="locale-switch" hrefLang={other}>
            {other === 'ar' ? 'العربية' : 'English'}
          </a>
        </nav>
      </header>

      <main
        id="main"
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'start',
          justifyContent: 'center',
          padding: spacingTokens.md,
        }}
      >
        <div
          style={{
            inlineSize: '100%',
            maxInlineSize: '26rem',
            background: colorTokens.surface,
            border: `1px solid ${colorTokens.cardBorder}`,
            borderRadius: radiusTokens.lg,
            boxShadow: shadowTokens.card,
            padding: spacingTokens.lg,
          }}
        >
          <h1 style={{ marginBlockStart: 0, fontSize: '1.25rem' }}>{heading}</h1>
          {children}
        </div>
      </main>
    </div>
  );
}

export function authInputStyle(): CSSProperties {
  return {
    inlineSize: '100%',
    minBlockSize: '40px',
    marginBlockStart: '4px',
    paddingInline: spacingTokens.sm,
    paddingBlock: '8px',
    borderRadius: radiusTokens.md,
    border: `1px solid ${colorTokens.border}`,
    background: colorTokens.surface,
    color: colorTokens.textPrimary,
    fontFamily: 'inherit',
    fontSize: '0.9375rem',
    // `box-sizing` so a 100% width plus padding does not overflow the card at
    // 390px, which the responsive suite checks.
    boxSizing: 'border-box',
  };
}

export function authButtonStyle(): CSSProperties {
  return {
    inlineSize: '100%',
    minBlockSize: '44px',
    borderRadius: radiusTokens.md,
    background: colorTokens.brandPurple,
    color: colorTokens.brandPurpleInk,
    border: `1px solid ${colorTokens.brandPurple}`,
    fontSize: '0.9375rem',
    fontWeight: 600,
    cursor: 'pointer',
  };
}
