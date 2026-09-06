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
 * Run with:  pnpm e2e:screenshots
 *
 * NOT part of `pnpm test:e2e`. This project is registered only when
 * `BRANDSPACE_VISUAL_REVIEW=1`, which that script sets — see the comment beside
 * the project in `playwright.config.ts` and F-33 in `docs/DECISIONS.md`. It
 * writes files into the repository rather than asserting behaviour, so running
 * it in CI produced artefacts nobody reads and, at fifty-five captures, a step
 * that did not finish.
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

/**
 * A long screen, captured in READABLE SECTIONS rather than as one tall strip.
 *
 * A full-page shot of the showcase is roughly 12,000 pixels tall. Scaled to fit
 * a review window it is illegible, which makes it useless as the evidence it is
 * supposed to be. This takes a viewport-height slice at the top, the middle and
 * the bottom of the document, each at 1:1, so the reviewer can actually read
 * the type they are being asked to approve (§23).
 */
async function captureSections(page: Page, name: string): Promise<void> {
  await settle(page);
  const viewport = page.viewportSize();
  const height = viewport?.height ?? 900;
  const documentHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  const sections: readonly (readonly [string, number])[] = [
    ['top', 0],
    ['middle', Math.max(0, Math.round(documentHeight / 2 - height / 2))],
    ['bottom', Math.max(0, documentHeight - height)],
  ];

  for (const [suffix, offset] of sections) {
    await page.evaluate((y) => window.scrollTo(0, y), offset);
    // One frame for the scroll to land before the shot.
    await page.waitForTimeout(120);
    await page.screenshot({ path: path.join(OUTPUT, `${name}-${suffix}.png`) });
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

/**
 * A route sweep shot: the FIRST VIEWPORT, at 1:1, not the whole document.
 *
 * The stored-secrets page renders 176 rows against the seeded database, so a
 * `fullPage: true` capture of it is 42,000 pixels tall — a grey smear once
 * scaled into a review window, and evidence of nothing. What a reviewer needs
 * from a route sweep is whether the page reads as the approved direction, and
 * that is entirely decided above the fold.
 */
async function captureViewport(page: Page, name: string): Promise<void> {
  await settle(page);
  await page.screenshot({ path: path.join(OUTPUT, `${name}.png`) });
}

/** One section of the showcase, clipped to its own card. */
async function captureRegion(page: Page, testId: string, name: string): Promise<void> {
  const region = page.getByTestId(testId);
  await region.scrollIntoViewIfNeeded();
  await settle(page);
  await region.screenshot({ path: path.join(OUTPUT, `${name}.png`) });
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

  test('customer sign-in — both directions and mobile', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${DASHBOARD_BASE_URL}/en/sign-in`);
    await expect(page.getByTestId('auth-brand-panel')).toBeVisible();
    await capture(page, '09-customer-sign-in-en');
    await page.goto(`${DASHBOARD_BASE_URL}/ar/sign-in`);
    await capture(page, '10-customer-sign-in-ar');
    await expect(page.getByTestId('signin-submit')).toBeVisible();

    // The phone drops the brand panel entirely; the form is the whole screen.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${DASHBOARD_BASE_URL}/en/sign-in`);
    await capture(page, '11-customer-sign-in-mobile');
  });

  test('Platform Admin sign-in and MFA challenge', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${ADMIN_BASE_URL}/en/login`);
    await expect(page.getByTestId('platform-auth-card')).toBeVisible();
    await capture(page, '12-platform-admin-sign-in');

    // The second factor, which is a separate screen and a separate realm.
    const creds = credentials();
    await page.getByTestId('email').fill(creds.email);
    await page.getByTestId('password').fill(creds.password);
    await page.getByTestId('submit').click();
    await expect(page).toHaveURL(`${ADMIN_BASE_URL}/en/mfa`);
    await capture(page, '13-platform-admin-mfa');
  });

  test('Control Center — overview, directory and workspace detail', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInAdmin(page, 'en');
    await capture(page, '14-admin-overview');

    await page.goto(`${ADMIN_BASE_URL}/en/console/workspaces`);
    await expect(page.getByTestId('workspace-table')).toBeVisible();
    await capture(page, '15-admin-workspaces-directory');

    // A workspace detail page, which is the third console screen restyled.
    await page.getByTestId('workspace-table').getByRole('link').first().click();
    await page.waitForURL(/\/console\/workspaces\/[0-9a-f-]{36}/);
    await captureSections(page, '16-admin-workspace-detail');
  });

  /*
   * §15 AND §19: THE PAGES THE FIRST ROUND DID NOT REACH.
   *
   * Round 1 restyled a representative set and stated plainly that the rest
   * inherited the tokens without having their layouts reworked. "Do not finish
   * while some pages still look like the previous outlined admin console" means
   * that claim has to be checked rather than repeated, so every remaining route
   * in both applications is captured here and reviewed like the others.
   */
  test('every remaining Control Center route', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInAdmin(page, 'en');

    const routes = [
      ['50-admin-configuration', '/console/configuration'],
      ['51-admin-secrets', '/console/secrets'],
      ['52-admin-flags', '/console/flags'],
      ['53-admin-plans', '/console/plans'],
      ['54-admin-providers', '/console/providers'],
      ['55-admin-ai-models', '/console/ai-models'],
      ['56-admin-routing', '/console/routing'],
      ['57-admin-audit', '/console/audit'],
      ['58-admin-health', '/console/health'],
      ['59-admin-support', '/console/support'],
    ] as const;

    for (const [name, route] of routes) {
      await page.goto(`${ADMIN_BASE_URL}/en${route}`);
      await expect(page.getByTestId('heading')).toBeVisible();
      await captureViewport(page, name);
    }
  });

  test('every remaining customer route', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInCustomer(page, 'en');

    const routes = [
      ['60-customer-permissions', '/permissions'],
      ['61-customer-plan', '/plan'],
      ['62-customer-settings', '/settings'],
      ['63-customer-workspaces', '/workspaces'],
    ] as const;

    for (const [name, route] of routes) {
      await page.goto(`${DASHBOARD_BASE_URL}/en${route}`);
      await expect(page.getByTestId('heading')).toBeVisible();
      await captureViewport(page, name);
    }
  });

  test('the design showcase — full page, in readable sections', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });

    await page.goto(`${DASHBOARD_BASE_URL}/en/design-system`);
    await expect(page.getByTestId('showcase-support-banner')).toBeVisible();
    await captureSections(page, '17-showcase-en');

    await page.goto(`${DASHBOARD_BASE_URL}/ar/design-system`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await captureSections(page, '18-showcase-ar-rtl');
  });

  test('the component gallery, section by section', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${DASHBOARD_BASE_URL}/en/design-system`);

    await captureRegion(page, 'showcase-support-banner', '19-support-mode-banner');
    await captureRegion(page, 'showcase-buttons', '20-buttons-and-controls');
    await captureRegion(page, 'showcase-forms', '21-forms');
    await captureRegion(page, 'showcase-feedback', '22-component-states');
    await captureRegion(page, 'showcase-table', '23-tables-and-records');
    await captureRegion(page, 'showcase-metrics', '24-metric-cards');
  });

  test('the social post previews, by format', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${DASHBOARD_BASE_URL}/en/design-system`);

    // Seven required variants, in one grid: Instagram feed, Story and Reel,
    // Facebook, LinkedIn, a vertical TikTok video and an X-style post.
    await expect(page.getByTestId('preview-instagram-story')).toBeVisible();
    await expect(page.getByTestId('preview-tiktok-video')).toBeVisible();
    const social = page.getByTestId('showcase-social');
    await social.scrollIntoViewIfNeeded();
    await settle(page);
    await social.screenshot({ path: path.join(OUTPUT, '25-social-previews.png') });
  });

  test('the features hub', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${DASHBOARD_BASE_URL}/en/design-system`);
    await expect(page.getByTestId('features-prototype-notice')).toBeVisible();
    await captureRegion(page, 'showcase-features', '26-features-hub');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${DASHBOARD_BASE_URL}/en/design-system`);
    await captureRegion(page, 'showcase-features', '27-features-hub-mobile');
  });

  test('the content calendar — month on desktop, agenda on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${DASHBOARD_BASE_URL}/en/design-system`);
    await expect(page.getByTestId('calendar-month-grid')).toBeVisible();
    await captureRegion(page, 'showcase-calendar', '28-calendar-month-desktop');

    // The agenda view, which is a first-class desktop view and not only a
    // fallback.
    await page.getByTestId('calendar-view-agenda').click();
    await captureRegion(page, 'showcase-calendar', '29-calendar-agenda-desktop');

    // On a phone the calendar is ALWAYS the agenda: the month grid is not
    // squeezed into 390px, it is replaced.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${DASHBOARD_BASE_URL}/en/design-system`);
    await captureRegion(page, 'showcase-calendar', '30-calendar-agenda-mobile');
  });

  test('the calendar in Arabic', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${DASHBOARD_BASE_URL}/ar/design-system`);
    await captureRegion(page, 'showcase-calendar', '31-calendar-month-ar-rtl');
  });

  test('the posts library — grid, list and bulk selection', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${DASHBOARD_BASE_URL}/en/design-system`);
    await expect(page.getByTestId('library-prototype-notice')).toBeVisible();
    await captureRegion(page, 'showcase-library', '32-posts-library-all');

    // Selecting a record reveals the bulk bar, which exists only in that state.
    await page
      .getByTestId('showcase-library')
      .getByRole('button', { name: 'Select' })
      .first()
      .click();
    await expect(page.getByTestId('library-bulk-bar')).toBeVisible();
    await captureRegion(page, 'showcase-library', '33-posts-library-bulk-selection');

    // A status tab that genuinely matches nothing, showing the empty state
    // rather than the same records under a different heading.
    await page.getByTestId('tab-archived').click();
    await captureRegion(page, 'showcase-library', '34-posts-library-empty-state');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${DASHBOARD_BASE_URL}/en/design-system`);
    await captureRegion(page, 'showcase-library', '35-posts-library-mobile');
  });

  test('the post composer — desktop, mobile and Arabic', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${DASHBOARD_BASE_URL}/en/design-system`);
    await expect(page.getByTestId('prototype-composer')).toBeVisible();
    await captureRegion(page, 'showcase-composer', '36-composer-desktop');

    await page.goto(`${DASHBOARD_BASE_URL}/ar/design-system`);
    await captureRegion(page, 'showcase-composer', '37-composer-ar-rtl');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${DASHBOARD_BASE_URL}/en/design-system`);
    await captureRegion(page, 'showcase-composer', '38-composer-mobile');
  });

  test('the Design Studio — desktop and mobile', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${DASHBOARD_BASE_URL}/en/design-system`);
    await expect(page.getByTestId('studio-canvas')).toBeVisible();
    await captureRegion(page, 'showcase-studio', '39-design-studio-desktop');

    await page.goto(`${DASHBOARD_BASE_URL}/ar/design-system`);
    await captureRegion(page, 'showcase-studio', '40-design-studio-ar-rtl');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${DASHBOARD_BASE_URL}/en/design-system`);
    await captureRegion(page, 'showcase-studio', '41-design-studio-mobile');
  });

  test('the contextual Copilot — surfaces, states and the approval preview', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${DASHBOARD_BASE_URL}/en/design-system`);

    // The composer's action set.
    await page.getByTestId('copilot-surface-composer').click();
    await captureRegion(page, 'showcase-copilot', '42-copilot-composer-context');

    // A different surface offers a different set — the point of D-56.
    await page.getByTestId('copilot-surface-studio').click();
    await captureRegion(page, 'showcase-copilot', '43-copilot-studio-context');

    await page.getByTestId('copilot-state-streaming').click();
    await captureRegion(page, 'showcase-copilot', '44-copilot-processing');

    await page.getByTestId('copilot-state-error').click();
    await captureRegion(page, 'showcase-copilot', '45-copilot-error');

    await page.getByTestId('copilot-state-insufficient-credits').click();
    await captureRegion(page, 'showcase-copilot', '46-copilot-insufficient-credits');

    // The approval gate, with the before/after preview of what would change.
    await page.getByTestId('copilot-state-approval').click();
    await expect(page.getByTestId('copilot-change-preview').first()).toBeVisible();
    await captureRegion(page, 'showcase-copilot', '47-copilot-approval-preview');

    // And the docked desktop panel.
    await page.getByTestId('copilot-launcher').click();
    await expect(page.getByTestId('copilot-panel')).toBeVisible();
    await capture(page, '48-copilot-desktop-panel');
    await page.getByTestId('copilot-close').click();
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
    await page.screenshot({ path: path.join(OUTPUT, '49-copilot-mobile-sheet.png') });
  });
});
