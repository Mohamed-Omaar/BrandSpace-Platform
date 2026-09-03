import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';
import { DASHBOARD_BASE_URL, ADMIN_BASE_URL } from './apps';
import { E2E_CREDENTIALS_FILE, repoRoot, type E2eAdminCredentials } from './env';

/**
 * VISUAL-REVIEW EVIDENCE for the Phase 2C-A checkpoint (§10 of the brief).
 *
 * Not a test of behaviour — it asserts only that each surface rendered — but a
 * capture run that writes the screenshots the owner reviews, into
 * `docs/visual-review/`. It is a normal Playwright spec so it uses the same
 * seeded fixtures and the same built applications as the suites, rather than a
 * separate script that could drift from them.
 *
 * DETERMINISTIC BY CONSTRUCTION: the seeded estate is created by `pnpm e2e:seed`
 * with fixed names, the showcase renders fixed fixtures, and animations are
 * disabled for the capture. No credential and no customer data appears in any
 * image — the accounts are the throwaway `@brandspace.test` ones the suite
 * creates and discards.
 *
 * Run with:  npx playwright test --project=visual-review
 */

const OUTPUT = path.join(repoRoot, 'docs', 'visual-review');

function credentials(): E2eAdminCredentials {
  return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
}

/** Freeze motion, so two runs of the same screen produce the same image. */
async function settle(page: Page): Promise<void> {
  await page.addStyleTag({
    content: '*,*::before,*::after{animation:none!important;transition:none!important}',
  });
  await page.waitForLoadState('networkidle');
}

async function capture(page: Page, name: string): Promise<void> {
  await settle(page);
  await page.screenshot({ path: path.join(OUTPUT, `${name}.png`), fullPage: true });
}

