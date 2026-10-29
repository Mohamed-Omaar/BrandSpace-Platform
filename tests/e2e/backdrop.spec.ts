import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { withPlatformPrisma } from './platform-prisma';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

/**
 * THE ONE BACKDROP (design-system programme, S5; D-5) — and KNOWN bugs 8 and 9.
 *
 * Bug 9: the backdrop behind the Add media drawer covered only part of the
 * page. Bug 8: the drawer itself was the wrong height. One cause: a
 * `position: fixed` layer is laid out against the nearest ancestor that has a
 * `transform`, `filter` or `backdrop-filter`, and the app frame had a
 * full-window `backdrop-filter` (removed by D-575). So these tests measure,
 * against the WINDOW, after the page has scrolled:
 *   - every backdrop covers the whole window, exactly;
 *   - a side sheet runs from the top inset to the bottom inset;
 *   - every backdrop has the same tint and blur (`--bs-scrim`,
 *     `--bs-fx-backdrop-scrim`), and no ancestor makes itself their
 *     containing block.
 */

function credentials(): E2eAdminCredentials {
  return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
}

async function signIn(page: Page, locale: string): Promise<void> {
  const loaded = credentials();
  const { customer } = loaded;
  await useBrand(page, customer.workspaceId, brandFixtures(loaded).primaryBrandId);
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/sign-in`);
  await page.fill('#email', customer.email);
  await page.fill('#password', customer.password);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL((url) => !url.pathname.endsWith('/sign-in'));
  await page.click(`[data-testid="choose-workspace-${customer.workspaceSlug}"]`);
  await page.waitForURL(new RegExp(`/${locale}/overview$`));
}

/** A draft with an Instagram variant, and enough library media to fill the drawer. */
async function draftWithLibrary(): Promise<string> {
  const loaded = credentials();
  const workspaceId = loaded.customer.workspaceId;
  const brandId = brandFixtures(loaded).primaryBrandId;
  return withPlatformPrisma(async (prisma) => {
    for (let i = 0; i < 9; i++) {
      await prisma.asset.create({
        data: {
          workspaceId,
          brandId,
          name: `backdrop-${randomUUID().slice(0, 6)}.png`,
          kind: 'IMAGE',
          mimeType: 'image/png',
          sizeBytes: 4_096,
          width: 1080,
          height: 1080,
          storageKey: `e2e/backdrop/${randomUUID()}`,
          checksumSha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
          status: 'READY',
          scanStatus: 'CLEAN',
        },
      });
    }
    const item = await prisma.contentItem.create({
      data: {
        workspaceId,
        brandId,
        title: `Backdrop ${randomUUID().slice(0, 6)}`,
        status: 'DRAFT',
        contentType: 'POST',
        primaryLocale: 'EN',
      },
      select: { id: true },
    });
    await prisma.contentVariant.create({
      data: {
        workspaceId,
        brandId,
        contentItemId: item.id,
        platformKey: 'instagram',
        locale: 'EN',
        body: 'A post caption.',
        assetIds: [],
      },
    });
    return item.id;
  });
}

/** The backdrop's box against the window, its look, and what could contain it. */
function measure(backdrop: Locator) {
  return backdrop.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const containing: string[] = [];
    for (let node = el.parentElement; node; node = node.parentElement) {
      const s = getComputedStyle(node);
      const props = {
        transform: s.transform,
        filter: s.filter,
        backdropFilter: s.backdropFilter,
        perspective: s.perspective,
        translate: s.translate,
        scale: s.scale,
        rotate: s.rotate,
      };
      for (const [name, value] of Object.entries(props)) {
        if (value !== 'none')
          containing.push(`${node.tagName.toLowerCase()}.${node.className}: ${name}`);
      }
      if (/paint|layout|strict|content/.test(s.contain))
        containing.push(`${node.tagName}: contain`);
    }
    return {
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      window: { width: innerWidth, height: innerHeight },
      position: style.position,
      background: style.backgroundColor,
      blur: style.backdropFilter,
      containing,
    };
  });
}

async function expectCoversWindow(backdrop: Locator) {
  // A modal's veil fades in (MO6): measure it once the fade has ended.
  await backdrop.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  const m = await measure(backdrop);
  expect(m.containing).toEqual([]);
  expect(m.position).toBe('fixed');
  expect(m.box).toEqual({ x: 0, y: 0, width: m.window.width, height: m.window.height });
  return m;
}

test.describe('the one backdrop (S5, bugs 8 and 9)', () => {
  for (const locale of ['en', 'ar'] as const) {
    test(`${locale}: the Add media backdrop covers the window and the drawer fills its height`, async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile === true, 'the phone layout is post-launch (D-468)');
      const itemId = await draftWithLibrary();
      await signIn(page, locale);
      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/content/compose?item=${itemId}`);
      await page.getByTestId('studio-tab-visual').click();
      // Scrolled to the end: a backdrop laid out against the page instead of
      // the window would now start above the top of the screen.
      await page.evaluate(() => {
        for (const el of [document.scrollingElement, ...document.querySelectorAll('*')]) {
          if (el && el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight;
        }
      });
      await page.getByTestId('content-media-instagram-add').click();
      const drawer = page.getByTestId('media-drawer');
      await expect(drawer).toBeVisible();
      await expect(drawer).not.toHaveAttribute('data-leaving');

      await expectCoversWindow(page.getByTestId('media-drawer-scrim'));
      const sheet = await drawer.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const inset = parseFloat(getComputedStyle(el).insetBlockStart);
        return { top: box.top, bottom: box.bottom, inset, window: innerHeight };
      });
      expect(sheet.inset).toBeGreaterThan(0);
      expect(Math.abs(sheet.top - sheet.inset)).toBeLessThan(1);
      expect(Math.abs(sheet.bottom - (sheet.window - sheet.inset))).toBeLessThan(1);
    });
  }

  test('a dialog sits on the same backdrop as a drawer', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'the phone layout is post-launch (D-468)');
    const itemId = await draftWithLibrary();
    await signIn(page, 'en');
    await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?item=${itemId}`);
    await page.getByTestId('studio-tab-visual').click();
    await page.getByTestId('content-media-instagram-add').click();
    const drawer = await expectCoversWindow(page.getByTestId('media-drawer-scrim'));
    await page.getByTestId('media-drawer-close').click();
    await expect(page.getByTestId('media-drawer-scrim')).toHaveCount(0);

    await page.goto(`${DASHBOARD_BASE_URL}/en/campaigns?new=1`);
    await expect(page.getByTestId('campaign-new-dialog')).toBeVisible();
    const dialog = await expectCoversWindow(page.getByTestId('campaign-new-dialog-scrim'));

    // One tint and one blur, from the tokens — whatever value the owner sets.
    const tokens = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.backgroundColor = 'var(--bs-scrim)';
      probe.style.backdropFilter = 'var(--bs-fx-backdrop-scrim)';
      document.body.append(probe);
      const s = getComputedStyle(probe);
      const out = { background: s.backgroundColor, blur: s.backdropFilter };
      probe.remove();
      return out;
    });
    for (const m of [drawer, dialog]) {
      expect({ background: m.background, blur: m.blur }).toEqual(tokens);
    }
  });
});
