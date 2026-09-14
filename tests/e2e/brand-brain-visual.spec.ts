import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { E2E_VISUAL_FILE, type E2eVisualFixture } from './env';

/**
 * VISUAL PARITY with the pinned demo — docs/UI-FIDELITY-CONTRACT.md §5.
 *
 * WHY THIS FILE EXISTS. The Phase 5A Brand Brain screen passed typecheck, lint,
 * axe, a design-system audit and 273 Playwright assertions while being a
 * different design from the one that was approved: a lavender container behind
 * the orb, a black rounded square where the demo draws a transparent circle, the
 * customer's brand name where the demo says "Brand Brain", white cards where the
 * demo draws 12px dots, and a chat that floated over the page instead of living
 * inside the hero. Every one of those is invisible to a test that only asks
 * whether an element is present and reachable.
 *
 * TWO KINDS OF ASSERTION, AND THE FIRST IS THE BINDING ONE.
 *
 * 1. DOM GEOMETRY, measured against the demo's own numbers, transcribed here
 *    from the pinned snapshot. These are exact, they mean the same thing on
 *    every machine, and each one names the defect it would have caught.
 *
 * 2. NUMERICAL SCREENSHOT COMPARISON against committed baselines. Run by
 *    default; skipped where `BRANDSPACE_VISUAL_BASELINE` is explicitly `0`.
 *    The gate exists for one honest reason: this page uses a SYSTEM font stack,
 *    and two machines with different fonts installed rasterise the same layout
 *    differently. A baseline that has to be re-approved whenever the runner
 *    changes is the exact failure the contract forbids — "A baseline is never
 *    updated to make a failing test pass" — so the environment-independent half
 *    is what gates the build, and the pixel half is a tight check run where the
 *    baseline was produced.
 *
 * DYNAMICS ARE FROZEN, NOT TOLERATED. The project sets `reducedMotion: reduce`,
 * so the orb draws ONE static frame (D-86) instead of a different one every
 * millisecond. The canvas itself is still MASKED: its particle field is seeded
 * from `Math.random()` and its rotation from a frame timestamp, so it is the one
 * genuinely non-deterministic thing on the page. Everything the contract is
 * about — the stage, the centre, the nodes, the hero, the grid, the chat — is
 * DOM, is deterministic, and is compared.
 */

const PIXEL_COMPARISON = process.env['BRANDSPACE_VISUAL_BASELINE'] !== '0';

function fixture(): E2eVisualFixture {
  try {
    return JSON.parse(readFileSync(E2E_VISUAL_FILE, 'utf8')) as E2eVisualFixture;
  } catch {
    throw new Error(
      'The visual fixture is missing. Run `pnpm e2e:seed` first — `pnpm test:e2e` does it for you.',
    );
  }
}

/* --- the demo's own numbers, transcribed ---------------------------------- */

/**
 * Every value below is quoted from `docs/visual-reference/brand-brain-native/`
 * at the pinned commit. They are duplicated here rather than imported so that
 * an edit to the stylesheet cannot make this file agree with it: a test that
 * reads its expectations from the thing under test asserts nothing.
 */
const DEMO = {
  stageMinHeightDesktop: 570,
  stageMinHeightMobile: 470,
  centreDiameterDesktop: 122,
  centreDiameterMobile: 104,
  nodeDiameterDesktop: 12,
  nodeDiameterMobile: 11,
  heroPaddingDesktop: 24,
  heroPaddingMobile: 16,
  heroRadiusDesktop: 24,
  heroRadiusMobile: 20,
  /** `minmax(0,1.22fr) minmax(320px,.78fr)` — the orb column is the wider one. */
  heroColumnRatio: 1.22 / 0.78,
  orbitNodes: 6,
  areaCards: 10,
} as const;

const MOBILE = { width: 390, height: 844 };

/* --- helpers -------------------------------------------------------------- */

async function signIn(page: Page, locale: 'en' | 'ar'): Promise<void> {
  const { email, password, workspaceSlug } = fixture();
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/sign-in`);
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL(
    (url) => !url.pathname.endsWith('/sign-in') || url.searchParams.has('error'),
  );

  /*
   * THE CHOOSER IS NOT OPTIONAL. Sign-in lands on it whenever no workspace is
   * active, and navigating straight to the route from there bounces back to it
   * — which is how this suite first failed, with every assertion reporting that
   * the orb was missing from a page that was never the Brand Brain page.
   */
  await page.click(`[data-testid="choose-workspace-${workspaceSlug}"]`);
  await page.waitForURL(new RegExp(`/${locale}/overview$`));

  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/brand-brain`);
  await settle(page);
}

