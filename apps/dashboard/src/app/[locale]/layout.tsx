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
import '@brandspace/ui/prototype.css';
/*
 * THE PROTOTYPE'S TYPE, SERVED FROM THIS ORIGIN (D-468). `prototype-2026-09-27`
 * sets Latin in Inter and Arabic in Cairo, at 400–800. The policy allows fonts
 * from `'self'` only, so the faces are bundled with the application (OFL-1.1,
 * `@fontsource/*`) rather than fetched from a third party at run time — which
 * the optional stylesheet below could never do under that policy.
 */
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
