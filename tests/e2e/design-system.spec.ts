import { readFileSync } from 'node:fs';
import { clippedInlineOverflow, expectNothingClippedAway, inlineEndOverhang } from './overflow';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ADMIN_BASE_URL, DASHBOARD_BASE_URL } from './apps';
import { E2E_CREDENTIALS_FILE, type E2eAdminCredentials } from './env';

/**
 * The Phase 2C design foundation, in a real browser.
 *
 * WHAT THIS SUITE IS FOR. The design system's promises are mostly behavioural —
 * a sidebar that collapses and remembers, a drawer that traps focus and gives it
 * back, a caption that truncates, a panel that becomes a sheet — and none of
 * them can be verified by reading a style object. Every assertion here is about
 * something a person would notice.
 *
 * The showcase route is enabled for the dashboard only (playwright.config.ts),
 * which doubles as the assertion that the gate is real: the same path on the
 * Control Center, where the flag is not set, must be a 404.
 */

const SHOWCASE = (locale: string) => `${DASHBOARD_BASE_URL}/${locale}/design-system`;

const WIDTHS = [
  { name: '390', width: 390, height: 844 },
  { name: '768', width: 768, height: 1024 },
  { name: '1280', width: 1280, height: 800 },
  { name: '1440', width: 1440, height: 900 },
] as const;

function credentials(): E2eAdminCredentials {
  try {
    return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
  } catch {
    throw new Error(
      'The end-to-end credentials file is missing. Run `pnpm e2e:seed` first — ' +
        '`pnpm test:e2e` does it for you.',
    );
  }
}

