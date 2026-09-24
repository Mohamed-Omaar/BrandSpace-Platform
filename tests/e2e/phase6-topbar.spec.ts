import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { withPlatformPrisma } from './platform-prisma';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';
import { inlineEndOverhang } from './overflow';

/**
 * PHASE 6 · P6-16 — THE CUSTOMER TOP BAR REACHES REAL DOMAINS.
 *
 * Review · Notes · Notifications · Copilot · Create — every control proven to
 * land on the screen that owns the capability, each dot proven against the
 * number that screen itself shows, and no preview placeholder or unconnected
 * search anywhere. Keyboard, focus, Arabic/RTL, phone width and axe are covered
 * here because the top bar is on every page.
 *
 * READ-ONLY. Both viewport projects run it in parallel against the seeded
 * workspace; it navigates, opens menus and dialogs, and submits nothing.
 */

function credentials(): E2eAdminCredentials {
  return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
}

type Account = 'owner' | 'viewer' | 'copywriter';

async function signIn(page: Page, account: Account = 'owner', locale = 'en'): Promise<void> {
  const loaded = credentials();
  const { customer } = loaded;
  const [email, password] =
    account === 'viewer'
      ? [customer.viewerEmail, customer.viewerPassword]
      : account === 'copywriter'
        ? [customer.copywriterEmail, customer.copywriterPassword]
        : [customer.email, customer.password];
  await useBrand(page, customer.workspaceId, brandFixtures(loaded).primaryBrandId);
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/sign-in`);
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL(
    (url) => !url.pathname.endsWith('/sign-in') || url.searchParams.has('error'),
  );
  await page.click(`[data-testid="choose-workspace-${customer.workspaceSlug}"]`);
  await page.waitForURL(new RegExp(`/${locale}/overview$`));
}

const topbar = (page: Page) => page.locator('header.bs-topbar');

/** The number of the last run of digits in a string, or 0. */
function lastNumber(text: string | null): number {
  const matches = (text ?? '').match(/\d+/g);
  return matches ? Number(matches[matches.length - 1]) : 0;
}

test.describe('P6-16 · the customer top bar', () => {
  test('carries Review, Notes, Notifications, Copilot and Create — and no placeholder', async ({
    page,
  }) => {
    await signIn(page);
    const bar = topbar(page);
    const order = await bar
      .locator('[data-testid^="topbar-"]:not([data-testid$="-dot"])')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')));
    expect(order).toEqual([
      'topbar-review',
      'topbar-notes',
      'topbar-notifications',
      'topbar-copilot',
      'topbar-create',
    ]);
    await expect(page.getByTestId('topbar-search')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('Not connected yet');
    await expect(page.locator('body')).not.toContainText('has not shipped');
    await expect(page.getByTestId('topbar-search-panel')).toHaveCount(0);
  });

  test('Review, Notes and Notifications land on their real screens', async ({ page }) => {
    await signIn(page);
    await page.getByTestId('topbar-review').click();
    await page.waitForURL(/\/en\/approvals$/);
    await expect(page.getByTestId('heading')).toHaveText('Approvals');
    await expect(page.getByTestId('topbar-review')).toHaveAttribute('aria-current', 'page');

    await page.getByTestId('topbar-notes').click();
    await page.waitForURL(/\/en\/notes$/);
    await expect(page.getByTestId('notes-for-you')).toBeVisible();
    await expect(page.getByTestId('notes-open')).toBeVisible();

    // D-297 — the bell is still the link to the full screen (no-script path)…
    await expect(page.getByTestId('topbar-notifications')).toHaveAttribute(
      'href',
      '/en/notifications',
    );
    // …and a plain click opens the feed over the screen, with "See all" to it.
    await page.getByTestId('topbar-notifications').click();
    const feed = page.getByTestId('notifications-feed');
    await expect(feed).toBeVisible();
    await expect(feed.getByTestId('notifications-tab-mention')).toBeVisible();
    await feed.getByTestId('notifications-see-all').click();
    await page.waitForURL(/\/en\/notifications$/);
    await expect(page.getByTestId('notifications')).toBeVisible();
  });

  /*
   * PHASE 6 FINAL (D-277 §37): THE COPILOT OPENS OVER THE SCREEN.
   *
   * The control is still a link to the full Copilot for this surface — the
   * no-script path and a modified click follow it — and a plain click opens
   * the drawer where the reader already is, saying which brand it acts on and
   * which screen it was opened from.
   */
  test('Copilot opens over the screen, with that screen as its context', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/analytics`);
    const control = page.getByTestId('topbar-copilot');
    await expect(control).toHaveAttribute('href', '/en/copilot?from=analytics');

    await control.click();
    const drawer = page.getByTestId('copilot-drawer');
    await expect(drawer).toBeVisible();
    await expect(page).toHaveURL(/\/en\/analytics$/);
    await expect(drawer.getByTestId('copilot-context')).toContainText(/Acting on /);
    await expect(drawer.getByTestId('copilot-context')).toContainText(/opened from Analytics/);
    await expect(drawer.getByTestId('global-copilot-full')).toHaveAttribute(
      'href',
      '/en/copilot?from=analytics',
    );

    // A modal: Escape closes it and focus returns to the control that opened it.
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(control).toBeFocused();
  });

  test('on a campaign, the Copilot knows which campaign', async ({ page }) => {
    const loaded = credentials();
    const campaign = await withPlatformPrisma((prisma) =>
      prisma.campaign.findFirst({
        where: {
          workspaceId: loaded.customer.workspaceId,
          brandId: brandFixtures(loaded).primaryBrandId,
          deletedAt: null,
        },
        select: { id: true, name: true },
      }),
    );
    test.skip(!campaign, 'the seeded brand has no campaign');
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/campaigns/${campaign?.id}`);
    await page.getByTestId('topbar-copilot').click();
    const context = page.getByTestId('copilot-drawer').getByTestId('copilot-context');
    await expect(context).toContainText(`looking at “${campaign?.name}”`);
  });

  test('the full Copilot screen is still one click away', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/copilot?from=analytics`);
    await expect(page.getByTestId('topbar-copilot')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('copilot-context')).toContainText(/opened from Analytics/);
  });

  test('the notifications dot is the unread count the inbox shows', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/notifications`);
    const unread = lastNumber(await page.getByTestId('notifications-unread-count').textContent());
    const bell = page.getByTestId('topbar-notifications');
    if (unread > 0) {
      await expect(page.getByTestId('topbar-notifications-dot')).toBeVisible();
      await expect(bell).toHaveAttribute('data-indicator', String(unread));
      await expect(bell).toHaveAttribute('aria-label', `Notifications, ${unread} unread`);
    } else {
      await expect(page.getByTestId('topbar-notifications-dot')).toHaveCount(0);
      await expect(bell).toHaveAttribute('aria-label', 'Notifications');
    }
  });

  test('the notes dot is the unread mentions the Notes screen lists', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/notes`);
    const listed = await page
      .locator('[data-testid^="notes-thread-"]')
      .evaluateAll((rows) =>
        rows.reduce((sum, row) => sum + Number(row.getAttribute('data-unread') ?? 0), 0),
      );
    const notes = page.getByTestId('topbar-notes');
    if (listed > 0) {
      await expect(notes).toHaveAttribute('data-indicator', String(listed));
    } else {
      await expect(page.getByTestId('topbar-notes-dot')).toHaveCount(0);
    }
  });

  test('Create is a keyboard menu of real creation flows', async ({ page }) => {
    await signIn(page);
    const create = page.getByTestId('topbar-create');
    await expect(create).toHaveAttribute('aria-haspopup', 'menu');
    await create.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByTestId('topbar-create-menu');
    await expect(menu).toBeVisible();
    await expect(create).toHaveAttribute('aria-expanded', 'true');
    const items = menu.getByRole('menuitem');
    await expect(items).toHaveText([
      'New content',
      'New campaign',
      'AI creative',
      'Upload to the library',
    ]);

    // Escape closes and returns focus to the trigger.
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(create).toBeFocused();

    // ArrowDown on the trigger opens the menu ON its first item (menu-button
    // pattern); arrows then move through the items, and wrap.
    await page.keyboard.press('ArrowDown');
    await expect(items.first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await expect(items.last()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(create).toBeFocused();

    await create.click();
    await page.getByTestId('topbar-create-content').click();
    await page.waitForURL(/\/en\/content\/compose$/);
    await expect(page.getByTestId('topbar-create-menu')).toHaveCount(0);

    await page.getByTestId('topbar-create').click();
    await page.getByTestId('topbar-create-campaign').click();
    await page.waitForURL(/\/en\/campaigns\/new$/);
  });

  test('"Upload to the library" opens the Asset Library’s own upload dialog', async ({ page }) => {
    await signIn(page);
    await page.getByTestId('topbar-create').click();
    await page.getByTestId('topbar-create-asset').click();
    await page.waitForURL(/\/en\/assets\?upload=1$/);
    await expect(page.getByTestId('assets-upload-dialog')).toBeVisible();
  });

  test('a read-only member is offered only their own notifications', async ({ page }) => {
    await signIn(page, 'viewer');
    for (const key of ['review', 'notes', 'copilot', 'create']) {
      await expect(page.getByTestId(`topbar-${key}`), key).toHaveCount(0);
    }
    await expect(page.getByTestId('topbar-notifications')).toBeVisible();
  });

  test('a copywriter can start only what a copywriter can create', async ({ page }) => {
    await signIn(page, 'copywriter');
    await page.getByTestId('topbar-create').click();
    await expect(page.getByTestId('topbar-create-menu').getByRole('menuitem')).toHaveText([
      'New content',
    ]);
  });

  test('in Arabic the bar is right-to-left, named in Arabic, and fits', async ({ page }) => {
    await signIn(page, 'owner', 'ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const names: Record<string, string> = {
      'topbar-review': 'المراجعة',
      'topbar-notes': 'الملاحظات',
      'topbar-copilot': 'المساعد',
    };
    for (const [testId, name] of Object.entries(names)) {
      await expect(page.getByTestId(testId)).toHaveAttribute('aria-label', new RegExp(`^${name}`));
    }
    await expect(page.getByTestId('topbar-notifications')).toHaveAttribute(
      'aria-label',
      /^الإشعارات/,
    );

    // RTL: Review sits to the RIGHT of Create, the mirror of English.
    const review = await page.getByTestId('topbar-review').boundingBox();
    const create = await page.getByTestId('topbar-create').boundingBox();
    expect(review!.x).toBeGreaterThan(create!.x);

    await page.getByTestId('topbar-create').click();
    await expect(page.getByTestId('topbar-create-menu').getByRole('menuitem').first()).toHaveText(
      'محتوى جديد',
    );
    const overhang = await inlineEndOverhang(page);
    expect(overhang.px, overhang.offender).toBe(0);
  });

  test('every action is a 24px-or-larger keyboard stop with a visible focus ring', async ({
    page,
  }) => {
    await signIn(page);
    // Reached the way a keyboard user reaches them — by Tab — because a
    // programmatic focus() does not raise `:focus-visible` on a link.
    const wanted = ['review', 'notes', 'notifications', 'copilot', 'create'].map(
      (key) => `topbar-${key}`,
    );
    const seen: string[] = [];
    for (let press = 0; press < 80 && seen.length < wanted.length; press += 1) {
      await page.keyboard.press('Tab');
      const probe = await page.evaluate(() => {
        const element = document.activeElement as HTMLElement | null;
        if (!element) return null;
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return {
          id: element.getAttribute('data-testid'),
          ring: `${style.outlineStyle}|${style.outlineWidth}|${style.boxShadow}`,
          width: box.width,
          height: box.height,
        };
      });
      if (!probe?.id || !wanted.includes(probe.id) || seen.includes(probe.id)) continue;
      seen.push(probe.id);
      expect(probe.ring, probe.id).not.toMatch(/^none\|0px\|none$/);
      expect(probe.width, probe.id).toBeGreaterThanOrEqual(24);
      expect(probe.height, probe.id).toBeGreaterThanOrEqual(24);
    }
    // In document order, which is the visual order in both directions.
    expect(seen).toEqual(wanted);
  });

  test('the bar, and its open menu, are clean under axe in both directions', async ({ page }) => {
    await signIn(page);
    for (const locale of ['en', 'ar']) {
      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/overview`);
      await page.getByTestId('topbar-create').click();
      await expect(page.getByTestId('topbar-create-menu')).toBeVisible();
      const results = await new AxeBuilder({ page })
        .include('header.bs-topbar')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(
        results.violations.map(
          (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
        ),
        locale,
      ).toEqual([]);
    }
  });
});
