import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { withPlatformPrisma } from './platform-prisma';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

/**
 * PHASE 6 FINAL · D-277 §11, §44-§47, D-298 — SETTINGS THAT READ AS ONE PLACE.
 *
 * Billing & usage is one Settings row with two tabs; Team leads with the
 * person; a post carries its own history from the audit trail; Brand Brain
 * reaches the brand's profile. The suite writes its own draft and the audit
 * row that authored it, and soft-deletes the draft afterwards.
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

const made: string[] = [];

test.afterAll(async () => {
  if (made.length === 0) return;
  await withPlatformPrisma(async (prisma) => {
    await prisma.contentItem.updateMany({
      where: { id: { in: made } },
      data: { deletedAt: new Date() },
    });
  });
});

test.describe('D-298 · settings, team, billing and history', () => {
  test('Billing & usage is one Settings row with two tabs', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/billing`);
    const nav = page.getByTestId('settings-nav');
    await expect(nav.getByRole('link', { name: 'Billing & usage' })).toHaveCount(1);
    await expect(nav.getByRole('link', { name: 'Plan & usage' })).toHaveCount(0);

    const tabs = page.getByTestId('billing-tabs');
    await expect(tabs.getByTestId('tab-billing')).toHaveAttribute('aria-current', 'page');
    await tabs.getByTestId('tab-usage').click();
    await page.waitForURL(/\/en\/plan$/);
    await expect(page.getByTestId('billing-tabs').getByTestId('tab-usage')).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByTestId('current-plan')).toBeVisible();
    // The section, not a second row, is current in the Settings nav.
    await expect(
      page.getByTestId('settings-nav').getByRole('link', { name: 'Billing & usage' }),
    ).toHaveAttribute('aria-current', 'page');
  });

  test('Team leads with the member, and says when they joined', async ({ page }, testInfo) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/members`);
    if (testInfo.project.name.includes('mobile')) {
      // A phone gets labelled cards, not a squeezed table.
      const list = page.getByTestId('members-list');
      await expect(list.getByText(/^Joined /).first()).toBeVisible();
      return;
    }
    const table = page.getByTestId('members-table');
    await expect(table.getByRole('columnheader', { name: 'Member' })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: 'Brand access' })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: 'Status' })).toBeVisible();
    await expect(table.getByText(/^Joined /).first()).toBeVisible();
  });

  test('a post shows its own history, in words, with who and when', async ({ page }) => {
    const loaded = credentials();
    const workspaceId = loaded.customer.workspaceId;
    const brandId = brandFixtures(loaded).primaryBrandId;
    const itemId = await withPlatformPrisma(async (prisma) => {
      const me = await prisma.user.findFirstOrThrow({
        where: { email: loaded.customer.email },
        select: { id: true },
      });
      const item = await prisma.contentItem.create({
        data: {
          workspaceId,
          brandId,
          title: `History post ${randomUUID().slice(0, 6)}`,
          status: 'DRAFT',
          primaryLocale: 'EN',
        },
        select: { id: true },
      });
      await prisma.contentVariant.create({
        data: {
          workspaceId,
          brandId,
          contentItemId: item.id,
          platformKey: 'instagram',
          locale: 'EN',
          body: 'A post with a history.',
        },
      });
      await prisma.auditEvent.create({
        data: {
          workspaceId,
          actorType: 'USER',
          actorId: me.id,
          action: 'content.item.authored',
          resourceType: 'ContentItem',
          resourceId: item.id,
          brandId,
        },
      });
      return item.id;
    });
    made.push(itemId);

    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?item=${itemId}`);
    const history = page.getByTestId('post-history');
    await expect(history).toBeVisible();
    const entry = history.getByTestId('post-history-list-entry').first();
    await expect(entry).toContainText('Content was written');
    await expect(entry).toContainText('You');
    await expect(entry.locator('time')).toHaveText(/ago|now|second|minute/);
    // Never the machine key.
    await expect(history).not.toContainText('content.item.authored');
  });

  test('Brand Brain reaches the brand profile, and the page is clean under axe in Arabic', async ({
    page,
  }) => {
    await signIn(page, 'ar');
    await page.goto(`${DASHBOARD_BASE_URL}/ar/brand-brain`);
    const link = page.getByTestId('brand-brain-profile');
    await expect(link).toHaveAttribute('href', /\/ar\/settings\/brand\?brand=/);
    await page.goto(`${DASHBOARD_BASE_URL}/ar/plan`);
    await expect(page.getByTestId('billing-tabs')).toBeVisible();
    const results = await new AxeBuilder({ page })
      .include('[data-testid="billing-tabs"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
