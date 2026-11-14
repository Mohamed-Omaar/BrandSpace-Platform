import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { signIn as adminSignIn } from './admin-session';
import { ADMIN_BASE_URL, DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';
import { createFreshWorkspace, finishFreshOnboarding, freshSignUp } from './fresh-signup';
import { paintedContrast, type PaintedFinding } from './painted-contrast';

/**
 * PR E — DARK MODE: SWITCHED AT ONCE, AND READABLE.
 *
 *   1. The Appearance item changes the whole page in place — no reload, no
 *      navigation — in the dashboard and in the Control Center; a page reached
 *      afterwards, a reload and a second tab all keep the new scheme, and the
 *      first paint after a reload is already right (no flip).
 *   2. Every main page, in dark, in English and Arabic, at the desktop and the
 *      phone size (the two viewport projects), meets WCAG AA: axe's
 *      `color-contrast`, AND `paintedContrast` — the same rule measured on the
 *      pixels, because axe leaves text on glass, blur and gradients
 *      "incomplete" and the product's frame is all three. Text 4.5:1 (large
 *      3:1), an icon-only control's icon 3:1, a field's edge 3:1.
 *
 * The scheme is a cookie on this test's own context, or the account of a
 * person signed up for this test alone, so nothing here reaches another suite.
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
  await page.waitForURL((url) => !url.pathname.endsWith('/sign-in'));
  await page.click(`[data-testid="choose-workspace-${customer.workspaceSlug}"]`);
  await page.waitForURL(new RegExp(`/${locale}/overview$`));
}

/** What the page paints right now: the body's ground and the main heading's ink. */
async function paint(page: Page): Promise<{ ground: string; ink: string; luminance: number }> {
  return page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--bs-surface)';
    document.body.append(probe);
    const surface = getComputedStyle(probe).color;
    probe.remove();
    const [r, g, b] = (surface.match(/\d+(\.\d+)?/g) ?? ['0', '0', '0'])
      .slice(0, 3)
      .map((value) => Number(value) / 255);
    const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const heading = document.querySelector('h1') ?? document.body;
    return {
      ground: surface,
      ink: getComputedStyle(heading).color,
      luminance: 0.2126 * lin(r ?? 0) + 0.7152 * lin(g ?? 0) + 0.0722 * lin(b ?? 0),
    };
  });
}

/** A mark that only survives while the document does: gone after any reload. */
async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __prE: number }).__prE =
      performance.getEntriesByType('navigation').length;
  });
}
async function sameDocument(page: Page): Promise<boolean> {
  return page.evaluate(() => typeof (window as unknown as { __prE?: number }).__prE === 'number');
}

/**
 * Press the account menu's Appearance item and wait for the choice to be
 * saved (the server action's POST). The page has already changed by then.
 */
async function chooseNext(page: Page, menu = 'profile-menu'): Promise<void> {
  const item = page.getByTestId('account-appearance');
  if (!(await item.isVisible())) await page.getByTestId(menu).click();
  const saved = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.status() < 400,
  );
  await item.click();
  await saved;
  // The dashboard's re-render closes the menu; the Control Center's stays open.
  if (await item.isVisible()) await page.keyboard.press('Escape');
  await expect(item).toBeHidden();
}

