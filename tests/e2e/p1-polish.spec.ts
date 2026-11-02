import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { withPlatformPrisma } from './platform-prisma';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

/**
 * P1 — THE STYLE POLISH BEFORE THE PERFORMANCE PR, in a real browser against
 * the real services, in English and Arabic, light and dark.
 *
 *   2. one colour-scheme rule, rendered by the server: no flip after load,
 *      each of the three settings, a reload keeps the choice, two tabs agree;
 *   3. the same rule on the screens before sign-in;
 *   5. the Add media drawer sized to its content, its actions clear of the
 *      field above them;
 *   6. waiting made visible: the image request, an upload's percentage, and a
 *      button that waits for the server.
 *
 * Item 1 (no strip under the Copilot button) is final-walk-copilot-clear.spec.ts,
 * on every screen and three sizes. The scheme is a cookie on this test's own
 * browser context, so nothing here reaches another suite.
 */

const SCHEME_COOKIE = 'bs_color_scheme';

function credentials(): E2eAdminCredentials {
  return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
}

async function withScheme(context: BrowserContext, scheme: string): Promise<void> {
  await context.addCookies([{ name: SCHEME_COOKIE, value: scheme, url: DASHBOARD_BASE_URL }]);
}

async function signIn(page: Page, locale: string): Promise<void> {
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

/** The relative luminance of the page's own surface, 0 (black) to 1 (white). */
async function surfaceLuminance(page: Page): Promise<number> {
  return page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--bs-surface)';
    document.body.append(probe);
    const [r, g, b] = (getComputedStyle(probe).color.match(/\d+(\.\d+)?/g) ?? ['0', '0', '0'])
      .slice(0, 3)
      .map((value) => Number(value) / 255);
    probe.remove();
    const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r ?? 0) + 0.7152 * lin(g ?? 0) + 0.0722 * lin(b ?? 0);
  });
}

const isDark = async (page: Page) => (await surfaceLuminance(page)) < 0.2;

test.describe('P1 · one rule for light, dark and device', () => {
  for (const locale of ['en', 'ar'] as const) {
    test(`each setting is drawn from the first paint, and nothing changes it after (${locale})`, async ({
      page,
      context,
    }) => {
      // Every change to the page's scheme after the first byte is recorded.
      await page.addInitScript(() => {
        const flips: string[] = [];
        (window as unknown as { __flips: string[] }).__flips = flips;
        new MutationObserver((records) => {
          for (const record of records) {
            if (record.attributeName === 'data-color-scheme') {
              flips.push(String(document.documentElement.dataset['colorScheme']));
            }
          }
        }).observe(document.documentElement, { attributes: true });
      });
      await signIn(page, locale);
      for (const scheme of ['light', 'dark', 'system'] as const) {
        await withScheme(context, scheme);
        for (const device of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme: device });
          await page.goto(`${DASHBOARD_BASE_URL}/${locale}/overview`);
          await expect(page.locator('html')).toHaveAttribute('data-color-scheme', scheme);
          const expected = scheme === 'system' ? device === 'dark' : scheme === 'dark';
          expect(await isDark(page), `${scheme} on a ${device} device`).toBe(expected);
          await page.waitForTimeout(1500);
          expect(
            await page.evaluate(() => (window as unknown as { __flips: string[] }).__flips),
          ).toEqual([]);
          expect(await isDark(page), `${scheme} on a ${device} device, after load`).toBe(expected);
        }
      }
    });
  }

  test('"device" follows the device live, without a reload', async ({ page, context }) => {
    await withScheme(context, 'system');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(`${DASHBOARD_BASE_URL}/en/sign-in`);
    expect(await isDark(page)).toBe(false);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => isDark(page)).toBe(true);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => isDark(page)).toBe(false);
  });

  test('the account menu sets the choice, a reload keeps it, and a second tab agrees', async ({
    page,
    context,
  }) => {
    await signIn(page, 'en');
    await withScheme(context, 'light');
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    const other = await context.newPage();
    await other.goto(`${DASHBOARD_BASE_URL}/en/content`);
    await expect(other.locator('html')).toHaveAttribute('data-color-scheme', 'light');

    await page.click('[data-testid="profile-menu"]');
    await page.getByTestId('account-appearance').click();
    await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'dark');
    expect(await isDark(page)).toBe(true);
    // The other tab takes the same value without being touched.
    await expect(other.locator('html')).toHaveAttribute('data-color-scheme', 'dark');
    await expect.poll(() => isDark(other)).toBe(true);

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'dark');
    await other.reload();
    await expect(other.locator('html')).toHaveAttribute('data-color-scheme', 'dark');
    await other.close();
  });
});