/**
 * Wait for everything that legitimately changes after load.
 *
 * Fonts first: a screenshot taken before they resolve photographs the fallback
 * and differs from one taken after. Then the orb, which positions its nodes on
 * its first frame — before that they are all stacked at the centre.
 */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByTestId('brand-orb')).toBeVisible();
  await expect(page.getByTestId('orb-node-IDENTITY')).toBeVisible();
  // The first animation frame has run once a node has moved off the centre.
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const node = document.querySelector<HTMLElement>('[data-testid="orb-node-IDENTITY"]');
        return node ? Number.parseFloat(node.style.left || '0') : 0;
      }),
    )
    .toBeGreaterThan(0);
}

async function box(locator: Locator): Promise<{ width: number; height: number }> {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error('element has no box');
  return { width: bounds.width, height: bounds.height };
}

const style = (locator: Locator, property: string): Promise<string> =>
  locator.evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), property);

/**
 * Take the comparison shot, with the particle field hidden rather than MASKED.
 *
 * The difference matters and cost a round to find. The canvas is
 * `position: absolute; inset: 0`, so it covers the entire stage — and
 * Playwright's `mask` paints an opaque box over the masked element, which means
 * masking the canvas also hides the STAGE BEHIND IT. A lavender container
 * planted behind the orb passed the pixel comparison for exactly that reason:
 * the comparison could not see the thing the contract cares most about.
 *
 * Hiding it with `visibility: hidden` removes the non-deterministic pixels and
 * nothing else: the stage's own background, the centre, the hint and the six
 * dots all stay in the image and are all compared.
 */
async function shot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!PIXEL_COMPARISON) return;
  await page.addStyleTag({ content: '.bb-orb-canvas { visibility: hidden !important; }' });
  try {
    await expect(target ?? page).toHaveScreenshot(name);
  } finally {
    // Undo it, so a later assertion in the same test sees the real page.
    await page.addStyleTag({ content: '.bb-orb-canvas { visibility: visible !important; }' });
  }
}

/* --- the orb ------------------------------------------------------------- */

