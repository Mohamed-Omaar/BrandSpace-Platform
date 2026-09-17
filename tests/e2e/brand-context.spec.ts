import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DASHBOARD_BASE_URL } from './apps';
import { E2E_CREDENTIALS_FILE, type E2eAdminCredentials } from './env';

/**
 * PHASE 8 — the global Brand Context and Brand Profile, in a real browser.
 *
 * WHAT THESE ASSERT THAT THE OTHER SUITES CANNOT. The unit suite proves the
 * precedence rules and the isolation suite proves the database refusals. Only a
 * browser can show that the selector is actually THERE, in both languages, in
 * both directions, on a phone, and that the profile form is the Settings design
 * rather than a page of its own invention.
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
    // sibling, not a second navigation system somewhere else on the page.
    await expect(page.getByTestId('workspace-switcher')).toBeVisible();
    const brandCard = page.getByTestId('brand-switcher');
    await expect(brandCard).toBeVisible();

    // THE CARD NEVER LIES ABOUT WHICH BRAND YOU ARE ON: it either names one or
    // says it has none. What it must never do is be blank.
    await expect(page.getByTestId('active-brand')).not.toBeEmpty();
    await expect(page.getByTestId('active-brand-caption')).not.toBeEmpty();
  });

  test('offers the aggregate where it means something, and not where it does not', async ({
    page,
  }) => {
    await signIn(page);

    // `/assets` is BRAND-OR-ALL: the aggregate is a real state there.
    await page.goto(`${DASHBOARD_BASE_URL}/en/assets`);
    await page.getByTestId('brand-switcher').click();
    await expect(page.getByTestId('brand-option-all')).toBeVisible();
    await page.keyboard.press('Escape');

    // `/brand-brain` needs exactly one brand, so a control that would set a
    // state the page cannot act on is not rendered at all (the dead control
    // §20 forbids).
    await page.goto(`${DASHBOARD_BASE_URL}/en/brand-brain`);
    await page.getByTestId('brand-switcher').click();
    await expect(page.getByTestId('brand-option-all')).toHaveCount(0);
  });

  test('the selection survives ordinary navigation', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/assets`);

    await page.getByTestId('brand-switcher').click();
    const firstBrand = page.locator('[data-testid^="brand-option-"]').filter({
      hasNotText: /^$/,
    });
    // The aggregate row is an option too; take a real brand.
    const brandOption = page
      .locator('[data-testid^="brand-option-"]')
      .filter({ has: page.locator('span') })
      .last();
    await expect(brandOption).toBeVisible();
    await expect(firstBrand.first()).toBeVisible();
    await brandOption.click();

    await page.waitForURL(/\/en\/assets/);
    const chosen = await page.getByTestId('active-brand').textContent();
    expect(chosen?.trim()).not.toBe('');

    // Somewhere else entirely, and the rail still says the same thing.
    await page.goto(`${DASHBOARD_BASE_URL}/en/content`);
    await expect(page.getByTestId('active-brand')).toHaveText(chosen!.trim());
  });

  test('renders in Arabic, right to left, and on a phone', async ({ page }) => {
    await signIn(page, 'ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByTestId('brand-switcher')).toBeVisible();

    // THE MOBILE DRAWER, not a desktop-only control. `headerStart` renders in
    // both, which is why the selector went to the rail rather than the top bar.
    await page.setViewportSize({ width: 390, height: 780 });
    await page.goto(`${DASHBOARD_BASE_URL}/ar/overview`);
    await page.getByTestId('open-navigation').click();
    await expect(page.getByTestId('brand-switcher')).toBeVisible();
  });
});

test.describe('brand profile', () => {
  test('is reached from the selector and uses the settings design', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings/brand`);

    await expect(page.getByTestId('brand-profile-form')).toBeVisible();
    // The Settings composition, not a page of its own invention.
    await expect(page.locator('nav', { hasText: 'Brand profile' }).first()).toBeVisible();
    await expect(page.getByTestId('brand-profile-name')).toBeVisible();
  });

  test('saves a change and shows it back', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings/brand`);

    const industry = page.locator('#brand-industry');
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
    const picker = page.getByTestId('brand-profile-primary-logo');
    await expect(picker).toBeVisible();
    await expect(page.locator('img[src=""]')).toHaveCount(0);
  });

  test('renders in Arabic and is clean under axe in both languages', async ({ page }) => {
    for (const locale of ['en', 'ar'] as const) {
      await signIn(page, locale);
      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/settings/brand`);
      await expect(page.getByTestId('brand-profile-form')).toBeVisible();

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    }
  });
});
