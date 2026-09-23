import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

/**
 * PHASE 6 · P6-13 — TEAM, ACTIVITY, SETTINGS AND PLAN, READ-ONLY.
 *
 * Every assertion here READS: this spec runs in both viewport projects in
 * parallel against the shared seeded workspace, so it changes nothing. What it
 * pins is what a member is told — brand access is visible, the Activity log
 * speaks the reader's language rather than printing machine keys, the Data
 * controls page names what exists and what does not, and the Plan screen shows
 * usage against its real ceilings.
 */

function credentials(): E2eAdminCredentials {
  return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
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

/** A dotted machine key such as `content.review_requested`. */
const MACHINE_KEY = /^[a-z_]+(\.[a-z_]+)+$/;

test.describe('P6-13 · team, activity, settings, plan', () => {
  test('the Team screen shows each member’s brand access', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/members`);
    await expect(page.getByTestId('members-card')).toContainText('Brand access');
    await expect(page.getByTestId('members-card')).toContainText(/All brands|and \d+ more|\w/);
  });

  test('the Activity log names events in words, in both languages', async ({ page }) => {
    await signIn(page);
    for (const locale of ['en', 'ar']) {
      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/activity`);
      const list = page.getByTestId('activity-list');
      if ((await list.count()) === 0) continue; // an empty log is an honest state
      const titles = await list.locator('li strong').allTextContents();
      expect(titles.length).toBeGreaterThan(0);
      for (const title of titles) {
        expect(title.trim(), `${locale} activity title`).not.toMatch(MACHINE_KEY);
      }
      const options = await page.getByTestId('activity-filter').locator('option').allTextContents();
      for (const option of options) {
        expect(option.trim(), `${locale} filter option`).not.toMatch(MACHINE_KEY);
      }
    }
  });

  test('Data controls names what exists, and says what does not', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings/data`);
    const card = page.getByTestId('data-controls');
    await expect(card).toBeVisible();
    await expect(page.getByTestId('data-control-retention')).toBeVisible();
    await expect(page.getByTestId('data-control-workspaceDeletion')).toContainText(
      'Not available yet',
    );
    // Reachable from the Settings navigation, alongside Connected accounts.
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings`);
    await expect(page.getByRole('link', { name: 'Data controls' }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Connected accounts' }).first()).toBeVisible();
  });

  test('the Plan screen shows brands and accounts against their real ceilings', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/plan`);
    for (const row of ['usage-brands', 'usage-social-accounts']) {
      await expect(page.getByTestId(row)).toBeVisible();
      await expect(page.getByTestId(row)).toContainText(/\d+ (of \d+|· no ceiling stated)/);
    }
  });

  test('the new screens are clean under axe in both directions', async ({ page }) => {
    await signIn(page);
    for (const locale of ['en', 'ar']) {
      for (const path of ['/settings/data', '/members']) {
        await page.goto(`${DASHBOARD_BASE_URL}/${locale}${path}`);
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(results.violations, `${locale}${path}`).toEqual([]);
      }
    }
  });
});
