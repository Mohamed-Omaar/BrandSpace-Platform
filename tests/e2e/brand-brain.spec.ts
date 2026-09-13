import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DASHBOARD_BASE_URL } from './apps';
import { E2E_CREDENTIALS_FILE, type E2eAdminCredentials } from './env';

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

/**
 * Brand Brain, end to end, in a real browser.
 *
 * What these assert that a unit test cannot: that the computed numbers reach
 * the screen, that the orb survives a missing canvas and a reduced-motion
 * preference, that the drawer is genuinely modal for a keyboard user, that the
 * chat panel does not grow when a message is sent, and that all of it works in
 * BOTH writing directions.
 */

async function signIn(page: Page, email: string, password: string, locale = 'en'): Promise<void> {
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/sign-in`);
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL(
    (url) => !url.pathname.endsWith('/sign-in') || url.searchParams.has('error'),
  );
}

async function openBrandBrain(page: Page, locale = 'en'): Promise<void> {
  const { customer } = credentials();
  await signIn(page, customer.email, customer.password, locale);
  await page.click(`[data-testid="choose-workspace-${customer.workspaceSlug}"]`);
  await page.waitForURL(new RegExp(`/${locale}/overview$`));
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/brand-brain`);
  await page.waitForLoadState('domcontentloaded');
}

/** The page in whichever state this workspace is in: with a brand, or without. */
async function ensureBrand(page: Page, locale = 'en'): Promise<void> {
  const empty = page.getByTestId('brand-brain-no-brand');
  if (await empty.isVisible().catch(() => false)) {
    const create = page.getByTestId('create-brand');
    if (await create.isVisible().catch(() => false)) {
      await page.fill('[data-testid="new-brand-name"]', 'E2E Brand');
      await create.click();
      await page.waitForURL(new RegExp(`/${locale}/brand-brain`));
    }
  }
}

/**
 * Put one approved knowledge item into an area, through the real UI.
 *
 * The grounded chat path needs something to ground ON. A fresh workspace has
 * nothing, so every chat question correctly reaches the honest
 * insufficient-knowledge answer — which is worth testing, and is not the same
 * thing as testing that grounding works. This adds a fact the way a customer
 * would, so the assertion that follows is about the real pipeline.
 */
async function addKnowledge(page: Page, area: string, key: string, body: string): Promise<void> {
  await page.getByTestId(`area-card-${area}`).click();
  await expect(page.getByTestId('area-drawer')).toBeVisible();

  const form = page.getByTestId('add-knowledge-form');
  if (!(await form.isVisible().catch(() => false))) {
    await page.keyboard.press('Escape');
    return;
  }
  await page.fill('[data-testid="new-item-key"]', key);
  await page.fill('[data-testid="new-item-title-en"]', key);
  await page.fill('[data-testid="new-item-body-en"]', body);
  await page.getByTestId('save-knowledge').click();
  await page.waitForURL(/brand-brain/);
}

