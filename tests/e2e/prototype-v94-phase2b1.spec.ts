import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

/**
 * Prototype v94, Phase 2B-1 — the read-only half, as a person meets it in a
 * real browser. Nothing here changes shared state, so it runs in the two
 * viewport projects; the suites that change workspace settings run serially in
 * `prototype-v94-settings.spec.ts`. The rules themselves are proven against
 * PostgreSQL in tests/isolation.
 */

function credentials(): E2eAdminCredentials {
  try {
    return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
  } catch {
    throw new Error('The end-to-end credentials file is missing. Run `pnpm e2e:seed` first.');
  }
}

async function signIn(page: Page, locale = 'en'): Promise<void> {
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

test.describe('UI-1 · one global scrollbar', () => {
  test('a scroll area gets the thin bar; the sidebar navigation keeps its bar hidden', async ({
    page,
    isMobile,
  }) => {
    // Phone emulation draws overlay scrollbars that take no width at all.
    test.skip(isMobile === true, 'desktop scrollbars only');
    await signIn(page);
    const probe = await page.evaluate(() => {
      const box = document.createElement('div');
      box.style.cssText =
        'position:absolute;inset-block-start:0;width:120px;height:60px;overflow:scroll';
      box.innerHTML = '<div style="width:400px;height:400px"></div>';
      document.body.appendChild(box);
      const bar = box.offsetWidth - box.clientWidth;
      box.remove();
      return bar;
    });
    // Chromium draws the pseudo-element bar at the token's 8px — not the
    // platform's default width, and not zero.
    expect(probe).toBe(8);

    const nav = page.locator('.bs-nav-scroll').first();
    await expect(nav).toBeVisible();
    const hidden = await nav.evaluate((element) => ({
      bar: (element as HTMLElement).offsetWidth - (element as HTMLElement).clientWidth,
      width: getComputedStyle(element).getPropertyValue('scrollbar-width'),
    }));
    expect(hidden.bar).toBe(0);
    expect(hidden.width).toBe('none');
  });
});
