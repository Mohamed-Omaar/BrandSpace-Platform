import { expect, test } from '@playwright/test';
import { APPS, LOCALES } from './apps';
import { expectNoHorizontalOverflow } from './overflow';

/**
 * Responsive layout smoke tests.
 *
 * The single assertion that matters most: the page must never scroll
 * HORIZONTALLY. Horizontal overflow is the classic RTL regression — a hardcoded
 * `margin-left` or a fixed width that only breaks in Arabic — so it is checked
 * in both directions at both sizes.
 *
 * The measurement lives in `./overflow` and walks the DOM rather than reading
 * `scrollWidth`; the reasoning is written out there (F-26). The short version:
 * `scrollWidth` cannot see content pushed past the LEFT edge, which is exactly
 * the direction an Arabic regression goes.
 */

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile', width: 390, height: 844 },
] as const;

for (const app of APPS) {
  for (const viewport of VIEWPORTS) {
    for (const locale of LOCALES) {
      test(`${app.label} has no horizontal overflow at ${viewport.name} (${locale.code})`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto(`${app.baseUrl}/${locale.code}`);

        await expectNoHorizontalOverflow(page, `${app.label} ${viewport.name} ${locale.code}`);
      });
    }
  }

  test(`${app.label} keeps its main content visible at mobile width`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${app.baseUrl}/ar`);
    await expect(page.getByTestId('heading')).toBeInViewport();
    await expect(page.getByTestId('description')).toBeVisible();
  });
}
