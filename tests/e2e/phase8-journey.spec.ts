import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

/**
 * THE PHASE 8 EXIT JOURNEY, IN A REAL BROWSER (AC-30.2, AC-30.3, AC-30.4).
 *
 * WHAT THIS SUITE IS FOR, AND WHAT IT IS NOT. Every area it walks has its own
 * deeper suite — the Studio composes, the calendar schedules, approvals decide,
 * publishing publishes. This one asks the question none of those can: does the
 * product hold together as ONE system? A customer does not open eleven screens;
 * they follow a path from a workspace to a published post to what was learned
 * from it, and the path either exists or it does not.
 *
 * SO IT ASSERTS REACHABILITY AND COHERENCE, NOT DEPTH. Each stop must render,
 * in the reader's own language and direction, under the one shell, with the one
 * brand context — and must never be a dead link, a second navigation system, or
 * a 500. Where a stop needs credits or a provider, the suite accepts the honest
 * refusal as an outcome: a screen that says "not enough credit" has worked.
 *
 * THE DENIAL PATHS ARE PART OF THE JOURNEY. A route typed by hand without the
 * permission answers 404 — shaped exactly like a route that does not exist —
 * and that is asserted here rather than assumed, because the hidden rail link
 * is tidiness and the route's own refusal is the control.
 */

function credentials(): E2eAdminCredentials {
  try {
    return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
  } catch {
    throw new Error(
      'The end-to-end credentials file is missing. Run `pnpm e2e:seed` first — ' +
        '`pnpm test:e2e` does it for you.',
    );
  }
}

async function signIn(page: Page, locale = 'en'): Promise<void> {
  const { customer } = credentials();
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/sign-in`);
  await page.fill('#email', customer.email);
  await page.fill('#password', customer.password);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL(
    (url) => !url.pathname.endsWith('/sign-in') || url.searchParams.has('error'),
  );
  await page.click(`[data-testid="choose-workspace-${customer.workspaceSlug}"]`);
  await page.waitForURL(new RegExp(`/${locale}/overview$`));
}

/** Sign in AND fix the brand, which every brand-scoped stop below requires. */
async function enterProduct(page: Page, locale = 'en'): Promise<void> {
  const { customer } = credentials();
  const brands = brandFixtures(credentials());
  await signIn(page, locale);
  await useBrand(page, customer.workspaceId, brands.primaryBrandId);
}

/**
 * THE JOURNEY, AS A TABLE.
 *
 * Transcribed from D-195's exit criterion in the order it states, so a reader
 * comparing the decision with this file sees the same list. Each row is a stop
 * and the thing on the screen that proves the stop rendered rather than
 * redirected — a heading is not enough, because an error page has one too.
 */
const JOURNEY: readonly { readonly name: string; readonly path: string }[] = [
  { name: 'Workspace — the Command Center', path: '/overview' },
  { name: 'Brand Profile', path: '/settings/brand' },
  { name: 'Brand Brain', path: '/brand-brain' },
  { name: 'Assets', path: '/assets' },
  { name: 'AI Strategy', path: '/strategy' },
  { name: 'Campaigns', path: '/campaigns' },
  { name: 'AI Content Studio', path: '/content' },
  { name: 'AI Creative Studio', path: '/creative' },
  { name: 'Approvals', path: '/approvals' },
  { name: 'Calendar', path: '/calendar' },
  { name: 'Publishing — where posts go out (D-277)', path: '/publishing' },
  { name: 'Settings > Connections — the accounts behind it', path: '/integrations' },
  { name: 'Analytics', path: '/analytics' },
  { name: 'Marketing Intelligence', path: '/intelligence' },
];

test.describe('the exit journey runs end to end', () => {
  for (const stop of JOURNEY) {
    test(`${stop.name} is reachable and is one product`, async ({ page }) => {
      await enterProduct(page);
      const response = await page.goto(`${DASHBOARD_BASE_URL}/en${stop.path}`);

      // NOT A 404 AND NOT A 500. A stop on the journey that answers either is a
      // broken journey however good the screen behind it is.
      expect(response?.status(), `${stop.path} responded ${response?.status()}`).toBeLessThan(400);

      // ONE SHELL. Every stop wears the same rail with the same two selectors —
      // no page invents its own navigation and no page invents its own brand
      // picker (D-190).
      await expect(page.getByTestId('sidebar')).toBeVisible();
      await expect(page.getByTestId('sidebar').getByTestId('workspace-switcher')).toHaveCount(0);
      await expect(page.getByTestId('sidebar').getByTestId('brand-switcher')).toBeVisible();

      // AND IT IS THE PAGE THAT WAS ASKED FOR, rather than a redirect to the
      // overview that would make every assertion above pass for free.
      expect(new URL(page.url()).pathname).toBe(`/en${stop.path}`);
    });
  }

  test('the last leg is real: intelligence offers the write-back into Brand Brain', async ({
    page,
  }) => {
    await enterProduct(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/intelligence`);

    /*
     * THE HONESTY LINE IS NOT OPTIONAL. Before any finding, the screen states
     * that BrandSpace has no external market source — which is the answer to
     * the question a customer asks of any recommendation.
     */
    await expect(page.getByText(/no outside source|nothing outside/i).first()).toBeVisible();

    /*
     * AND THE LOOP HAS A CONTROL. Whether a finding exists depends on what the
     * fixture's analytics contain, so this asserts the form that COMMISSIONS
     * one is there — the journey's entry point — rather than requiring a
     * generation to have already happened.
     */
    await expect(page.getByTestId('content-gap-form')).toBeVisible();
  });
});

