import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

/**
 * PHASE 6 FINAL · D-277 §26, D-301 — CREATIVE STUDIO SAYS WHAT AN IMAGE WILL
 * DRAW ON BEFORE IT IS ASKED FOR. Read-only: nothing is generated.
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
  await page.waitForURL(
    (url) => !url.pathname.endsWith('/sign-in') || url.searchParams.has('error'),
  );
  await page.click(`[data-testid="choose-workspace-${customer.workspaceSlug}"]`);
  await page.waitForURL(/\/en\/overview$/);
}

test('the studio names the brand, its identity notes and a way to change them', async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`${DASHBOARD_BASE_URL}/en/creative`);
  const identity = page.getByTestId('creative-identity');
  await expect(identity).toContainText(/What .+ images draw on/);
  // Counted from Brand Brain, or said plainly that there are none — never a score.
  await expect(page.getByTestId('creative-identity-summary')).toContainText(
    /approved identity and voice notes|No approved identity or voice notes yet/,
  );
  await expect(page.getByTestId('creative-identity-profile')).toHaveAttribute(
    'href',
    /\/en\/settings\/brand\?brand=/,
  );
  // The price is still shown before anything is spent.
  await expect(page.getByTestId('creative-generate')).toBeVisible();
});