async function signInAndEnterWorkspace(page: Page, locale = 'en'): Promise<void> {
  const { customer } = credentials();
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/sign-in`);
  await page.fill('#email', customer.email);
  await page.fill('#password', customer.password);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL((url) => !url.pathname.endsWith('/sign-in'));
  await page.click(`[data-testid="choose-workspace-${customer.workspaceSlug}"]`);
  await page.waitForURL(new RegExp(`/${locale}/overview$`));
}

/** Fail on serious and critical axe violations only (F-04a). */
async function expectNoBlockingA11yViolations(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  expect(
    blocking.map((violation) => `${violation.id}: ${violation.help}`),
    `axe violations on ${label}`,
  ).toEqual([]);
}

/**
 * Fail EARLY and with a reason if the served dashboard is not the one this
 * suite expects.
 *
 * `reuseExistingServer` is on outside CI, so a dashboard left running from an
 * earlier build is silently reused — and then twenty assertions fail with a
 * 404 or a missing selector, none of which names the actual cause. This check
 * turns that into one sentence.
 */
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  try {
    const response = await page.goto(SHOWCASE('en'));
    if (response?.status() !== 200) {
      throw new Error(
        `The design showcase is not being served (HTTP ${response?.status()}).\n` +
          '  A dashboard from an earlier build is probably still running and was reused.\n' +
          '  Stop it and re-run, so Playwright starts one with BRANDSPACE_DESIGN_SHOWCASE=1.',
      );
    }
  } finally {
    await page.close();
  }
});

test.describe('the showcase is isolated from the product', () => {
  test('the Control Center has no showcase route, because the flag is not set there', async ({
    page,
  }) => {
    // The gate, proven rather than described: the same path, an app without the
    // opt-in, and the answer is a 404 — indistinguishable from a route that was
    // never built.
    const response = await page.goto(`${ADMIN_BASE_URL}/en/design-system`);
    expect(response?.status()).toBe(404);
  });

  test('it is reachable in the dashboard only because the suite opted in', async ({ page }) => {
    const response = await page.goto(SHOWCASE('en'));
    expect(response?.status()).toBe(200);
    await expect(page.getByTestId('showcase-notice')).toBeVisible();
  });

  test('no navigation in the product links to it', async ({ page }) => {
    await signInAndEnterWorkspace(page);
    const links = await page
      .locator('nav a')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href') ?? ''));
    expect(links.filter((href) => href.includes('design-system'))).toEqual([]);
  });
});

test.describe('the sidebar collapses, remembers, and stays reachable', () => {
  test('collapses to icons and expands again', async ({ page }) => {
    await signInAndEnterWorkspace(page);
    const shell = page.getByTestId('app-shell');
    await expect(shell).toHaveAttribute('data-sidebar-state', 'expanded');

    // The label is visible when expanded.
    await expect(page.getByTestId('nav-members')).toContainText(/\w/);

    await page.click('[data-testid="toggle-sidebar"]');
    await expect(shell).toHaveAttribute('data-sidebar-state', 'collapsed');
    // Collapsed, the item is still THERE and still reachable — only its text is
    // gone. A collapsed sidebar that removes navigation is not a collapse.
    await expect(page.getByTestId('nav-members')).toBeVisible();

    await page.click('[data-testid="toggle-sidebar"]');
    await expect(shell).toHaveAttribute('data-sidebar-state', 'expanded');
  });

  test('the collapse control names its own effect for a screen reader', async ({ page }) => {
    await signInAndEnterWorkspace(page);
    const toggle = page.getByTestId('toggle-sidebar');
    // `aria-pressed` carries the state; the label says what pressing will do.
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle).toHaveAttribute('aria-label', /expand/i);
  });

  test('the preference survives a reload, and only affects display', async ({ page }) => {
    await signInAndEnterWorkspace(page);
    await page.click('[data-testid="toggle-sidebar"]');
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-sidebar-state', 'collapsed');

    await page.reload();
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-sidebar-state', 'collapsed');

    /*
     * STRENGTHENED, because the collapsed rail changed under it.
     *
     * This used to assert the workspace NAME was visible while collapsed, which
     * only held because the rail was not yet hiding its copy. The reference
     * shows the avatar alone in a 78px rail, so the name is now `display: none`
     * there — and asserting a hidden element is visible would have meant
     * reverting a correct change to satisfy a test.
     *
     * The property the test is actually for is "the preference is a display
     * choice that touches no session", so it now proves exactly that: the
     * session survives the reload (the rail and its navigation are still
     * there), and expanding again brings the same workspace back. That is a
     * stronger claim than the original, not a weaker one.
     */
    await expect(page.getByTestId('sidebar')).toBeVisible();
    await expect(page.getByTestId('nav-overview')).toBeVisible();

    await page.click('[data-testid="toggle-sidebar"]');
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-sidebar-state', 'expanded');
    await expect(page.getByTestId('active-workspace')).toBeVisible();
  });

  test('a collapsed item explains itself on keyboard focus, not only on hover', async ({
    page,
  }) => {
    await signInAndEnterWorkspace(page);
    await page.click('[data-testid="toggle-sidebar"]');
    // WCAG 1.4.13: content available on hover must also be available on focus.
    const item = page.getByTestId('nav-members');
    await item.focus();
    // The tooltip of THAT item, not whichever one happens to be first in the
    // document — the sidebar renders one per link.
    const tooltip = page.locator('span:has(> span > [data-testid="nav-members"]) [role="tooltip"]');
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveText(/\w/);
  });

  test('the sidebar never pushes the page sideways', async ({ page }) => {
    await signInAndEnterWorkspace(page);
    for (const collapsed of [false, true]) {
      if (collapsed) await page.click('[data-testid="toggle-sidebar"]');
      const { px, offender } = await inlineEndOverhang(page);
      expect(px, `sidebar collapsed=${collapsed}: ${offender} overhangs by ${px}px`).toBe(0);
    }
  });
});

test.describe('mobile navigation is a drawer, not a squeezed sidebar', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the sidebar is replaced by a drawer trigger', async ({ page }) => {
    await signInAndEnterWorkspace(page);
    await expect(page.getByTestId('sidebar')).toBeHidden();
    await expect(page.getByTestId('open-navigation')).toBeVisible();
  });

  test('opens as a modal, traps focus, and closes on Escape', async ({ page }) => {
    await signInAndEnterWorkspace(page);
    await page.click('[data-testid="open-navigation"]');

    const drawer = page.getByTestId('navigation-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute('aria-modal', 'true');

    // Focus moved INTO the drawer.
    const insideAtOpen = await drawer.evaluate((node) => node.contains(document.activeElement));
    expect(insideAtOpen).toBe(true);

    // Tab repeatedly: focus must never leave the drawer.
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('Tab');
      const stillInside = await drawer.evaluate((node) => node.contains(document.activeElement));
      expect(stillInside, `focus escaped the drawer after ${i + 1} tabs`).toBe(true);
    }

    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
  });

  test('returns focus to the trigger when it closes', async ({ page }) => {
    await signInAndEnterWorkspace(page);
    await page.click('[data-testid="open-navigation"]');
    await page.keyboard.press('Escape');
    // Otherwise a keyboard user is dumped at the top of the document.
    const focused = await page.evaluate(
      () => document.activeElement?.getAttribute('data-testid') ?? '',
    );
    expect(focused).toBe('open-navigation');
  });

  test('keeps the workspace context while navigating from the drawer', async ({ page }) => {
    await signInAndEnterWorkspace(page);
    const workspace = await page.getByTestId('active-workspace').textContent();

    await page.click('[data-testid="open-navigation"]');
    // Scoped to the drawer: the sidebar renders the same link, and at this
    // width it is hidden, so an unscoped selector resolves to two elements and
    // clicks the invisible one.
    await page.getByTestId('navigation-drawer').getByTestId('nav-members').click();
    await page.waitForURL(/\/en\/members/);

    await expect(page.getByTestId('active-workspace')).toHaveText(workspace ?? '');
    // The drawer closes on navigation rather than covering the page it opened.
    await expect(page.getByTestId('navigation-drawer')).toBeHidden();
  });
});

test.describe('the restyled pages hold their shape at every width', () => {
  for (const locale of ['ar', 'en'] as const) {
    for (const viewport of WIDTHS) {
      test(`no horizontal overflow at ${viewport.name}px (${locale})`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await signInAndEnterWorkspace(page, locale);

        for (const path of [`/${locale}/overview`, `/${locale}/members`]) {
          await page.goto(`${DASHBOARD_BASE_URL}${path}`);
          const { px, offender } = await inlineEndOverhang(page);
          expect(px, `${path} at ${viewport.name}px: ${offender} overhangs by ${px}px`).toBe(0);

          /*
           * The shell clips its own rounded corners and the panel scrolls, as
           * the demo does. Both fit the viewport, so the measurement above is
           * defined to forgive anything they cut off — which is why the second
           * half is asserted directly: neither container may be hiding page
           * content along the inline axis.
           */
          await expectNothingClippedAway(page, '.bs-shell', `${path} at ${viewport.name}px`);
          await expectNothingClippedAway(page, 'main', `${path} at ${viewport.name}px`);
        }
      });
    }
  }

  test('the overhang measurement actually detects an overflowing element', async ({ page }) => {
    // Without this, a measurement that silently returned 0 would make every
    // assertion above pass while the pages overflowed.
    await page.setViewportSize({ width: 390, height: 844 });
    await signInAndEnterWorkspace(page);
    expect((await inlineEndOverhang(page)).px).toBe(0);

    /*
     * Planted INSIDE the panel, which clips and scrolls its own box: this is
     * the case `inlineEndOverhang` is defined to forgive, and the case the
     * shell's `overflow: hidden` would otherwise let through unseen. The
     * clipped-away measurement is what has to catch it.
     */
    await page.evaluate(() => {
      const planted = document.createElement('div');
      planted.dataset['testid'] = 'planted-overflow';
      planted.style.cssText = 'inline-size:900px;block-size:20px;background:red';
      document.querySelector('main')?.appendChild(planted);
    });
    expect(await clippedInlineOverflow(page, 'main')).toBeGreaterThan(100);
    expect(await clippedInlineOverflow(page, '.bs-shell')).toBeGreaterThan(100);

    /*
     * Planted where nothing clips it, so it genuinely hangs past the viewport:
     * this is what `inlineEndOverhang` measures, and it must still be able to
     * report a number and name the offender.
     */
    await page.evaluate(() => {
      document.querySelector('[data-testid="planted-overflow"]')?.remove();
      const planted = document.createElement('div');
      planted.dataset['testid'] = 'planted-overflow';
      planted.style.cssText =
        'position:absolute;inset-block-start:0;inset-inline-start:0;inline-size:900px;block-size:20px;background:red';
      document.body.appendChild(planted);
    });

    const { px, offender } = await inlineEndOverhang(page);
    expect(px).toBeGreaterThan(100);
    expect(offender).toContain('planted-overflow');
  });

  test('the table becomes a record list on a phone, and only one is shown', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signInAndEnterWorkspace(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/members`);

    // Exactly one representation is visible, so a screen reader reads the data
    // once rather than twice.
    await expect(page.getByTestId('members-list')).toBeVisible();
    await expect(page.getByTestId('members-table')).toBeHidden();

    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByTestId('members-table')).toBeVisible();
    await expect(page.getByTestId('members-list')).toBeHidden();
  });
});

