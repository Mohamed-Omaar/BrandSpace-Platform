import type { CSSProperties, ReactNode } from 'react';
import {
  AmbientBackground,
  BrandMark,
  LanguageSwitcher,
  buttonStyle,
  colorTokens,
  gradientTokens,
  inputStyle,
  layoutTokens,
  radiusTokens,
  shadowTokens,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import { translator } from '../i18n/messages';

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
  const t = translator(locale);
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

      {/*
        THE STAGE (`.auth-stage`): `padding: 45px 20px; border-radius: 28px`
        over an OPAQUE wash — two soft radials on a lavender-to-white base. It
        is opaque on purpose: with the ambient orbs showing through, the
        "forgot password" link landed on a yellow blend at 4.12:1 and axe
        flagged it serious. The demo's stage is opaque for the same reason its
        card is readable.
      */}
      <main
        id="main"
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          paddingBlock: '2.8125rem',
          paddingInline: spacingTokens.md,
          marginInline: spacingTokens.md,
          marginBlockEnd: spacingTokens.md,
          borderRadius: radiusTokens['3xl'],
          background: gradientTokens.authStage,
        }}
      >
        {/*
          ONE CENTRED CARD, not a two-column split.

          The demo's entry screens are a single `min(420px, 100%)` card centred
          on the stage (`.auth-stage { display: grid; place-items: center }`).
          The brand panel beside it was written against the superseded
          reference to fill what looked like an empty half-screen; the full
          demo (D-60) answers that differently and better — the stage's own
          wash carries the space, and the card carries the brand MARK, an
          overline and a 34px heading, which is what stops it reading as a bare
          form. That copy belongs on the public website, which is its audience.
        */}
        <div style={{ inlineSize: '100%', display: 'grid', placeItems: 'center' }}>
          <div style={{ inlineSize: '100%', maxInlineSize: '26.25rem' }}>
            {/*
              THE CARD (`.auth-card`): `width: min(420px, 100%); padding: 30px;
              border-radius: 24px; background: rgba(255,255,255,.9);
              box-shadow: 0 24px 70px rgba(44,25,82,.12)`. Not a bordered box —
              a soft-shadowed surface floating on the stage.
            */}
            <div
              data-testid="auth-form-card"
              style={{
                background: colorTokens.authCardAlpha,
                borderRadius: radiusTokens['3xl'],
                boxShadow: shadowTokens.authCard,
                padding: '1.875rem',
                display: 'grid',
                gap: spacingTokens.md,
              }}
            >
              {/*
                `.auth-card > .brand-mark { margin-bottom: 24px }` above an
                overline and the heading. The mark inside the card is what
                makes it the product's front door rather than a bare form.
              */}
              <span
                aria-hidden="true"
                data-testid="auth-brand-mark"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  inlineSize: layoutTokens.brandMark,
                  blockSize: layoutTokens.brandMark,
                  borderRadius: radiusTokens.lg,
                  background: colorTokens.ink,
                  color: colorTokens.inkInk,
                  fontSize: layoutTokens.brandMarkGlyph,
                  lineHeight: 1,
                  fontWeight: 850,
                  marginBlockEnd: spacingTokens.sm,
                }}
              >
                B
              </span>
              <div style={{ display: 'grid', gap: spacingTokens.xs }}>
                <p
                  data-testid="auth-eyebrow"
                  style={{
                    margin: 0,
                    ...typographyTokens.overline,
                    textTransform: 'uppercase',
                    color: colorTokens.textMuted,
                  }}
                >
                  {t('app.title')}
                </p>
                <h1 data-testid="heading" style={{ ...typographyTokens.authHeading, margin: 0 }}>
                  {heading}
                </h1>
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
              {/*
                `.auth-card > small` — centred, muted, `margin-top: 18px`, and
                INSIDE the card. It used to sit outside it, on the stage, which
                is both a departure from the demo and where the contrast
                failure came from.
              */}
              {footer ? (
                <div
                  style={{
                    marginBlockStart: '0.5rem',
                    textAlign: 'center',
                    ...typographyTokens.bodySm,
                  }}
                >
                  {footer}
                </div>
              ) : null}
            </div>
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
