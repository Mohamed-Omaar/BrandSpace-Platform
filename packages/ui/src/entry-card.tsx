import type { ReactNode } from 'react';
import { BrandGlyph } from './app-shell';
import { LanguageSwitcher } from './switchers';

/**
 * THE ENTRY CARD — D-468, `Auth.dc.html` lines 39–117: one 540px card
 * (`rgba(255,255,255,.96)`, radius 36, `padding: 42px 44px 34px`,
 * `0 40px 100px rgba(20,16,35,.14)`, `gap: 20px`) on the purple / pink /
 * yellow wash; inside it the logo and the 44px language button on one row,
 * the purple eyebrow pill, the 42px heading and its 15px line, the form,
 * then the footer line. Drawn by `entry.css` at the entry screens' 0.80
 * (D-491).
 *
 * SHARED BY BOTH APPS (owner decision, Control Center Simple mode): the
 * customer's sign-in and the Control Center's sign-in and second step are
 * this one component, so they cannot drift apart. The only difference is
 * `realmLabel` — the small "Control Center" label beside the name, so the
 * two are never confused. Everything app-specific (the language link, which
 * keeps the screen; the footer line) arrives as props.
 */
export function EntryCard({
  locale,
  heading,
  eyebrow,
  description,
  descriptionTestId,
  footer,
  footNote,
  languageHref,
  realmLabel,
  cardTestId = 'auth-form-card',
  children,
}: {
  readonly locale: string;
  readonly heading: string;
  /** The small purple pill above the heading: the screen's name. */
  readonly eyebrow?: string | undefined;
  readonly description?: string | undefined;
  readonly descriptionTestId?: string | undefined;
  readonly footer?: ReactNode;
  /** The line at the card's foot. */
  readonly footNote: string;
  /** The other language's address for this same screen. */
  readonly languageHref: string;
  /** Names a realm other than the customer's (the Control Center). */
  readonly realmLabel?: string | undefined;
  readonly cardTestId?: string | undefined;
  readonly children: ReactNode;
}) {
  const other = locale === 'ar' ? 'en' : 'ar';
  return (
    <div className="bsp-auth">
      <main id="main" className="bsp-auth-stage">
        <div className="bsp-auth-card" data-testid={cardTestId}>
          <div className="bsp-auth-brand">
            <span data-testid="auth-brand-mark" className="bsp-auth-logo">
              <BrandGlyph size="var(--bsp-px-46)" />
            </span>
            {/* The product's name, in Latin in both languages, as the prototype writes it. */}
            <span className="bsp-auth-word bsp-ltr" lang="en">
              Brandspace
            </span>
            {realmLabel ? (
              <span className="bsp-auth-realm" data-testid="auth-realm">
                {realmLabel}
              </span>
            ) : null}
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
            {description ? <p data-testid={descriptionTestId}>{description}</p> : null}
          </div>
          <div className="bsp-auth-body">{children}</div>
          {footer ? <div className="bsp-auth-links">{footer}</div> : null}
          <p className="bsp-auth-foot">
            <span aria-hidden="true" />
            {footNote}
          </p>
        </div>
      </main>
    </div>
  );
}
