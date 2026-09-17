import { expect, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';

/**
 * ESTABLISHING THE GLOBAL BRAND CONTEXT FOR A SUITE THAT IS NOT ABOUT IT.
 *
 * From Phase 8 a brand-scoped screen — Brand Brain, Strategy, Analytics, the
 * Copilot, the Brand Profile — requires an EXPLICIT brand and will not pick one
 * for you (D-191). Before Phase 8 those screens silently took the first brand
 * they found, and every suite that visited one was quietly relying on that
 * guess. Now each suite says which brand it means.
 *
 * WHY A COOKIE AND NOT A CLICK. For a suite whose subject is Brand Brain or
 * Analytics, choosing a brand is a PRECONDITION, not the thing under test, and
 * it should not depend on the viewport (the selector lives in the rail on a
 * desktop and in the drawer on a phone) or on the menu's ordering. This writes
 * exactly what the selector's server action writes — `bs_brand`, keyed by the
 * workspace so a selection cannot survive a switch — and then ASSERTS the shell
 * agrees, so a change to the cookie's shape fails here with a clear message
 * rather than silently leaving every brand screen empty.
 *
 * The selector's own behaviour — the menu, the persistence, the aggregate, the
 * workspace switch — is `brand-context.spec.ts`, through the real UI.
 */
const BRAND_COOKIE = 'bs_brand';

export async function useBrand(page: Page, workspaceId: string, brandId: string): Promise<void> {
  await page.context().addCookies([
    {
      name: BRAND_COOKIE,
      value: `${workspaceId}:${brandId}`,
      // `url` ALONE: Playwright takes either a url or a domain/path pair, and
      // refuses both. The dashboard's origin gives the path the action uses.
      url: DASHBOARD_BASE_URL,
      sameSite: 'Lax',
      // The same flags the action writes, so the fixture is the real cookie and
      // not a permissive lookalike. Localhost counts as a secure origin.
      httpOnly: true,
      secure: true,
    },
  ]);
}

/**
 * The same thing, proven.
 *
 * Call this when the page is already open: it reloads so the server reads the
 * cookie, then checks the shell names a brand rather than asking for one.
 */
export async function useBrandAndReload(
  page: Page,
  workspaceId: string,
  brandId: string,
): Promise<void> {
  await useBrand(page, workspaceId, brandId);
  await page.reload();
  await expect(page.getByTestId('active-brand').first()).not.toHaveText(/^\s*$/);
}
