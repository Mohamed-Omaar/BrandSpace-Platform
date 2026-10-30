import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import {
  SUPPORTED_LOCALES,
  directionForLocale,
  htmlLangForLocale,
  isSupportedLocale,
  webfontHref,
} from '@brandspace/ui';
import '@brandspace/ui/tokens.css';
/*
 * Control Center Simple mode (owner decision): the sign-in and second step are
 * the customer's entry card, so they take its stylesheet and its faces —
 * Inter for Latin, Cairo for Arabic, at 400–800, bundled rather than fetched
 * (the customer app's own reasoning). `entry.css` is scoped to `.bsp-auth`, so
 * it draws nothing on the console screens.
 */
import '@brandspace/ui/entry.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter/800.css';
import '@fontsource/cairo/400.css';
import '@fontsource/cairo/500.css';
import '@fontsource/cairo/600.css';
import '@fontsource/cairo/700.css';
import '@fontsource/cairo/800.css';

export const metadata = {
  title: 'Brandspace Control Center',
  description: 'Internal platform administration',
  // The Control Center must never be indexed.
  robots: { index: false, follow: false },
};

export function generateStaticParams() {
  return SUPPORTED_LOCALES.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) notFound();
  const webfont = webfontHref(process.env['BRANDSPACE_WEBFONTS']);
  return (
    <html lang={htmlLangForLocale(locale)} dir={directionForLocale(locale)}>
      <head>
        {/*
          LF — the Look & feel theme. Empty while "Keep the Control Center on
          the original look" is on, which is the default.
        */}
        <link rel="stylesheet" href="/theme.css" />
        {/*
          OPTIONAL WEBFONTS, and optional on purpose.

          `next/font/google` downloads the faces at BUILD time and fails the
          build when it cannot reach the host — which would make every build, in
          CI and offline alike, depend on a third party. F-06 was exactly that
          shape of problem. This is a runtime stylesheet the browser may or may
          not fetch; either way the page renders in the system fallback stack
          that `tokens.css` declares, in both scripts.

          Off unless `BRANDSPACE_WEBFONTS=google`, so tests and CI stay hermetic.
        */}
        {webfont ? (
          <>
            <link rel="preconnect" href="https://fonts.googleapis.com" />
            <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
            <link rel="stylesheet" href={webfont} />
          </>
        ) : null}
      </head>
      <body>
        <a href="#main" className="skip-link" data-testid="skip-link">
          {locale === 'ar' ? 'تخطَّ إلى المحتوى' : 'Skip to content'}
        </a>
        {children}
      </body>
    </html>
  );
}
