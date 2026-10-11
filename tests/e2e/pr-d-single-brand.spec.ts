import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { enter, ownWorkspace, type OwnWorkspace } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';

/**
 * D-501 — THE BETA'S ONE BRAND, BY CONFIGURATION, AND A BRAND MENU THAT NEVER
 * OVERFLOWS.
 *
 *   - Allowed one brand and holding it: the rail shows the brand as a plain
 *     card — no brand menu, no "+ Add a brand", and no add form on
 *     Settings → Brands.
 *   - The Control Center raises the allowance (a workspace override, read on
 *     the next request): the brand menu and "+ Add a brand" are back, with no
 *     release.
 *   - With many brands the menu stays inside the frame: the brands scroll in
 *     it, the heading "Brands · used/allowed" is one line, and "+ Add a brand"
 *     stays in view.
 */

/** The Control Center's workspace override, as it writes one. */
async function override(own: OwnWorkspace, featureKey: string, limitValue: number | null) {
  await withPlatformPrisma(async (prisma) => {
    const owner = await prisma.platformUser.findFirstOrThrow({ select: { id: true } });
    await prisma.workspaceOverride.deleteMany({
      where: { workspaceId: own.workspaceId, featureKey },
    });
    await prisma.workspaceOverride.create({
      data: {
        workspaceId: own.workspaceId,
        featureKey,
        enabled: true,
        limitValue,
        reason: 'End-to-end fixture: the beta brand allowance (D-501).',
        grantedByPlatformUserId: owner.id,
      },
    });
  });
}

/** The open brand menu's geometry against the frame. */
async function menuBox(page: Page) {
  return page.evaluate(() => {
    const menu = document.querySelector<HTMLElement>('[data-testid="sidebar"] .bsp-bmenu');
    const frame = document.querySelector<HTMLElement>('.bs-shell.bsp-frame');
    const list = menu?.querySelector<HTMLElement>('[data-testid="brand-menu-list"]');
    const head = menu?.querySelector<HTMLElement>('.bsp-menu-head');
    const add = menu?.querySelector<HTMLElement>('[data-testid="brand-add"]');
    if (!menu || !frame || !list || !head || !add) return null;
    const m = menu.getBoundingClientRect();
    const f = frame.getBoundingClientRect();
    const a = add.getBoundingClientRect();
    const lineHeight = parseFloat(getComputedStyle(head).fontSize) * 1.6;
    return {
      insideFrame: m.bottom <= f.bottom + 0.5,
      scrolls: list.scrollHeight > list.clientHeight + 1,
      headOneLine: head.getBoundingClientRect().height <= lineHeight + 8,
      addInMenu: a.top >= m.top && a.bottom <= m.bottom + 0.5 && a.height > 0,
    };
  });
}

for (const locale of ['en', 'ar'] as const) {
  test(`allowed one brand: a plain card and nothing offers another; raised, the menu is back (${locale})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'the rail card is desktop; the phone layout is post-launch');
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1536, height: 864 });
    const own = await ownWorkspace(`pr-d-single-${locale}`);
    // Multi-brand on, so it is the allowance alone that keeps one brand.
    await override(own, 'feature.multi_brand', null);
    await override(own, 'limit.brands', 1);
    await enter(page, own.slug, locale);

    const rail = page.getByTestId('sidebar');
    await expect(rail.getByTestId('brand-card')).toBeVisible();
    await expect(rail.getByTestId('brand-switcher')).toHaveCount(0);
    await expect(rail.getByTestId('workspace-switcher')).toHaveCount(0);
    await expect(page.getByTestId('brand-add')).toHaveCount(0);
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/settings/brand?add=1`);
    await expect(page.getByTestId('settings-nav')).toBeVisible();
    await expect(page.getByTestId('brand-add-form')).toHaveCount(0);

    // The Control Center raises the allowance: no release, the next page has it.
    await override(own, 'limit.brands', 2);
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/overview`);
    const switcher = rail.getByTestId('brand-switcher');
    await expect(switcher).toBeVisible();
    await switcher.click();
    await expect(rail.getByTestId('brand-usage')).toContainText('1/2');
    await expect(rail.getByTestId('brand-add')).toHaveAttribute(
      'href',
      `/${locale}/settings/brand?add=1`,
    );
    const box = await menuBox(page);
    expect(box).not.toBeNull();
    expect(box!.insideFrame).toBe(true);
    expect(box!.headOneLine).toBe(true);
    expect(box!.addInMenu).toBe(true);
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/settings/brand?add=1`);
    await expect(page.getByTestId('brand-add-form')).toBeVisible();
  });

  test(`many brands: the menu stays in the frame and its list scrolls (${locale})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'the rail card is desktop; the phone layout is post-launch');
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1536, height: 864 });
    const own = await ownWorkspace(`pr-d-many-${locale}`);
    await override(own, 'feature.multi_brand', null);
    await override(own, 'limit.brands', 40);
    await withPlatformPrisma(async (prisma) => {
      for (let index = 1; index <= 24; index += 1) {
        await prisma.brand.create({
          data: {
            workspaceId: own.workspaceId,
            slug: `menu-${index}-${randomUUID().slice(0, 6)}`,
            name: `Brand ${String(index).padStart(2, '0')}`,
            status: 'ACTIVE',
            defaultLocale: 'EN',
            supportedLocales: ['EN', 'AR'],
          },
        });
      }
    });
    await enter(page, own.slug, locale);
    const rail = page.getByTestId('sidebar');
    await rail.getByTestId('brand-switcher').click();
    await expect(rail.getByTestId('brand-usage')).toContainText('25/40');
    const box = await menuBox(page);
    expect(box).not.toBeNull();
    expect(box!.insideFrame, 'the menu ends inside the frame').toBe(true);
    expect(box!.scrolls, 'the brands scroll inside the menu').toBe(true);
    expect(box!.headOneLine, '"Brands · used/allowed" is one line').toBe(true);
    expect(box!.addInMenu, '"+ Add a brand" stays in view').toBe(true);
    // The window itself does not scroll for it.
    expect(
      await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight),
    ).toBe(true);
  });
}