test.describe('P1 · the screens before sign-in follow the same rule', () => {
  const SCREENS = ['/sign-in', '/sign-up', '/reset'] as const;
  for (const locale of ['en', 'ar'] as const) {
    test(`sign-in, sign-up and password reset, light and dark (${locale})`, async ({
      page,
      context,
    }) => {
      for (const scheme of ['light', 'dark'] as const) {
        await withScheme(context, scheme);
        for (const screen of SCREENS) {
          await page.goto(`${DASHBOARD_BASE_URL}/${locale}${screen}`);
          await expect(page.locator('html')).toHaveAttribute('data-color-scheme', scheme);
          await expect(page.locator('html')).toHaveAttribute(
            'dir',
            locale === 'ar' ? 'rtl' : 'ltr',
          );
          expect(await isDark(page), `${screen} ${scheme}`).toBe(scheme === 'dark');
        }
      }
    });
  }

  test('with no choice yet, a visitor on a dark device reads the default rule', async ({
    page,
  }) => {
    // No cookie: the Look & feel default, which for the original look is light.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(`${DASHBOARD_BASE_URL}/en/sign-in`);
    const scheme = await page.locator('html').getAttribute('data-color-scheme');
    expect(['light', 'dark', 'system']).toContain(scheme);
    expect(await isDark(page)).toBe(scheme !== 'light');
  });
});

async function draftWithInstagram(): Promise<string> {
  const loaded = credentials();
  const brandId = brandFixtures(loaded).primaryBrandId;
  return withPlatformPrisma(async (prisma) => {
    const item = await prisma.contentItem.create({
      data: {
        workspaceId: loaded.customer.workspaceId,
        brandId,
        title: `P1 drawer ${randomUUID().slice(0, 6)}`,
        status: 'DRAFT',
        contentType: 'POST',
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
        body: 'A caption.',
        assetIds: [],
      },
    });
    return item.id;
  });
}

