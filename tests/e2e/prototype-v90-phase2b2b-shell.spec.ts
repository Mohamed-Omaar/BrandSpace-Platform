import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { statusMessage } from '../../apps/dashboard/src/i18n/messages';
import { toastDuration } from '../../packages/ui/src/toast-timing';
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

/** Toggle the brand's AI suggestions and save: a real action that redirects with `?ok=SETTINGS_SAVED`. */
async function saveAiSettings(page: Page, brandId: string): Promise<void> {
  await page.getByTestId(`ai-suggestions-${brandId}`).click();
  await page.getByTestId(`ai-save-${brandId}`).click();
}

test.describe('C8 · the toast host', () => {
  test.skip(
    ({ isMobile }) => isMobile === true,
    'one run creates its own workspace; the desktop run covers it',
  );

  test('a save says so in a toast, the URL loses ok=, and a refresh does not replay it', async ({
    page,
  }) => {
    const ws = await ownWorkspace('toast');
    await enter(page, ws.slug);
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings/ai`);
    await saveAiSettings(page, ws.brandId);

    const toast = page.getByTestId('toast');
    await expect(toast).toContainText(statusMessage('SETTINGS_SAVED', 'en')!);
    // The success banner it replaces is gone from the page.
    await expect(page.getByTestId('ai-settings')).toBeVisible();
    await expect(page).toHaveURL(/\/en\/settings\/ai$/);

    await page.reload();
    await expect(page.getByTestId('ai-settings')).toBeVisible();
    await expect(page.getByTestId('toast')).toHaveCount(0);
  });

  test('it stays its reading time, holds while hovered, and resumes with 2.2 s to go', async ({
    page,
  }) => {
    const ws = await ownWorkspace('toast-time');
    await enter(page, ws.slug);
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings/ai`);
    await saveAiSettings(page, ws.brandId);

    const toast = page.getByTestId('toast');
    const text = statusMessage('SETTINGS_SAVED', 'en')!;
    await expect(toast).toContainText(text);
    await expect(page.locator('[data-toast-duration]')).toHaveAttribute(
      'data-toast-duration',
      String(toastDuration(text)),
    );

    // Held: well past its own reading time, it is still there.
    await toast.hover();
    await page.waitForTimeout(toastDuration(text) + 1_000);
    await expect(toast).toBeVisible();

    // Released: it stays about 2.2 s more, then goes.
    const released = Date.now();
    await page.mouse.move(2, 2);
    await expect(toast).toBeHidden({ timeout: 6_000 });
    expect(Date.now() - released).toBeGreaterThanOrEqual(1_800);
  });

  test('dismiss closes it at once, and so does the next navigation', async ({ page }) => {
    const ws = await ownWorkspace('toast-close');
    await enter(page, ws.slug);
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings/ai`);

    await saveAiSettings(page, ws.brandId);
    await expect(page.getByTestId('toast')).toBeVisible();
    await page.getByTestId('toast-dismiss').click();
    await expect(page.getByTestId('toast')).toHaveCount(0);

    await saveAiSettings(page, ws.brandId);
    await expect(page.getByTestId('toast')).toBeVisible();
    // A client-side navigation, not a reload: the host itself stays mounted.
    await page.locator('a[href="/en/calendar"]').first().click();
    await page.waitForURL(/\/en\/calendar/);
    await expect(page.getByTestId('toast')).toHaveCount(0);
  });

  test('in Arabic the toast speaks Arabic', async ({ page }) => {
    const ws = await ownWorkspace('toast-ar');
    await enter(page, ws.slug, 'ar');
    await page.goto(`${DASHBOARD_BASE_URL}/ar/settings/ai`);
    await saveAiSettings(page, ws.brandId);
    await expect(page.getByTestId('toast')).toContainText(statusMessage('SETTINGS_SAVED', 'ar')!);
    await expect(page.getByTestId('toast-dismiss')).toHaveAttribute('aria-label', 'إغلاق الإشعار');
  });

  test('a page that still draws its own banner keeps ok= in its URL (not refactored here)', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/approvals?ok=SAVED`);
    await expect(page.getByText(statusMessage('SAVED', 'en')!).first()).toBeVisible();
    await expect(page).toHaveURL(/[?&]ok=SAVED/);
    await expect(page.getByTestId('toast')).toHaveCount(0);
  });
});
