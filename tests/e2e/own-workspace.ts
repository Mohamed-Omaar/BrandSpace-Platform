import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';
import { withPlatformPrisma } from './platform-prisma';

/**
 * A WORKSPACE OF ITS OWN for a test that seeds data (Phase 2B-2b): owned by the
 * e2e customer, with one ACTIVE brand, so nothing another suite reads moves.
 * Shared by the Phase 2B-2b specs; data is seeded through the platform client
 * and every assertion is made through the screen.
 */

function credentials(): E2eAdminCredentials {
  try {
    return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
  } catch {
    throw new Error('The end-to-end credentials file is missing. Run `pnpm e2e:seed` first.');
  }
}

export async function signIn(page: Page, locale = 'en'): Promise<void> {
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

export interface OwnWorkspace {
  readonly slug: string;
  readonly workspaceId: string;
  readonly brandId: string;
  readonly ownerId: string;
}

/** A workspace of its own, owned by the e2e customer, with one ACTIVE brand. */
export async function ownWorkspace(label: string): Promise<OwnWorkspace> {
  const { customer } = credentials();
  const slug = `e2e-${label}-${randomUUID().slice(0, 8)}`;
  const brandId = randomUUID();
  const workspaceId = randomUUID();
  let ownerId = '';
  await withPlatformPrisma(async (prisma) => {
    const owner = await prisma.user.findFirstOrThrow({
      where: { email: customer.email },
      select: { id: true },
    });
    ownerId = owner.id;
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
        timezone: 'UTC',
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
  return { slug, workspaceId, brandId, ownerId };
}

export async function enter(page: Page, slug: string, locale = 'en'): Promise<void> {
  await signIn(page, locale);
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/workspaces`);
  await page.click(`[data-testid="choose-workspace-${slug}"]`);
  await page.waitForURL(new RegExp(`/${locale}/overview$`));
}

export async function noSeriousViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = results.violations.filter((v) =>
    ['serious', 'critical'].includes(v.impact ?? ''),
  );
  expect(blocking.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}
