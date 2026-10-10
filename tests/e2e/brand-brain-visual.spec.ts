import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { scaled } from './scale';
import { E2E_VISUAL_FILE, type E2eVisualFixture } from './env';

/**
 * VISUAL PARITY with the approved prototype — docs/UI-FIDELITY-CONTRACT.md §5.
 *
 * REPLACED (D-468, batch 4): the numbers below were the `brand-brain-native`
 * demo's; the prototype `prototype-2026-09-27/Main.dc.html` (lines 757–926)
 * superseded it, so they are now the prototype's, and the baselines were
 * re-taken from the ported screen in the same change. The rules stay: the
 * stage is transparent, the centre is an empty transparent circle and never
 * the brand's name, the nodes are dots, six of them, and the rest is DOM.
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

/* --- the prototype's own numbers, transcribed ---------------------------- */

/**
 * Quoted from `docs/visual-reference/prototype-2026-09-27/Main.dc.html`:
 * the hero is `.card` with `padding: 0; grid-template-columns: 450px
 * minmax(0, 1fr)`; the orb column `min-height: 400px` over a `min-height:
 * 362px` stage; the centre a 96px transparent circle; a node a 7px dot with a
 * 3px white ring; six nodes, ten area cards four across; the chat card 600px.
 * Duplicated here, not imported, so an edit to the stylesheet cannot make this
 * file agree with it.
 */
/*
 * The prototype's own values. D-484: the product draws them at 0.88
 * (`scaled()` in `scale.ts`), so every comparison below scales them.
 */
const PROTO = {
  orbColumn: 450,
  orbColumnMinHeight: 400,
  stageMinHeight: 362,
  centreDiameter: 96,
  nodeDot: 11,
  heroPadding: 0,
  cardRadius: 22,
  orbitNodes: 6,
  areaCards: 10,
  areaColumns: 4,
  chatHeight: 600,
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
  await page.addStyleTag({ content: '.bsp-bb-canvas { visibility: hidden !important; }' });
  try {
    await expect(target ?? page).toHaveScreenshot(name);
  } finally {
    // Undo it, so a later assertion in the same test sees the real page.
    await page.addStyleTag({ content: '.bsp-bb-canvas { visibility: visible !important; }' });
  }
}

/* --- the orb ------------------------------------------------------------- */

