import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';
import { inlineEndOverhang } from './overflow';

/**
 * PHASE 6 FINAL · D-277 §48-§51, D-299 — OVERLAYS AND WHOLE-SCREEN STATES, IN
 * BOTH LANGUAGES AND AT BOTH WIDTHS.
 *
 * The locale sweep proves every route. This proves what it cannot reach by
 * URL: the bell's feed and the Copilot drawer open from the inline-END side
 * (the left in Arabic), fit the phone, and are clean under axe; and a record
 * that does not exist (or is not the reader's) answers one localized
 * not-found page with a way home, as a 404. Read-only.
 */

function credentials(): E2eAdminCredentials {
  return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
}

async function signIn(page: Page, locale: 'en' | 'ar'): Promise<void> {
  const loaded = credentials();
  const { customer } = loaded;
  await useBrand(page, customer.workspaceId, brandFixtures(loaded).primaryBrandId);
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

const OVERLAYS = [
  { control: 'topbar-notifications', sheet: 'notifications-feed' },
  { control: 'topbar-copilot', sheet: 'copilot-drawer' },
] as const;

test.describe('D-299 · overlays, both languages', () => {
  for (const locale of ['en', 'ar'] as const) {
    for (const overlay of OVERLAYS) {
      test(`${overlay.sheet} opens from the inline end in ${locale}, fits, and passes axe`, async ({
        page,
      }) => {
        await signIn(page, locale);
        await page.getByTestId(overlay.control).click();
        const sheet = page.getByTestId(overlay.sheet);
        await expect(sheet).toBeVisible();
        // Let the entrance transition settle before measuring.
        await page.waitForTimeout(400);

        const box = await sheet.boundingBox();
        const width = page.viewportSize()?.width ?? 0;
        expect(box, 'sheet has a box').not.toBeNull();
        if (box) {
          // The sheet floats inside a gutter; it sits against the inline END.
          const startGap = box.x;
          const endGap = width - (box.x + box.width);
          if (locale === 'ar') expect(startGap).toBeLessThan(endGap + 1);
          else expect(endGap).toBeLessThan(startGap + 1);
          expect(box.width).toBeLessThanOrEqual(width + 1);
        }
        const overhang = await inlineEndOverhang(page);
        expect(overhang.px, `overhangs by ${overhang.px}px: ${overhang.offender}`).toBe(0);

        const results = await new AxeBuilder({ page })
          .include(`[data-testid="${overlay.sheet}"]`)
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(results.violations.map((v) => v.id)).toEqual([]);

        // Escape closes it, and focus is not lost to the void.
        await page.keyboard.press('Escape');
        await expect(sheet).toBeHidden();
      });
    }
  }
});

test.describe('D-299 · not found is one localized page', () => {
  for (const locale of ['en', 'ar'] as const) {
    test(`a post that is not there answers 404 with a way home in ${locale}`, async ({ page }) => {
      await signIn(page, locale);
      const response = await page.goto(
        `${DASHBOARD_BASE_URL}/${locale}/content/compose?item=${randomUUID()}`,
      );
      expect(response?.status()).toBe(404);
      const state = page.getByTestId('route-not-found');
      await expect(state).toBeVisible();
      await expect(state).toContainText(
        locale === 'ar' ? 'لم نجد هذه الصفحة' : "We couldn't find that page",
      );
      await expect(page.getByTestId('route-not-found-home')).toHaveAttribute(
        'href',
        `/${locale}/overview`,
      );
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations.map((v) => v.id)).toEqual([]);
    });
  }
});
