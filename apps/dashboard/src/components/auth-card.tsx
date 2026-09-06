import type { CSSProperties, ReactNode } from 'react';
import {
  AmbientBackground,
  BrandMark,
  CheckIcon,
  LanguageSwitcher,
  buttonStyle,
  colorTokens,
  inputStyle,
  layoutTokens,
  radiusTokens,
  shadowTokens,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import { translator } from '../i18n/messages';

/**
 * The unauthenticated shell: sign-in, password reset, invitation acceptance.
 *
 * WHAT CHANGED, AND WHY. It used to be a single bordered card floating near the
 * top of an otherwise empty white page — the whole screen was one outline and a
 * lot of nothing. It is now a SPLIT: a soft lavender brand panel carrying the
 * product's identity and three plain statements of what it does, beside a
 * borderless form.
 *
 * The panel is the one place outside the Copilot's header where the restrained
 * purple glow is used, and the only yellow is a small accent rule — never a
 * surface behind text, because yellow is 1.35:1 on white and can carry none.
 *
 * The panel is hidden below 1024px rather than stacked above the form: on a
 * phone the fields are the only thing that matters, and pushing them under a
 * marketing block is how a sign-in page gets slower to use.
 *
 * The landmarks the accessibility suite asserts are unchanged: a single `main`
 * that the skip link targets, exactly one `h1`, and a focus ring that is never
 * removed. All layout properties are logical, so Arabic RTL mirrors with no
 * second stylesheet.
 */
function BrandPanel({ locale }: { readonly locale: string }) {
  const t = translator(locale);
  const benefits = [t('auth.benefit.plan'), t('auth.benefit.brand'), t('auth.benefit.team')];

  return (
    <aside
      className="bs-auth-panel"
      aria-label={t('auth.panelLabel')}
      data-testid="auth-brand-panel"
      style={{
        gap: spacingTokens.lg,
        alignContent: 'center',
        padding: spacingTokens['2xl'],
        borderRadius: radiusTokens['2xl'],
        background: `radial-gradient(90% 110% at 100% 0%, ${colorTokens.surfaceLavenderStrong} 0%, ${colorTokens.surfaceLavender} 55%, ${colorTokens.surfaceSoft} 100%)`,
        boxShadow: shadowTokens.brandGlow,
        minBlockSize: '30rem',
      }}
    >
      {/* A small yellow rule, the accent's whole appearance on this page. */}
      <span
        aria-hidden="true"
        style={{
          inlineSize: '3rem',
          blockSize: '0.375rem',
          borderRadius: radiusTokens.full,
          background: colorTokens.brandYellow,
        }}
      />
      <p
        style={{
          margin: 0,
          ...typographyTokens.display,
          color: colorTokens.textPrimary,
          maxInlineSize: '18ch',
        }}
      >
        {t('auth.panelTitle')}
      </p>
      <ul
        style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: spacingTokens.sm }}
      >
        {benefits.map((benefit) => (
          <li
            key={benefit}
            style={{
              display: 'grid',
              gridTemplateColumns: 'auto minmax(0, 1fr)',
              gap: spacingTokens.sm,
              alignItems: 'start',
              ...typographyTokens.body,
              color: colorTokens.textSecondary,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                inlineSize: '1.5rem',
                blockSize: '1.5rem',
                borderRadius: radiusTokens.full,
                background: colorTokens.brandPurple,
                color: colorTokens.brandPurpleInk,
                marginBlockStart: '0.125rem',
              }}
            >
              <CheckIcon size={14} />
            </span>
            {benefit}
          </li>
        ))}
      </ul>
      <p
        style={{
          margin: 0,
          ...typographyTokens.caption,
          color: colorTokens.textSecondary,
        }}
      >
        {t('auth.panelFootnote')}
      </p>
    </aside>
  );
}

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
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* The same ambient ground the signed-in shell floats on, so sign-in is
          recognisably the same product rather than a plain white front door. */}
      <AmbientBackground />
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: spacingTokens.md,
          minBlockSize: layoutTokens.headerHeight,
          paddingInline: spacingTokens.lg,
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
          alignItems: 'center',
          justifyContent: 'center',
          padding: spacingTokens.lg,
          paddingBlockEnd: spacingTokens['2xl'],
        }}
      >
        <div
          className="bs-auth-split"
          style={{ inlineSize: '100%', maxInlineSize: layoutTokens.contentMaxWidth }}
        >
          <BrandPanel locale={locale} />

          <div style={{ inlineSize: '100%', maxInlineSize: '26rem', marginInline: 'auto' }}>
            {/*
              THE FORM SURFACE, not a bordered box. On the white ground it is
              separated by a soft shadow and its own generous padding; the
              fields inside it are filled rather than outlined.
            */}
            <div
              data-testid="auth-form-card"
              style={{
                background: colorTokens.surface,
                borderRadius: radiusTokens['2xl'],
                boxShadow: shadowTokens.raised,
                padding: spacingTokens.xl,
                display: 'grid',
                gap: spacingTokens.md,
              }}
            >
              <div style={{ display: 'grid', gap: spacingTokens.xs }}>
                <h1 style={{ ...typographyTokens.h1, margin: 0 }}>{heading}</h1>
                {description ? (
                  <p
                    style={{
                      margin: 0,
                      ...typographyTokens.bodySm,
                      color: colorTokens.textSecondary,
                    }}
                  >
                    {description}
                  </p>
                ) : null}
              </div>
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
 * size rather than the 24px minimum. Borderless like every other control —
 * `bs-control` supplies the fill, the hover and the focus ring.
 */
export function authInputStyle(): CSSProperties {
  return {
    ...inputStyle({ size: 'lg' }),
    fontSize: typographyTokens.body.fontSize,
  };
}

export function authButtonStyle(): CSSProperties {
  return {
    ...buttonStyle('primary', 'lg'),
    inlineSize: '100%',
    fontSize: typographyTokens.body.fontSize,
  };
}
