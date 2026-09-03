import { readFileSync } from 'node:fs';
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

/**
 * The furthest any VISIBLE element extends past the viewport's inline-end edge.
 *
 * MEASURED BY FINDING THE ELEMENT, not by a page-level proxy — and the two
 * proxies both proved unreliable here:
 *
 *   - `scrollWidth - clientWidth` counts content parked at negative offsets.
 *     Next.js puts its route announcer at `left: -10px` and the skip link at
 *     `-2px`, so it reported a 10px "overflow" on pages with nothing overflowing.
 *   - Actually scrolling has the same problem: Chromium's scrollable region
 *     includes that announcer, so `scrollTo(9999)` really does move 10px.
 *
 * Neither is the requirement. The requirement is that no content a reader is
 * meant to see sits past the edge of the screen. So this walks the DOM, skips
 * anything already clipped by a scrolling ancestor (a wide table is SUPPOSED to
 * scroll inside its own box) and anything with no area (off-screen affordances),
 * and returns the worst overhang together with the element responsible — which
 * also makes a failure diagnosable instead of a bare number.
 *
 * Direction-aware: in Arabic the inline-end edge is the left one.
 */
async function inlineEndOverhang(page: Page): Promise<{ px: number; offender: string }> {
  return page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    const rtl = getComputedStyle(document.documentElement).direction === 'rtl';
    let worst = 0;
    let offender = 'none';

    for (const element of Array.from(document.querySelectorAll('*'))) {
      const box = element.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) continue;

      const overhang = rtl ? -box.left : box.right - viewport;
      if (overhang <= 1 || overhang <= worst) continue;

      // Clipped by a scrolling ancestor that itself fits? Then it is scrolling
      // inside its own box, which is the intended behaviour.
      let ancestor = element.parentElement;
      let clipped = false;
      while (ancestor) {
        const style = getComputedStyle(ancestor);
        if (style.overflowX !== 'visible') {
          const ancestorBox = ancestor.getBoundingClientRect();
          const ancestorOverhang = rtl ? -ancestorBox.left : ancestorBox.right - viewport;
          if (ancestorOverhang <= 1) {
            clipped = true;
            break;
          }
        }
        ancestor = ancestor.parentElement;
      }
      if (clipped) continue;

      worst = overhang;
      const testId = (element as HTMLElement).dataset['testid'] ?? '';
      offender = `${element.tagName}${testId ? `[${testId}]` : ''} w=${Math.round(box.width)}`;
    }

    return { px: Math.round(worst), offender };
  });
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
    // Still signed in, still in the workspace: the preference is a display
    // choice in localStorage and touches no session or authorization.
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

    await page.evaluate(() => {
      const planted = document.createElement('div');
      planted.dataset['testid'] = 'planted-overflow';
      planted.style.cssText = 'inline-size:900px;block-size:20px;background:red';
      document.querySelector('main')?.appendChild(planted);
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
    await expect(
      page.getByTestId('preview-failed-missing').getByTestId('preview-media-missing'),
    ).toBeVisible();
    await expect(
      page.getByTestId('preview-loading').getByTestId('preview-media-loading'),
    ).toBeVisible();
    await expect(
      page.getByTestId('preview-story').getByTestId('preview-video-badge'),
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
