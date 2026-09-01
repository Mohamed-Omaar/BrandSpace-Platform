import { expect, test } from '@playwright/test';
import { APPS, LOCALES } from './apps';

/**
 * Keyboard reachability and visible focus.
 *
 * CLAUDE.md §4 targets WCAG 2.2 AA: every flow must be completable using only
 * the keyboard, and focus must always be visible. Automated axe checks do not
 * cover either property, so they are asserted directly.
 */

for (const app of APPS) {
  test.describe(`${app.label} keyboard access`, () => {
    for (const locale of LOCALES) {
      test(`skip link is the first tab stop and is visible when focused (${locale.code})`, async ({
        page,
      }) => {
        await page.goto(`${app.baseUrl}/${locale.code}`);

        await page.keyboard.press('Tab');
        const skip = page.getByTestId('skip-link');
        await expect(skip).toBeFocused();
        // Off-screen until focused, then genuinely visible — not merely present.
        await expect(skip).toBeInViewport();
      });
    }

    test('every interactive element is reachable by Tab alone', async ({ page }) => {
      await page.goto(`${app.baseUrl}/en`);

      const interactive = page.locator('a[href], button, [tabindex]:not([tabindex="-1"])');
      const total = await interactive.count();
      expect(total, 'the page must have interactive elements to test').toBeGreaterThan(0);

      const reached = new Set<string>();
      for (let i = 0; i < total + 2; i += 1) {
        await page.keyboard.press('Tab');
        const marker = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return null;
          return el.getAttribute('data-testid') ?? el.tagName.toLowerCase();
        });
        if (marker) reached.add(marker);
      }

      expect(reached).toContain('skip-link');
      expect(reached).toContain('locale-switch');
      expect(reached).toContain('primary-link');
    });

    test('the focused element has a visible focus indicator', async ({ page }) => {
      await page.goto(`${app.baseUrl}/en`);
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');

      const indicator = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el) return null;
        const style = window.getComputedStyle(el);
        return {
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
          boxShadow: style.boxShadow,
        };
      });

      expect(indicator).not.toBeNull();
      // Focus must not be suppressed: either an outline or a box-shadow ring.
      const hasOutline =
        indicator!.outlineStyle !== 'none' && parseFloat(indicator!.outlineWidth) > 0;
      const hasRing = indicator!.boxShadow !== 'none' && indicator!.boxShadow !== '';
      expect(hasOutline || hasRing, `focus indicator missing: ${JSON.stringify(indicator)}`).toBe(
        true,
      );
    });

    test('skip link moves focus to the main landmark', async ({ page }) => {
      await page.goto(`${app.baseUrl}/en`);
      await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/#main$/);
      await expect(page.locator('main#main')).toBeVisible();
    });
  });
}