test.describe('direction is a routing property, in both apps', () => {
  for (const { locale, dir } of [
    { locale: 'ar', dir: 'rtl' },
    { locale: 'en', dir: 'ltr' },
  ] as const) {
    test(`the showcase renders ${locale} as ${dir}`, async ({ page }) => {
      await page.goto(SHOWCASE(locale));
      await expect(page.locator('html')).toHaveAttribute('dir', dir);
    });

    test(`the restyled workspace home renders ${locale} as ${dir}`, async ({ page }) => {
      await signInAndEnterWorkspace(page, locale);
      await expect(page.locator('html')).toHaveAttribute('dir', dir);
      await expect(page.getByTestId('heading')).toBeVisible();
    });
  }

  test('the sidebar sits on the start edge in both directions', async ({ page }) => {
    // ONE sign-in. The locale is a URL segment, not a stored preference, so
    // both directions are reachable from the same session — and visiting
    // `/sign-in` again would simply redirect an authenticated caller away.
    await signInAndEnterWorkspace(page, 'ar');
    const width = page.viewportSize()?.width ?? 1280;

    const arabic = await page.getByTestId('sidebar').boundingBox();
    // RTL: the sidebar is on the RIGHT, i.e. past the middle of the viewport.
    expect(arabic?.x ?? 0).toBeGreaterThan(width / 2);

    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    const english = await page.getByTestId('sidebar').boundingBox();
    expect(english?.x ?? width).toBeLessThan(width / 2);
  });
});

