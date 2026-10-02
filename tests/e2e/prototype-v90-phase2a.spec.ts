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

async function signIn(
  page: Page,
  who: 'owner' | 'viewer' | 'copywriter',
  locale = 'en',
): Promise<void> {
  const loaded = credentials();
  const { customer } = loaded;
  await useBrand(page, customer.workspaceId, brandFixtures(loaded).primaryBrandId);
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/sign-in`);
  const [email, password] =
    who === 'owner'
      ? [customer.email, customer.password]
      : who === 'copywriter'
        ? [customer.copywriterEmail, customer.copywriterPassword]
        : [customer.viewerEmail, customer.viewerPassword];
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL(
    (url) => !url.pathname.endsWith('/sign-in') || url.searchParams.has('error'),
  );
  await page.click(`[data-testid="choose-workspace-${customer.workspaceSlug}"]`);
  await page.waitForURL(new RegExp(`/${locale}/overview$`));
}

test.describe('A6 · Home by role', () => {
  test('the owner gets the full Home — hero, figures, Needs you — and no role section (D-468)', async ({
    page,
  }) => {
    // SUPERSEDED BY D-468: the prototype's owner Home (`homeOwner`) is the full
    // Home; the role sections are the approver's, creator's, analyst's and
    // viewer's Homes (`VA_meKind`), which the owner's pending reviews, drafts
    // and performance reach through Needs you, Upcoming and the figures.
    await signIn(page, 'owner');
    await expect(page.getByTestId('hero-performance')).toBeVisible();
    await expect(page.getByTestId('overview-metrics')).toBeVisible();
    await expect(page.getByTestId('attention-card')).toBeVisible();
    for (const id of ['home-role-hero', 'home-review-queue', 'home-my-drafts', 'home-feedback']) {
      await expect(page.getByTestId(id), id).toHaveCount(0);
    }
  });

  test('a copywriter, who creates and does not approve, gets their own work and what is coming up', async ({
    page,
  }) => {
    await signIn(page, 'copywriter');
    await expect(page.getByTestId('home-role-hero')).toBeVisible();
    for (const id of ['home-my-drafts', 'home-my-sent', 'home-my-scheduled', 'home-coming-up']) {
      await expect(page.getByTestId(id), id).toBeVisible();
    }
    for (const id of ['home-review-queue', 'home-feedback', 'hero-performance']) {
      await expect(page.getByTestId(id), id).toHaveCount(0);
    }
  });

  test('the Viewer, which reads content since Q12, gets the feedback section and no other', async ({
    page,
  }) => {
    await signIn(page, 'viewer');
    await expect(page.getByTestId('home-feedback')).toBeVisible();
    for (const id of ['home-review-queue', 'home-my-work', 'home-top-posts']) {
      await expect(page.getByTestId(id), id).toHaveCount(0);
    }
  });
});