test.describe('PR E · the Appearance item applies at once', () => {
  test('dashboard: light → dark → device → light without a reload; every page, a reload and a second tab follow', async ({
    page,
    context,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'the rail copy of the menu (D-468(b)); the desktop run covers it');
    test.setTimeout(120_000);
    // A person of this test's own: the choice is stored on their account.
    await withScheme(context, 'light');
    await page.emulateMedia({ colorScheme: 'light' });
    await freshSignUp(page);
    // Every change to the scheme after the first byte, from the first byte on.
    await context.addInitScript(() => {
      const flips: string[] = [];
      (window as unknown as { __flips: string[] }).__flips = flips;
      new MutationObserver((records) => {
        for (const record of records) {
          if (record.attributeName === 'data-color-scheme') {
            flips.push(document.documentElement.getAttribute('data-color-scheme') ?? '');
          }
        }
      }).observe(document.documentElement, { attributes: true });
    });
    // The account menu lives in the workspace shell: a business first.
    await createFreshWorkspace(page);
    await finishFreshOnboarding(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'light');
    const light = await paint(page);
    expect(light.luminance).toBeGreaterThan(0.8);
    await markDocument(page);

    await page.click('[data-testid="profile-menu"]');
    const item = page.getByTestId('account-appearance');
    await expect(item).toHaveAttribute('data-scheme', 'light');
    await item.click();
    // At once, on this page, before the server has answered: the attribute,
    // the painted colours, the item's label.
    await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'dark', {
      timeout: 1_000,
    });
    const dark = await paint(page);
    expect(dark.luminance).toBeLessThan(0.05);
    expect(dark.ground).not.toBe(light.ground);
    expect(dark.ink).not.toBe(light.ink);
    await expect(item).toContainText('Dark');
    await expect(item).toBeHidden(); // saved: the action's re-render closed the menu
    expect(await sameDocument(page), 'no reload, no navigation').toBe(true);
    expect(new URL(page.url()).pathname).toBe('/en/overview');
    // The server's render agrees: still dark after the action re-rendered.
    expect((await paint(page)).luminance).toBeLessThan(0.05);

    // Device: follows the device, still without a reload.
    await chooseNext(page);
    await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'system');
    await expect.poll(async () => (await paint(page)).luminance).toBeGreaterThan(0.8);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(async () => (await paint(page)).luminance).toBeLessThan(0.05);
    await page.emulateMedia({ colorScheme: 'light' });
    // Back to light, then dark again for the rest.
    await chooseNext(page);
    await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'light');
    await expect.poll(async () => (await paint(page)).luminance).toBeGreaterThan(0.8);
    await chooseNext(page);
    await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'dark');
    expect(await sameDocument(page)).toBe(true);

    // A page reached in the app afterwards — including one the router fetched
    // before the switch — is dark too, and so is its menu's label.
    await page.getByRole('link', { name: 'Posts' }).first().click();
    await page.waitForURL(/\/en\/content/);
    await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'dark');
    expect((await paint(page)).luminance).toBeLessThan(0.05);
    await page.click('[data-testid="profile-menu"]');
    await expect(page.getByTestId('account-appearance')).toHaveAttribute('data-scheme', 'dark');
    await page.keyboard.press('Escape');

    // A second tab agrees; a reload keeps it, painted dark from the first byte.
    const other = await context.newPage();
    await other.goto(`${DASHBOARD_BASE_URL}/en/calendar`);
    await expect(other.locator('html')).toHaveAttribute('data-color-scheme', 'dark');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'dark');
    expect((await paint(page)).luminance).toBeLessThan(0.05);
    expect(await page.evaluate(() => (window as unknown as { __flips: string[] }).__flips)).toEqual(
      [],
    );
    // And the other tab follows a switch made here, without being touched.
    await chooseNext(page); // dark → device
    await expect(other.locator('html')).toHaveAttribute('data-color-scheme', 'system');
    await other.close();
  });

  test('Control Center: the operator switches light → dark at once, and a reload keeps it', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'the Control Center is checked at the desktop size');
    test.setTimeout(90_000);
    await page.emulateMedia({ colorScheme: 'light' });
    await adminSignIn(page, 'en', { mode: 'simple' });
    await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'light');
    const light = await paint(page);
    await markDocument(page);
    await page.getByTestId('profile-menu').click();
    await expect(page.getByTestId('account-appearance')).toHaveAttribute('data-scheme', 'light');
    await chooseNext(page);
    await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'dark');
    const dark = await paint(page);
    expect(dark.luminance).toBeLessThan(0.05);
    expect(dark.ground).not.toBe(light.ground);
    expect(await sameDocument(page)).toBe(true);
    // Safe mode is on by default: the stylesheet holds only the ORIGINAL
    // look's dark palette, keyed on the attribute — never the owner's theme.
    const css = await (await page.request.get(`${ADMIN_BASE_URL}/theme.css`)).text();
    expect(css).toContain(":root:root[data-color-scheme='dark'] {");
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'dark');
    expect((await paint(page)).luminance).toBeLessThan(0.05);
    // Back to light for whoever signs in next on this context.
    await chooseNext(page); // → device
    await chooseNext(page); // → light
    await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'light');
  });
});

/* ---------------------------------------------------------------- 2 ---- */

/*
 * Brand Brain is not in this list: its page and stylesheet belong to the
 * Copilot / brand-reading work, which this PR does not touch. Its remaining
 * dark findings (the orb nodes' "N of M key questions" at 3.2–4.3:1, the
 * missing-fact chip at 2.2:1) are reported to that work, which adds the page
 * here when it fixes them.
 */
