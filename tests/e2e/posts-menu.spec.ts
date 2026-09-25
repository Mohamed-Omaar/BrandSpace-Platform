import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { withPlatformPrisma } from './platform-prisma';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

/**
 * B8 — the Posts "…" menu in the Content library, driven as a person drives it:
 * opened from the keyboard, archive in two steps, restore, and filing a post
 * under a campaign. Each test makes its own draft and soft-deletes it after.
 */

function credentials(): E2eAdminCredentials {
  try {
    return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
  } catch {
    throw new Error('The end-to-end credentials file is missing. Run `pnpm e2e:seed` first.');
  }
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

const created: string[] = [];
test.afterAll(async () => {
  if (created.length === 0) return;
  await withPlatformPrisma((prisma) =>
    prisma.contentItem.updateMany({
      where: { id: { in: created } },
      data: { deletedAt: new Date() },
    }),
  );
});

async function draft(): Promise<{ itemId: string; title: string }> {
  const loaded = credentials();
  const workspaceId = loaded.customer.workspaceId;
  const brandId = brandFixtures(loaded).primaryBrandId;
  const title = `Menu post ${randomUUID().slice(0, 6)}`;
  return withPlatformPrisma(async (prisma) => {
    const item = await prisma.contentItem.create({
      data: { workspaceId, brandId, title, status: 'DRAFT', primaryLocale: 'EN' },
      select: { id: true },
    });
    await prisma.contentVariant.create({
      data: {
        workspaceId,
        brandId,
        contentItemId: item.id,
        platformKey: 'instagram',
        locale: 'EN',
        body: `${title} words`,
      },
    });
    created.push(item.id);
    return { itemId: item.id, title };
  });
}

test.describe('B8 · the Posts menu', () => {
  test('opens from the keyboard and archives only after a second step, then restores', async ({
    page,
  }) => {
    const { itemId, title } = await draft();
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/content?q=${encodeURIComponent(title)}`);
    const trigger = page.getByTestId(`post-menu-${itemId}`);
    await trigger.focus();
    await page.keyboard.press('ArrowDown');
    // The first item a draft offers depends on whether its brand has campaigns;
    // whichever it is, focus lands inside the menu, not on the page.
    await expect(
      page.getByTestId(`post-menu-${itemId}-menu`).getByRole('menuitem').first(),
    ).toBeFocused();
    await expect(trigger).toHaveAccessibleName('Post actions');
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();

    await trigger.click();
    await page.getByTestId(`post-menu-archive-${itemId}`).click();
    const confirm = page.getByTestId(`post-archive-dialog-${itemId}`);
    await expect(confirm).toBeVisible();
    await Promise.all([
      page.waitForURL(/[?&]ok=SAVED/),
      confirm.getByTestId('confirm-accept').click(),
    ]);
    const archived = await withPlatformPrisma((prisma) =>
      prisma.contentItem.findUniqueOrThrow({ where: { id: itemId }, select: { status: true } }),
    );
    expect(archived.status).toBe('ARCHIVED');

    await page.goto(
      `${DASHBOARD_BASE_URL}/en/content?status=ARCHIVED&q=${encodeURIComponent(title)}`,
    );
    await page.getByTestId(`post-menu-${itemId}`).click();
    await Promise.all([
      page.waitForURL(/[?&]ok=SAVED/),
      page.getByTestId(`post-menu-restore-${itemId}`).click(),
    ]);
    const restored = await withPlatformPrisma((prisma) =>
      prisma.contentItem.findUniqueOrThrow({ where: { id: itemId }, select: { status: true } }),
    );
    expect(restored.status).toBe('DRAFT');
  });

  test('files a post that has no campaign under one (Q21)', async ({ page }) => {
    const { itemId, title } = await draft();
    const loaded = credentials();
    const campaign = await withPlatformPrisma((prisma) =>
      prisma.campaign.create({
        data: {
          workspaceId: loaded.customer.workspaceId,
          brandId: brandFixtures(loaded).primaryBrandId,
          name: `Menu campaign ${randomUUID().slice(0, 6)}`,
          objective: 'AWARENESS',
          status: 'ACTIVE',
        },
        select: { id: true },
      }),
    );
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/content?q=${encodeURIComponent(title)}`);
    await page.getByTestId(`post-menu-${itemId}`).click();
    await page.getByTestId(`post-menu-campaign-${itemId}`).click();
    await page.getByTestId(`post-campaign-select-${itemId}`).selectOption(campaign.id);
    await Promise.all([
      page.waitForURL(/[?&]ok=CAMPAIGN_LINKED/),
      page.getByTestId(`post-campaign-submit-${itemId}`).click(),
    ]);
    const filed = await withPlatformPrisma((prisma) =>
      prisma.contentItem.findUniqueOrThrow({ where: { id: itemId }, select: { campaignId: true } }),
    );
    expect(filed.campaignId).toBe(campaign.id);
  });
});