async function openGenerateTab(page: Page, locale: string, itemId: string): Promise<void> {
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/content/compose?item=${itemId}`);
  await page.getByTestId('studio-tab-visual').click();
  await page.getByTestId('content-media-instagram-add').click();
  await expect(page.getByTestId('media-drawer')).toBeVisible();
  await page.getByTestId('media-drawer').getByRole('tab').last().click();
  await expect(page.getByTestId('media-generate')).toBeVisible();
}

test.describe('P1 · the Add media drawer and the image request', () => {
  for (const locale of ['en', 'ar'] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      test(`sized to its content, actions clear of the field (${locale}, ${scheme})`, async ({
        page,
        context,
        isMobile,
      }) => {
        test.skip(isMobile === true, 'the drawer geometry is checked at the desktop size');
        await withScheme(context, scheme);
        await signIn(page, locale);
        await openGenerateTab(page, locale, await draftWithInstagram());
        const sheet = await page.getByTestId('media-drawer').boundingBox();
        const viewport = page.viewportSize();
        expect(sheet && viewport).toBeTruthy();
        // As tall as its content: well short of the window.
        expect(sheet!.height).toBeLessThan(viewport!.height * 0.85);
        expect(sheet!.y + sheet!.height).toBeLessThanOrEqual(viewport!.height);
        const select = await page.getByTestId('media-generate-format').boundingBox();
        const quote = await page.getByTestId('media-generate-quote').boundingBox();
        const submit = await page.getByTestId('media-generate-submit').boundingBox();
        // Its own space below the last field, and the two buttons on one line.
        expect(quote!.y - (select!.y + select!.height)).toBeGreaterThanOrEqual(10);
        expect(
          Math.abs(quote!.y + quote!.height / 2 - (submit!.y + submit!.height / 2)),
        ).toBeLessThan(1);
        expect(Math.abs(quote!.height - submit!.height)).toBeLessThan(1);
        expect(await isDark(page)).toBe(scheme === 'dark');
      });
    }

    test(`the image request shows its progress, then a clear result (${locale})`, async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile === true, 'one size is enough for the waiting state');
      await signIn(page, locale);
      await openGenerateTab(page, locale, await draftWithInstagram());
      // The provider is never called: the request is held, then refused.
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      await page.route('**/api/creative/generate', async (route) => {
        await held;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: '{"error":{"code":"UNAVAILABLE"}}',
        });
      });
      await page.getByTestId('media-generate-prompt').fill('A bright window display');
      await page.getByTestId('media-generate-submit').click();
      const progress = page.getByTestId('media-generate-progress');
      await expect(progress).toBeVisible();
      await expect(progress).toHaveAttribute('role', 'status');
      await expect(page.getByTestId('media-generate-submit')).toBeDisabled();
      await expect(page.getByTestId('media-generate-submit')).toHaveAttribute('aria-busy', 'true');
      await expect(page.getByTestId('media-generate-progress-time')).toHaveText('0:01', {
        timeout: 3000,
      });
      release();
      await expect(progress).toHaveCount(0);
      await expect(page.getByTestId('media-generate').getByRole('alert')).toBeVisible();
      await expect(page.getByTestId('media-generate-submit')).toBeEnabled();
    });
  }
});

/** A small PNG padded to `bytes`, so a throttled upload takes a few seconds. */
function paddedPng(bytes: number): Buffer {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  return Buffer.concat([png, Buffer.alloc(Math.max(0, bytes - png.length))]);
}

test.describe('P1 · an upload shows its percentage', () => {
  for (const locale of ['en', 'ar'] as const) {
    test(`Media: the bar and its percentage, then the library's result (${locale})`, async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile === true, 'one size is enough for the bar');
      await signIn(page, locale);
      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/assets`);
      // The relay's answer is held, so the bar and the waiting button can be
      // seen on any machine (a local upload is over before a frame is drawn).
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      await page.route('**/api/upload/**', async (route) => {
        const response = await route.fetch();
        await held;
        await route.fulfill({ response });
      });
      await page.getByTestId('assets-upload-open').click();
      const form = page.getByTestId('assets-upload-form');
      await form.locator('input[type="file"]').setInputFiles({
        name: `p1-${randomUUID().slice(0, 6)}.png`,
        mimeType: 'image/png',
        buffer: paddedPng(900 * 1024),
      });
      await form.locator('button[type="submit"]').click();
      const bar = page.getByTestId('assets-upload-status-progress');
      await expect(bar).toBeVisible();
      await expect(bar.locator('progress')).toHaveAttribute('max', '100');
      await expect(page.getByTestId('assets-upload-status-progress-value')).toHaveText(
        /^\d{1,3}%$/,
      );
      await expect(form.locator('button[type="submit"]')).toHaveAttribute('aria-busy', 'true');
      await expect(form.locator('button[type="submit"]')).toBeDisabled();
      release();
      // The result, as before the bar: the dialog closes and the library says
      // the file arrived.
      await expect(page.getByTestId('assets-upload-dialog')).toHaveCount(0);
      await expect(page).toHaveURL(/ok=ASSET_UPLOADED/);
    });
  }

  test('the relay refuses a request from another site', async ({ request }) => {
    const response = await request.post(`${DASHBOARD_BASE_URL}/api/upload/asset`, {
      headers: { origin: 'https://evil.example', 'x-bs-upload': '1' },
      multipart: { locale: 'en' },
    });
    expect(response.status()).toBe(403);
    const unknown = await request.post(`${DASHBOARD_BASE_URL}/api/upload/anything`, {
      headers: { origin: DASHBOARD_BASE_URL, 'x-bs-upload': '1' },
      multipart: { locale: 'en' },
    });
    expect(unknown.status()).toBe(404);
  });
});

test.describe('P1 · a button that waits for the server says so', () => {
  for (const locale of ['en', 'ar'] as const) {
    test(`sign-in is disabled and busy while its action runs (${locale})`, async ({ page }) => {
      const { customer } = credentials();
      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/sign-in`);
      await page.fill('#email', customer.email);
      await page.fill('#password', 'not-the-password');
      // Hold the action's request, so the waiting state can be seen.
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      await page.route(`**/${locale}/sign-in*`, async (route) => {
        if (route.request().method() === 'POST') await held;
        await route.continue();
      });
      await page.click('[data-testid="signin-submit"]');
      const button = page.getByTestId('signin-submit');
      await expect(button).toHaveAttribute('aria-busy', 'true');
      await expect(button).toBeDisabled();
      release();
      await expect(button).not.toHaveAttribute('aria-busy', 'true');
    });
  }
});
