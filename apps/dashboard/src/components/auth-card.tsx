import type { CSSProperties, ReactNode } from 'react';
import { BrandGlyph, LanguageSwitcher } from '@brandspace/ui';
import { translator } from '../i18n/messages';

export function AuthCard({
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
              <BrandGlyph size="46px" />
            </span>
            <span className="bsp-auth-word">{t('app.title')}</span>
            <nav
              aria-label={locale === 'ar' ? 'التنقل الرئيسي' : 'Main navigation'}
              className="bsp-auth-lang"
            >
              <LanguageSwitcher
                href={`/${other}/sign-in`}
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

/**
 * The auth form's input and button. D-468: the prototype's `.in` (a 58px
 * `#f4f4f5` field, radius 14, 15.5px) and `.btn` (56px, radius 14, 15px /
 * 800) are drawn by `prototype.css` (§3-AUTH) on the card; these keep only the
 * full width, so the page's forms need not change.
 */
export function authInputStyle(): CSSProperties {
  return { inlineSize: '100%' };
}

export function authButtonStyle(): CSSProperties {
  return { inlineSize: '100%' };
}
