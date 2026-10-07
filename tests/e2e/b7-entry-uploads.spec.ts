import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { createFreshWorkspace, freshSignUp } from './fresh-signup';
import { signIn } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';

/**
 * BATCH 7 (A2–A5, D-483) — THE ENTRY, THE UPLOADS AND THE TIME ZONES, AS THE
 * OWNER MET THEM ON A NEW ACCOUNT.
 *
 *   - A wizard logo said nothing when chosen, offered SVG the server refuses,
 *     and with a background scan was never attached at all.
 *   - Teach accepted an HTML page into the picker, stored it as failed, and
 *     said only "Could not read", run together with the other files.
 *   - "Everything has been reviewed" appeared before any file had been read.
 *   - The time-zone list offered ONE zone: opening it typed the chosen label
 *     into the search box. Each row printed the zone twice.
 *   - The window scrolled by 20 px on every app page, and the sign-up card and
 *     two wizard steps ran past a 1536×864 window.
 */

test.describe.configure({ mode: 'serial' });

// A 1×1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>', 'utf8');

async function windowScroll(page: Page): Promise<number> {
  return page.evaluate(() => {
    const element = document.scrollingElement ?? document.documentElement;
    return Math.max(0, element.scrollHeight - window.innerHeight);
  });
}

test.describe('a new customer through the wizard', () => {
  test('the logo: rules beside it, SVG refused in place, a PNG previewed with change and remove', async ({
    page,
  }) => {
    test.slow();
    await page.setViewportSize({ width: 1536, height: 864 });
    const email = await freshSignUp(page);
    await createFreshWorkspace(page);
    await expect(page.getByTestId('setup-wizard')).toHaveAttribute('data-view', 'brand');

    // BEFORE: the formats and the size, under the button; the picker is limited.
    const logo = page.getByTestId('setup-logo');
    await expect(logo.getByTestId('upload-rules')).toContainText('PNG');
    await expect(logo.getByTestId('upload-rules')).not.toContainText('SVG');
    const accept = await page.getByTestId('setup-logo-input').getAttribute('accept');
    expect(accept).toContain('image/png');
    expect(accept).not.toContain('svg');

    // A type the server would refuse is refused AT ONCE, in place, and not kept.
    await page.getByTestId('setup-logo-input').setInputFiles({
      name: 'logo.svg',
      mimeType: 'image/svg+xml',
      buffer: SVG,
    });
    await expect(page.getByTestId('setup-logo-status')).toBeVisible();
    await expect(page.getByTestId('setup-logo-status')).toHaveAttribute('data-tone', 'error');
    await expect(page.getByTestId('setup-logo-status')).toContainText('PNG');
    expect(
      await page
        .getByTestId('setup-logo-input')
        .evaluate((input) => (input as HTMLInputElement).files?.length ?? 0),
    ).toBe(0);

    // An admitted file shows itself at once, with its name, Change and Remove.
    await page.getByTestId('setup-logo-input').setInputFiles({
      name: 'cafe-logo.png',
      mimeType: 'image/png',
      buffer: PNG,
    });
    await expect(page.getByTestId('setup-logo-status')).toBeHidden();
    await expect(logo.locator('.bsp-wz-logo img')).toBeVisible();
    await expect(page.getByTestId('setup-logo-name')).toContainText('cafe-logo.png');
    await expect(page.getByTestId('setup-logo-remove')).toBeVisible();
    await page.getByTestId('setup-logo-remove').click();
    await expect(logo.locator('.bsp-wz-logo img')).toHaveCount(0);
    await expect(page.getByTestId('setup-logo-name')).toHaveCount(0);

    // Chosen again, it goes with Continue and becomes the brand's logo.
    await page.getByTestId('setup-logo-input').setInputFiles({
      name: 'cafe-logo.png',
      mimeType: 'image/png',
      buffer: PNG,
    });
    await page.fill('[data-testid="setup-brand-name"]', 'Batch Seven Cafe');
    await page.getByTestId('setup-create-brand').click();
    await page.waitForURL(/step=(learn|brand)/, { timeout: 30_000 });
    // Either attached already (scan finished within the wait), or the brand
    // step says it is being checked and attaches it when the scan passes.
    if (/step=brand/.test(page.url())) {
      await expect(page.getByTestId('setup-logo-state')).toHaveAttribute('data-state', 'checking');
    }
    await expect
      .poll(
        () =>
          withPlatformPrisma(async (prisma) => {
            const user = await prisma.user.findUniqueOrThrow({
              where: { email },
              select: { memberships: { select: { workspaceId: true }, take: 1 } },
            });
            const brand = await prisma.brand.findFirst({
              where: { workspaceId: user.memberships[0]?.workspaceId ?? '', deletedAt: null },
              select: { primaryLogoAssetId: true },
            });
            return brand?.primaryLogoAssetId ?? null;
          }),
        { timeout: 60_000, intervals: [1_000, 2_000] },
      )
      .not.toBeNull();
  });

  test('Teach: an HTML page is refused before upload; a file that cannot be read says why on its own row', async ({
    page,
  }) => {
    test.slow();
    await page.setViewportSize({ width: 1536, height: 864 });
    await freshSignUp(page);
    await createFreshWorkspace(page);
    await page.fill('[data-testid="setup-brand-name"]', 'Teach Cafe');
    await page.getByTestId('setup-create-brand').click();
    await page.waitForURL(/step=learn/, { timeout: 30_000 });

    // Nothing read yet: no "everything reviewed" line.
    await expect(page.getByTestId('setup-review-done')).toHaveCount(0);

    // The tile's second line is the configured rules.
    await expect(page.getByTestId('setup-upload-tile').getByTestId('upload-rules')).toContainText(
      'PDF',
    );

    // An HTML page never leaves the browser, and says what is accepted.
    await page.getByTestId('setup-upload-input').setInputFiles({
      name: 'our-website.html',
      mimeType: 'text/html',
      buffer: Buffer.from('<html><body>Our menu</body></html>', 'utf8'),
    });
    await expect(page.getByTestId('setup-upload-status')).toBeVisible();
    await expect(page.getByTestId('setup-upload-status')).toHaveAttribute('data-tone', 'error');
    await expect(page).toHaveURL(/step=learn/);
    await expect(page.locator('[data-testid^="setup-source-"]')).toHaveCount(0);

    // A PDF that is not a PDF reaches the server, which refuses or fails it:
    // the reason is written on the file's own row.
    await page.getByTestId('setup-upload-input').setInputFiles({
      name: 'broken-menu.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('this is not a pdf at all', 'utf8'),
    });
    const row = page
      .getByTestId('setup-sources')
      .locator('li')
      .filter({ hasText: 'broken-menu.pdf' });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(async () => {
      await page.reload();
      await expect(row.getByTestId('setup-source-reason')).toBeVisible();
    }).toPass({ timeout: 60_000, intervals: [1_000, 2_000, 3_000] });
    expect(((await row.getByTestId('setup-source-reason').textContent()) ?? '').trim()).not.toBe(
      '',
    );
    // Only a failed file: still nothing read, and the page says so.
    await expect(page.getByTestId('setup-review-done')).toHaveCount(0);
    await expect(page.getByTestId('setup-none-read')).toBeVisible();
  });
});

