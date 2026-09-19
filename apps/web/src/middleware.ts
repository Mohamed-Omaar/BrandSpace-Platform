import { NextResponse, type NextRequest } from 'next/server';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@brandspace/ui';
/*
 * IMPORTED FROM THE SUBPATH, NOT THE BARREL, and that is load-bearing.
 *
 * Middleware runs in the EDGE runtime, which has no `process.stdout`. Importing
 * `@brandspace/shared` pulls its index, which pulls the logger, which writes to
 * stdout at module scope — and the build fails with a Node API error pointing
 * at a file this middleware never meant to use. The subpath reaches
 * `security-headers.ts` and its one dependency (`deployment.ts`, which reads
 * `process.env` and nothing else).
 */
import { securityHeaders } from '@brandspace/shared/security-headers';

/**
 * PHASE 10 §21 — SECURITY HEADERS ON THE PUBLIC WEBSITE.
 *
 * NO NONCE HERE, AND THAT IS THE CORRECT ANSWER RATHER THAN A SHORTCUT. This
 * site is statically rendered on purpose: it has a Lighthouse budget and an LCP
 * target, and every page is prerendered at build time. A nonce has to be minted
 * per request and stamped into the HTML, which prerendered markup cannot carry —
 * and Next.js would opt the route into dynamic rendering to provide one,
 * trading the performance commitment for a policy the page cannot use.
 *
 * WHAT IT COSTS, stated plainly: `script-src 'self' 'unsafe-inline'` refuses
 * every cross-origin script — the vector that turns an injection into
 * exfiltration — and does not stop an inline injection. That is acceptable HERE
 * and nowhere else: this site has no session, no customer data and no
 * authenticated action. The dashboard and the Control Center are dynamic and
 * get the nonce policy.
 *
 * Found by an end-to-end run, not by reading: with a nonce policy the
 * prerendered pages refused every one of the framework's own chunks and the
 * site rendered without JavaScript at all.
 */
function secured(redirectTo?: URL): NextResponse {
  const response = redirectTo ? NextResponse.redirect(redirectTo) : NextResponse.next();
  for (const [key, value] of Object.entries(
    securityHeaders({ nonce: null, rendering: 'static' }),
  )) {
    response.headers.set(key, value);
  }
  return response;
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasLocale = SUPPORTED_LOCALES.some(
    (locale) => pathname === `/${locale}` || pathname.startsWith(`/${locale}/`),
  );
  if (hasLocale) return secured();

  const url = request.nextUrl.clone();
  url.pathname = `/${DEFAULT_LOCALE}${pathname === '/' ? '' : pathname}`;
  return secured(url);
}

export const config = {
  matcher: ['/((?!_next|favicon.ico|.*\\..*).*)'],
};
