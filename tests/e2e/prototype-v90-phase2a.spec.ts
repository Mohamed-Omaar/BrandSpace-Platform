import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

/**
 * Prototype v90 alignment, Phase 2A — the permission and post-lifecycle items
 * as a person meets them in a real browser. The rules themselves are proven
 * against PostgreSQL in tests/isolation; this proves the screens follow them.
 */

function credentials(): E2eAdminCredentials {
  try {
    return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
  } catch {
    throw new Error('The end-to-end credentials file is missing. Run `pnpm e2e:seed` first.');
  }
}

async function signIn(page: Page, who: 'owner' | 'viewer', locale = 'en'): Promise<void> {
  const loaded = credentials();
  const { customer } = loaded;
  await useBrand(page, customer.workspaceId, brandFixtures(loaded).primaryBrandId);
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/sign-in`);
  await page.fill('#email', who === 'owner' ? customer.email : customer.viewerEmail);
  await page.fill('#password', who === 'owner' ? customer.password : customer.viewerPassword);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL(
    (url) => !url.pathname.endsWith('/sign-in') || url.searchParams.has('error'),
  );
  await page.click(`[data-testid="choose-workspace-${customer.workspaceSlug}"]`);
  await page.waitForURL(new RegExp(`/${locale}/overview$`));
}

test.describe('A6 · Home by role', () => {
  test('the owner sees the review queue, their own work and top posts — not the feedback card', async ({
    page,
  }) => {
    await signIn(page, 'owner');
    await expect(page.getByTestId('home-review-queue')).toBeVisible();
    await expect(page.getByTestId('home-my-work')).toBeVisible();
    await expect(page.getByTestId('home-my-drafts')).toBeVisible();
    await expect(page.getByTestId('home-my-sent')).toBeVisible();
    await expect(page.getByTestId('home-my-scheduled')).toBeVisible();
    await expect(page.getByTestId('home-top-posts')).toBeVisible();
    await expect(page.getByTestId('home-feedback')).toHaveCount(0);
  });

  test('the Viewer, which reads no content yet, gets none of the role sections', async ({
    page,
  }) => {
    await signIn(page, 'viewer');
    for (const id of ['home-review-queue', 'home-my-work', 'home-top-posts', 'home-feedback']) {
      await expect(page.getByTestId(id), id).toHaveCount(0);
    }
  });
});