test.describe('the orb matches the approved demo', () => {
  test('the stage, the centre and the nodes are the demo’s, on desktop', async ({ page }) => {
    await signIn(page, 'en');

    const stage = page.getByTestId('brand-orb');
    const stageBox = await box(stage);
    expect(stageBox.height).toBeGreaterThanOrEqual(DEMO.stageMinHeightDesktop);

    /*
     * THE DEFECT THIS CATCHES: a lavender container behind the orb. The demo's
     * stage is TRANSPARENT — the particles are drawn on the hero's own frosted
     * panel — and Phase 5A gave it a filled surface.
     */
    expect(await style(stage, 'background-color')).toBe('rgba(0, 0, 0, 0)');
    expect(await style(stage, 'background-image')).toBe('none');

    /*
     * THE DEFECT THIS CATCHES: a black rounded square in the middle. The demo's
     * centre is a transparent 122px CIRCLE with no fill and no border.
     */
    const centre = page.getByTestId('orb-center');
    const centreBox = await box(centre);
    expect(Math.round(centreBox.width)).toBe(DEMO.centreDiameterDesktop);
    expect(Math.round(centreBox.height)).toBe(DEMO.centreDiameterDesktop);
    expect(await style(centre, 'background-color')).toBe('rgba(0, 0, 0, 0)');
    expect(await style(centre, 'border-radius')).toBe('50%');

    /*
     * THE DEFECT THIS CATCHES: the customer's brand name in the centre. The
     * approved demo shows the PRODUCT's name there, in both languages.
     */
    await expect(centre).toContainText('Brand');
    await expect(centre).toContainText('Brain');
    await expect(centre).not.toContainText(fixture().brandName);

    /*
     * THE DEFECT THIS CATCHES: white rectangular cards instead of dots. The
     * demo's node is a 12px circle with a radial-gradient fill.
     */
    const node = page.getByTestId('orb-node-IDENTITY');
    /*
     * THE CSS BOX, NOT THE PAINTED ONE. A node carries the demo's own depth
     * `scale()` — between 0.82 and 1.04 depending on where it is in its orbit —
     * so its bounding box is a moving target while its declared size is not.
     * Both are asserted: the size here, the scale range below.
     */
    expect(await style(node, 'width')).toBe(`${DEMO.nodeDiameterDesktop}px`);
    expect(await style(node, 'height')).toBe(`${DEMO.nodeDiameterDesktop}px`);
    expect(await style(node, 'border-radius')).toBe('50%');
    expect(await style(node, 'background-image')).toContain('radial-gradient');

    // `scale = .82 + z * .22`, so every node sits inside [0.82, 1.04].
    const scales = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('.bb-orbit-node')).map((element) =>
        Number.parseFloat(/scale\(([0-9.]+)\)/.exec(element.style.transform)?.[1] ?? '0'),
      ),
    );
    expect(scales).toHaveLength(6);
    for (const value of scales) {
      expect(value).toBeGreaterThanOrEqual(0.82);
      expect(value).toBeLessThanOrEqual(1.04);
    }

    /*
     * THE DEFECT THIS CATCHES: moving all ten knowledge areas into the orb. The
     * demo carries six dots and its grid carries the rest (D-87).
     */
    await expect(page.locator('.bb-orbit-node')).toHaveCount(DEMO.orbitNodes);
    await expect(page.getByTestId('area-grid').locator('button')).toHaveCount(DEMO.areaCards);

    await shot(page, 'orb-desktop-en.png', page.getByTestId('brand-brain-hero'));
  });

  test('the hero keeps the demo’s two-column proportion', async ({ page }) => {
    await signIn(page, 'en');

    const stage = await box(page.getByTestId('brand-orb'));
    const stats = await box(page.getByTestId('hero-stats'));

    // `minmax(0,1.22fr) minmax(320px,.78fr)`. The tolerance absorbs the 24px
    // gap and sub-pixel rounding, not a different layout.
    expect(stage.width / stats.width).toBeGreaterThan(DEMO.heroColumnRatio - 0.25);
    expect(stage.width / stats.width).toBeLessThan(DEMO.heroColumnRatio + 0.25);

    const hero = page.getByTestId('brand-brain-hero');
    expect(await style(hero, 'padding-top')).toBe(`${DEMO.heroPaddingDesktop}px`);
    expect(await style(hero, 'border-radius')).toBe(`${DEMO.heroRadiusDesktop}px`);
  });

  test('the mobile breakpoint is the demo’s, not a different design', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await signIn(page, 'en');

    const stage = await box(page.getByTestId('brand-orb'));
    expect(stage.height).toBeGreaterThanOrEqual(DEMO.stageMinHeightMobile);

    expect(await style(page.getByTestId('orb-center'), 'width')).toBe(
      `${DEMO.centreDiameterMobile}px`,
    );

    expect(await style(page.getByTestId('orb-node-IDENTITY'), 'width')).toBe(
      `${DEMO.nodeDiameterMobile}px`,
    );

    const hero = page.getByTestId('brand-brain-hero');
    expect(await style(hero, 'padding-top')).toBe(`${DEMO.heroPaddingMobile}px`);
    expect(await style(hero, 'border-radius')).toBe(`${DEMO.heroRadiusMobile}px`);

    // One column below 1100px, which is what stacks the panel under the orb.
    const stats = await box(page.getByTestId('hero-stats'));
    expect(Math.abs(stage.width - stats.width)).toBeLessThan(2);

    // And nothing overflows sideways at phone width.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    await shot(page, 'orb-mobile-en.png', page.getByTestId('brand-brain-hero'));
  });
});

/* --- right to left -------------------------------------------------------- */

test.describe('Arabic renders the same design, mirrored', () => {
  test('the page is RTL and the orb is unchanged', async ({ page }) => {
    await signIn(page, 'ar');

    expect(await page.getAttribute('html', 'dir')).toBe('rtl');

    // The orb is a circle in a symmetric stage: mirroring the page must NOT
    // change its geometry, and a value that differs from the LTR run means
    // something physical crept into the layout.
    const centre = await box(page.getByTestId('orb-center'));
    expect(Math.round(centre.width)).toBe(DEMO.centreDiameterDesktop);
    await expect(page.locator('.bb-orbit-node')).toHaveCount(DEMO.orbitNodes);

    // The centre says "Brand Brain" in Arabic, not the brand's name.
    await expect(page.getByTestId('orb-center')).not.toContainText(fixture().brandName);

    // The stats panel sits on the LEFT in Arabic, which is the same logical
    // position it holds on the right in English.
    const stage = await page.getByTestId('brand-orb').boundingBox();
    const stats = await page.getByTestId('hero-stats').boundingBox();
    expect(stats!.x).toBeLessThan(stage!.x);

    await shot(page, 'orb-desktop-ar.png', page.getByTestId('brand-brain-hero'));
  });

  test('the Arabic phone layout holds together', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await signIn(page, 'ar');

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    await shot(page, 'orb-mobile-ar.png', page.getByTestId('brand-brain-hero'));
  });
});