test.describe('the time-zone list', () => {
  test('opening it offers every zone, scrolled to the chosen one; each row names its zone once', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1536, height: 864 });
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings`);
    const select = page.getByTestId('settings-timezone');
    await select.click();
    const list = page.getByRole('listbox');
    await expect(list).toBeVisible();
    expect(await list.getByRole('option').count()).toBeGreaterThan(300);
    // The chosen zone is in view.
    const chosen = list.locator('[aria-selected="true"]');
    if ((await chosen.count()) > 0) await expect(chosen).toBeInViewport();
    // Riyadh: the city, then its offset, and no "Asia/Riyadh".
    const riyadh = list.getByRole('option', { name: /^Riyadh/ }).first();
    await expect(riyadh).toContainText('UTC+03:00');
    await expect(riyadh).not.toContainText('Asia/Riyadh');
    // Typing filters, by city or by identifier.
    await select.fill('Asia/Riyadh');
    await expect(list.getByRole('option')).toHaveCount(1);
  });
});

test.describe('the browser window never scrolls (768 px and wider)', () => {
  for (const viewport of [
    { width: 1536, height: 864 },
    { width: 1920, height: 1080 },
  ]) {
    test(`at ${viewport.width}×${viewport.height}: entry screens and every app page`, async ({
      page,
    }) => {
      test.slow();
      await page.setViewportSize(viewport);
      const offenders: string[] = [];
      for (const locale of ['en', 'ar']) {
        for (const path of ['/sign-in', '/sign-up']) {
          await page.goto(`${DASHBOARD_BASE_URL}/${locale}${path}`);
          const scroll = await windowScroll(page);
          if (scroll > 0) offenders.push(`${locale}${path}: ${scroll}px`);
        }
      }
      await signIn(page);
      for (const locale of ['en', 'ar']) {
        for (const path of [
          '/overview',
          '/content',
          '/content/compose?mode=write',
          '/calendar',
          '/approvals',
          '/campaigns',
          '/assets',
          '/brand-brain',
          '/analytics',
          '/automations',
          '/members',
          '/settings',
          '/billing',
          '/integrations',
          '/workspaces',
        ]) {
          await page.goto(`${DASHBOARD_BASE_URL}/${locale}${path}`);
          await page.waitForLoadState('networkidle');
          const scroll = await windowScroll(page);
          if (scroll > 0) offenders.push(`${locale}${path}: ${scroll}px`);
        }
      }
      expect(offenders).toEqual([]);
    });
  }
});