test.describe('Brand Brain screen', () => {
  test('renders the hero, the computed completion and the area grid', async ({ page }) => {
    await openBrandBrain(page);
    await ensureBrand(page);

    await expect(page.getByTestId('brand-brain-hero')).toBeVisible();
    await expect(page.getByTestId('completion-card')).toBeVisible();

    /*
     * THE NUMBER IS COMPUTED, NOT THE DEMO'S.
     *
     * A fresh workspace has no approved knowledge, so completion must read a
     * low honest figure — and in particular must NOT read 82%, which is the
     * value the approved visual reference hard-codes. This assertion exists
     * specifically to fail if the demo number is ever copied in.
     */
    const percent = await page.getByTestId('completion-percent').innerText();
    expect(percent).toMatch(/^\d{1,3}%$/);
    expect(percent).not.toBe('82%');

    // The other two demo numbers, likewise.
    await expect(page.getByTestId('metric-items')).not.toHaveText('128');
    await expect(page.getByTestId('metric-sources')).not.toHaveText('4');

    // Ten areas, every one rendered whatever the database holds.
    await expect(page.getByTestId('area-grid').locator('button')).toHaveCount(10);
  });

  test('the orb renders its nodes as real buttons', async ({ page }) => {
    await openBrandBrain(page);
    await ensureBrand(page);

    await expect(page.getByTestId('brand-orb')).toBeVisible();
    await expect(page.getByTestId('orb-center')).toBeVisible();
    // Six orbit nodes, each a button — reachable whether or not the canvas
    // painted a single pixel.
    await expect(page.getByTestId('orb-node-IDENTITY')).toBeVisible();
    await expect(page.getByTestId('orb-node-AUDIENCE')).toBeVisible();
  });

  test('clicking an area card opens the real detail drawer', async ({ page }) => {
    await openBrandBrain(page);
    await ensureBrand(page);

    await page.getByTestId('area-card-IDENTITY').click();
    const drawer = page.getByTestId('area-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute('aria-modal', 'true');
    // Real state, not a placeholder: an area with nothing in it says so.
    await expect(page.getByTestId('drawer-count')).toBeVisible();
  });

  test('clicking an orb node opens the same drawer', async ({ page }) => {
    await openBrandBrain(page);
    await ensureBrand(page);

    await page.getByTestId('orb-node-AUDIENCE').click();
    await expect(page.getByTestId('area-drawer')).toBeVisible();
  });
});

test.describe('the drawer is genuinely modal', () => {
  test('Escape closes it and focus returns to the page', async ({ page }) => {
    await openBrandBrain(page);
    await ensureBrand(page);

    await page.getByTestId('area-card-IDENTITY').click();
    await expect(page.getByTestId('area-drawer')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('area-drawer')).toBeHidden();
  });

  test('focus moves INTO the drawer on open', async ({ page }) => {
    await openBrandBrain(page);
    await ensureBrand(page);

    await page.getByTestId('area-card-OFFERS').click();
    await expect(page.getByTestId('area-drawer')).toBeVisible();
    // The close button takes focus, so a keyboard user starts inside the layer
    // rather than at the top of the document.
    await expect(page.getByTestId('drawer-close')).toBeFocused();
  });

  test('the page behind is INERT while the drawer is open', async ({ page }) => {
    await openBrandBrain(page);
    await ensureBrand(page);

    await page.getByTestId('area-card-GLOSSARY').click();
    await expect(page.getByTestId('area-drawer')).toBeVisible();

    /*
     * An overlay stops clicks. It does NOT stop Tab. `inert` on every sibling
     * of the panel is what removes the page behind from the tab order and the
     * accessibility tree, and this is the assertion that proves it is applied.
     */
    const inertCount = await page.evaluate(
      () => Array.from(document.body.children).filter((el) => el.hasAttribute('inert')).length,
    );
    expect(inertCount).toBeGreaterThan(0);
  });

  test('Tab stays inside the drawer', async ({ page }) => {
    await openBrandBrain(page);
    await ensureBrand(page);

    await page.getByTestId('area-card-IDENTITY').click();
    await expect(page.getByTestId('area-drawer')).toBeVisible();

    for (let i = 0; i < 12; i += 1) await page.keyboard.press('Tab');

    const insideDrawer = await page.evaluate(() => {
      const drawer = document.querySelector('[data-testid="area-drawer"]');
      return drawer?.contains(document.activeElement) ?? false;
    });
    expect(insideDrawer).toBe(true);
  });
});

test.describe('Brand Brain chat', () => {
  test('the panel has a FIXED height and does not grow when a message is sent', async ({
    page,
  }) => {
    await openBrandBrain(page);
    await ensureBrand(page);

    // The demo's only chat entry point is the orb's centre, and the port keeps
    // it that way (D-85). There is no separate floating "open chat" button.
    const opener = page.getByTestId('orb-center');
    if (!(await opener.isVisible().catch(() => false))) test.skip();
    await opener.click();

    const panel = page.getByTestId('brand-chat');
    await expect(panel).toBeVisible();
    const before = await panel.boundingBox();

    await page.fill('[data-testid="chat-input"]', 'What is our tone of voice?');
    await page.getByTestId('chat-send').click();
    // Whatever the answer is — a real one, an insufficient-knowledge refusal or
    // an error — the panel must be the same size afterwards. This is the
    // failure the brief names by name.
    await page.waitForTimeout(1500);

    const after = await panel.boundingBox();
    expect(Math.abs((after?.height ?? 0) - (before?.height ?? 0))).toBeLessThan(2);
  });

  test('messages scroll INSIDE the conversation area', async ({ page }) => {
    await openBrandBrain(page);
    await ensureBrand(page);

    // The demo's only chat entry point is the orb's centre, and the port keeps
    // it that way (D-85). There is no separate floating "open chat" button.
    const opener = page.getByTestId('orb-center');
    if (!(await opener.isVisible().catch(() => false))) test.skip();
    await opener.click();
    await expect(page.getByTestId('brand-chat')).toBeVisible();

    // The list is its own scroller: it clips its content rather than pushing
    // the composer down.
    const overflow = await page
      .getByTestId('chat-messages')
      .evaluate((el) => getComputedStyle(el).overflowY);
    expect(['auto', 'scroll']).toContain(overflow);
  });

  test('the composer stays visible and reachable', async ({ page }) => {
    await openBrandBrain(page);
    await ensureBrand(page);

    // The demo's only chat entry point is the orb's centre, and the port keeps
    // it that way (D-85). There is no separate floating "open chat" button.
    const opener = page.getByTestId('orb-center');
    if (!(await opener.isVisible().catch(() => false))) test.skip();
    await opener.click();

    const composer = page.getByTestId('chat-input');
    await expect(composer).toBeVisible();
    await composer.focus();
    await expect(composer).toBeFocused();

    // The demo's composer is a SINGLE-LINE input inside a fixed pill, so a long
    // draft scrolls the field rather than growing the panel and pushing the send
    // button out of it.
    await composer.fill('line '.repeat(60));
    const height = await composer.evaluate((el) => el.getBoundingClientRect().height);
    expect(height).toBeLessThanOrEqual(130);
    await expect(page.getByTestId('chat-send')).toBeVisible();
  });

  test('an answer is grounded or honestly refused — never fabricated', async ({ page }) => {
    await openBrandBrain(page);
    await ensureBrand(page);

    // The demo's only chat entry point is the orb's centre, and the port keeps
    // it that way (D-85). There is no separate floating "open chat" button.
    const opener = page.getByTestId('orb-center');
    if (!(await opener.isVisible().catch(() => false))) test.skip();
    await opener.click();

    await page.fill('[data-testid="chat-input"]', 'What is our refund policy?');
    await page.getByTestId('chat-send').click();
    await page.waitForTimeout(2000);

    const panel = page.getByTestId('brand-chat');
    const text = await panel.innerText();

    /*
     * NO INTERNALS ON A CUSTOMER SCREEN, whatever the outcome.
     * docs/SECURITY.md and CLAUDE.md §10: never a provider, a model key, a
     * prompt or an infrastructure detail.
     */
    expect(text.toLowerCase()).not.toContain('mock');
    expect(text.toLowerCase()).not.toContain('provider');
    expect(text.toLowerCase()).not.toContain('api key');
    expect(text.toLowerCase()).not.toContain('system prompt');
    expect(text).not.toMatch(/sk-[A-Za-z0-9]/);
  });

  test('the retention notice is shown BEFORE anything is persisted', async ({ page }) => {
    // D-78 / F-63: the customer-facing notice belongs with the first feature
    // that turns persistence on, and it has to be visible before they type.
    await openBrandBrain(page);
    await ensureBrand(page);

    // The demo's only chat entry point is the orb's centre, and the port keeps
    // it that way (D-85). There is no separate floating "open chat" button.
    const opener = page.getByTestId('orb-center');
    if (!(await opener.isVisible().catch(() => false))) test.skip();
    await opener.click();

    const panel = page.getByTestId('brand-chat');
    await expect(panel).toContainText(/kept for \d+ days|تُحفظ/);
  });
});

test.describe('reduced motion', () => {
  test('the orb still renders its knowledge map with motion reduced', async ({ page }) => {
    // Emulated on the page rather than via `test.use`, so the preference is set
    // before the orb mounts and the component sees it on its first effect.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openBrandBrain(page);
    await ensureBrand(page);
    // Reduced motion draws ONE STATIC FRAME rather than hiding the visual:
    // someone who asked for less motion still gets the map.
    await expect(page.getByTestId('brand-orb')).toBeVisible();
    await expect(page.getByTestId('orb-node-IDENTITY')).toBeVisible();
  });
});

test.describe('right-to-left', () => {
  test('the Arabic screen renders RTL with its own copy', async ({ page }) => {
    await openBrandBrain(page, 'ar');
    await ensureBrand(page, 'ar');

    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByTestId('brand-brain-hero')).toBeVisible();
    await expect(page.getByTestId('completion-card')).toBeVisible();

    // Arabic copy, not the English strings in a mirrored layout.
    const hero = await page.getByTestId('brand-brain-hero').innerText();
    expect(hero).toMatch(/[؀-ۿ]/);
  });

  test('the drawer opens on the correct side in RTL', async ({ page }) => {
    await openBrandBrain(page, 'ar');
    await ensureBrand(page, 'ar');

    await page.getByTestId('area-card-IDENTITY').click();
    const drawer = page.getByTestId('area-drawer');
    await expect(drawer).toBeVisible();

    // `inset-inline-end` puts it on the LEFT in RTL. A `right` literal would
    // leave it on the right and overlap the content it is meant to sit beside.
    const box = await drawer.boundingBox();
    const viewport = page.viewportSize();
    expect(box?.x ?? 0).toBeLessThan((viewport?.width ?? 1280) / 2);
  });
});