/* --- chat ---------------------------------------------------------------- */

test.describe('the chat lives inside the hero', () => {
  test('opening it SWAPS the stats view and changes nothing else', async ({ page }) => {
    await signIn(page, 'en');

    const heroBefore = await box(page.getByTestId('brand-brain-hero'));
    const stageBefore = await box(page.getByTestId('brand-orb'));

    await page.getByTestId('orb-center').click();
    const chat = page.getByTestId('brand-chat');
    await expect(chat).toBeVisible();

    /*
     * THE DEFECT THIS CATCHES: a chat that floats over the page. The demo's
     * `.bb-hero-stats.chat-open` hides the stats and shows the chat in the SAME
     * fixed-height box, so opening it must not move or resize anything.
     */
    await expect(page.getByTestId('stats-view')).toBeHidden();
    expect(await style(chat, 'position')).toBe('static');

    const heroAfter = await box(page.getByTestId('brand-brain-hero'));
    const stageAfter = await box(page.getByTestId('brand-orb'));
    expect(Math.abs(heroAfter.height - heroBefore.height)).toBeLessThan(2);
    expect(Math.abs(stageAfter.width - stageBefore.width)).toBeLessThan(2);

    // The chat occupies the panel the stats vacated, to the pixel.
    const chatBox = await box(chat);
    const panel = await box(page.getByTestId('hero-stats'));
    expect(Math.abs(chatBox.height - panel.height)).toBeLessThan(2);

    await shot(page, 'chat-open-desktop-en.png', page.getByTestId('brand-brain-hero'));
  });

  test('the panel does not grow when a message is sent', async ({ page }) => {
    await signIn(page, 'en');
    await page.getByTestId('orb-center').click();

    const chat = page.getByTestId('brand-chat');
    await expect(chat).toBeVisible();
    const before = await box(chat);

    await page.fill('[data-testid="chat-input"]', 'What is our positioning?');
    await page.getByTestId('chat-send').click();
    await expect(
      page.getByTestId('chat-insufficient').or(page.getByTestId('chat-message-assistant')).first(),
    ).toBeVisible({ timeout: 20_000 });

    const after = await box(chat);
    expect(Math.abs(after.height - before.height)).toBeLessThan(2);
  });
});

/* --- drawer --------------------------------------------------------------- */

test.describe('the area drawer', () => {
  test('opens over the page without moving it', async ({ page }) => {
    await signIn(page, 'en');

    const heroBefore = await box(page.getByTestId('brand-brain-hero'));

    await page.getByTestId('area-card-IDENTITY').click();
    const drawer = page.getByTestId('area-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute('aria-modal', 'true');

    const heroAfter = await box(page.getByTestId('brand-brain-hero'));
    expect(Math.abs(heroAfter.width - heroBefore.width)).toBeLessThan(2);

    await shot(page, 'drawer-open-desktop-en.png');
  });

  test('opens on the correct side in Arabic', async ({ page }) => {
    await signIn(page, 'ar');

    await page.getByTestId('area-card-IDENTITY').click();
    const drawer = page.getByTestId('area-drawer');
    await expect(drawer).toBeVisible();

    /*
     * Logical inline-end, which in RTL is the LEFT edge. A physical `right`
     * anywhere in the drawer's styles would put it on the wrong side.
     *
     * Asserted as "in the left half", not "at x = 0": the shell insets the
     * drawer from the edge, and pinning the exact inset here would make this
     * test fail on a spacing change rather than on the thing it is about.
     */
    const bounds = (await drawer.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(bounds.x + bounds.width / 2).toBeLessThan(viewport.width / 2);

    await shot(page, 'drawer-open-desktop-ar.png');
  });
});

/* --- the fixture itself --------------------------------------------------- */

test.describe('the fixture is what the baseline was taken against', () => {
  test('the page shows the numbers the seed produced', async ({ page }) => {
    await signIn(page, 'en');
    const expected = fixture();

    /*
     * THE GUARD ON EVERY SCREENSHOT ABOVE. If the fixture drifts — an extra
     * knowledge item, a different completion rule — the pixel comparison would
     * fail and the tempting fix would be to re-approve the baseline. This makes
     * the drift itself the failure, and names it.
     */
    await expect(page.getByTestId('metric-items')).toHaveText(String(expected.knowledgeItems));
    await expect(page.getByTestId('metric-sources')).toHaveText(String(expected.sourceDocuments));
    await expect(page.getByTestId('completion-percent')).toHaveText(/^\d{1,3}%$/);
  });
});
