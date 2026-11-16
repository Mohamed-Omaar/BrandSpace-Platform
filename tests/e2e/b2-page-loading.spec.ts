import { expect, test } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { signIn } from './own-workspace';

/**
 * B2 (owner, 2026-11-14) — A CLICK ANSWERS AT ONCE.
 *
 * Moving to another page used to leave the old one up, unchanged, until the
 * server had the new one ready. Now the panel shows the page on its way —
 * skeleton cards and the shared progress line, "Loading…" in the page's
 * language — while the rail stays where it is, and the new page replaces it.
 */

for (const locale of ['en', 'ar'] as const) {
  test(`a slow page change shows the loading panel, then the page (${locale})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'the rail is the desktop’s; the panel is the same on a phone');
    test.setTimeout(90_000);
    await signIn(page, locale);
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/overview`);
    await expect(page.getByTestId('heading')).toBeVisible();

    // The next page's data arrives 1.5 s late.
    await page.route(`**/${locale}/assets**`, async (route) => {
      if (route.request().headers()['rsc'] === '1') {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
      await route.continue();
    });
    await page.getByTestId('nav-assets').click();

    const loading = page.getByTestId('page-loading');
    await expect(loading).toBeVisible();
    await expect(loading.getByTestId('page-loading-status')).toContainText(
      locale === 'ar' ? 'جارٍ التحميل' : 'Loading',
    );
    await expect(loading.getByTestId('skeleton').first()).toBeVisible();
    // The rail stays: the same one, on screen, while the page is on its way.
    await expect(page.getByTestId('nav-assets')).toBeVisible();

    // The page arrives and takes the panel back.
    await expect(page).toHaveURL(new RegExp(`/${locale}/assets`));
    await expect(loading).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByTestId('heading')).toBeVisible();
  });
}