test.describe('the showcase renders every component state', () => {
  test('exposes buttons, forms, feedback, tables and metrics', async ({ page }) => {
    await page.goto(SHOWCASE('en'));
    for (const section of [
      'showcase-buttons',
      'showcase-forms',
      'showcase-feedback',
      'showcase-overlays',
      'showcase-table',
      'showcase-social',
      'showcase-copilot',
      'showcase-metrics',
      'showcase-colors',
      'showcase-typography',
    ]) {
      await expect(page.getByTestId(section), `${section} is missing`).toBeVisible();
    }
  });

  test('the Support Mode banner is unmistakable and stays put when scrolling', async ({ page }) => {
    await page.goto(SHOWCASE('en'));
    const banner = page.getByTestId('showcase-support-banner');
    await expect(banner).toBeVisible();
    // It names the reader as platform staff, not the customer (D-28).
    await expect(banner).toContainText(/platform staff, not the customer/i);

    const before = await banner.boundingBox();
    await page.evaluate(() => window.scrollTo(0, 1200));
    const after = await banner.boundingBox();
    // Sticky: still on screen after scrolling a long page.
    expect(after?.y ?? -1).toBeGreaterThanOrEqual(0);
    expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(4);
  });

  test('a dialog traps focus and restores it', async ({ page }) => {
    await page.goto(SHOWCASE('en'));
    await page.click('[data-testid="open-dialog"]');
    const dialog = page.getByTestId('dialog');
    await expect(dialog).toBeVisible();

    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press('Tab');
      const inside = await dialog.evaluate((node) => node.contains(document.activeElement));
      expect(inside, `focus escaped the dialog after ${i + 1} tabs`).toBe(true);
    }

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    const focused = await page.evaluate(
      () => document.activeElement?.getAttribute('data-testid') ?? '',
    );
    expect(focused).toBe('open-dialog');
  });

  test('a destructive confirmation does not focus the destructive button', async ({ page }) => {
    await page.goto(SHOWCASE('en'));
    await page.click('[data-testid="open-confirm"]');
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    // A stray Enter carried over from the previous screen must not confirm a
    // destructive action.
    const focused = await page.evaluate(
      () => document.activeElement?.getAttribute('data-testid') ?? '',
    );
    expect(focused).not.toBe('confirm-accept');
  });

  test('tabs follow the arrow keys', async ({ page }) => {
    await page.goto(SHOWCASE('en'));
    await page.getByTestId('tab-states').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('tab-loading')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('End');
    await expect(page.getByTestId('tab-badges')).toHaveAttribute('aria-selected', 'true');
  });
});

/**
 * §9 and §20, in a browser: every visible post must be clickable, clicking it
 * must open its real details, and the details must lead somewhere.
 *
 * These assertions are deliberately about STATE rather than appearance. A chip
 * that opens a panel showing a DIFFERENT post's caption would look perfect in a
 * screenshot and be useless; the only way to know the chain is real is to open
 * a specific record and read what came back.
 */
const CALENDAR_CHIP = '[data-testid="prototype-calendar"] [data-testid^="calendar-post-"]';

