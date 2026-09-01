import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import {
  SUPPORTED_LOCALES,
  directionForLocale,
  htmlLangForLocale,
  isSupportedLocale,
} from '@brandspace/ui';
import '@brandspace/ui/tokens.css';

export const metadata = {
  title: 'BrandSpace',
  description: 'AI-powered brand and social media operating system',
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

  return (
    <html lang={htmlLangForLocale(locale)} dir={directionForLocale(locale)}>
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
