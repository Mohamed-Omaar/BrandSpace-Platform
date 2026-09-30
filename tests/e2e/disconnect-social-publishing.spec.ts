import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DASHBOARD_BASE_URL } from './apps';
import { withPlatformPrisma } from './platform-prisma';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

/**
 * FIX PR 1 · F4 (D-411) — THE DASHBOARD'S TWO-STEP DISCONNECT STILL WORKS,
 * NOW THAT THE API HOLDS THE CONFIRMATION TOO.
 *
 * The API refuses a disconnect without `confirm: true` (proven against the real
 * handler in tests/isolation/fix-pr1-confirmation-enforced.test.ts). This walks
 * the only path that sends it: the first click opens the explanation, the
 * second — a separate danger button — disconnects. Keyboard only, in English
 * and in Arabic (RTL), with axe on the open confirmation.
 *
 * Each test disconnects an account of its own, created here, so the seeded
 * account the other publishing specs read is never touched. Runs in the serial
 * `social-publishing` project.
 */

function credentials(): E2eAdminCredentials {
  try {
    return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
  } catch {
    throw new Error('The end-to-end credentials file is missing. Run `pnpm e2e:seed` first.');
  }
}

async function signIn(page: Page, locale: 'en' | 'ar'): Promise<void> {
  const { customer } = credentials();
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

/** A connected account in the seeded workspace's primary brand, for this test alone. */
async function ownAccount(): Promise<string> {
  const loaded = credentials();
  return withPlatformPrisma(async (prisma) => {
    const owner = await prisma.user.findFirstOrThrow({
      where: { email: loaded.customer.email },
      select: { id: true },
    });
    const suffix = randomUUID().slice(0, 8);
    const connection = await prisma.socialConnection.create({
      data: {
        workspaceId: loaded.customer.workspaceId,
        brandId: brandFixtures(loaded).primaryBrandId,
        provider: 'LINKEDIN',
        externalAccountId: `f4-e2e-${suffix}`,
        displayName: `F4 disconnect ${suffix}`,
        targetKind: 'organization',
        status: 'ACTIVE',
        grantedScopes: ['w_member_social'],
        connectedByUserId: owner.id,
        connectedAt: new Date(),
      },
      select: { id: true },
    });
    return connection.id;
  });
}

const statusOf = (id: string) =>
  withPlatformPrisma(async (prisma) => {
    const row = await prisma.socialConnection.findUniqueOrThrow({ where: { id } });
    return row.status;
  });

test.describe('F4 · disconnecting an account takes two deliberate steps, and the second really disconnects', () => {
  for (const locale of ['en', 'ar'] as const) {
    test(`keyboard only, with axe on the open confirmation (${locale})`, async ({ page }) => {
      const id = await ownAccount();
      await signIn(page, locale);
      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/integrations`);
      if (locale === 'ar') await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

      const open = page.locator(`[data-testid="disconnect-${id}"]`);
      const confirm = page.locator(`[data-testid="disconnect-confirm-${id}"]`);
      await expect(open).toBeVisible();
      await expect(confirm).toBeHidden();

      // STEP ONE only explains: nothing is disconnected by opening it.
      await open.focus();
      await page.keyboard.press('Enter');
      await expect(confirm).toBeVisible();
      expect(await statusOf(id)).toBe('ACTIVE');

      const results = await new AxeBuilder({ page })
        .include(`[data-testid="connection-${id}"]`)
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations).toEqual([]);

      // STEP TWO — the separate danger button, reached by keyboard.
      await page.keyboard.press('Tab');
      await expect(confirm).toBeFocused();
      await page.keyboard.press('Enter');
      await page.waitForURL(/\/integrations/);
      await expect.poll(() => statusOf(id)).toBe('REVOKED');
    });
  }
});
