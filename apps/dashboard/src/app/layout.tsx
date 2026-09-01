import type { ReactNode } from 'react';
import { DEFAULT_LOCALE, directionForLocale, htmlLangForLocale } from '@brandspace/ui';
import '@brandspace/ui/tokens.css';

export const metadata = {
  title: 'BrandSpace Dashboard',
  description: 'Customer workspace',
};

/**
 * Direction is set at the document root from the active locale. Arabic renders RTL
 * with no separate stylesheet because layout uses logical CSS properties.
 * Phase 1 uses the default locale; `/[locale]` routing arrives with the UI work.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  const locale = DEFAULT_LOCALE;
  return (
    <html lang={htmlLangForLocale(locale)} dir={directionForLocale(locale)}>
      <body>{children}</body>
    </html>
  );
}
