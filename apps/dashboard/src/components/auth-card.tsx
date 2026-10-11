import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { BrandGlyph, LanguageSwitcher } from '@brandspace/ui';
import { translator } from '../i18n/messages';
import { switchLocalePath } from '../i18n/locale-path';

export async function AuthCard({
  locale,
  heading,
  eyebrow,
  description,
  footer,
  children,
}: {
  locale: string;
  heading: string;
  /** The small purple pill above the heading: the screen's name (`Auth.dc.html`'s `eyebrow`). */
  eyebrow?: string | undefined;
  description?: string | undefined;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const t = translator(locale);
  const other = locale === 'ar' ? 'en' : 'ar';
  /*
   * PR D (Auth 1) — THE LANGUAGE BUTTON KEEPS THE SCREEN, as the prototype's
   * does (`Auth.dc.html`: the language flips in place). It linked to sign-in
   * from every card, so sign-up, reset, verify and the workspace list lost
   * their screen. The middleware puts the real path and query on the request;
   * sign-in is the fallback.
   */
  const languageHref = switchLocalePath(
    (await headers()).get('x-brandspace-path'),
    other,
    `/${other}/sign-in`,
  );
  /*
   * D-468 — THE PROTOTYPE'S AUTH CARD, `Auth.dc.html` lines 39–117: one 540px
   * card (`rgba(255,255,255,.96)`, radius 36, `padding: 42px 44px 34px`,
   * `0 40px 100px rgba(20,16,35,.14)`, `gap: 20px`) on the purple / pink /
   * yellow wash; inside it the logo and the 44px language button on one row,
   * the purple eyebrow pill, the 42px heading and its 15px line, the form,
   * then the footer line.
   */
  return (
    <div className="bsp-auth">
      <main id="main" className="bsp-auth-stage">
        <div className="bsp-auth-card" data-testid="auth-form-card">
          <div className="bsp-auth-brand">
            <span data-testid="auth-brand-mark" className="bsp-auth-logo">
              <BrandGlyph size="var(--bsp-px-46)" />
            </span>
            {/* The product's name, in Latin in both languages, as the prototype writes it. */}
            <span className="bsp-auth-word bsp-ltr" lang="en">
              Brandspace
            </span>
            <nav
              aria-label={locale === 'ar' ? 'التنقل الرئيسي' : 'Main navigation'}
              className="bsp-auth-lang"
            >
              <LanguageSwitcher
                href={languageHref}
                targetLocale={other}
                targetLabel={other === 'ar' ? 'ع' : 'EN'}
                ariaLabel={locale === 'ar' ? 'تغيير اللغة' : 'Change language'}
              />
            </nav>
          </div>
          <span data-testid="auth-eyebrow" className="bsp-auth-eyebrow">
            <span aria-hidden="true" />
            {eyebrow ?? heading}
          </span>
          <div className="bsp-auth-head">
            <h1 data-testid="heading">{heading}</h1>
            {description ? <p>{description}</p> : null}
          </div>
          <div className="bsp-auth-body">{children}</div>
          {footer ? <div className="bsp-auth-links">{footer}</div> : null}
          <p className="bsp-auth-foot">
            <span aria-hidden="true" />
            {t('auth.footer')}
          </p>
        </div>
      </main>
    </div>
  );
}

export { authButtonStyle, authInputStyle } from './auth-styles';
