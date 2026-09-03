import type { CSSProperties, ReactNode } from 'react';
import {
  BrandMark,
  LanguageSwitcher,
  buttonStyle,
  cardStyle,
  colorTokens,
  inputStyle,
  layoutTokens,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';

/**
 * The unauthenticated shell: sign-in, password reset, invitation acceptance.
 *
 * One white card on the application ground, with the landmarks the
 * accessibility suite asserts: a single `main` that the skip link targets,
 * exactly one `h1`, and a focus ring that is never removed.
 *
 * Since the ground is now white too (D-49), the card is separated by its border
 * and one restrained shadow rather than by a tinted page — which is the whole
 * point of the approved direction, and is also why the card is centred with
 * generous whitespace rather than pinned to the top of the viewport.
 *
 * All layout properties are logical, so Arabic RTL mirrors with no second
 * stylesheet.
 */
export function AuthCard({
  locale,
  heading,
  description,
  footer,
  children,
}: {
  locale: string;
  heading: string;
  description?: string | undefined;
  footer?: ReactNode;
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
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: spacingTokens.md,
          minBlockSize: layoutTokens.headerHeight,
          paddingInline: spacingTokens.md,
        }}
      >
        <BrandMark title="BrandSpace" />
        <nav aria-label={locale === 'ar' ? 'التنقل الرئيسي' : 'Main navigation'}>
          <LanguageSwitcher
            href={`/${other}/sign-in`}
            targetLocale={other}
            targetLabel={other === 'ar' ? 'العربية' : 'English'}
            ariaLabel={locale === 'ar' ? 'تغيير اللغة' : 'Change language'}
          />
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
          paddingBlockStart: spacingTokens['2xl'],
        }}
      >
        <div style={{ inlineSize: '100%', maxInlineSize: '26rem' }}>
          <div style={cardStyle()}>
            <h1
              style={{ ...typographyTokens.h1, marginBlockEnd: description ? 0 : spacingTokens.md }}
            >
              {heading}
            </h1>
            {description ? (
              <p
                style={{
                  marginBlockStart: spacingTokens.xs,
                  marginBlockEnd: spacingTokens.md,
                  ...typographyTokens.bodySm,
                  color: colorTokens.textSecondary,
                }}
              >
                {description}
              </p>
            ) : null}
            {children}
          </div>
          {footer ? (
            <div
              style={{
                marginBlockStart: spacingTokens.md,
                textAlign: 'center',
                ...typographyTokens.bodySm,
              }}
            >
              {footer}
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}

/**
 * The auth form's input.
 *
 * A taller control than the in-app default: these forms are the first thing a
 * customer touches, often on a phone, and a 44px target is the comfortable
 * size rather than the 24px minimum.
 */
export function authInputStyle(): CSSProperties {
  return {
    ...inputStyle(),
    minBlockSize: '2.75rem',
    fontSize: typographyTokens.body.fontSize,
  };
}

export function authButtonStyle(): CSSProperties {
  return {
    ...buttonStyle('primary'),
    inlineSize: '100%',
    minBlockSize: '2.75rem',
    fontSize: typographyTokens.body.fontSize,
  };
}
