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
import { AUTHENTICATED_CACHE_CONTROL, securityHeaders } from '@brandspace/shared/security-headers';

/**
 * PHASE 10 §21 — SECURITY HEADERS, WITH A PER-REQUEST NONCE.
 *
 * The four baseline headers used to live in `next.config.mjs`, one copy per
 * app. They move here because the fifth — Content-Security-Policy — cannot be
 * static: a nonce has to be minted per request, and Next.js reads the CSP off
 * the REQUEST headers to stamp that nonce onto its own inline bootstrap
 * scripts. A static `headers()` block would produce a policy that forbids the
 * framework's own scripts.
 *
 * CSP IS THE CONTROL THIS PLATFORM DID NOT HAVE. `nosniff` and
 * `X-Frame-Options` cover the two easiest attacks; a nonce with
 * `'strict-dynamic'` is what turns an injected `<script>` into nothing at all.
 */
function secured(request: NextRequest, redirectTo?: URL): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const headers = securityHeaders({ nonce, rendering: 'dynamic' });

  /*
   * THE REQUEST CARRIES THE POLICY TOO, and that is not redundant: Next.js
   * looks for `Content-Security-Policy` on the INCOMING request, reads the
   * nonce out of it, and applies it to the scripts it renders. Without this the
   * page would be served under a policy that forbids its own bootstrap.
   *
   * A redirect has no body to nonce, so it only carries the response headers.
   */
  const response = redirectTo
    ? NextResponse.redirect(redirectTo)
    : (() => {
        const forwarded = new Headers(request.headers);
        forwarded.set('x-nonce', nonce);
        forwarded.set('Content-Security-Policy', headers['Content-Security-Policy'] ?? '');
        return NextResponse.next({ request: { headers: forwarded } });
      })();

  for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);

  /*
   * NOTHING IN THE CONTROL CENTER IS CACHEABLE (§21).
   *
   * Every page here is about the platform's own operation — workspaces,
   * credentials, configuration — and several are read on shared machines
   * during support. `private` is what a proxy obeys and `no-store` is what the
   * back/forward cache obeys.
   */
  response.headers.set('Cache-Control', AUTHENTICATED_CACHE_CONTROL);
  return response;
}

/**
 * Locale redirect, plus the response security headers.
 *
 * The locale part is a CONVENIENCE, never a security control. Authorisation is
 * enforced in the console layout and in every server action against the real
 * session (docs/SECURITY.md §4.5). Middleware runs on the edge with no database
 * access, so it could not verify a session even if we wanted it to — which is
 * exactly why the headers above are the only security work it does.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasLocale = SUPPORTED_LOCALES.some(
    (locale) => pathname === `/${locale}` || pathname.startsWith(`/${locale}/`),
  );
  if (hasLocale) return secured(request);

  const url = request.nextUrl.clone();
  url.pathname = `/${DEFAULT_LOCALE}${pathname === '/' ? '' : pathname}`;
  return secured(request, url);
}

export const config = {
  matcher: ['/((?!_next|favicon.ico|.*\\..*).*)'],
};
