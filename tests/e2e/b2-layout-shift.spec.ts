import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { signIn } from './own-workspace';

/**
 * B2 (owner, 2026-11-14) — NOTHING JUMPS WHILE A PAGE FILLS IN.
 *
 * Cumulative Layout Shift under 0.1 on every main page, in English and Arabic,
 * with every picture held back 1.5 s: a tile, a cover or a piece of artwork
 * keeps its box from the first paint, so its picture arriving later moves
 * nothing around it.
 */

const PAGES = [
  'overview',
  'assets',
  'brand-brain',
  'content',
  'calendar',
  'analytics',
  'approvals',
  'copilot',
  'publishing',
] as const;

async function layoutShift(page: Page, path: string): Promise<number> {
  await page.goto(`${DASHBOARD_BASE_URL}${path}`);
  await page.waitForLoadState('networkidle');
  // Let the held-back pictures land and anything late settle.
  await page.waitForTimeout(2_000);
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let total = 0;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as (PerformanceEntry & {
            value: number;
            hadRecentInput: boolean;
          })[]) {
            if (!entry.hadRecentInput) total += entry.value;
          }
        }).observe({ type: 'layout-shift', buffered: true });
        setTimeout(() => resolve(total), 250);
      }),
  );
}

for (const locale of ['en', 'ar'] as const) {
  test(`every main page shifts less than 0.1 while its pictures arrive late (${locale})`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await page.route('**/assets/file/**', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.continue();
    });
    await signIn(page, locale);
    const shifts: Record<string, number> = {};
    for (const name of PAGES) {
      shifts[name] = Number((await layoutShift(page, `/${locale}/${name}`)).toFixed(4));
    }
    test.info().annotations.push({ type: 'cls', description: JSON.stringify(shifts) });
    for (const [name, value] of Object.entries(shifts)) {
      expect(value, `${name} (${locale})`).toBeLessThan(0.1);
    }
  });
}
