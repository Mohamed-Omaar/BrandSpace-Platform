import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { enter, ownWorkspace, type OwnWorkspace } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';

/**
 * FINAL REVIEW (owner, item 2) — A FORM'S REDIRECT IS A PAGE CHANGE THE RAIL
 * HOST TAKES OVER AT.
 *
 * D-502: a loaded page keeps the rail in the server's HTML until the visit's
 * first page change, where the layout's host takes it over; from then on every
 * page change keeps that one rail (the same `nav`, the same pill, gliding). The
 * gap: a form whose action redirects to another page (Duplicate on Posts opens
 * the copy in the Studio) was not a hand-over, so the next page drew its own
 * rail and the host was still not holding it — the hand-over, and its one
 * replacement of the rail, waited for the NEXT page change.
 *
 * The host now takes over when a form in the page is submitted. Measured the
 * way `pr-d-rail-persists` measures a hand-over that has happened: after the
 * redirect, a rail press to another page keeps the same `nav`. The control
 * case shows the check can fail: on a freshly loaded page, with no page change
 * yet, the first rail press IS the hand-over and the `nav` is replaced.
 */

async function draftPost(own: OwnWorkspace): Promise<string> {
  return withPlatformPrisma(async (prisma) => {
    const item = await prisma.contentItem.create({
      data: {
        workspaceId: own.workspaceId,
        brandId: own.brandId,
        title: 'Copy me',
        status: 'DRAFT',
        primaryLocale: 'EN',
        contentType: 'POST',
        createdByUserId: own.ownerId,
      },
      select: { id: true },
    });
    await prisma.contentVariant.create({
      data: {
        workspaceId: own.workspaceId,
        brandId: own.brandId,
        contentItemId: item.id,
        platformKey: 'instagram',
        locale: 'EN',
        body: 'Words to copy',
      },
    });
    return item.id;
  });
}

const hydrated = (page: Page, selector: string) =>
  expect
    .poll(() =>
      page
        .locator(selector)
        .first()
        .evaluate((node) => Object.keys(node).some((key) => key.startsWith('__react'))),
    )
    .toBe(true);

/** Marks the rail's `nav`, presses Home on the rail, and says whether it is the same element. */
async function railKeptOnPress(page: Page, locale: string): Promise<boolean> {
  await page.evaluate(() => {
    (window as unknown as { __railNav: Element | null }).__railNav = document.querySelector(
      '[data-testid="sidebar"] nav',
    );
  });
  await page.getByTestId('sidebar').getByTestId('nav-overview').click();
  await page.waitForURL(new RegExp(`/${locale}/overview$`));
  await expect(page.getByTestId('sidebar').locator('[aria-current="page"]')).toHaveAttribute(
    'data-testid',
    'nav-overview',
  );
  return page.evaluate(() => {
    const marked = (window as unknown as { __railNav: Element | null }).__railNav;
    const nav = document.querySelector('[data-testid="sidebar"] nav');
    return marked !== null && nav === marked;
  });
}

for (const locale of ['en', 'ar'] as const) {
  test(`after Duplicate's redirect the host holds the rail: the next page keeps it (${locale})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'the phone layout is post-launch (D-468 (b))');
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1536, height: 864 });
    const own = await ownWorkspace(`rail-form-${locale}`);
    const itemId = await draftPost(own);
    await enter(page, own.slug, locale);

    // CONTROL — a fresh document, no page change yet: the first rail press is
    // the hand-over (D-502), so the `nav` is replaced and the check says so.
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/content?status=DRAFT`);
    await hydrated(page, '[data-testid="sidebar"] nav a');
    expect(
      await railKeptOnPress(page, locale),
      'control: a fresh page hands over on its press',
    ).toBe(false);

    // THE CASE — a fresh document again, and the first page change is a form's
    // redirect: Duplicate opens the copy in the Studio.
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/content?status=DRAFT`);
    const menu = page.getByTestId(`post-menu-${itemId}`);
    await expect(menu).toBeVisible();
    await hydrated(page, `[data-testid="post-menu-${itemId}"]`);
    await menu.click();
    await page.getByTestId(`content-duplicate-${itemId}`).click();
    await expect
      .poll(
        () => {
          const url = new URL(page.url());
          const opened = url.searchParams.get('item');
          return (
            url.pathname === `/${locale}/content/compose` && opened !== null && opened !== itemId
          );
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    await expect(page.getByTestId('sidebar')).toHaveCount(1);
    await hydrated(page, '[data-testid="sidebar"] nav a');

    expect(
      await railKeptOnPress(page, locale),
      'after the redirect the host already holds the rail, so the next page keeps it',
    ).toBe(true);
    await expect(page.getByTestId('sidebar')).toHaveCount(1);
  });
}
