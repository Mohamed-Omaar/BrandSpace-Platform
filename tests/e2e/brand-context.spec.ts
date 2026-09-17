import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

/**
 * PHASE 8 — the global Brand Context and Brand Profile, in a real browser.
 *
 * WHAT THESE ASSERT THAT THE OTHER SUITES CANNOT. The unit suite proves the
 * precedence rules and the isolation suite proves the database refusals. Only a
 * browser can show that the selector is actually THERE, in both languages, in
 * both directions, on a phone, and that the profile form is the Settings design
 * rather than a page of its own invention.
 *
 * THE SELECTOR EXISTS TWICE IN THE DOM, on purpose: `headerStart` renders in
 * the rail and again in the mobile drawer, so one control serves both layouts
 * (§20 — no desktop-only control). Every locator here is therefore scoped to
 * the surface it means, because an unscoped `brand-switcher` is ambiguous by
 * design rather than by accident.
 *
 * NOTHING HERE PUBLISHES and nothing here changes another suite's fixtures: the
 * profile edit writes to a field this suite reads back and then restores.
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

/** The rail's copy of the selector — the one a desktop visitor sees. */
function rail(page: Page): Locator {
  return page.getByTestId('sidebar');
}

/** The drawer's copy — the one a phone visitor sees, once it is open. */
function drawer(page: Page): Locator {
  return page.getByTestId('navigation-drawer');
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

test.describe('the global brand selector', () => {
  test('sits beside the workspace selector and names the active brand', async ({ page }) => {
    await signIn(page);

    // BOTH CARDS, IN THE SAME BLOCK. The brand card is the workspace card's
    // sibling in the rail, not a second navigation system somewhere else.
    await expect(rail(page).getByTestId('workspace-switcher')).toBeVisible();
    await expect(rail(page).getByTestId('brand-switcher')).toBeVisible();

    // THE CARD NEVER LIES ABOUT WHICH BRAND YOU ARE ON: it either names one or
    // says it has none. What it must never do is be blank.
    await expect(rail(page).getByTestId('active-brand')).not.toBeEmpty();
    await expect(rail(page).getByTestId('active-brand-caption')).not.toBeEmpty();
  });

  test('offers the aggregate where it means something, and not where it does not', async ({
    page,
  }) => {
    await signIn(page);

    // `/assets` is BRAND-OR-ALL: the aggregate is a real state there.
    await page.goto(`${DASHBOARD_BASE_URL}/en/assets`);
    await rail(page).getByTestId('brand-switcher').click();
    await expect(rail(page).getByTestId('brand-option-all')).toBeVisible();
    await page.keyboard.press('Escape');

    // `/brand-brain` needs exactly one brand, so a control that would set a
    // state the page cannot act on is not rendered at all (the dead control
    // §20 forbids).
    await page.goto(`${DASHBOARD_BASE_URL}/en/brand-brain`);
    await rail(page).getByTestId('brand-switcher').click();
    await expect(rail(page).getByTestId('brand-option-all')).toHaveCount(0);
  });

  test('the selection survives ordinary navigation', async ({ page }) => {
    const loaded = credentials();
    const { primaryBrandId, primaryBrandName } = brandFixtures(loaded);
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/assets`);

    // THROUGH THE REAL CONTROL, not through the cookie: this test is about the
    // selector, so it uses it.
    await rail(page).getByTestId('brand-switcher').click();
    await rail(page).getByTestId(`brand-option-${primaryBrandId}`).click();

    await page.waitForURL(/\/en\/assets/);
    await expect(rail(page).getByTestId('active-brand')).toHaveText(primaryBrandName);

    // Somewhere else entirely, and the rail still says the same thing — which
    // is the point of a SERVER-READABLE selection rather than client state.
    await page.goto(`${DASHBOARD_BASE_URL}/en/content`);
    await expect(rail(page).getByTestId('active-brand')).toHaveText(primaryBrandName);
  });

  test('renders in Arabic, right to left, and on a phone', async ({ page }) => {
    await signIn(page, 'ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(rail(page).getByTestId('brand-switcher')).toBeVisible();

    // THE MOBILE DRAWER, not a desktop-only control. `headerStart` renders in
    // both, which is why the selector went to the rail rather than the top bar.
    await page.setViewportSize({ width: 390, height: 780 });
    await page.goto(`${DASHBOARD_BASE_URL}/ar/overview`);
    await page.getByTestId('open-navigation').click();
    await expect(drawer(page).getByTestId('brand-switcher')).toBeVisible();
  });
});

test.describe('brand profile', () => {
  /*
   * A BRAND IS A PRECONDITION HERE, not the subject. `/settings/brand` is
   * brand-scoped and asks rather than guesses (D-191) — which the selector
   * suite above proves. These tests are about the FORM, so they arrive with a
   * brand already chosen, the same one the seeds built.
   */
  test.beforeEach(async ({ page }) => {
    const loaded = credentials();
    await useBrand(page, loaded.customer.workspaceId, brandFixtures(loaded).primaryBrandId);
  });

  test('is reached from the selector and uses the settings design', async ({ page }) => {
    await signIn(page);

    // THE ROUTE THE SELECTOR POINTS AT, followed from the selector itself.
    await rail(page).getByTestId('brand-switcher').click();
    await rail(page).getByTestId('manage-brand').click();
    await page.waitForURL(/\/en\/settings\/brand/);

    await expect(page.getByTestId('brand-profile-form')).toBeVisible();
    // The Settings composition, not a page of its own invention.
    await expect(page.locator('nav', { hasText: 'Brand profile' }).first()).toBeVisible();
    await expect(page.getByTestId('brand-profile-name')).toBeVisible();
  });

  test('saves a change and shows it back', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings/brand`);

    const industry = page.locator('#brand-industry');
    await expect(industry).toBeVisible();
    const original = (await industry.inputValue()) ?? '';
    const next = `E2E industry ${Date.now()}`;

    await industry.fill(next);
    await page.getByTestId('brand-profile-save').click();
    await page.waitForURL(/ok=BRAND_PROFILE_SAVED/);
    await expect(page.locator('#brand-industry')).toHaveValue(next);

    // Leave the fixture as it was found: the next suite's assumptions are not
    // this suite's to change.
    await page.locator('#brand-industry').fill(original);
    await page.getByTestId('brand-profile-save').click();
    await page.waitForURL(/ok=BRAND_PROFILE_SAVED/);
  });

  test('is honest when there is no logo to show', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings/brand`);
    // Either a picker with a "no logo" option selected, or a plain sentence
    // saying there are no images yet. Never a broken image.
    await expect(page.getByTestId('brand-profile-primary-logo')).toBeVisible();
    await expect(page.locator('img[src=""]')).toHaveCount(0);
  });

  test('renders in Arabic and is clean under axe in both languages', async ({ page }) => {
    // ONE SIGN-IN, TWO LOCALES. The session is not locale-bound and the locale
    // is a route segment, so signing in again would only be redirected away
    // from a sign-in page the session has already passed.
    await signIn(page);
    for (const locale of ['en', 'ar'] as const) {
      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/settings/brand`);
      await expect(page.getByTestId('brand-profile-form')).toBeVisible();

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    }
  });
});
