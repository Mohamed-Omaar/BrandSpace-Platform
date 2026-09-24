import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { withPlatformPrisma } from './platform-prisma';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

/**
 * PHASE 6 FINAL · D-277 §30, D-286, D-287 — THE ASSET LIBRARY.
 *
 * Views that filter real columns, a detail drawer with "Used in" from real
 * references and "Use in a post", licence and rights editing whose expiry the
 * composer then honours, and bulk tagging through the single-file service.
 * Each test creates what it needs.
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

async function libraryAsset(name: string, source: 'UPLOAD' | 'AI_GENERATED' = 'UPLOAD') {
  const loaded = credentials();
  return withPlatformPrisma(
    async (prisma) =>
      (
        await prisma.asset.create({
          data: {
            workspaceId: loaded.customer.workspaceId,
            brandId: brandFixtures(loaded).primaryBrandId,
            name,
            kind: 'IMAGE',
            mimeType: 'image/png',
            sizeBytes: 4_096,
            width: 1080,
            height: 1080,
            storageKey: `e2e/p6a/${randomUUID()}`,
            checksumSha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
            status: 'READY',
            scanStatus: 'CLEAN',
            source,
          },
          select: { id: true },
        })
      ).id,
  );
}

async function postUsing(assetId: string, title: string): Promise<string> {
  const loaded = credentials();
  const brandId = brandFixtures(loaded).primaryBrandId;
  return withPlatformPrisma(async (prisma) => {
    const item = await prisma.contentItem.create({
      data: {
        workspaceId: loaded.customer.workspaceId,
        brandId,
        title,
        status: 'DRAFT',
        primaryLocale: 'EN',
      },
      select: { id: true },
    });
    await prisma.contentVariant.create({
      data: {
        workspaceId: loaded.customer.workspaceId,
        brandId,
        contentItemId: item.id,
        platformKey: 'instagram',
        locale: 'EN',
        body: 'Uses a picture.',
        assetIds: [assetId],
      },
    });
    return item.id;
  });
}

const assets = (locale: string, query = '') => `${DASHBOARD_BASE_URL}/${locale}/assets${query}`;

test.describe('D-287 · the Asset Library', () => {
  test('the AI generated view shows only what the AI made', async ({ page }) => {
    const tag = randomUUID().slice(0, 6);
    const made = await libraryAsset(`ai-made-${tag}.png`, 'AI_GENERATED');
    await signIn(page);
    await page.goto(assets('en'));
    await page.getByTestId('assets-views').getByRole('link', { name: 'AI generated' }).click();
    await page.waitForURL((url) => url.searchParams.get('view') === 'ai');
    await expect(page.getByTestId(`asset-tile-${made}`)).toBeVisible();
    await expect(page.getByTestId(`asset-badges-${made}`)).toContainText('AI generated');
    const badges = page.locator('[data-testid^="asset-badges-"]');
    for (const text of await badges.allInnerTexts()) expect(text).toContain('AI generated');
  });

  test('the detail drawer shows where a file is used, and offers it for a new post', async ({
    page,
  }) => {
    const tag = randomUUID().slice(0, 6);
    const picture = await libraryAsset(`used-${tag}.png`);
    const title = `Uses ${tag}`;
    const itemId = await postUsing(picture, title);
    await signIn(page);
    await page.goto(assets('en', `?asset=${picture}`));
    const drawer = page.getByTestId('asset-detail');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByTestId(`asset-use-${itemId}`)).toContainText(title);
    await expect(drawer.getByTestId('asset-use-in-post')).toHaveAttribute(
      'href',
      new RegExp(`asset=${picture}`),
    );
    await drawer.getByTestId('asset-detail-close').click();
    await page.waitForURL((url) => !url.searchParams.has('asset'));
  });

  test('a lapsed licence is marked, and the composer stops offering the file', async ({ page }) => {
    const tag = randomUUID().slice(0, 6);
    const picture = await libraryAsset(`licensed-${tag}.png`);
    await signIn(page);
    await page.goto(assets('en', `?asset=${picture}`));
    await page.getByTestId('asset-license-input').fill('Stock licence 4411');
    await page.getByTestId('asset-rights-input').fill('2020-01-31');
    await page.getByTestId('asset-save').click();
    await page.waitForURL((url) => url.searchParams.get('ok') === 'ASSET_UPDATED');
    await expect(page.getByTestId('asset-rights-expired')).toBeVisible();

    const stored = await withPlatformPrisma((prisma) =>
      prisma.asset.findUniqueOrThrow({
        where: { id: picture },
        select: { license: true, rightsExpiryAt: true },
      }),
    );
    expect(stored.license).toBe('Stock licence 4411');
    expect(stored.rightsExpiryAt?.toISOString()).toBe('2020-01-31T23:59:59.999Z');

    // The composer's library no longer offers it.
    const itemId = await postUsing(picture, `Lapsed ${tag}`);
    await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?item=${itemId}`);
    await expect(page.getByTestId('editor-issues-instagram')).toContainText('licence has ended');
    await page.getByTestId('content-media-instagram-add').click();
    await expect(page.getByTestId(`media-choose-${picture}`)).toHaveCount(0);
  });

  test('bulk tagging goes through the same service as one file', async ({ page }) => {
    const tag = randomUUID().slice(0, 6);
    const one = await libraryAsset(`bulk-a-${tag}.png`);
    const two = await libraryAsset(`bulk-b-${tag}.png`);
    await signIn(page);
    await page.goto(assets('en', `?q=bulk-&view=images`));
    await page.getByTestId(`asset-select-${one}`).check();
    await page.getByTestId(`asset-select-${two}`).check();
    await page.getByTestId('assets-bulk-operation').selectOption('tag');
    await page.getByTestId('assets-bulk-tag').fill(`campaign-${tag}`);
    await page.getByTestId('assets-bulk-apply').click();
    await page.waitForURL((url) => url.searchParams.get('ok') === 'ASSETS_BULK_DONE');
    const rows = await withPlatformPrisma((prisma) =>
      prisma.asset.findMany({ where: { id: { in: [one, two] } }, select: { tags: true } }),
    );
    for (const row of rows) expect(row.tags).toContain(`campaign-${tag}`);
  });

  test('the brand kit is a view over the Brand Profile and the library', async ({ page }) => {
    const loaded = credentials();
    const suffix = randomUUID().slice(0, 6);
    const brandId = await withPlatformPrisma(
      async (prisma) =>
        (
          await prisma.brand.create({
            data: {
              workspaceId: loaded.customer.workspaceId,
              name: `Kit ${suffix}`,
              slug: `kit-${suffix}`,
              status: 'ACTIVE',
              defaultLocale: 'EN',
              supportedLocales: ['EN'],
              colorPalette: ['#7935FE', '#FFDD15'],
              typography: { heading: 'Kit Heading Sans', body: 'Kit Body Serif' },
            },
            select: { id: true },
          })
        ).id,
    );
    await signIn(page);
    await useBrand(page, loaded.customer.workspaceId, brandId);
    await page.goto(assets('en'));
    const kit = page.getByTestId('assets-brand-kit');
    await expect(kit).toContainText(`Kit ${suffix} brand kit`);
    await expect(kit.getByTestId('assets-kit-palette')).toContainText('#7935FE');
    await expect(kit.getByTestId('assets-kit-fonts')).toContainText('Kit Heading Sans');
  });

  test('the library and its drawer are clean under axe in Arabic', async ({ page }) => {
    const picture = await libraryAsset(`axe-${randomUUID().slice(0, 6)}.png`);
    await signIn(page, 'ar');
    await page.goto(assets('ar', `?asset=${picture}`));
    await expect(page.getByTestId('asset-detail')).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations)).toEqual([]);
  });
});
