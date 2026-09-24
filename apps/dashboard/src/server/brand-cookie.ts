import 'server-only';
import { cookies } from 'next/headers';
import { BRAND_COOKIE, brandCookieValue } from './brand-context';

/**
 * REMEMBER A BRAND SELECTION — the one place the brand cookie is written.
 *
 * The brand selector writes it when a member chooses a brand, and the Setup
 * Wizard writes it when a member creates one (D-277 §6), so the brand they
 * just made is the one every following step is about. One writer means one
 * set of cookie attributes; the reasons for each are below.
 *
 * THE CALLER HAS ALREADY VALIDATED THE VALUE against the member's accessible
 * brands. The cookie carries no authority either way — it is re-validated
 * against BrandScope on every read (`server/brand-context.ts`).
 *
 * NOT a `'use server'` module: an exported async function there is a server
 * action any client can call, and this must only ever be called by one.
 */
export async function rememberBrand(workspaceId: string, value: string): Promise<void> {
  const store = await cookies();
  store.set(BRAND_COOKIE, brandCookieValue(workspaceId, value), {
    /*
     * HTTP-ONLY, because nothing in the browser needs to read it: the server
     * resolves the context and renders the result. A value scripts cannot touch
     * is one an injected script cannot silently move somebody's work onto
     * another brand with.
     */
    httpOnly: true,
    sameSite: 'lax',
    // Lax rather than Strict so following a colleague's link into the dashboard
    // still arrives with the reader's own selection intact.
    /*
     * SECURE UNCONDITIONALLY, exactly as the session cookie is set. An
     * environment-dependent flag would mean the one environment where somebody
     * forgets to set the variable is the one that ships a cookie over plain
     * HTTP — and localhost is treated as a secure origin, so nothing local
     * needs the exception.
     */
    secure: true,
    path: '/',
    // A YEAR, because a preference that expires mid-session is a preference
    // that looks like a bug. It carries no authority, so its lifetime is a
    // convenience question rather than a security one.
    maxAge: 60 * 60 * 24 * 365,
  });
}