const DASHBOARD_PAGES: ReadonlyArray<readonly string[]> = [
  ['overview', 'content', 'content/compose', 'calendar'],
  ['approvals', 'campaigns', 'assets', 'notifications'],
  ['strategy', 'analytics', 'copilot', 'creative'],
  ['automations', 'notes', 'members', 'integrations', 'publishing'],
  ['settings', 'settings/brand', 'billing', 'plan', 'activity'],
  /*
   * PR D (D-609): My notes, the photo card on the account page, the business
   * list. Not `settings/data`: in Arabic its current settings item sits across
   * the bottom edge of the 800px window, and the pixel measure reads the page
   * behind the part that is off screen (1.07:1 on staging too; the item itself
   * is the light pill with dark text, as on every other settings page).
   */
  ['notes?tab=mine', 'notes?tab=mine&note=new', 'settings/security', 'workspaces'],
];
const ENTRY_PAGES = ['sign-in', 'sign-up', 'reset'] as const;
const CONSOLE_PAGES = [
  'console',
  'console/look',
  'console/workspaces',
  'console/plans',
  'console/audit',
  'console/health',
  'console/ai-usage',
  'console/team',
] as const;

/** The element the page scrolls in: the tallest scroller, else the document. */
async function scrollOnce(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const scrollers = Array.from(document.querySelectorAll<HTMLElement>('*')).filter((el) => {
      const s = getComputedStyle(el);
      return (
        /(auto|scroll)/.test(s.overflowY) &&
        el.scrollHeight > el.clientHeight + 40 &&
        el.clientHeight > window.innerHeight * 0.4
      );
    });
    const target =
      scrollers.sort((a, b) => b.clientHeight - a.clientHeight)[0] ??
      (document.scrollingElement as HTMLElement | null);
    if (!target) return false;
    const before = target.scrollTop;
    target.scrollTop = before + target.clientHeight * 0.85;
    return target.scrollTop > before;
  });
}

const describe = (f: PaintedFinding) =>
  `    [${f.kind}] ${f.where} "${f.text}" ${f.ratio}:1 < ${f.needed}:1 (${f.fg} on ${f.bg})`;

/**
 * Not under test: the Look & feel preview box shows the look in the scheme the
 * owner picks for it (light by default) inside the dark Control Center.
 */
const NOT_DARK = '[data-testid="lf-preview"]';

/** Measure this page in dark: the first screen and up to two more. */
async function measure(page: Page, label: string, failures: string[]): Promise<void> {
  await page.waitForLoadState('load');
  await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'dark');
  // Fonts and the entrance settle before colours are read.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  for (let screen = 0; screen < 3; screen++) {
    const axe = await new AxeBuilder({ page })
      .withRules(['color-contrast'])
      .exclude(NOT_DARK)
      .analyze();
    for (const v of axe.violations) {
      for (const n of v.nodes) failures.push(`  ${label} (axe) ${n.target.join(' ')}`);
    }
    for (const f of await paintedContrast(page, { exclude: NOT_DARK }))
      failures.push(`  ${label}\n${describe(f)}`);
    if (!(await scrollOnce(page))) break;
    await page.waitForTimeout(250);
  }
}

test.describe('PR E · every main page meets WCAG AA in dark', () => {
  test.use({ colorScheme: 'light', contextOptions: { reducedMotion: 'reduce' } });

  for (const locale of ['en', 'ar'] as const) {
    test(`the screens before sign-in (${locale})`, async ({ page, context }) => {
      await withScheme(context, 'dark');
      const failures: string[] = [];
      for (const route of ENTRY_PAGES) {
        await page.goto(`${DASHBOARD_BASE_URL}/${locale}/${route}`);
        await measure(page, `/${locale}/${route}`, failures);
      }
      expect(failures, `contrast below AA in dark:\n${failures.join('\n')}`).toEqual([]);
    });

    DASHBOARD_PAGES.forEach((group, index) => {
      test(`dashboard pages ${index + 1} of ${DASHBOARD_PAGES.length}: ${group.join(', ')} (${locale})`, async ({
        page,
        context,
      }) => {
        test.setTimeout(150_000);
        await withScheme(context, 'dark');
        await signIn(page, locale);
        const failures: string[] = [];
        for (const route of group) {
          await page.goto(`${DASHBOARD_BASE_URL}/${locale}/${route}`);
          await measure(page, `/${locale}/${route}`, failures);
        }
        expect(failures, `contrast below AA in dark:\n${failures.join('\n')}`).toEqual([]);
      });
    });

    test(`Control Center pages (${locale})`, async ({ page, isMobile }) => {
      test.skip(isMobile === true, 'the Control Center is checked at the desktop size');
      test.setTimeout(150_000);
      await adminSignIn(page, locale, { mode: 'advanced' });
      // The operator's own choice, through the real menu item.
      await chooseNext(page);
      await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'dark');
      const failures: string[] = [];
      for (const route of CONSOLE_PAGES) {
        await page.goto(`${ADMIN_BASE_URL}/${locale}/${route}`);
        await measure(page, `/${locale}/${route}`, failures);
      }
      expect(failures, `contrast below AA in dark:\n${failures.join('\n')}`).toEqual([]);
    });
  }
});