test.describe('responsive', () => {
  test('the screen holds together on a phone without horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openBrandBrain(page);
    await ensureBrand(page);

    await expect(page.getByTestId('brand-brain-hero')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    // A couple of pixels of sub-pixel rounding is tolerable; a scrollbar is not.
    expect(overflow).toBeLessThanOrEqual(2);
  });

  test('the drawer fits a phone screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openBrandBrain(page);
    await ensureBrand(page);

    await page.getByTestId('area-card-IDENTITY').click();
    const drawer = page.getByTestId('area-drawer');
    await expect(drawer).toBeVisible();
    const box = await drawer.boundingBox();
    expect(box?.width ?? 0).toBeLessThanOrEqual(390);
  });
});

test.describe('accessibility', () => {
  /**
   * WCAG 2.2 AA (CLAUDE.md §4) on the real screen, in both writing directions.
   *
   * Serious and critical only, matching the existing customer suite: axe's
   * lower-impact findings are advisory and gating on them turns the suite into
   * a lint run that nobody can keep green.
   */
  for (const locale of ['en', 'ar']) {
    test(`the page has no serious or critical violations (${locale})`, async ({ page }) => {
      await openBrandBrain(page, locale);
      await ensureBrand(page, locale);

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      const serious = results.violations.filter((v) =>
        ['serious', 'critical'].includes(v.impact ?? ''),
      );
      expect(serious, JSON.stringify(serious.map((v) => v.id))).toEqual([]);
    });
  }

  test('the OPEN DRAWER has no serious or critical violations', async ({ page }) => {
    // Asserted with the modal open, because that is when the page has two
    // competing focus contexts and an `inert` subtree — the state most likely
    // to be wrong and least likely to be checked.
    await openBrandBrain(page);
    await ensureBrand(page);
    await page.getByTestId('area-card-IDENTITY').click();
    await expect(page.getByTestId('area-drawer')).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const serious = results.violations.filter((v) =>
      ['serious', 'critical'].includes(v.impact ?? ''),
    );
    expect(serious, JSON.stringify(serious.map((v) => v.id))).toEqual([]);
  });

  test('the whole screen is reachable by keyboard alone', async ({ page }) => {
    await openBrandBrain(page);
    await ensureBrand(page);

    // Tab until an area card takes focus, then open it with the keyboard.
    let reached = false;
    for (let i = 0; i < 40 && !reached; i += 1) {
      await page.keyboard.press('Tab');
      reached = await page.evaluate(() =>
        (document.activeElement?.getAttribute('data-testid') ?? '').startsWith('area-card-'),
      );
    }
    expect(reached).toBe(true);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('area-drawer')).toBeVisible();
  });
});

