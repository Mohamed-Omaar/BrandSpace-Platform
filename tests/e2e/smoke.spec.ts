import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { APPS, LOCALES } from './apps';

/**
 * F-04 — bilingual smoke tests across all three interfaces.
 *
 * These assert the properties Phase 1 actually claims: that Arabic RTL is a real
 * routing property rather than a hardcoded default, that pages render with
 * correct landmarks, that navigation works, and that nothing throws in the
 * browser. No test touches an external API — every page is statically rendered.
 */

/** Collect uncaught page errors and console errors for the whole test. */
function watchForErrors(page: Page): { errors: string[] } {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  return { errors };
}

for (const app of APPS) {
  test.describe(`${app.label} (${app.name})`, () => {
    for (const locale of LOCALES) {
      test(`renders ${locale.code} with dir=${locale.dir} and no browser errors`, async ({
        page,
      }) => {
        const seen = watchForErrors(page);
        await page.goto(`${app.baseUrl}/${locale.code}`);

        // Direction and language must come from the URL segment.
        await expect(page.locator('html')).toHaveAttribute('dir', locale.dir);
        await expect(page.locator('html')).toHaveAttribute('lang', locale.lang);

        // Page actually rendered.
        await expect(page.getByTestId('heading')).toBeVisible();
        await expect(page.locator('main#main')).toBeVisible();

        // Exactly one h1 and one main landmark — an accessibility basic that
        // axe alone does not always flag.
        expect(await page.locator('h1').count()).toBe(1);
        expect(await page.locator('main').count()).toBe(1);
        expect(await page.locator('header').count()).toBe(1);

        expect(seen.errors, `browser errors on ${app.name}/${locale.code}`).toEqual([]);
      });
    }

    test('a locale-less path redirects to the default locale (Arabic)', async ({ page }) => {
      await page.goto(`${app.baseUrl}/`);
      await expect(page).toHaveURL(`${app.baseUrl}/ar`);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    });

    test('navigates to the second page and back', async ({ page }) => {
      const seen = watchForErrors(page);
      await page.goto(`${app.baseUrl}/en`);

      await page.getByTestId('primary-link').click();
      await expect(page).toHaveURL(`${app.baseUrl}/en/${app.secondPath}`);
      await expect(page.getByTestId('heading')).toBeVisible();

      await page.getByTestId('back-link').click();
      await expect(page).toHaveURL(`${app.baseUrl}/en`);

      expect(seen.errors).toEqual([]);
    });

    test('switching locale switches direction', async ({ page }) => {
      await page.goto(`${app.baseUrl}/en`);
      await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');

      await page.getByTestId('locale-switch').click();
      await expect(page).toHaveURL(`${app.baseUrl}/ar`);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    });

    test('a 404 is returned for an unsupported locale', async ({ page }) => {
      const response = await page.goto(`${app.baseUrl}/fr`);
      expect(response?.status()).toBe(404);
    });
  });
}
