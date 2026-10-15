import type { ReactNode } from 'react';
import { EntryCard } from '@brandspace/ui';
import { translator } from '../i18n/messages';

/**
 * The Control Center's unauthenticated screens: sign-in and the second step.
 *
 * THE CUSTOMER'S ENTRY CARD, BY OWNER DECISION (Control Center Simple mode,
 * overriding D-58's "visually distinct"): the same `EntryCard` from
 * `@brandspace/ui`, the same layout, card, background, 0.80 sizes (D-491),
 * fonts, inputs, buttons, links, mark, name and language switch. The one
 * difference is the "Control Center" label beside the name, so the two are
 * never confused. The realms stay separate where it matters — the session,
 * the cookie, the permission model (`docs/SECURITY.md` §2).
 *
 * MFA stays mandatory (D-27) and every failure reads the same, whatever the
 * cause, so nothing tells a caller whether an account exists.
 *
 * The landmarks the accessibility suite asserts are unchanged: one `main` with
 * `id="main"` for the skip link, exactly one `h1`, and `data-testid="heading"`.
 */
export function PlatformAuthShell({
  locale,
  screen,
  eyebrow,
  heading,
  description,
  descriptionTestId,
  error,
  children,
}: {
  readonly locale: string;
  /** This screen's path after the locale, so the language link keeps it. */
  readonly screen: 'login' | 'mfa';
  readonly eyebrow: string;
  readonly heading: string;
  readonly description: string;
  /** The suites address the two pages' descriptions by different ids. */
  readonly descriptionTestId: string;
  readonly error?: ReactNode;
  readonly children: ReactNode;
}) {
  const t = translator(locale);
  const other = locale === 'ar' ? 'en' : 'ar';
  return (
    <EntryCard
      locale={locale}
      eyebrow={eyebrow}
      heading={heading}
      description={description}
      descriptionTestId={descriptionTestId}
      footNote={t('auth.footer')}
      languageHref={`/${other}/${screen}`}
      realmLabel={t('auth.realm')}
      cardTestId="platform-auth-card"
    >
      {error}
      {children}
    </EntryCard>
  );
}