test.describe('a post can be opened from the calendar and taken somewhere', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(SHOWCASE('en'));
  });

  test('every calendar chip is a real control, and none of them is dead', async ({ page }) => {
    const chips = page.locator(CALENDAR_CHIP);
    const count = await chips.count();
    expect(count, 'the calendar renders no openable posts at all').toBeGreaterThan(3);

    for (let index = 0; index < count; index += 1) {
      const chip = chips.nth(index);
      // A real BUTTON — not a div with a click handler, which is unreachable
      // by keyboard and invisible to assistive technology.
      await expect(chip).toHaveJSProperty('tagName', 'BUTTON');
      // …named by the post it opens, not by the verb, so eight of them are
      // eight different controls to a screen-reader user.
      const name = await chip.getAttribute('aria-label');
      expect(name, `calendar chip ${index} has no accessible name`).toBeTruthy();
      expect(name!.length, `calendar chip ${index} is named only by its verb`).toBeGreaterThan(20);
    }
  });

  test('opening a chip shows THAT post, not a generic panel', async ({ page }) => {
    const chip = page.locator(CALENDAR_CHIP).first();
    // `calendar-post-<id>` — the identity of the record the chip stands for.
    const chipId = (await chip.getAttribute('data-testid'))!.replace('calendar-post-', '');
    const name = (await chip.getAttribute('aria-label')) ?? '';

    await chip.click();
    const drawer = page.getByTestId('post-detail-drawer');
    await expect(drawer).toBeVisible();

    // The panel opened for THAT record, not for a generic one. This is the
    // assertion a screenshot cannot make: a panel showing a different post's
    // caption would look perfect and be useless.
    await expect(drawer).toHaveAttribute('data-post-id', chipId);

    // …and its caption is the chip's caption, not a placeholder.
    const caption = (await drawer.locator('p').first().innerText()).trim();
    expect(caption.length).toBeGreaterThan(5);
    expect(name, 'the panel shows a caption the chip never mentioned').toContain(caption);

    // The facts panel is populated, not an empty shell.
    await expect(drawer.locator('dt')).not.toHaveCount(0);
  });

  test('the details panel takes the keyboard and gives it back', async ({ page }) => {
    const chip = page.locator(CALENDAR_CHIP).first();
    const chipTestId = await chip.getAttribute('data-testid');
    await chip.click();

    const drawer = page.getByTestId('post-detail-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute('aria-modal', 'true');

    // Focus moved INTO the panel.
    const focusedInside = await page.evaluate(
      () =>
        document
          .querySelector('[data-testid="post-detail-drawer"]')
          ?.contains(document.activeElement) ?? false,
    );
    expect(focusedInside, 'focus stayed outside the panel that just opened').toBe(true);

    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();

    // …and came back to the chip that opened it, not to the top of the page.
    const restored = await page.evaluate(
      (id) => document.activeElement?.getAttribute('data-testid') === id,
      chipTestId,
    );
    expect(restored, 'focus was not returned to the control that opened the panel').toBe(true);
  });

  test('"view in library" lands on a tab that actually contains the post', async ({ page }) => {
    await page.locator(CALENDAR_CHIP).first().click();
    const drawer = page.getByTestId('post-detail-drawer');
    const postId = await drawer.getAttribute('data-post-id');

    await page.getByTestId('post-detail-view-in-library').click();
    await expect(drawer).toBeHidden();

    // The record is present in the library, and marked.
    const card = page.locator(
      `[data-testid="post-card-${postId}"], [data-testid="post-row-${postId}"]`,
    );
    await expect(card.first()).toBeVisible();
    await expect(card.first()).toHaveAttribute('aria-selected', 'true');
  });

  test('"edit post" loads that post into the composer', async ({ page }) => {
    await page.locator(CALENDAR_CHIP).first().click();
    const drawer = page.getByTestId('post-detail-drawer');
    const label = await drawer.locator('p').first().innerText();

    await page.getByTestId('post-detail-edit').click();
    await expect(drawer).toBeHidden();

    await expect(page.getByTestId('composer-editing-notice')).toBeVisible();
    const caption = page.locator('[data-testid="prototype-composer"] textarea').first();
    await expect(caption).toHaveValue(label.trim());
  });

  test('the composer preview follows what is typed and which format is chosen', async ({
    page,
  }) => {
    const composer = page.getByTestId('prototype-composer');
    const caption = composer.locator('textarea').first();
    await caption.fill('A caption typed by the interaction suite.');
    await expect(composer).toContainText('A caption typed by the interaction suite.');

    // Changing the format changes the PREVIEW, not just a chip's colour: the
    // rendered composition and its aspect ratio both follow.
    const preview = composer.getByTestId('composer-preview');
    await expect(preview).toHaveAttribute('data-format', 'feed');
    const feedAspect = await preview.getAttribute('data-aspect');

    await composer.getByTestId('composer-format-story').click();
    await expect(preview).toHaveAttribute('data-format', 'story');
    await expect(preview).not.toHaveAttribute('data-aspect', feedAspect ?? '');
  });

  test('nothing on the prototype screens is a placeholder link', async ({ page }) => {
    // §20: "No placeholder link uses `#`."
    const hrefs = await page.$$eval('a[href]', (nodes) =>
      nodes.map((node) => node.getAttribute('href') ?? ''),
    );
    expect(hrefs.filter((href) => href === '#' || href === '')).toEqual([]);
  });
});

