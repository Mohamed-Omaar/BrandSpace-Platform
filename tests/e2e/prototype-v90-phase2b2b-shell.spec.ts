import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { enter, ownWorkspace, signIn, type OwnWorkspace } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';

/**
 * Prototype v90, Phase 2B-2b (PR B) — the shell (C8), motion (§8) and the
 * calendar drag (§8.2), as a person meets them in a real browser.
 *
 * Tests that seed data create their own workspace and run once, on the desktop
 * project; the touch tests run on the mobile project, which is a real
 * touch-capable device context.
 */

/** A READY, clean file in `ws`, as the worker would have left it. */
async function seedAsset(ws: OwnWorkspace, name: string): Promise<string> {
  const id = randomUUID();
  await withPlatformPrisma((prisma) =>
    prisma.asset.create({
      data: {
        id,
        workspaceId: ws.workspaceId,
        brandId: ws.brandId,
        name,
        kind: 'DOCUMENT',
        mimeType: 'application/pdf',
        sizeBytes: 1_024,
        storageKey: `e2e/${randomUUID()}`,
        checksumSha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
        status: 'READY',
        scanStatus: 'CLEAN',
        source: 'UPLOAD',
        uploadedByUserId: ws.ownerId,
      } as never,
    }),
  );
  return id;
}

test.describe('C8 · one overlay stack', () => {
  test('a dialog asked from a sheet stacks on it: Escape closes the dialog only, then the sheet', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const ws = await ownWorkspace('overlay');
    const assetId = await seedAsset(ws, 'Stacked overlays.pdf');
    await enter(page, ws.slug);
    await page.goto(`${DASHBOARD_BASE_URL}/en/assets?asset=${assetId}`);

    const sheet = page.getByTestId('asset-detail');
    await expect(sheet).toBeVisible();
    const remove = sheet.getByTestId('asset-delete');
    await remove.click();
    const dialog = page.getByTestId('assets-delete-dialog');
    await expect(dialog).toBeVisible();
    await expect(sheet).toBeVisible();

    // The live bug: one Escape used to close BOTH, the sheet underneath included.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(sheet).toBeVisible();
    // Focus goes back to what opened the dialog, inside the sheet.
    await expect(remove).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(page).not.toHaveURL(/asset=/);
  });

  test('opened from outside, an overlay closes the one already open', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    const create = page.getByTestId('topbar-create');
    await create.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('topbar-create-menu')).toBeVisible();

    // A keyboard user leaves the menu for the bell — no pointer, so nothing
    // "outside" was clicked. The stack closes the menu when the sheet opens.
    // The trigger's test id is on a `display: contents` wrapper; the bell
    // itself is the link inside it.
    const bell = page.getByTestId('notifications-bell-trigger').locator('a').first();
    await bell.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('notifications-feed')).toBeVisible();
    await expect(page.getByTestId('topbar-create-menu')).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('notifications-feed')).toHaveCount(0);
    await expect(bell).toBeFocused();
  });

  test('a menu opened inside a sheet stacks, and Escape closes the menu first', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile !== true, 'the navigation drawer is the phone shell');
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    await page.getByTestId('open-navigation').click();
    const drawer = page.getByTestId('navigation-drawer');
    await expect(drawer).toBeVisible();
    const trigger = drawer.getByTestId('brand-switcher');
    await trigger.click();
    await expect(drawer.getByTestId('brand-switcher-menu')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(drawer.getByTestId('brand-switcher-menu')).toHaveCount(0);
    await expect(drawer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
  });
});
