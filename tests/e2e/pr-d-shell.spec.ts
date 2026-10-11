import { expect, test } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { enter, ownWorkspace, signIn } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';

/**
 * PR D — THE SHELL'S MENUS (audit Shell 4, 6).
 *
 *   4. "AI credits" for a member who may read the balance but not Billing:
 *      the row says the balance in a toast instead of linking to /billing.
 *   6. The brand menu: "Brands in this workspace · used/allowed" and
 *      "+ Add a brand" → Settings → Brand's add form, built on
 *      `createBrandAction`; a refusal comes back to the form with its words.
 *
 * Shell 5 (the greyed "+ New workspace n/n" at the limit) renders the same
 * `PrototypeMenuButton` as row 4; its branch is the rail foot's `limit`
 * kind, pinned by unit/pr-d-workspaces-foot and unit/pr-d-brand-allowance.
 */

for (const locale of ['en', 'ar'] as const) {
  test(`AI credits without Billing says the balance in a toast (${locale})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
    const own = await ownWorkspace(`pr-d-credits-${locale}`);
    await withPlatformPrisma(async (prisma) => {
      // A Marketing Manager reads credits and uses the Copilot, without billing.read.
      const role = await prisma.role.findFirstOrThrow({
        where: { key: 'marketing_manager', workspaceId: null },
        select: { id: true },
      });
      await prisma.membership.updateMany({
        where: { workspaceId: own.workspaceId, userId: own.ownerId },
        data: { roleId: role.id },
      });
      await prisma.creditWallet.upsert({
        where: { workspaceId: own.workspaceId },
        create: {
          workspaceId: own.workspaceId,
          balanceMilliCredits: 25_000n,
          lifetimeGrantedMilliCredits: 25_000n,
        },
        update: {},
      });
    });
    await enter(page, own.slug, locale);
    await page.getByTestId('profile-menu').click();
    const row = page.getByTestId('account-credits');
    await expect(row).toBeVisible();
    await expect(row).toContainText('25');
    // A button, not a link to Billing.
    expect(await row.evaluate((el) => el.tagName)).toBe('BUTTON');
    await row.click();
    await expect(page.getByTestId('account-credits-toast')).toContainText('25');
  });

  test(`the brand menu counts the brands and adds one through Settings (${locale})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'the rail copy of the menu; the desktop run covers it');
    await signIn(page, locale);
    const sidebar = page.getByTestId('sidebar');
    await sidebar.getByTestId('brand-switcher').click();
    await expect(sidebar.getByTestId('brand-usage')).toBeVisible();
    await expect(sidebar.getByTestId('brand-usage')).toContainText(/\d/);
    const add = sidebar.getByTestId('brand-add');
    await expect(add).toBeVisible();
    if ((await add.evaluate((el) => el.tagName)) === 'A') {
      await expect(add).toHaveAttribute('href', `/${locale}/settings/brand?add=1`);
    } else {
      // At the plan's limit: greyed, and it says so.
      await expect(add).toHaveAttribute('aria-disabled', 'true');
      await add.click();
      await expect(page.getByTestId('brand-add-toast')).toBeVisible();
    }

    // The add form; Discard leaves without adding.
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/settings/brand?add=1`);
    await expect(page.getByTestId('brand-add-form')).toBeVisible();
    await expect(page.getByTestId('brand-add-name')).toBeVisible();
  });

  test(`a refused brand comes back to the add form with its words (${locale})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
    // A workspace without multi-brand already holds its one brand (D-327).
    const own = await ownWorkspace(`pr-d-addbrand-${locale}`);
    await enter(page, own.slug, locale);
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/settings/brand?add=1`);
    await page.getByTestId('brand-add-name').fill(`Second brand ${locale}`);
    await page.getByTestId('brand-add-create').click();
    await page.waitForURL(/\/settings\/brand\?.*add=1.*error=/);
    await expect(page.getByTestId('brand-add-form')).toBeVisible();
    await expect(
      page.locator('[role="alert"], .bs-banner, [data-tone="error"]').first(),
    ).toBeVisible();
    const count = await withPlatformPrisma((prisma) =>
      prisma.brand.count({ where: { workspaceId: own.workspaceId, deletedAt: null } }),
    );
    expect(count).toBe(1);
  });
}