test.describe('the orb matches the approved prototype', () => {
  test('the stage, the centre and the nodes are the prototype’s, on desktop', async ({ page }) => {
    await signIn(page, 'en');

    const stage = page.getByTestId('brand-orb');
    expect((await box(stage)).height).toBeGreaterThanOrEqual(scaled(PROTO.stageMinHeight));

    // THE DEFECT THIS CATCHES: a filled container behind the orb. The stage is
    // TRANSPARENT; the particles are drawn on the hero card's own wash.
    expect(await style(stage, 'background-color')).toBe('rgba(0, 0, 0, 0)');
    expect(await style(stage, 'background-image')).toBe('none');

    // THE DEFECT THIS CATCHES: a filled centre. The prototype's is a 96px
    // transparent circle with nothing written in it — never the brand's name.
    const centre = page.getByTestId('orb-center');
    const centreBox = await box(centre);
    expect(Math.abs(centreBox.width - scaled(PROTO.centreDiameter))).toBeLessThanOrEqual(0.5);
    expect(Math.abs(centreBox.height - scaled(PROTO.centreDiameter))).toBeLessThanOrEqual(0.5);
    expect(await style(centre, 'background-color')).toBe('rgba(0, 0, 0, 0)');
    expect(await style(centre, 'border-radius')).toBe('50%');
    await expect(centre).toHaveText('');
    await expect(centre).not.toContainText(fixture().brandName);

    // THE DEFECT THIS CATCHES: cards instead of dots. A node is the prototype's
    // 7px dot (11px of colour inside a 3px white ring), round.
    const dot = page.getByTestId('orb-node-IDENTITY').locator('i');
    expect(await style(dot, 'width')).toBe(`${scaled(PROTO.nodeDot)}px`);
    expect(await style(dot, 'height')).toBe(`${scaled(PROTO.nodeDot)}px`);
    expect(await style(dot, 'border-radius')).toBe('50%');

    // `sc = 0.82 + z * 0.22`, so every node sits inside [0.82, 1.04].
    const scales = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('.bsp-bb-node')).map((element) =>
        Number.parseFloat(/scale\(([0-9.]+)\)/.exec(element.style.transform)?.[1] ?? '0'),
      ),
    );
    expect(scales).toHaveLength(PROTO.orbitNodes);
    for (const value of scales) {
      expect(value).toBeGreaterThanOrEqual(0.82);
      expect(value).toBeLessThanOrEqual(1.04);
    }

    // Six dots on the orb, all ten areas in the grid (D-87).
    await expect(page.locator('.bsp-bb-node')).toHaveCount(PROTO.orbitNodes);
    await expect(page.getByTestId('area-grid').locator('button')).toHaveCount(PROTO.areaCards);

    await shot(page, 'orb-desktop-en.png', page.getByTestId('brand-brain-hero'));
  });

  test('the hero keeps the prototype’s 450px orb column', async ({ page }) => {
    await signIn(page, 'en');

    const column = await box(page.locator('.bsp-bb-orbcol'));
    expect(Math.abs(column.width - scaled(PROTO.orbColumn))).toBeLessThanOrEqual(0.5);
    expect(column.height).toBeGreaterThanOrEqual(scaled(PROTO.orbColumnMinHeight));

    const hero = page.getByTestId('brand-brain-hero');
    expect(await style(hero, 'padding-top')).toBe(`${scaled(PROTO.heroPadding)}px`);
    expect(await style(hero, 'border-radius')).toBe(`${scaled(PROTO.cardRadius)}px`);

    // Four area cards across.
    const columns = await style(page.getByTestId('area-grid'), 'grid-template-columns');
    expect(columns.split(' ')).toHaveLength(PROTO.areaColumns);
  });

  test('on a phone the hero stacks and nothing scrolls sideways', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await signIn(page, 'en');

    expect((await box(page.getByTestId('brand-orb'))).height).toBeGreaterThanOrEqual(
      scaled(PROTO.stageMinHeight),
    );
    expect(await style(page.getByTestId('orb-center'), 'width')).toBe(
      `${scaled(PROTO.centreDiameter)}px`,
    );

    // One column below 1100px: the text sits under the orb, as wide as it.
    const column = await box(page.locator('.bsp-bb-orbcol'));
    const text = await box(page.getByTestId('completion-card'));
    expect(Math.abs(column.width - text.width)).toBeLessThan(2);

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

    // The orb is a circle in a symmetric stage: mirroring must not change it.
    const centre = await box(page.getByTestId('orb-center'));
    expect(Math.abs(centre.width - scaled(PROTO.centreDiameter))).toBeLessThanOrEqual(0.5);
    await expect(page.locator('.bsp-bb-node')).toHaveCount(PROTO.orbitNodes);
    await expect(page.getByTestId('orb-center')).not.toContainText(fixture().brandName);

    // The text column sits on the LEFT in Arabic — the same logical place it
    // holds on the right in English.
    const orb = await page.locator('.bsp-bb-orbcol').boundingBox();
    const text = await page.getByTestId('completion-card').boundingBox();
    expect(text!.x).toBeLessThan(orb!.x);

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

test.describe('Talk with the brand is the prototype’s chat card', () => {
  test('the centre opens it, alone, at the prototype’s fixed height', async ({ page }) => {
    await signIn(page, 'en');

    await page.getByTestId('orb-center').click();
    const chat = page.getByTestId('brand-chat');
    await expect(chat).toBeVisible();

    // The prototype's chat tab is the card on its own (lines 899–925): the
    // hero and the grid give way to it, and it does not float over the page.
    await expect(page.getByTestId('brand-brain-hero')).toHaveCount(0);
    await expect(page.getByTestId('tab-chat')).toHaveAttribute('aria-selected', 'true');
    expect(await style(chat, 'position')).toBe('static');
    expect(Math.abs((await box(chat)).height - scaled(PROTO.chatHeight))).toBeLessThanOrEqual(0.5);

    await shot(page, 'chat-open-desktop-en.png', chat);
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

/* --- an open area --------------------------------------------------------- */

test.describe('an open area', () => {
  test('opens in place of the grid, in two columns', async ({ page }) => {
    await signIn(page, 'en');

    await page.getByTestId('area-card-IDENTITY').click();
    const area = page.getByTestId('area-drawer');
    await expect(area).toBeVisible();

    // The prototype opens the area where the cards were (lines 817–866): the
    // hero, "What's missing" and the grid give way, and the facts sit beside
    // what is waiting, `1.3fr 1fr`.
    await expect(page.getByTestId('area-grid')).toHaveCount(0);
    await expect(page.getByTestId('brand-brain-hero')).toHaveCount(0);
    const facts = await box(page.locator('.bsp-bb-facts'));
    const waiting = await box(page.getByTestId('drawer-review'));
    expect(facts.width / waiting.width).toBeGreaterThan(1.2);
    expect(facts.width / waiting.width).toBeLessThan(1.4);

    await shot(page, 'area-open-desktop-en.png');
  });

  test('starts on the right in Arabic', async ({ page }) => {
    await signIn(page, 'ar');

    await page.getByTestId('area-card-IDENTITY').click();
    await expect(page.getByTestId('area-drawer')).toBeVisible();

    // "← All areas" at the inline START, which in RTL is the right.
    const back = (await page.getByTestId('drawer-close').boundingBox())!;
    const area = (await page.getByTestId('area-drawer').boundingBox())!;
    expect(back.x + back.width / 2).toBeGreaterThan(area.x + area.width / 2);

    await shot(page, 'area-open-desktop-ar.png');
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
    // Q19 (D-357): "answered n of m", never a percentage.
    await expect(page.getByTestId('completion-answered')).toHaveText(/^answered \d+ of \d+$/);
  });
});
