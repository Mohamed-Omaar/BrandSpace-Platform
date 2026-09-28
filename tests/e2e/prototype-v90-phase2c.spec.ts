import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';
import { withPlatformPrisma } from './platform-prisma';

/**
 * Prototype v90, Phase 2C-1 — Brand Brain v2: grounding (item 1) and knowledge,
 * review and completeness (item 2), as a person meets them in a real browser.
 *
 * EVERY TEST CREATES ITS OWN WORKSPACE with one brand, so nothing another suite
 * reads moves, and runs once (the desktop project) unless it is about the
 * phone. What each path SENDS a model is proven against PostgreSQL in
 * tests/isolation/phase2c-grounding.test.ts; this file proves the screens.
 */

function credentials(): E2eAdminCredentials {
  try {
    return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
  } catch {
    throw new Error('The end-to-end credentials file is missing. Run `pnpm e2e:seed` first.');
  }
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

/** A workspace of its own, owned by the e2e customer, with one ACTIVE brand. */
async function ownWorkspace(
  label: string,
  timezone = 'UTC',
): Promise<{ slug: string; brandId: string; workspaceId: string }> {
  const { customer } = credentials();
  const slug = `e2e-${label}-${randomUUID().slice(0, 8)}`;
  const brandId = randomUUID();
  const workspaceId = randomUUID();
  await withPlatformPrisma(async (prisma) => {
    const owner = await prisma.user.findFirstOrThrow({
      where: { email: customer.email },
      select: { id: true },
    });
    const role = await prisma.role.findFirstOrThrow({
      where: { key: 'workspace_owner', workspaceId: null },
      select: { id: true },
    });
    await prisma.workspace.create({
      data: {
        id: workspaceId,
        workspaceId,
        slug,
        name: `E2E ${label} ${slug.slice(-8)}`,
        ownerUserId: owner.id,
        status: 'ACTIVE',
        country: 'US',
        defaultLocale: 'EN',
        timezone,
        currency: 'USD',
      },
    });
    await prisma.membership.create({
      data: {
        workspaceId,
        userId: owner.id,
        roleId: role.id,
        status: 'ACTIVE',
        acceptedAt: new Date(),
      },
    });
    await prisma.brand.create({
      data: {
        id: brandId,
        workspaceId,
        slug: `${slug}-brand`,
        name: `${label} Brand`,
        status: 'ACTIVE',
      },
    });
  });
  return { slug, brandId, workspaceId };
}

async function enter(page: Page, slug: string, locale = 'en'): Promise<void> {
  await signIn(page, locale);
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/workspaces`);
  await page.click(`[data-testid="choose-workspace-${slug}"]`);
  await page.waitForURL(new RegExp(`/${locale}/overview$`));
}

async function noSeriousViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = results.violations.filter((v) =>
    ['serious', 'critical'].includes(v.impact ?? ''),
  );
  expect(blocking.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

test.describe('Item 1 · Settings → AI "Use Brand Brain" (D9)', () => {
  for (const locale of ['en', 'ar'] as const) {
    test(`the switch saves and reads back, by keyboard, in ${locale}`, async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
      const { slug, brandId } = await ownWorkspace(`bb-switch-${locale}`);
      await enter(page, slug, locale);

      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/settings/ai`);
      await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
      const toggle = page.getByTestId(`ai-use-brand-brain-${brandId}`);
      await expect(toggle).toBeChecked();
      await noSeriousViolations(page);

      await toggle.focus();
      await page.keyboard.press('Space');
      await expect(toggle).not.toBeChecked();
      await page.getByTestId(`ai-save-${brandId}`).click();
      await page.waitForURL(/ok=SETTINGS_SAVED/);
      await expect(page.getByTestId(`ai-use-brand-brain-${brandId}`)).not.toBeChecked();

      const stored = await withPlatformPrisma((prisma) =>
        prisma.brand.findUniqueOrThrow({
          where: { id: brandId },
          select: { useBrandBrain: true },
        }),
      );
      expect(stored.useBrandBrain).toBe(false);
    });
  }
});
