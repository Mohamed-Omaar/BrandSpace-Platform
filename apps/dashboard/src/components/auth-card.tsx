import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { EntryCard } from '@brandspace/ui';
import { translator } from '../i18n/messages';
import { switchLocalePath } from '../i18n/locale-path';

/**
 * The customer's entry screens: `EntryCard` from `@brandspace/ui` (shared with
 * the Control Center's sign-in since the Control Center Simple-mode pass),
 * given this app's language link and footer line.
 */
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
   * their screen. The proxy (`src/proxy.ts`) puts the real path and query on the request;
   * sign-in is the fallback.
   */
  const languageHref = switchLocalePath(
    (await headers()).get('x-brandspace-path'),
    other,
    `/${other}/sign-in`,
  );
  return (
    <EntryCard
      locale={locale}
      heading={heading}
      eyebrow={eyebrow}
      description={description}
      footer={footer}
      footNote={t('auth.footer')}
      languageHref={languageHref}
    >
      {children}
    </EntryCard>
  );
}

export { authButtonStyle, authInputStyle } from './auth-styles';