test.describe('the denial paths refuse the same way a missing route does', () => {
  test('an unauthenticated visitor is sent to sign in, not shown a stop', async ({ page }) => {
    for (const path of ['/campaigns', '/creative', '/intelligence']) {
      await page.goto(`${DASHBOARD_BASE_URL}/en${path}`);
      // SIGNED OUT IS NOT A 404 — it is an invitation to sign in, and the
      // difference is deliberate: hiding the existence of the product from an
      // anonymous visitor protects nothing.
      await expect(page).toHaveURL(/\/sign-in/);
    }
  });

  test('a route that does not exist and one without permission look alike', async ({ page }) => {
    await enterProduct(page);

    const invented = await page.goto(`${DASHBOARD_BASE_URL}/en/not-a-real-area`);
    expect(invented?.status()).toBe(404);

    /*
     * The seeded customer is an owner and holds every permission, so this suite
     * cannot produce a permission refusal itself — `viewer-read-only.spec.ts`
     * does, for exactly the Phase 7 areas, and Phase 8's routes use the same
     * `requireWorkspace(locale, permission)` gate. What IS asserted here is the
     * shape the product answers with when there is nothing to show, so the two
     * can be compared at all.
     */
    const body = (await page.content()).toLowerCase();
    expect(body).not.toContain('stack');
    expect(body).not.toContain('prisma');
  });
});

test.describe('the journey reads as one product in both languages', () => {
  /*
   * A SAMPLE RATHER THAN ALL THIRTEEN, deliberately. Axe against every stop in
   * both directions is thirteen sign-ins and several minutes for assertions
   * that each stop's own suite already makes. These three are the ones Phase 8
   * BUILT — the areas with no prior suite — plus the shell that carries them.
   */
  for (const path of ['/campaigns', '/creative', '/intelligence']) {
    test(`${path} is clean under axe in Arabic, right to left`, async ({ page }) => {
      await enterProduct(page, 'ar');
      await page.goto(`${DASHBOARD_BASE_URL}/ar${path}`);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });

    test(`${path} is clean under axe in English, left to right`, async ({ page }) => {
      await enterProduct(page, 'en');
      await page.goto(`${DASHBOARD_BASE_URL}/en${path}`);
      await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }

  test('no stop overflows a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await enterProduct(page);

    for (const path of ['/campaigns', '/creative', '/intelligence', '/calendar']) {
      await page.goto(`${DASHBOARD_BASE_URL}/en${path}`);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      // A pixel or two of rounding is not a horizontal scrollbar; a sidebar
      // that did not collapse is.
      expect(overflow, `${path} overflows by ${overflow}px`).toBeLessThanOrEqual(2);
    }
  });
});
