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
  title: 'BrandSpace Control Center',
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
  return (
    <html lang={htmlLangForLocale(locale)} dir={directionForLocale(locale)}>
      <body>
        <a href="#main" className="skip-link" data-testid="skip-link">
          {locale === 'ar' ? 'تخطَّ إلى المحتوى' : 'Skip to content'}
        </a>
        {children}
      </body>
    </html>
  );
}
