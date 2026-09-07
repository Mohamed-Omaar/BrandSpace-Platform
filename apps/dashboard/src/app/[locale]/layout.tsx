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

export const metadata = {
  title: 'BrandSpace Dashboard',
  description: 'Customer workspace',
};

/** Both locales are pre-rendered, so E2E runs need no network or API. */
export function generateStaticParams() {
  return SUPPORTED_LOCALES.map((locale) => ({ locale }));
}

/**
 * Root layout. `dir` and `lang` derive from the URL segment, so Arabic RTL is a
 * real routing property rather than a hardcoded default — which is what makes
 * the RTL/LTR E2E assertions meaningful.
 */
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
        {/* Skip link: the first tab stop, a WCAG 2.2 requirement. */}
        <a href="#main" className="skip-link" data-testid="skip-link">
          {locale === 'ar' ? 'تخطَّ إلى المحتوى' : 'Skip to content'}
        </a>
        {children}
      </body>
    </html>
  );
}