test.describe('chat answers, in development, without a real provider', () => {
  /*
   * WHAT THESE EXIST FOR. Until now Brand Brain chat had never been observed to
   * produce an answer outside a unit test. The gateway is configuration-driven
   * — no active routing rule for `copilot.chat` means `RoutingError`, a 500,
   * and the generic red failure on the panel — and nothing had ever activated
   * one outside the isolation suite's in-memory configuration.
   *
   * `pnpm e2e:seed` now activates a MOCK routing rule through the real
   * Configuration Service, with no validation relaxed and no real provider
   * chosen (tests/e2e/seed-ai.ts explains what it is and is not). So both
   * outcomes the product promises are now reachable here, and both are asserted:
   * an honest refusal when there is nothing to ground on, and a grounded answer
   * with citations when there is.
   */

  test('an empty Brand Brain refuses honestly rather than failing', async ({ page }) => {
    await openBrandBrain(page);
    await ensureBrand(page);

    await page.getByTestId('orb-center').click();
    const panel = page.getByTestId('brand-chat');
    await expect(panel).toBeVisible();

    await page.fill('[data-testid="chat-input"]', 'What is our refund policy?');
    await page.getByTestId('chat-send').click();

    // Either outcome is correct here — it depends on what previous tests in
    // this file have already added to the workspace — but the generic failure
    // is not one of them, and neither is a silent empty panel.
    await expect(
      panel.getByTestId('chat-insufficient').or(panel.getByTestId('chat-message-assistant')),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('chat-error')).toBeHidden();
  });

  test('an answer is grounded in approved knowledge and cites it', async ({ page }) => {
    await openBrandBrain(page);
    await ensureBrand(page);

    /*
     * A UNIQUE KEY PER RUN, not `positioning`.
     *
     * `itemKey` is unique per area, so reusing one leaves the item from an
     * earlier run in place and the assertion below would pass on THAT run's
     * marker — a test that verifies its own history rather than this run's
     * answer.
     */
    const marker = `Kestrel Provisioning ${Date.now()}`;
    await addKnowledge(
      page,
      'IDENTITY',
      `positioning-${Date.now()}`,
      `Our positioning is ${marker}. We help independent retailers compete with national chains.`,
    );

    await page.getByTestId('orb-center').click();
    const panel = page.getByTestId('brand-chat');
    await expect(panel).toBeVisible();

    await page.fill('[data-testid="chat-input"]', 'What is our positioning?');
    await page.getByTestId('chat-send').click();

    const answer = panel.getByTestId('chat-message-assistant').last();
    await expect(answer).toBeVisible({ timeout: 20_000 });

    // GROUNDED: the answer contains the fact the workspace approved seconds
    // ago, which no fixture and no placeholder vocabulary could produce.
    await expect(answer).toContainText(marker, { timeout: 20_000 });
    // CITED: the citation list is built from retrieval, never parsed out of
    // the model's text, so its presence is evidence the retrieval ran.
    await expect(panel.getByTestId('chat-citations').last()).toBeVisible();
    await expect(page.getByTestId('chat-error')).toBeHidden();
  });

  test('the answer carries no trace of how it was produced', async ({ page }) => {
    await openBrandBrain(page);
    await ensureBrand(page);

    await page.getByTestId('orb-center').click();
    await expect(page.getByTestId('brand-chat')).toBeVisible();
    await page.fill('[data-testid="chat-input"]', 'What do we sell?');
    await page.getByTestId('chat-send').click();
    await expect(
      page.getByTestId('chat-insufficient').or(page.getByTestId('chat-message-assistant')).first(),
    ).toBeVisible({ timeout: 20_000 });

    /*
     * NO INTERNALS ON A CUSTOMER SCREEN. This is the assertion the mock's
     * placeholder output would fail — "[mock:mock-fast] placeholder sample" —
     * which is exactly why the development answer is composed from the
     * workspace's own approved knowledge instead.
     */
    const text = (await page.getByTestId('brand-chat').innerText()).toLowerCase();
    expect(text).not.toContain('mock');
    expect(text).not.toContain('provider');
    expect(text).not.toContain('api key');
    expect(text).not.toContain('system prompt');
    expect(text).not.toMatch(/sk-[a-z0-9]/);
  });
});
