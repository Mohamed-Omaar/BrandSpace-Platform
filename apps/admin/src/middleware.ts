import { NextResponse, type NextRequest } from 'next/server';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@brandspace/ui';

/**
 * Redirects a locale-less path to the default locale (Arabic — D-03), so every
 * route resolves to an explicit locale and `dir`/`lang` are always unambiguous.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasLocale = SUPPORTED_LOCALES.some(
    (locale) => pathname === `/${locale}` || pathname.startsWith(`/${locale}/`),
  );
  if (hasLocale) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = `/${DEFAULT_LOCALE}${pathname === '/' ? '' : pathname}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next|favicon.ico|.*\\..*).*)'],
};
