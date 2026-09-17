'use server';

import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import {
  ALL_BRANDS,
  BRAND_COOKIE,
  brandCookieValue,
  listAccessibleBrands,
  safeReturnPath,
} from '../../server/brand-context';
import { requireWorkspace } from '../../server/customer-context';
import { scopeForPath } from '../../server/route-scope';

/**
 * Choose the brand the dashboard is about (D-190, D-191).
 *
 * A SERVER ACTION RATHER THAN A LINK, and that is not a style choice. The
 * Workspace Selector navigates because switching workspace rewrites the
 * SESSION, which the server already owns. A brand selection is remembered in a
 * cookie, and a cookie cannot be set by following a link — so the selector
 * posts, exactly as the profile menu's sign-out does, and the server decides.
 *
 * WHAT IS VALIDATED, AND IN WHICH ORDER:
 *
 *   1. THE SESSION AND THE WORKSPACE, by `requireWorkspace`, which re-verifies
 *      membership on every request. Nothing below runs for a stale session.
 *   2. THE BRAND, against the brands this member may act on — listed with their
 *      BrandScope IN THE QUERY (D-132), so a brand outside it is never read.
 *      An unknown id answers 404, the same answer a brand that does not exist
 *      gets, because "you may not have that one" and "there is no such thing"
 *      must be indistinguishable (CLAUDE.md §2.1).
 *   3. THE RETURN PATH, by `safeReturnPath`, because an unvalidated destination
 *      in a redirect is an open redirect.
 *
 * THE COOKIE CARRIES NO AUTHORITY. It names a preference and is re-validated
 * against BrandScope on every read; see `server/brand-context.ts`.
 */
export async function selectBrandAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const session = await requireWorkspace(locale);

  const raw = formData.get('brandId');
  /*
   * MISSING IS NOT EMPTY, AND NEITHER IS A CHOICE (the Phase 7 round-5 rule).
   * Every option this selector renders carries a value, so a request with the
   * field absent did not come from the screen.
   */
  if (raw === null) notFound();
  const requested = String(raw);

  const destination = safeReturnPath(formData.get('next')?.toString(), locale);

  let value: string;
  if (requested === ALL_BRANDS) {
    /*
     * THE AGGREGATE IS ONLY OFFERED WHERE IT MEANS SOMETHING. Storing `all`
     * from a brand-required page would leave the reader's selection in a state
     * that page can never act on, so the selector does not render it there and
     * the server does not accept it there either.
     */
    const path = destination.slice(`/${locale}`.length) || '/overview';
    if (scopeForPath(path) !== 'brand-or-all') notFound();
    value = ALL_BRANDS;
  } else {
    const brands = await listAccessibleBrands(session.workspace);
    const brand = brands.find((candidate) => candidate.id === requested);
    if (!brand) notFound();
    value = brand.id;
  }

  const store = await cookies();
  store.set(BRAND_COOKIE, brandCookieValue(session.workspace.workspaceId, value), {
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

  redirect(destination);
}
