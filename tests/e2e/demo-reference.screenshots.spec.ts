import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { repoRoot } from './env';

/**
 * THE REFERENCE HALF of the visual-review evidence.
 *
 * Captures `docs/visual-reference/full-demo/` — the vendored demo that is the
 * visual authority (D-60) — screen by screen, into
 * `docs/visual-review/reference/`, so a fidelity review compares two IMAGES
 * rather than an image against a memory of one.
 *
 * The demo is a static bundle with no build step. Serve it first, from the
 * repository root:
 *
 *     python3 -m http.server 8900 --directory docs/visual-reference/full-demo
 *
 * then run the visual-review project (`pnpm e2e:screenshots`). If nothing is
 * listening on 8900 the test SKIPS rather than fails: the demo server is a
 * local convenience, not a dependency of the suite, and CI never runs this
 * project at all.
 *
 * It writes files and asserts nothing about the product, so it lives in the
 * opt-in `visual-review` project alongside the product captures.
 */

const DEMO = 'http://localhost:8900/index.html';
const OUT = path.join(repoRoot, 'docs', 'visual-review', 'reference');

const CUSTOMER = [
  'overview',
  'calendar',
  'posts',
  'composer',
  'studio',
  'analytics',
  'team',
  'roles',
  'plan',
  'settings',
  'social',
  'customer-signin',
  'workspace-picker',
] as const;

const ADMIN = ['admin-overview', 'workspaces', 'workspace-detail', 'plans', 'providers'] as const;

async function settle(page: Page) {
  await page.addStyleTag({
    content: '*,*::before,*::after{animation:none!important;transition:none!important}',
  });
  await page.waitForTimeout(150);
}

async function go(page: Page, view: string) {
  await page.evaluate((id) => {
    const button = document.querySelector(`[data-view-target="${id}"]`);
    (button as HTMLElement | null)?.click();
  }, view);
  await page.waitForTimeout(200);
}

test('capture the demo reference', async ({ page }) => {
  const reachable = await page.request
    .get(DEMO, { timeout: 2000 })
    .then((response) => response.ok())
    .catch(() => false);
  test.skip(!reachable, `No demo server on ${DEMO} — see this file's header.`);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(DEMO, { waitUntil: 'networkidle' });
  await settle(page);

  for (const view of CUSTOMER) {
    await go(page, view);
    await settle(page);
    await page.screenshot({ path: path.join(OUT, `customer-${view}-en.png`) });
  }

  // Arabic RTL: the demo's own language toggle.
  await go(page, 'overview');
  await page.click('#languageButton');
  await page.waitForTimeout(300);
  await settle(page);
  for (const view of ['overview', 'calendar', 'composer', 'team', 'settings'] as const) {
    await go(page, view);
    await settle(page);
    await page.screenshot({ path: path.join(OUT, `customer-${view}-ar.png`) });
  }

  // Back to English, then the Control Center.
  await page.click('#languageButton');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    (window as unknown as { setMode: (mode: string) => void }).setMode('admin');
  });
  await page.waitForTimeout(300);
  await settle(page);
  for (const view of ADMIN) {
    await go(page, view);
    await settle(page);
    await page.screenshot({ path: path.join(OUT, `admin-${view}-en.png`) });
  }

  expect(true).toBe(true);
});
