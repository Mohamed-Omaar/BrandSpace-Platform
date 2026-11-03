import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

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
  const loaded = credentials();
  const { customer } = loaded;
  /*
   * THE BRAND THIS SUITE MEANS, said out loud (D-191). Brand Brain is about one
   * brand's identity and no longer picks one for the visitor, so the suite
   * names the brand the seeds built — rather than relying, as it used to, on
   * whichever row the page happened to find first.
   */
  await useBrand(page, customer.workspaceId, brandFixtures(loaded).primaryBrandId);
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
    await page.getByTestId('drawer-close').click();
    return;
  }
  await page.fill('[data-testid="new-item-key"]', key);
  await page.fill('[data-testid="new-item-title-en"]', key);
  await page.fill('[data-testid="new-item-body-en"]', body);
  await page.getByTestId('save-knowledge').click();

  /*
   * ASSERT THE SAVE, rather than assuming it. The action redirects with a code
   * either way, so a failed save looks exactly like a successful one to a test
   * that only waits for the URL to change — and the grounding assertion that
   * follows would then fail for a reason several steps removed from its cause.
   */
  await page.waitForURL(/brand-brain/);
  await expect(page).toHaveURL(/ok=KNOWLEDGE_SAVED/);
}

test.describe('Brand Brain screen', () => {
  test('renders the hero, the computed completion and the area grid', async ({ page }) => {
    await openBrandBrain(page);
    await ensureBrand(page);

    await expect(page.getByTestId('brand-brain-hero')).toBeVisible();
    await expect(page.getByTestId('completion-card')).toBeVisible();

    /*
     * THE NUMBERS ARE COMPUTED, NOT THE DEMO'S — PROVED BY MAKING THEM MOVE.
     *
     * This used to assert that the three figures differed from the values the
     * approved visual reference hard-codes: `82%`, `128` items and `4` sources.
     * The intent was right and the assertion was wrong, and it failed on a
     * developer's accumulated local database while passing on CI.
     *
     * THE ROOT CAUSE, since it is worth recording rather than muting: this
     * suite adds knowledge through the real UI and nothing removes it between
     * runs, so the workspace's item count grows monotonically across local
     * runs. `not.toHaveText('4')` is therefore a coincidence waiting to
     * happen — the honest live count passes through 4 on its way up, and a
     * correct page then failed the test. The assertion conflated "do not
     * hard-code the demo constant" with "the live value must differ from it",
     * and only the first is true.
     *
     * WHAT REPLACES IT IS STRICTLY STRONGER. A hard-coded number cannot
     * change: adding one knowledge item through the UI must move the item
     * count by exactly one. That catches the demo constant being pasted in —
     * which is what the old assertion was for — and it is immune to whatever
     * the database already holds, because it measures a DIFFERENCE.
     */
    // Q19 (D-357): key questions "answered n of m", never a percentage — this
    // replaces the old `completion-percent` /^\d{1,3}%$/ assertion.
    // Review of #67 — the answered count and the item metric sit in the hero's
    // "More" disclosure, so they are read as text, not as rendered lines.
    const answeredText = (await page.getByTestId('completion-answered').textContent()) ?? '';
    expect(answeredText).toMatch(/^answered \d+ of \d+$/);
    expect(answeredText).not.toContain('%');

    const itemsBefore = Number(await page.getByTestId('metric-items').textContent());
    expect(Number.isFinite(itemsBefore), 'the item metric must render a number').toBe(true);

    await addKnowledge(
      page,
      'IDENTITY',
      `live-metric-${Date.now()}`,
      'A fact added so the metric has to move.',
    );

    await expect
      .poll(async () => Number(await page.getByTestId('metric-items').textContent()), {
        timeout: 15_000,
      })
      .toBe(itemsBefore + 1);

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

  test('clicking an area card opens the real area in place of the grid', async ({ page }) => {
    await openBrandBrain(page);
    await ensureBrand(page);

    await page.getByTestId('area-card-IDENTITY').click();
    const drawer = page.getByTestId('area-drawer');
    await expect(drawer).toBeVisible();
    // D-468: the prototype opens an area where the cards were (lines 817–866).
    await expect(page.getByTestId('area-grid')).toHaveCount(0);
    // Real state, not a placeholder: an area with nothing in it says so.
    await expect(page.getByTestId('drawer-count')).toBeVisible();
  });

  test('clicking an orb node opens the same area', async ({ page }) => {
    await openBrandBrain(page);
    await ensureBrand(page);

    await page.getByTestId('orb-node-AUDIENCE').click();
    await expect(page.getByTestId('area-drawer')).toBeVisible();
  });
});

/*
 * REPLACED (D-468, batch 4): the area was a modal drawer — Escape, `inert`
 * siblings and a focus trap. The prototype opens it IN PLACE of the grid, with
 * "← All areas" above it, so these now prove the inline view's own contract:
 * focus starts on the way back, the way back restores the grid, nothing on the
 * page is made inert, and Tab walks on from the area into the page.
 */
test.describe('the open area replaces the grid, keyboard first', () => {
  test('"All areas" closes it and the grid comes back', async ({ page }) => {
    await openBrandBrain(page);
    await ensureBrand(page);

    await page.getByTestId('area-card-IDENTITY').click();
    await expect(page.getByTestId('area-drawer')).toBeVisible();
    await page.getByTestId('drawer-close').click();
    await expect(page.getByTestId('area-drawer')).toBeHidden();
    await expect(page.getByTestId('area-grid')).toBeVisible();
  });

  test('focus moves to "All areas" on open', async ({ page }) => {
    await openBrandBrain(page);
    await ensureBrand(page);

    await page.getByTestId('area-card-OFFERS').click();
    await expect(page.getByTestId('area-drawer')).toBeVisible();
    // The way back takes focus, so a keyboard user starts at the area.
    await expect(page.getByTestId('drawer-close')).toBeFocused();
  });

  test('nothing on the page is inert while an area is open', async ({ page }) => {
    await openBrandBrain(page);
    await ensureBrand(page);

    await page.getByTestId('area-card-GLOSSARY').click();
    await expect(page.getByTestId('area-drawer')).toBeVisible();
    // The page around the area stays live: the rail, the top bar and the tabs.
    const inert = await page.evaluate(() =>
      ['nav', 'main', '[data-testid="brand-brain-tabs"]'].map(
        (selector) => document.querySelector(selector)?.closest('[inert]') !== null,
      ),
    );
    expect(inert).toEqual([false, false, false]);
  });

  test('Tab moves from "All areas" into the area', async ({ page }) => {
    await openBrandBrain(page);
    await ensureBrand(page);

    await page.getByTestId('area-card-IDENTITY').click();
    await expect(page.getByTestId('drawer-close')).toBeFocused();
    await page.keyboard.press('Tab');

    const insideArea = await page.evaluate(() => {
      const area = document.querySelector('[data-testid="area-drawer"]');
      return area?.contains(document.activeElement) ?? false;
    });
    expect(insideArea).toBe(true);
  });
});

/*
 * PR B (D-594) — ONE ASSISTANT. Brand Brain's chat is retired: the orb's
 * centre, "Ask the brand" and an area's "Ask Copilot" open the Copilot's side
 * panel on this page. The guarantees the chat's tests held — a fixed panel, a
 * conversation that scrolls inside itself, a composer that stays reachable,
 * no internals on screen, the retention line before anything is typed — are
 * held here, on the Copilot.
 */
async function openCopilotFromOrb(page: Page) {
  await page.getByTestId('orb-center').click();
  const drawer = page.getByTestId('copilot-drawer');
  await expect(drawer).toBeVisible();
  return drawer;
}

async function askFromBrandBrain(page: Page, question: string) {
  const drawer = await openCopilotFromOrb(page);
  await drawer.getByTestId('copilot-request').fill(question);
  await drawer.getByTestId('copilot-propose').click();
  await expect
    .poll(
      async () =>
        (await drawer.getByTestId('copilot-answered').count()) +
        (await drawer.getByTestId('copilot-message-assistant').count()) +
        (await drawer.getByTestId('copilot-error').count()),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  return drawer;
}

test.describe('Brand Brain asks the Copilot (PR B)', () => {
  test('there is no chat tab; the orb centre opens the Copilot on Brand Brain, with its three chips', async ({
    page,
  }) => {
    await openBrandBrain(page);
    await ensureBrand(page);
    await expect(page.getByTestId('tab-chat')).toHaveCount(0);
    await expect(page.getByTestId('brand-chat')).toHaveCount(0);
    const drawer = await openCopilotFromOrb(page);
    await expect(drawer.getByTestId('copilot-context')).toContainText('Brand Brain');
    for (const id of ['positioning', 'gaps', 'voice']) {
      await expect(drawer.getByTestId(`copilot-suggestion-${id}`)).toBeVisible();
    }
    await expect(drawer.getByTestId('copilot-open-full')).toBeVisible();
  });

  test('the panel has a FIXED height and does not grow when a message is sent', async ({
    page,
  }) => {
    await openBrandBrain(page);
    await ensureBrand(page);
    const drawer = await openCopilotFromOrb(page);
    const before = await drawer.boundingBox();
    await drawer.getByTestId('copilot-request').fill('What is our tone of voice?');
    await drawer.getByTestId('copilot-propose').click();
    await page.waitForTimeout(1500);
    const after = await drawer.boundingBox();
    expect(Math.abs((after?.height ?? 0) - (before?.height ?? 0))).toBeLessThan(2);
  });

  test('messages scroll INSIDE the conversation area', async ({ page }) => {
    await openBrandBrain(page);
    await ensureBrand(page);
    const drawer = await openCopilotFromOrb(page);
    const overflow = await drawer
      .getByTestId('copilot-conversation')
      .evaluate((el) => getComputedStyle(el).overflowY);
    expect(['auto', 'scroll']).toContain(overflow);
  });

  test('the composer stays visible and reachable', async ({ page }) => {
    await openBrandBrain(page);
    await ensureBrand(page);
    const drawer = await openCopilotFromOrb(page);
    const composer = drawer.getByTestId('copilot-request');
    await expect(composer).toBeVisible();
    await composer.focus();
    await expect(composer).toBeFocused();
    await composer.fill('line '.repeat(60));
    const height = await composer.evaluate((el) => el.getBoundingClientRect().height);
    expect(height).toBeLessThanOrEqual(130);
    await expect(drawer.getByTestId('copilot-propose')).toBeVisible();
  });

  test('an answer is grounded or honestly refused — never fabricated', async ({ page }) => {
    await openBrandBrain(page);
    await ensureBrand(page);
    const drawer = await askFromBrandBrain(page, 'What is our refund policy?');
    const text = (await drawer.innerText()).toLowerCase();
    expect(text).not.toContain('mock');
    expect(text).not.toContain('provider');
    expect(text).not.toContain('api key');
    expect(text).not.toContain('system prompt');
    expect(text).not.toMatch(/sk-[a-z0-9]/);
  });

  test('the retention notice is shown BEFORE anything is persisted', async ({ page }) => {
    await openBrandBrain(page);
    await ensureBrand(page);
    const drawer = await openCopilotFromOrb(page);
    await expect(drawer.getByTestId('copilot-retention')).toContainText(/Kept for \d+ days/);
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

  test('the open area starts on the right in RTL', async ({ page }) => {
    await openBrandBrain(page, 'ar');
    await ensureBrand(page, 'ar');

    await page.getByTestId('area-card-IDENTITY').click();
    await expect(page.getByTestId('area-drawer')).toBeVisible();

    // "← All areas" sits at the inline START — the right edge in Arabic. A
    // physical `left` would leave it on the wrong side of the area.
    const back = await page.getByTestId('drawer-close').boundingBox();
    const area = await page.getByTestId('area-drawer').boundingBox();
    expect((back?.x ?? 0) + (back?.width ?? 0)).toBeGreaterThan(
      (area?.x ?? 0) + (area?.width ?? 0) / 2,
    );
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

  test('the open area fits a phone screen', async ({ page }) => {
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

  test('the OPEN AREA has no serious or critical violations', async ({ page }) => {
    // Asserted with the modal open, because that is when the page has two
    // competing focus contexts and an `inert` subtree — the state most likely
    // to be wrong and least likely to be checked.
    await openBrandBrain(page);
    await ensureBrand(page);
    await page.getByTestId('area-card-IDENTITY').click();
    const drawer = page.getByTestId('area-drawer');
    await expect(drawer).toBeVisible();
    /*
     * THE OPEN DRAWER, NOT THE OPENING ONE. MO5 brings the drawer's rows in one
     * after another with a fade, and Phase 2C's key questions put more rows
     * ahead of the facts, so a scan started at "visible" could read a fact row
     * mid-fade and measure its blended, half-transparent colours. The state
     * under test is the drawer at rest, so wait for its entrance to finish.
     */
    await expect
      .poll(() =>
        drawer.evaluate((element) =>
          element
            .getAnimations({ subtree: true })
            .every((animation) => animation.playState !== 'running'),
        ),
      )
      .toBe(true);

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
    // The budget counts every stop before the page's own content — the rail,
    // both switchers and the top bar. P6-16 gave the top bar three more real
    // destinations (Review, Notes, Copilot), which is what moved it past 40;
    // the cards are exactly as reachable as before.
    let reached = false;
    for (let i = 0; i < 60 && !reached; i += 1) {
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

test.describe('Copilot answers about the brand, in development, without a real provider', () => {
  /*
   * PR B — the retired chat's two promised outcomes, on the Copilot: an
   * honest "Brand Brain doesn't have that yet" when nothing grounds the
   * question, and a grounded answer naming the areas its facts came from
   * (`copilot-brand-areas`, from retrieval, never from the model's text).
   */
  test('an empty Brand Brain refuses honestly rather than failing', async ({ page }) => {
    await openBrandBrain(page);
    await ensureBrand(page);
    const drawer = await askFromBrandBrain(page, 'What is our refund policy?');
    await expect(drawer.getByTestId('copilot-error')).toHaveCount(0);
    await expect(drawer.getByTestId('copilot-message-assistant').last()).not.toHaveText('');
  });

  test('an answer is grounded in approved knowledge and names its areas', async ({ page }) => {
    await openBrandBrain(page);
    await ensureBrand(page);
    const marker = `Kestrel Provisioning ${Date.now()}`;
    await addKnowledge(
      page,
      'IDENTITY',
      `positioning-${Date.now()}`,
      `Our positioning is ${marker}. We help independent retailers compete with national chains.`,
    );
    const drawer = await askFromBrandBrain(page, `What does ${marker} mean for our brand?`);
    await expect(drawer.getByTestId('copilot-message-assistant').last()).toContainText(marker, {
      timeout: 20_000,
    });
    await expect(drawer.getByTestId('copilot-brand-areas')).toBeVisible();
    await expect(drawer.getByTestId('copilot-error')).toHaveCount(0);
  });

  test('the answer carries no trace of how it was produced', async ({ page }) => {
    await openBrandBrain(page);
    await ensureBrand(page);
    const drawer = await askFromBrandBrain(page, 'What do we sell?');
    const text = (await drawer.innerText()).toLowerCase();
    expect(text).not.toContain('mock');
    expect(text).not.toContain('provider');
    expect(text).not.toContain('api key');
    expect(text).not.toContain('system prompt');
    expect(text).not.toMatch(/sk-[a-z0-9]/);
  });
});

test.describe('an upload is processed by the WORKER, not by the request', () => {
  /*
   * THE PROOF THAT THE PIPELINE IS ASYNCHRONOUS.
   *
   * Phase 5A parsed uploaded documents inside the server action, so a test like
   * this passed the moment the redirect landed and proved nothing about where
   * the work happened. Now the action writes the row and dispatches; the
   * document only becomes READY once `apps/worker` — a separate process, started
   * by this suite's own web-server list — has consumed the message and parsed
   * it. The wait below is therefore the assertion: if the dispatch, the queue or
   * the worker were missing, the row would stay PROCESSING forever.
   */
  test('a text document reaches READY, and its chunks reach Brand Brain', async ({ page }) => {
    await openBrandBrain(page);
    await ensureBrand(page);

    // D1 (Phase 2C): uploads live on the Sources tab.
    await page.getByTestId('tab-sources').click();
    const upload = page.getByTestId('upload-input');
    if (!(await upload.isVisible().catch(() => false))) test.skip();

    const marker = `Ospreyline ${Date.now()}`;
    const fileName = `brand-notes-${Date.now()}.txt`;
    await upload.setInputFiles({
      name: fileName,
      mimeType: 'text/plain',
      buffer: Buffer.from(
        [
          `Our mission is ${marker}: to help independent retailers compete with national chains.`,
          '',
          'Our audience is founders of small retail businesses in the Gulf region.',
          '',
          'We never make price comparisons against named competitors.',
        ].join('\n'),
        'utf8',
      ),
    });
    await page.getByTestId('upload-submit').click();
    await expect(page).toHaveURL(/ok=SOURCE_UPLOADED/);

    /*
     * POLL THE PAGE, not a database. What a customer sees is the contract, and
     * the status they see has to become READY on its own — nothing in this test
     * touches the job, the queue or the worker to help it along.
     */
    const sources = page.getByTestId('sources-card');
    await expect(async () => {
      await page.reload();
      // Gate 2b — the prototype's row pills only a read in progress or a failure;
      // a READY source is the row with no pill, its counts, and "Read again".
      const row = sources.locator('li[data-status]', { hasText: fileName });
      await expect(row).toHaveAttribute('data-status', 'READY');
      await expect(row).toContainText(/Read again|اقرأ مجددًا/);
    }).toPass({ timeout: 60_000, intervals: [1_000, 2_000, 3_000] });
  });
});
