import { NextResponse, type NextRequest } from 'next/server';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@brandspace/ui';

/**
 * Redirects a locale-less path to the default locale (Arabic — D-03), so every
 * route resolves to an explicit locale and `dir`/`lang` are always unambiguous.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  /*
   * ROUTE HANDLERS ARE NOT PAGES AND HAVE NO LOCALE.
   *
   * `/api/*` is a machine endpoint: the Brand Brain chat proxy posts to it as
   * JSON. Redirecting it to `/ar/api/...` turned a POST into a 307 and then a
   * 404, and the browser surfaced it as "that request could not be completed" —
   * a chat that looked broken for a reason nothing in the chat code could
   * explain. Excluded here rather than in the matcher so the reason travels
   * with the rule.
   */
  if (pathname.startsWith('/api/')) return NextResponse.next();

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
