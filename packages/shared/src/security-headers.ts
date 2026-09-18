import { isProduction } from './deployment';

/**
 * RESPONSE SECURITY HEADERS — Phase 10 §21.
 *
 * ONE DEFINITION FOR THREE APPS. The public website, the dashboard and the
 * Control Center each had four headers declared in their own `next.config.mjs`,
 * and three copies of a security policy is how one of them quietly falls behind.
 *
 * WHAT PHASE 10 ADDS to the four that were already there:
 *
 *   CONTENT-SECURITY-POLICY, with a per-request nonce. This is the control that
 *   turns an injected `<script>` from a total compromise into nothing at all,
 *   and it is the one header the platform did not have. Without it, `nosniff`
 *   and `X-Frame-Options` protect against the two easiest attacks and none of
 *   the interesting ones.
 *
 *   STRICT-TRANSPORT-SECURITY, in production only. Sent over http it means
 *   nothing, and sent from a developer's machine it would pin `localhost` to
 *   https in their browser for a year — a genuinely unpleasant thing to debug.
 */

export interface SecurityHeaderOptions {
  /**
   * A fresh, unguessable value per request. Never reused across responses.
   *
   * `null` selects the STATIC policy — see `rendering` below.
   */
  readonly nonce: string | null;
  /**
   * How the surface this policy protects is rendered.
   *
   * THIS IS NOT A STYLE CHOICE, and it took a failing end-to-end run to make
   * that obvious. A nonce has to be minted per request and stamped into the
   * HTML, which is impossible for a page that was rendered at BUILD time: the
   * prerendered markup carries no nonce, `'strict-dynamic'` then disables
   * host-based allow-listing, and every one of the framework's own chunks is
   * refused. The public website is statically rendered on purpose — it has a
   * Lighthouse budget to meet — and forcing it dynamic to gain a nonce would
   * trade a real performance commitment for a policy it cannot use anyway.
   *
   * So `'dynamic'` (the dashboard and the Control Center, where every page is
   * `force-dynamic` and every session lives) gets the nonce policy, and
   * `'static'` gets a weaker one that actually works. The trade is stated
   * rather than hidden: see `contentSecurityPolicy`.
   */
  readonly rendering?: 'dynamic' | 'static';
  /**
   * Origins the page legitimately calls. The dashboard talks to `apps/api`
   * through a same-origin proxy, so this is usually empty; a deployment that
   * calls the API directly from the browser names it here.
   */
  readonly connectOrigins?: readonly string[];
  /** Overrides the deployment check, for tests. */
  readonly production?: boolean;
}

/**
 * Build the CSP.
 *
 * `'strict-dynamic'` IS THE POINT OF THE NONCE. With it, a script the nonce
 * admits may load the scripts it needs, and host allow-lists stop mattering —
 * which is what makes the policy hold up as the bundle changes rather than
 * needing a new domain added every time a chunk moves.
 *
 * `style-src` STILL CARRIES `'unsafe-inline'`, and the reason is honest rather
 * than convenient: this product styles through React `style` objects, which
 * become style ATTRIBUTES, and CSP has no nonce mechanism for those. Removing
 * them is a design-system rewrite, not a security fix, and claiming a stricter
 * policy while shipping a looser one helps nobody. `style-src-attr` is named
 * explicitly so the exception is visible and scoped to attributes rather than
 * being a blanket allowance for `<style>` blocks.
 */
export function contentSecurityPolicy(options: SecurityHeaderOptions): string {
  const connect = ["'self'", ...(options.connectOrigins ?? [])].join(' ');
  const isStatic = options.rendering === 'static' || options.nonce === null;

  /*
   * THE STATIC POLICY IS WEAKER, AND SAYING SO IS THE POINT.
   *
   * `'self' 'unsafe-inline'` still refuses every CROSS-ORIGIN script, which is
   * the vector that turns an injection into exfiltration. It does not stop an
   * inline injection, and a nonce would — but a nonce cannot exist on a page
   * rendered at build time, so the honest options are this or no policy at all.
   *
   * WHERE IT IS USED IS WHY IT IS ACCEPTABLE: the public marketing site. No
   * session, no customer data, no authenticated action, nothing to steal. The
   * two surfaces that hold a session get the nonce policy, and this comment
   * exists so nobody later copies the weaker one to where it does not belong.
   */
  const scriptSrc = isStatic
    ? "script-src 'self' 'unsafe-inline'"
    : `script-src 'self' 'nonce-${options.nonce}' 'strict-dynamic'`;

  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "style-src-attr 'unsafe-inline'",
    // `data:` covers the inline SVG and generated images the product renders;
    // `blob:` covers a client-side preview of a file the customer just picked.
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connect}`,
    // The three that close the classic gaps: no plugins, no injected <base>,
    // and no form posting to somebody else's server.
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    // Belt and braces with X-Frame-Options, which older browsers read instead.
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}

/**
 * Every security header a response carries.
 *
 * Returned as a plain record so middleware, a route handler and a test can all
 * apply the same set without three copies of the list.
 */
export function securityHeaders(options: SecurityHeaderOptions): Record<string, string> {
  const production = options.production ?? isProduction();
  return {
    'Content-Security-Policy': contentSecurityPolicy(options),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
    /*
     * Cross-origin isolation for the window itself. `same-origin` stops another
     * document holding a reference to this one after a navigation, which is the
     * mechanism behind several tab-napping techniques.
     */
    'Cross-Origin-Opener-Policy': 'same-origin',
    'X-Permitted-Cross-Domain-Policies': 'none',
    ...(production
      ? {
          // Two years, subdomains included. Only ever sent over https, and only
          // from a production deployment: pinning `localhost` would be cruel.
          'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
        }
      : {}),
  };
}

/**
 * The cache policy for a page behind a session.
 *
 * `no-store` AND `private`, because the two are read by different things: a
 * shared proxy obeys `private`, a browser's back/forward cache obeys
 * `no-store`. An authenticated page left in either is the classic
 * shared-computer disclosure — sign out, press Back, read the previous
 * customer's invoices.
 */
export const AUTHENTICATED_CACHE_CONTROL = 'private, no-store, max-age=0, must-revalidate';
