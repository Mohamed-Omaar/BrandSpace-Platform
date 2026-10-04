import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { signIn } from './own-workspace';

/**
 * D-468 — SIDE-BY-SIDE EVIDENCE: the vendored prototype and the product, the
 * same screen at 1440×900, in English and in Arabic.
 *
 * OPT-IN (`BRANDSPACE_PARITY=1`) and assertion-free on purpose: it writes the
 * screenshot pairs a batch PR attaches for the owner, and the eye that compares
 * them is a person's. Every behavioural and accessibility assertion lives in the
 * functional suites, which run on every push; this one never does.
 *
 * The prototype is opened straight from `docs/visual-reference/` (never copied
 * or edited) and switched to Arabic the way its own sign-up hand-off does.
 */

const OUT = process.env['BRANDSPACE_PARITY_DIR'] ?? path.join(process.cwd(), 'test-results/parity');
const PROTOTYPE = pathToFileURL(
  path.join(process.cwd(), 'docs/visual-reference/prototype-2026-09-27/Main.dc.html'),
).href;

/**
 * THE PROTOTYPE'S FONTS, SERVED LOCALLY. Its `<link>` asks Google Fonts for
 * Inter and Cairo; the run answers that request with the same @fontsource faces
 * the product self-hosts, so both sides of every pair are set in the same
 * typefaces whatever the network allows. Nothing in the prototype is edited.
 */
const fontsource = createRequire(path.join(process.cwd(), 'apps/dashboard/package.json'));
const FONT_HOST = 'https://fonts.gstatic.com/__fontsource';
function fontCss(): string {
  return (['inter', 'cairo'] as const)
    .flatMap((family) =>
      [400, 500, 600, 700, 800].map((weight) =>
        readFileSync(fontsource.resolve(`@fontsource/${family}/${weight}.css`), 'utf8').replaceAll(
          './files/',
          `${FONT_HOST}/${family}/`,
        ),
      ),
    )
    .join('\n');
}
async function serveFonts(page: Page): Promise<void> {
  await page.route('https://fonts.googleapis.com/**', (route) =>
    route.fulfill({ contentType: 'text/css', body: fontCss() }),
  );
  await page.route(`${FONT_HOST}/**`, (route) => {
    const [family, file] = new URL(route.request().url()).pathname.split('/').slice(-2);
    return route.fulfill({
      path: path.join(
        path.dirname(fontsource.resolve(`@fontsource/${family}/400.css`)),
        'files',
        file ?? '',
      ),
      headers: { 'access-control-allow-origin': '*' },
    });
  });
}

/** The prototype's own rail: press the item with this English / Arabic name. */
const viaRail =
  (en: string, ar: string) =>
  async (page: Page): Promise<void> => {
    await page
      // An item may carry its count badge after the name ("Approvals 2").
      .locator('nav .nav', { hasText: new RegExp(`^\\s*(${en}|${ar})\\s*\\d*\\s*$`) })
      .first()
      .click();
  };

/** Then press the first control with this English / Arabic name. */
const thenPress =
  (open: (page: Page) => Promise<void>, en: string, ar: string) =>
  async (page: Page): Promise<void> => {
    await open(page);
    await page
      .getByRole('button', { name: new RegExp(`^\\s*\\+?\\s*(${en}|${ar})\\s*$`) })
      .first()
      .click();
  };

/** The screens of a batch: the product route, and how the prototype is brought to it. */
const SCREENS: readonly {
  readonly key: string;
  readonly route: string;
  readonly prototype?: (page: Page) => Promise<void>;
  /** After the route: how the product is brought to the same screen. */
  readonly product?: (page: Page) => Promise<void>;
}[] = [
  { key: 'home', route: '/overview' },
  { key: 'calendar', route: '/calendar', prototype: viaRail('Calendar', 'التقويم') },
  { key: 'posts', route: '/content', prototype: viaRail('Posts', 'المنشورات') },
  { key: 'approvals', route: '/approvals', prototype: viaRail('Approvals', 'الموافقات') },
  { key: 'campaigns', route: '/campaigns', prototype: viaRail('Campaigns', 'الحملات') },
  { key: 'media', route: '/assets', prototype: viaRail('Media', 'الوسائط') },
  {
    key: 'media-generate',
    route: '/creative',
    prototype: thenPress(viaRail('Media', 'الوسائط'), 'Generate', 'توليد'),
  },
  {
    key: 'studio',
    route: '/content/compose?mode=write',
    prototype: thenPress(viaRail('Posts', 'المنشورات'), 'New post', 'منشور جديد'),
  },
  {
    key: 'studio-post',
    route: '/content',
    prototype: thenPress(viaRail('Posts', 'المنشورات'), 'Continue', 'كمّل'),
    product: async (page) => {
      await page.locator('[data-testid^="content-edit-"]').first().click();
      await page.waitForURL(/content\/compose\?item=/);
    },
  },
];

/**
 * The first 1440×900 view, then the rest of the screen: both sides scroll a
 * `<main>`, which is stepped a viewport at a time (less a 120px overlap) and
 * shot again, up to four frames — `-1` is the first view, `-2` the next.
 */
async function shoot(page: Page, file: (frame: number) => string): Promise<void> {
  for (let frame = 1; frame <= 4; frame += 1) {
    await page.screenshot({ path: file(frame) });
    const moved = await page.evaluate(() => {
      const main = document.querySelector('main');
      if (!main) return false;
      const before = main.scrollTop;
      main.scrollTop = before + main.clientHeight - 120;
      return main.scrollTop > before;
    });
    if (!moved) return;
    await page.waitForTimeout(700);
  }
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1200);
}

test.describe('prototype parity screenshots (D-468)', () => {
  test.skip(process.env['BRANDSPACE_PARITY'] !== '1', 'opt-in evidence, not a check');
  test.use({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  // Two full pages, a sign-in and two font loads per test: more than the default.
  test.setTimeout(120_000);

  for (const screen of SCREENS) {
    for (const locale of ['en', 'ar'] as const) {
      test(`${screen.key} — ${locale}`, async ({ page, browser }) => {
        mkdirSync(OUT, { recursive: true });

        const proto = await browser.newPage({
          viewport: { width: 1440, height: 900 },
          ignoreHTTPSErrors: true,
        });
        await serveFonts(proto);
        if (locale === 'ar') {
          await proto.addInitScript(() =>
            window.localStorage.setItem('bs.handoff', JSON.stringify({ lang: 'ar' })),
          );
        }
        await proto.goto(PROTOTYPE, { waitUntil: 'networkidle' });
        if (screen.prototype) await screen.prototype(proto);
        await settle(proto);
        await shoot(proto, (n) => path.join(OUT, `${screen.key}-${locale}-${n}-prototype.png`));
        await proto.close();

        await signIn(page, locale);
        await page.goto(`${DASHBOARD_BASE_URL}/${locale}${screen.route}`);
        if (screen.product) await screen.product(page);
        await settle(page);
        await shoot(page, (n) => path.join(OUT, `${screen.key}-${locale}-${n}-product.png`));
      });
    }
  }
});