test.describe('the social post preview keeps its visual contract', () => {
  test('renders the ratios each platform actually offers', async ({ page }) => {
    await page.goto(SHOWCASE('en'));
    const preview = page.getByTestId('social-post-preview').first();

    // TikTok is vertical only: switching to it must drop a landscape ratio
    // rather than offering a combination the platform will not accept.
    await page.click('[data-testid="preview-platform-tiktok"]');
    await expect(preview).toHaveAttribute('data-platform', 'tiktok');
    await expect(preview).toHaveAttribute('data-aspect', '9:16');
    await expect(page.getByTestId('preview-aspect-16:9')).toHaveCount(0);

    await page.click('[data-testid="preview-platform-linkedin"]');
    await page.click('[data-testid="preview-aspect-16:9"]');
    await expect(preview).toHaveAttribute('data-aspect', '16:9');
  });

  test('the frame honours the selected aspect ratio', async ({ page }) => {
    await page.goto(SHOWCASE('en'));
    await page.click('[data-testid="preview-platform-instagram"]');
    await page.click('[data-testid="preview-aspect-1:1"]');
    const box = await page.getByTestId('preview-media').first().boundingBox();
    expect(box).not.toBeNull();
    // Square, within a pixel of rounding.
    expect(Math.abs((box?.width ?? 0) - (box?.height ?? 0))).toBeLessThan(2);
  });

  test('a long caption truncates and expands', async ({ page }) => {
    await page.goto(SHOWCASE('en'));
    const caption = page.getByTestId('preview-caption').first();
    const toggle = page.getByTestId('preview-caption-toggle').first();

    const truncated = (await caption.textContent()) ?? '';
    expect(truncated.endsWith('…')).toBe(true);

    await toggle.click();
    const expanded = (await caption.textContent()) ?? '';
    expect(expanded.length).toBeGreaterThan(truncated.length);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  test('shows missing media, loading media and a video badge honestly', async ({ page }) => {
    await page.goto(SHOWCASE('en'));
    // The variants are now named by platform and FORMAT, because a feed post, a
    // Story and a Reel are three compositions rather than one card with three
    // badges. Same three assertions, addressed to the new names.
    await expect(
      page.getByTestId('preview-x-post').getByTestId('preview-media-missing'),
    ).toBeVisible();
    await expect(
      page.getByTestId('preview-loading').getByTestId('preview-media-loading'),
    ).toBeVisible();
    await expect(
      page.getByTestId('preview-instagram-reel').getByTestId('preview-video-badge'),
    ).toBeVisible();
    await expect(
      page.getByTestId('preview-tiktok-video').getByTestId('preview-video-badge'),
    ).toBeVisible();
  });

  test('a caption keeps its own direction, independent of the interface', async ({ page }) => {
    await page.goto(SHOWCASE('en'));
    // An Arabic caption inside an English interface must still read RTL, or the
    // preview misrepresents what will be published.
    const caption = page.getByTestId('preview-opposite-script').getByTestId('preview-caption');
    await expect(caption).toHaveAttribute('dir', 'rtl');
  });
});

test.describe('the Copilot shell is a preview that admits what it is', () => {
  test('the composer is inert and says so', async ({ page }) => {
    await page.goto(SHOWCASE('en'));
    const prompt = page.getByTestId('copilot-inline').getByTestId('copilot-prompt');
    await expect(prompt).toBeDisabled();
    // A prompt box that looks live but does nothing is exactly the "button that
    // claims an unsupported action" this phase must not ship.
    await expect(
      page.getByTestId('copilot-inline').getByTestId('copilot-disabled-notice'),
    ).toContainText(/no model is connected/i);
  });

  test('renders streaming, error and insufficient-credit states', async ({ page }) => {
    await page.goto(SHOWCASE('en'));
    const panel = page.getByTestId('copilot-inline');

    await page.click('[data-testid="copilot-state-streaming"]');
    await expect(panel.getByTestId('copilot-streaming')).toBeVisible();

    await page.click('[data-testid="copilot-state-error"]');
    await expect(panel.getByTestId('copilot-error')).toBeVisible();

    await page.click('[data-testid="copilot-state-insufficient-credits"]');
    await expect(panel.getByTestId('copilot-insufficient-credits')).toBeVisible();
  });

  test('a mutating action is gated behind an explicit approval', async ({ page }) => {
    await page.goto(SHOWCASE('en'));
    await page.click('[data-testid="copilot-state-approval"]');
    const panel = page.getByTestId('copilot-inline');

    await expect(panel.getByTestId('copilot-approval')).toBeVisible();
    // CLAUDE.md §2.5: the Copilot may propose and preview, never execute
    // silently. Both an approve and a reject must be present, and the action
    // must state in words that it changes data.
    await expect(panel.getByTestId('copilot-approve')).toBeVisible();
    await expect(panel.getByTestId('copilot-reject')).toBeVisible();
    await expect(panel.getByTestId('copilot-mutating-warning')).toContainText(
      /changes your workspace data/i,
    );
  });

  test('the panel is a docked region on desktop and a modal sheet on a phone', async ({ page }) => {
    await page.goto(SHOWCASE('en'));
    await page.click('[data-testid="copilot-launcher"]');
    const panel = page.getByTestId('copilot-panel');
    await expect(panel).toBeVisible();
    // Desktop: a complementary region beside the page, NOT a modal. A panel
    // that traps focus on a wide screen would make the page behind it
    // unreachable for no reason.
    expect(await panel.getAttribute('aria-modal')).toBeNull();
    expect(await panel.getAttribute('role')).toBe('complementary');
    await page.click('[data-testid="copilot-close"]');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.click('[data-testid="copilot-launcher"]');
    const sheet = page.getByTestId('copilot-panel');
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute('aria-modal', 'true');
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  });
});

test.describe('accessibility', () => {
  for (const locale of ['ar', 'en'] as const) {
    test(`the showcase has no serious or critical violations (${locale})`, async ({ page }) => {
      await page.goto(SHOWCASE(locale));
      await expectNoBlockingA11yViolations(page, `showcase ${locale}`);
    });
  }

  test('the restyled workspace home has no serious or critical violations', async ({ page }) => {
    await signInAndEnterWorkspace(page);
    await expectNoBlockingA11yViolations(page, 'overview');
  });

  test('the restyled team page has no serious or critical violations', async ({ page }) => {
    await signInAndEnterWorkspace(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/members`);
    await expectNoBlockingA11yViolations(page, 'members');
  });

  test('the collapsed sidebar has no serious or critical violations', async ({ page }) => {
    await signInAndEnterWorkspace(page);
    await page.click('[data-testid="toggle-sidebar"]');
    await expectNoBlockingA11yViolations(page, 'overview (collapsed sidebar)');
  });

  test('the open mobile drawer has no serious or critical violations', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signInAndEnterWorkspace(page);
    await page.click('[data-testid="open-navigation"]');
    await expectNoBlockingA11yViolations(page, 'mobile drawer');
  });

  test('every focused element keeps a visible indicator', async ({ page }) => {
    await signInAndEnterWorkspace(page);
    for (let i = 0; i < 10; i += 1) {
      await page.keyboard.press('Tab');
      const outline = await page.evaluate(() => {
        const element = document.activeElement;
        if (!element || element === document.body) return 'skip';
        const style = getComputedStyle(element);
        return `${style.outlineStyle}|${style.outlineWidth}|${style.boxShadow}`;
      });
      if (outline === 'skip') continue;
      expect(outline, `focus indicator missing on tab stop ${i + 1}`).not.toMatch(
        /^none\|0px\|none$/,
      );
    }
  });
});

/**
 * THE DEMO'S GEOMETRY, ASSERTED.
 *
 * `docs/visual-reference/full-demo/` is the visual authority (D-60), and the
 * standard is reproduction, not resemblance. Every number below was measured
 * from that demo rendered in this same browser at 1440×900 — not read off its
 * stylesheet — and each is a value the fidelity pass moved. Asserting them
 * turns "it looks right today" into something a future edit cannot quietly
 * undo, which is the only reason a screenshot review has to happen once.
 *
 * A failure here is not necessarily a bug: it means a measurement changed, and
 * the change has to be either wrong or recorded in
 * `docs/visual-reference/README.md` with its reason.
 */
test.describe('the shell reproduces the demo geometry', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInAndEnterWorkspace(page);
  });

  test('the shell, the rail and the ground', async ({ page }) => {
    const shell = page.locator('.bs-shell');
    // `.app-shell { width: min(1540px, calc(100% - 40px)); border-radius: 34px }`
    await expect(shell).toHaveCSS('border-radius', '34px');
    await expect(shell).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.78)');
    await expect(shell).toHaveCSS('backdrop-filter', 'blur(24px)');
    expect((await shell.boundingBox())?.width).toBe(1400);

    // `.sidebar { --sidebar: 248px; background: rgba(250,250,251,.78) }`
    const sidebar = page.locator('.bs-sidebar');
    expect((await sidebar.boundingBox())?.width).toBe(248);
    await expect(sidebar).toHaveCSS('background-color', 'rgba(250, 250, 251, 0.78)');

    // `html { background: #f2f2f2 }`, `.ambient { background: #f3f3f3 }`,
    // `body { font-size: 15px }`.
    const ground = await page.evaluate(() => ({
      html: getComputedStyle(document.documentElement).backgroundColor,
      ambient: getComputedStyle(document.querySelector('.bs-ambient')!).backgroundColor,
      body: getComputedStyle(document.body).fontSize,
    }));
    expect(ground).toEqual({
      html: 'rgb(242, 242, 242)',
      ambient: 'rgb(243, 243, 243)',
      body: '15px',
    });
  });

  test('the brand lockup', async ({ page }) => {
    /*
     * THE OFFICIAL MARK IS ARTWORK, NOT A STYLED LETTER.
     *
     * The demo drew `.brand-mark` as a 34px ink square with
     * `border-radius: 11px` holding a 15px/850 "B", and this test asserted all
     * three. The product now ships the official BrandSpace logo, so the
     * rounded square and the letterform are PATHS inside the SVG: the corner
     * is cut by the artwork at 261.09 of an 877.07 viewBox, which renders as
     * ~10.1px at 34px and keeps the demo's silhouette.
     *
     * So `border-radius`, `font-size` and `font-weight` stopped describing
     * anything. The container has no radius, no background and no text of its
     * own — `font-size` only still read 15px by inheriting `body`, which is a
     * coincidence rather than a contract. Those three assertions pinned the
     * OLD mark's implementation; what follows pins the lockup's visual and
     * accessible contract instead, which is the thing worth defending.
     */
    const mark = page.getByTestId('brand-mark').first();
    const brand = page.getByTestId('brand').first();

    // GEOMETRY, UNCHANGED. `.brand-mark { width: 34px; height: 34px }` inside
    // `.brand { gap: 10px }` — the demo's lockup rhythm, which the new mark
    // occupies exactly.
    const box = await mark.boundingBox();
    expect(box?.width).toBe(34);
    expect(box?.height).toBe(34);
    await expect(brand).toHaveCSS('gap', '10px');

    /*
     * THE ARTWORK FILLS THE SLOT IT IS GIVEN.
     *
     * Measured separately from the container on purpose: an SVG that failed to
     * inherit its box collapses to nothing while the span it sits in still
     * measures 34x34, so every assertion above would pass over an invisible
     * logo.
     */
    const logo = mark.locator('svg');
    const logoBox = await logo.boundingBox();
    expect(logoBox?.width).toBe(34);
    expect(logoBox?.height).toBe(34);
    await expect(logo).toHaveAttribute('viewBox', '0 0 877.07 877.07');

    // IT NEVER SQUASHES. The rail is a flex row and the wordmark beside it
    // grows with the workspace name; without this the mark is what gives way.
    await expect(mark).toHaveCSS('flex-shrink', '0');

    /*
     * THE OFFICIAL TWO-TONE: a black field carrying a white letterform.
     *
     * Compared as a SET rather than per path, so re-exporting the same logo
     * with its paths in a different order stays green while a tinted or
     * recoloured variant — which is not the official mark — does not.
     */
    const fills = await logo
      .locator('path')
      .evaluateAll((paths) => paths.map((path) => getComputedStyle(path).fill).sort());
    expect(fills).toEqual(['rgb(0, 0, 0)', 'rgb(255, 255, 255)']);

    /*
     * DECORATIVE AT BOTH LEVELS, and the wordmark carries the name.
     *
     * The mark repeats what the text beside it already says, so a screen
     * reader that announced both would read the product's name twice. Asserted
     * on the span AND the SVG because hiding only one leaves the other
     * reachable.
     */
    await expect(mark).toHaveAttribute('aria-hidden', 'true');
    await expect(logo).toHaveAttribute('aria-hidden', 'true');
    await expect(mark).toHaveText('');
    // Locale-independent: the lockup still has a name, and none of it comes
    // from the mark.
    expect(((await brand.textContent()) ?? '').trim().length).toBeGreaterThan(0);
  });

  test('the navigation rows', async ({ page }) => {
    // `.nav-item { height:39px; border-radius:12px; padding:0 11px; gap:11px;
    //  font-size:11px; font-weight:650 }` with a 20px `.nav-icon` slot.
    const item = page.locator('.bs-sidebar').getByRole('link').first();
    expect((await item.boundingBox())?.height).toBe(39);
    await expect(item).toHaveCSS('border-radius', '12px');
    await expect(item).toHaveCSS('padding', '0px 11px');
    await expect(item).toHaveCSS('gap', '11px');
    await expect(item).toHaveCSS('font-size', '11px');
    await expect(item).toHaveCSS('font-weight', '650');
    expect((await page.locator('.bs-nav-icon').first().boundingBox())?.width).toBe(20);
  });

  test('the top bar', async ({ page }) => {
    // `.topbar { min-height:88px; gap:16px; padding-bottom:12px }`,
    // `.eyebrow { font-size:9px; font-weight:800; letter-spacing:.08em }`,
    // `.topbar h1 { font-size:24px; letter-spacing:-.04em }`.
    const bar = page.locator('.bs-topbar');
    expect((await bar.boundingBox())?.height).toBe(88);
    await expect(bar).toHaveCSS('column-gap', '16px');
    await expect(bar).toHaveCSS('padding-bottom', '12px');

    const eyebrow = page.getByTestId('page-eyebrow');
    await expect(eyebrow).toHaveCSS('font-size', '9px');
    await expect(eyebrow).toHaveCSS('font-weight', '800');
    await expect(eyebrow).toHaveCSS('letter-spacing', '0.72px');

    const heading = page.getByTestId('heading');
    await expect(heading).toHaveCSS('font-size', '24px');
    await expect(heading).toHaveCSS('letter-spacing', '-0.96px');
  });

  test('the top bar controls', async ({ page }) => {
    // `.search-button { width:230px; height:38px; border-radius:12px; font-size:10px }`
    // and `.icon-button { width:38px; height:38px; border-radius:12px }`.
    const search = page.getByTestId('topbar-search');
    const searchBox = await search.boundingBox();
    expect(searchBox?.width).toBe(230);
    expect(searchBox?.height).toBe(38);
    await expect(search).toHaveCSS('border-radius', '12px');
    await expect(search).toHaveCSS('font-size', '10px');

    const bell = page.getByTestId('topbar-notifications');
    const bellBox = await bell.boundingBox();
    expect(bellBox?.width).toBe(38);
    expect(bellBox?.height).toBe(38);
    await expect(bell).toHaveCSS('border-radius', '12px');
  });

  test('the rail cards and the surfaces', async ({ page }) => {
    // `.experience-current` and `.profile-button` — 16px radius, 10px/8px padding.
    for (const testId of ['workspace-switcher', 'profile-menu']) {
      await expect(page.getByTestId(testId)).toHaveCSS('border-radius', '16px');
    }
    // `.metric { border-radius:20px; padding:20px; background:rgba(255,255,255,.72) }`
    const metric = page.locator('[data-surface="card"]').first();
    await expect(metric).toHaveCSS('border-radius', '20px');
    await expect(metric).toHaveCSS('padding', '20px');
    await expect(metric).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.72)');
  });
});
