import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { withPlatformPrisma } from './platform-prisma';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

/**
 * PHASE 6 FINAL ACCEPTANCE · D-305 — FOLDERS THAT LOOK AND BEHAVE LIKE FOLDERS.
 *
 * A folder made at the top of the library is a card there; opening it shows
 * where the reader is ("Media Library / <folder>"); a folder made from inside
 * it goes INSIDE it by default (the real `parentFolderId`), shows as a card
 * there and adds a level to the breadcrumb; the root is one click back. The
 * suite removes the folders it made. Names carry a per-run token, so the two
 * viewport projects never see each other's folders.
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

const RUN = randomUUID().slice(0, 8);

test.afterAll(async () => {
  await withPlatformPrisma(async (prisma) => {
    const folders = await prisma.assetFolder.findMany({
      where: { name: { contains: RUN } },
      select: { id: true, parentFolderId: true },
    });
    // Children first: a parent cannot go while it still holds a folder.
    const ordered = [...folders].sort(
      (a, b) => (a.parentFolderId ? 0 : 1) - (b.parentFolderId ? 0 : 1),
    );
    for (const folder of ordered) {
      await prisma.assetFolder.deleteMany({ where: { id: folder.id } });
    }
  });
});

async function newFolder(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'New folder' }).click();
  const dialog = page.getByTestId('assets-folder-dialog');
  await dialog.getByTestId('assets-folder-name').fill(name);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await page.waitForURL(/ok=ASSET_FOLDER_CREATED/);
}

test('a folder is a place: cards, a breadcrumb, and new folders made where you are', async ({
  page,
}, testInfo) => {
  const project = testInfo.project.name.includes('mobile') ? 'm' : 'd';
  const parent = `Campaigns ${project}-${RUN}`;
  const child = `National Day ${project}-${RUN}`;

  await signIn(page);
  await page.goto(`${DASHBOARD_BASE_URL}/en/assets`);

  // At the root the location says so.
  await expect(page.getByTestId('assets-breadcrumbs')).toContainText('Media Library');

  await newFolder(page, parent);
  const parentCard = page.getByTestId('assets-folders').getByRole('link', { name: parent });
  await expect(parentCard).toBeVisible();

  // Into the folder: the breadcrumb names the path, and the parent defaults.
  await parentCard.click();
  await page.waitForURL(/[?&]folder=/);
  await expect(page.getByTestId('assets-crumb-current')).toHaveText(parent);
  await page.getByRole('button', { name: 'New folder' }).click();
  const parentSelect = page.getByTestId('assets-folder-parent');
  await expect(parentSelect.locator('option:checked')).toHaveText(parent);
  await page.getByTestId('assets-folder-dialog').getByRole('button', { name: 'Cancel' }).click();

  await newFolder(page, child);
  // Back inside the parent, where the new folder now is.
  await expect(page.getByTestId('assets-crumb-current')).toHaveText(parent);
  const childCard = page.getByTestId('assets-folders').getByRole('link', { name: child });
  await expect(childCard).toBeVisible();

  await childCard.click();
  await expect(page.getByTestId('assets-crumb-current')).toHaveText(child);
  await expect(page.getByTestId('assets-breadcrumbs')).toContainText(
    new RegExp(`Media Library.*${parent}.*${child}`),
  );

  // The tree is real: the child's parent is the parent folder.
  const rows = await withPlatformPrisma((prisma) =>
    prisma.assetFolder.findMany({
      where: { name: { in: [parent, child] } },
      select: { id: true, name: true, parentFolderId: true },
    }),
  );
  const parentRow = rows.find((row) => row.name === parent);
  const childRow = rows.find((row) => row.name === child);
  expect(parentRow?.parentFolderId).toBeNull();
  expect(childRow?.parentFolderId).toBe(parentRow?.id);

  // One click back to the root.
  await page.getByTestId('assets-crumb-root').click();
  await expect(page.getByTestId('assets-crumb-current')).toHaveCount(0);
  await expect(
    page.getByTestId('assets-folders').getByRole('link', { name: parent }),
  ).toBeVisible();
});

test('several brands get one compact brand filter, never a chip per brand', async ({ page }) => {
  await signIn(page);
  await page.goto(`${DASHBOARD_BASE_URL}/en/assets`);
  // This workspace reaches several brands, so the ONE compact brand select is
  // offered — never a chip per brand.
  await expect(page.getByTestId('assets-brand-filter').locator('select')).toHaveCount(1);
  await expect(page.getByTestId('assets-filters').getByRole('link', { name: /Flow / })).toHaveCount(
    0,
  );
});