async function signInCustomer(page: Page, locale = 'en'): Promise<void> {
  const { customer } = credentials();
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/sign-in`);
  await page.fill('#email', customer.email);
  await page.fill('#password', customer.password);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL((url) => !url.pathname.endsWith('/sign-in'));
  await page.click(`[data-testid="choose-workspace-${customer.workspaceSlug}"]`);
  await page.waitForURL(new RegExp(`/${locale}/overview$`));
}

/**
 * Full Control Center sign-in: password, then MFA.
 *
 * The Control Center requires verified MFA (D-27), so a capture run has to
 * complete the second factor exactly as the admin suite does — acting as the
 * authenticator with the throwaway TOTP seed the seed script generated.
 */
async function signInAdmin(page: Page, locale = 'en'): Promise<void> {
  const creds = credentials();
  await page.goto(`${ADMIN_BASE_URL}/${locale}/login`);
  await page.getByTestId('email').fill(creds.email);
  await page.getByTestId('password').fill(creds.password);
  await page.getByTestId('submit').click();
  await expect(page).toHaveURL(`${ADMIN_BASE_URL}/${locale}/mfa`);
  await page.getByTestId('mfa-code').fill(
    new TOTP({
      issuer: 'BrandSpace Platform',
      label: 'e2e',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(creds.totpSecret),
    }).generate(),
  );
  await page.getByTestId('submit').click();
  await expect(page).toHaveURL(`${ADMIN_BASE_URL}/${locale}/console`);
}

test.describe('visual review evidence', () => {
  test('customer dashboard — desktop English', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInCustomer(page, 'en');
    await capture(page, '01-customer-dashboard-desktop-en');
    await expect(page.getByTestId('heading')).toBeVisible();
  });

  test('customer dashboard — desktop Arabic RTL', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInCustomer(page, 'ar');
    await capture(page, '02-customer-dashboard-desktop-ar-rtl');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  });

  test('customer dashboard — mobile, and the navigation drawer', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signInCustomer(page, 'en');
    await capture(page, '03-customer-dashboard-mobile');

    await page.click('[data-testid="open-navigation"]');
    await expect(page.getByTestId('navigation-drawer')).toBeVisible();
    await capture(page, '04-customer-mobile-drawer');
  });

  test('customer team page — desktop and mobile', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInCustomer(page, 'en');
    await page.goto(`${DASHBOARD_BASE_URL}/en/members`);
    await capture(page, '05-customer-team-desktop');
    await expect(page.getByTestId('members-table')).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${DASHBOARD_BASE_URL}/en/members`);
    await capture(page, '06-customer-team-mobile-record-list');
    await expect(page.getByTestId('members-list')).toBeVisible();
  });

  test('sidebar expanded and collapsed', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInCustomer(page, 'en');
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-sidebar-state', 'expanded');
    await capture(page, '07-sidebar-expanded');

    await page.click('[data-testid="toggle-sidebar"]');
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-sidebar-state', 'collapsed');
    await capture(page, '08-sidebar-collapsed');
  });

  test('customer sign-in — both directions', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${DASHBOARD_BASE_URL}/en/sign-in`);
    await capture(page, '09-customer-sign-in-en');
    await page.goto(`${DASHBOARD_BASE_URL}/ar/sign-in`);
    await capture(page, '10-customer-sign-in-ar');
    await expect(page.getByTestId('signin-submit')).toBeVisible();
  });

  test('Control Center — overview and workspaces directory', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInAdmin(page, 'en');
    await capture(page, '11-admin-overview');

    await page.goto(`${ADMIN_BASE_URL}/en/console/workspaces`);
    await expect(page.getByTestId('workspace-table')).toBeVisible();
    await capture(page, '12-admin-workspaces-directory');

    // A workspace detail page, which is the third console screen restyled.
    await page.getByTestId('workspace-table').getByRole('link').first().click();
    await page.waitForURL(/\/console\/workspaces\/[0-9a-f-]{36}/);
    await capture(page, '12b-admin-workspace-detail');
  });

  test('the design showcase, Support Mode banner, previews and Copilot', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });

    await page.goto(`${DASHBOARD_BASE_URL}/en/design-system`);
    await expect(page.getByTestId('showcase-support-banner')).toBeVisible();
    await capture(page, '13-showcase-full-en');

    await page.goto(`${DASHBOARD_BASE_URL}/ar/design-system`);
    await capture(page, '14-showcase-full-ar-rtl');

    // The Support Mode state, on its own.
    await page.goto(`${DASHBOARD_BASE_URL}/en/design-system`);
    await page.getByTestId('showcase-support-banner').scrollIntoViewIfNeeded();
    await settle(page);
    await page
      .getByTestId('showcase-support-banner')
      .screenshot({ path: path.join(OUTPUT, '15-support-mode-banner.png') });

    // Component states.
    await page
      .getByTestId('showcase-feedback')
      .screenshot({ path: path.join(OUTPUT, '16-component-states.png') });
    await page
      .getByTestId('showcase-buttons')
      .screenshot({ path: path.join(OUTPUT, '17-buttons-and-controls.png') });
    await page
      .getByTestId('showcase-forms')
      .screenshot({ path: path.join(OUTPUT, '18-forms.png') });

    // Social previews: the grid covers five platforms and four ratios at once.
    await page
      .getByTestId('showcase-social')
      .screenshot({ path: path.join(OUTPUT, '19-social-post-previews.png') });

    // Copilot: desktop panel.
    await page.getByTestId('showcase-copilot').scrollIntoViewIfNeeded();
    await page.click('[data-testid="copilot-state-approval"]');
    await page.click('[data-testid="copilot-launcher"]');
    await expect(page.getByTestId('copilot-panel')).toBeVisible();
    await capture(page, '20-copilot-desktop-panel');
    await page.click('[data-testid="copilot-close"]');

    await page
      .getByTestId('showcase-copilot')
      .screenshot({ path: path.join(OUTPUT, '21-copilot-states.png') });
  });

  test('Copilot as a mobile sheet', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${DASHBOARD_BASE_URL}/en/design-system`);
    await page.getByTestId('showcase-copilot').scrollIntoViewIfNeeded();
    await page.click('[data-testid="copilot-launcher"]');
    const sheet = page.getByTestId('copilot-panel');
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute('aria-modal', 'true');
    await settle(page);
    await page.screenshot({ path: path.join(OUTPUT, '22-copilot-mobile-sheet.png') });
  });
});
