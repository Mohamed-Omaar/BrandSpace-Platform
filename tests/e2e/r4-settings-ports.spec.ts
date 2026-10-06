import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

/**
 * ROUND 4, GATE 2b — THE NOT PORTED SETTINGS PAGES, AS THE PROTOTYPE DRAWS
 * THEM (`Main.dc.html` lines 1356–1442), on the product's own data and forms.
 * Each test checks the prototype's composition and that the product's control
 * behind it is still the one that posts.
 */

function credentials(): E2eAdminCredentials {
  return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
}

async function signIn(page: Page): Promise<void> {
  const loaded = credentials();
  const { customer } = loaded;
  await useBrand(page, customer.workspaceId, brandFixtures(loaded).primaryBrandId);
  await page.goto(`${DASHBOARD_BASE_URL}/en/sign-in`);
  await page.fill('#email', customer.email);
  await page.fill('#password', customer.password);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL((url) => !url.pathname.endsWith('/sign-in'));
  const choose = page.getByTestId(`choose-workspace-${customer.workspaceSlug}`);
  if (await choose.isVisible().catch(() => false)) await choose.click();
  await page.waitForURL(/\/en\/overview$/);
}

test.describe('Round 4 · Gate 2b — the Settings pages', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('Approvals: "Who approves" lists the team, each marked, over the two rules', async ({
    page,
  }) => {
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings/approvals`);
    const who = page.locator('[data-testid^="approvers-"]').first();
    await expect(who).toBeVisible();
    await expect(who).toContainText('Who approves');
    const rows = who.locator('[data-testid^="approver-"]');
    expect(await rows.count()).toBeGreaterThan(0);
    // Every row says one of the three answers.
    for (let index = 0; index < (await rows.count()); index += 1) {
      await expect(rows.nth(index)).toContainText(
        /^.+(Approves|Approves others’ posts|Doesn’t approve)$/,
      );
    }
    // At least the owner approves (the role holds `content.approve`).
    expect(await who.locator('[data-approves="true"]').count()).toBeGreaterThan(0);
    await expect(who.locator('[data-testid^="approvers-edit-"]')).toHaveAttribute(
      'href',
      '/en/members',
    );
    // The rules are switch rows with their line under each.
    await expect(page.getByTestId('approvals-policy')).toContainText(
      'Every post goes to review before it is scheduled',
    );
  });

  test('AI: the writing language is chips, and choosing one makes the bar dirty', async ({
    page,
  }) => {
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings/ai`);
    const group = page.locator('[data-testid^="ai-language-"][role="radiogroup"]').first();
    await expect(group).toBeVisible();
    await expect(group.locator('.bsp-ai-chip')).toHaveCount(2);
    const unchecked = group.locator('.bsp-ai-chip:not(:has(input:checked))').first();
    const bar = page.locator('[data-testid^="ai-bar-"]').first();
    await expect(bar).toHaveAttribute('data-state', 'clean');
    await unchecked.click();
    await expect(bar).toHaveAttribute('data-state', 'dirty');
    // Nothing that has no setting behind it is drawn.
    await expect(page.getByText('Alert me when credits reach')).toHaveCount(0);
    await expect(page.getByText('AI drafts go to review')).toHaveCount(0);
  });

  test('Data: rows, the retention card and the danger card with its inline confirmation', async ({
    page,
  }) => {
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings/data`);
    // Gate 2b review (4c) — the prototype's three rows first, in its order; the
    // product's rows and its retention control behind one "More".
    await expect(page.locator('.bsp-dt > section').nth(0)).toHaveAttribute(
      'data-testid',
      'data-control-workspaceExport',
    );
    await expect(page.locator('.bsp-dt > section').nth(1)).toHaveAttribute(
      'data-testid',
      'data-retention',
    );
    await expect(page.locator('.bsp-dt > section').nth(2)).toHaveAttribute(
      'data-testid',
      'workspace-deletion',
    );
    await expect(page.getByTestId('retention-card')).toBeHidden();
    await page.getByTestId('data-more').locator('summary').click();
    await expect(page.getByTestId('retention-card')).toBeVisible();
    const danger = page.getByTestId('workspace-deletion');
    await expect(danger).toHaveClass(/bsp-dt-danger/);
    await expect(page.getByTestId('workspace-deletion-name')).toBeVisible();
    await expect(page.getByTestId('workspace-deletion-password')).toBeVisible();
    await expect(page.getByTestId('workspace-deletion-confirm')).toBeVisible();
    await expect(page.getByTestId('workspace-deletion-open')).toHaveCount(0);
  });

  test('Security: one card of rows, ending in the activity log', async ({ page }) => {
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings/security`);
    const card = page.locator('.bsp-secu');
    await expect(card).toHaveCount(1);
    await expect(card.getByTestId('mfa-card')).toBeVisible();
    await expect(card.getByTestId('sessions-card')).toBeVisible();
    await expect(card.getByTestId('security-activity')).toContainText('Activity log');
    await expect(card.getByTestId('security-activity').getByRole('link')).toHaveAttribute(
      'href',
      '/en/activity',
    );
  });

  test('Publishing defaults: channel chips, the time choices and "Other"', async ({ page }) => {
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings/publishing`);
    const form = page.locator('[data-testid^="publishing-defaults-form-"]').first();
    await expect(form.locator('.bsp-pd-chip').first()).toBeVisible();
    // Gate 2b review (4d) — the times are chips too, and the time field is not
    // on the surface until "Other" is chosen.
    await expect(
      form.locator('label.bsp-pd-chip:has([name="defaultPostTimeChoice"])').first(),
    ).toBeVisible();
    await expect(form.locator('[data-testid$="-other"]')).toHaveCount(1);
    // Nothing that has no feature behind it is drawn.
    await expect(page.getByText(/link tracking/i)).toHaveCount(0);
  });

  test('Notifications: the event table has an "In app" column and no Email column', async ({
    page,
  }) => {
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings/notifications`);
    const card = page.getByTestId('notification-preferences');
    await expect(card.locator('.bsp-nt-head')).toContainText('In app');
    await expect(card.locator('.bsp-nt-head')).not.toContainText('Email');
    expect(await card.locator('.bsp-nt-row').count()).toBeGreaterThan(0);
  });

  test('Accounts: a row per account, and the connect form behind the card’s "⋯"', async ({
    page,
  }) => {
    await page.goto(`${DASHBOARD_BASE_URL}/en/integrations`);
    const card = page.getByTestId('connected-accounts');
    const connected = card.locator(
      '[data-testid^="connection-"]:not([data-testid^="connection-more"])',
    );
    expect(await connected.count()).toBeGreaterThan(0);
    await expect(connected.first().locator('.bsp-acc-ic')).toBeVisible();
    await expect(connected.first().locator('.bsp-pill')).toBeVisible();
    // The full connect form is not on the surface until the "⋯" is opened.
    await expect(page.getByTestId('connect-form')).toBeHidden();
    await page.getByTestId('connect-more').click();
    await expect(page.getByTestId('connect-form')).toBeVisible();
  });
});
