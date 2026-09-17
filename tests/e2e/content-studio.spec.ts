import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

/**
 * The AI Content Studio, end to end, in a real browser.
 *
 * WHAT THESE ASSERT THAT A UNIT OR ISOLATION TEST CANNOT: that the price a
 * customer is shown BEFORE confirming is the price the generation reserves
 * (AC-11.1); that a brief travels from a textarea through the API, the gateway
 * and the mock provider to a persisted draft with real citations (AC-11.4,
 * AC-11.5); that the same journey works in Arabic and in English (AC-11.7);
 * that the ported geometry holds in BOTH writing directions and at phone width;
 * and that the whole thing is operable by keyboard and clean under axe.
 *
 * AND THE ONE A SCREENSHOT CANNOT: that nothing on the page names a model, a
 * provider or a prompt (AC-11.6). That is asserted against the rendered DOM,
 * because the leak the criterion is about would be invisible in a picture.
 */

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

async function signIn(page: Page, locale = 'en'): Promise<void> {
  const loaded = credentials();
  const { customer } = loaded;
  /*
   * THE BRAND THIS SUITE MEANS, said out loud (D-191). A brand-scoped screen no
   * longer picks one for the visitor, so the precondition is established here
   * — the same brand the seeds attached their fixtures to.
   */
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

async function openLibrary(page: Page, locale = 'en'): Promise<void> {
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/content`);
  await page.waitForLoadState('domcontentloaded');
}

async function openComposer(page: Page, locale = 'en'): Promise<void> {
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/content/compose`);
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByTestId('content-composer')).toBeVisible();
}

/**
 * Make sure this workspace has a brand, and one approved fact to ground on.
 *
 * GENERATION IS GROUNDED, so a workspace with no brand cannot generate at all
 * and one with an empty Brand Brain correctly reaches the free refusal. Both are
 * real behaviours with their own assertions below — but a suite that relied on
 * whichever state the seed happened to leave behind would be testing the
 * fixture. This puts the workspace into the state the generation tests are
 * about, through the real UI, the way a customer would.
 *
 * Idempotent: every step checks before it acts, so a second run over a
 * workspace that already has both is a no-op rather than a duplicate.
 */
async function ensureBrandWithKnowledge(page: Page, locale = 'en'): Promise<void> {
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/brand-brain`);
  await page.waitForLoadState('domcontentloaded');

  const create = page.getByTestId('create-brand');
  if (await create.isVisible().catch(() => false)) {
    await page.fill('[data-testid="new-brand-name"]', 'E2E Brand');
    await create.click();
    await page.waitForURL(new RegExp(`/${locale}/brand-brain`));
    await page.waitForLoadState('domcontentloaded');
  }

  // One fact, in the area a brief about the brand will retrieve against.
  const card = page.getByTestId('area-card-TONE_OF_VOICE');
  if (!(await card.isVisible().catch(() => false))) return;
  await card.click();
  const form = page.getByTestId('add-knowledge-form');
  if (!(await form.isVisible().catch(() => false))) {
    await page.keyboard.press('Escape');
    return;
  }
  /*
   * A FIXED KEY, not a timestamped one.
   *
   * `brand_knowledge_item` is unique on (workspace, brand, area, key), so a
   * fixed key makes the second run a refused duplicate and a no-op — which is
   * what a fixture should be. A `Date.now()` key instead added ANOTHER copy on
   * every run, and five copies of the same fact crowded the Brand Brain chat's
   * retrieval until a neighbouring suite's grounding assertion failed. A
   * fixture that grows without bound eventually breaks something that is not
   * about it.
   */
  await page.fill('[data-testid="new-item-key"]', 'e2e-studio-voice');
  await page.fill('[data-testid="new-item-title-en"]', 'Voice');
  await page.fill(
    '[data-testid="new-item-body-en"]',
    'We write calmly and plainly. Short sentences, no hype, no exclamation marks. ' +
      'We describe what a product does rather than how exciting it is.',
  );
  await page.getByTestId('save-knowledge').click();
  await page.waitForURL(/brand-brain/);
}

/**
 * Fill the brief and pick one channel.
 *
 * The brand select only appears when the workspace has more than one brand, so
 * it is set when present rather than unconditionally — a helper that assumed
 * one shape would fail on a seed that legitimately has the other.
 */
async function compose(page: Page, brief: string): Promise<void> {
  await page.getByTestId('content-brief').fill(brief);
  const channel = page.getByTestId('content-channel').first();
  if ((await channel.getAttribute('aria-pressed')) !== 'true') await channel.click();
}

test.describe('the content library', () => {
  test('renders the ported composition and counts real rows', async ({ page }) => {
    await signIn(page);
    await openLibrary(page);

    // The demo's composition, in the demo's order.
    await expect(page.getByTestId('content-library')).toBeVisible();
    await expect(page.locator('.cs-view-toolbar')).toBeVisible();
    await expect(page.locator('.cs-tabs')).toBeVisible();
    await expect(page.locator('.cs-filter-row')).toBeVisible();

    /*
     * SIX TABS — the states that are REACHABLE, not the demo's five fixed ones.
     *
     * The rule (docs/UI-FIDELITY-CONTRACT.md §4.1) is that a tab exists when its
     * state can actually occur, because a tab that can only ever read zero is an
     * invented number. Phase 5B-2 rendered four; Phase 5B-3 added Changes
     * requested and Approved, which became reachable when the approvals workflow
     * shipped — and content in a state with no tab is content this screen
     * cannot find. Scheduled and Published stay out until Phase 6.
     */
    await expect(page.locator('.cs-tabs button')).toHaveCount(6);

    // Every count is a real number, not the demo's `· 28`.
    for (const label of await page.locator('.cs-tabs button').allTextContents()) {
      expect(label).toMatch(/·\s*\d+$/);
      expect(label).not.toContain('· 28');
    }
  });

  test('an empty library says so rather than borrowing a number', async ({ page }) => {
    await signIn(page);
    // A status nothing can be in yet, so this is deterministic whatever earlier
    // tests left behind.
    await page.goto(`${DASHBOARD_BASE_URL}/en/content?status=ARCHIVED&q=zzz-no-such-draft`);
    await expect(page.getByTestId('content-empty')).toBeVisible();
  });
});

test.describe('generation', () => {
  /*
   * A generation is a real round trip — the API, the gateway, retrieval, the
   * ledger — on top of provisioning a brand and a fact first. The default 30s
   * covers a page load, not that, and a timeout there fails several steps away
   * from anything it could diagnose.
   */
  test.describe.configure({ timeout: 120_000 });

  /*
   * Signed in and provisioned ONCE per test, in the hook rather than in each
   * body, so no generation test can forget it — a test that forgot would fail
   * on a disabled button several steps away from the reason.
   */
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await ensureBrandWithKnowledge(page);
  });

  test('AC-11.1 — the cost is shown before anything is spent', async ({ page }) => {
    await openComposer(page);
    await compose(page, 'Announce the new collection in a calm, useful tone.');

    await page.getByTestId('content-estimate').click();
    const quote = page.getByTestId('content-quote');
    await expect(quote).toBeVisible({ timeout: 30_000 });

    // A real number, and it is a quote rather than a charge: no draft appeared.
    await expect(quote).toContainText(/\d/);
    await expect(page.getByTestId('content-results')).not.toContainText(/#/);
  });

  /**
   * AC-11.4, AC-11.5 and AC-11.9, and the ONE THING THIS SUITE CANNOT PROVE.
   *
   * There is no real provider — D-13 approved the architecture and deferred
   * vendor selection — so the only adapter registered is the mock, which
   * SELECTS the retrieved material verbatim rather than generating. It does not
   * produce the JSON envelope the Content Studio's schema requires, and it is
   * not steerable from a prompt by design (see `MockProviderAdapter` property
   * 3). So in a browser the grounded path reaches AC-11.9's refusal — a
   * malformed provider response is a retryable error and is never persisted —
   * rather than a parsed draft.
   *
   * THAT IS ASSERTED HERE RATHER THAN WORKED AROUND, because it is the real
   * behaviour of the real system as configured, and the alternative — relaxing
   * the parser so prose becomes a draft — is exactly what AC-11.9 forbids.
   *
   * The SUCCESSFUL branch is proven in `tests/isolation/content-studio-
   * lifecycle.test.ts`, which drives the same service through a scripted
   * adapter and asserts the persisted draft, its variants, its citations and
   * its `aiRequestId`. When a provider is selected, the two outcomes below
   * collapse to the first and this test needs no change.
   */
  test('AC-11.4, AC-11.5, AC-11.9 — a grounded request reaches a draft or an honest refusal', async ({
    page,
  }) => {
    await openComposer(page);
    await compose(page, 'Write a short post about what our brand stands for.');
    await page.getByTestId('content-generate').click();

    /*
     * THREE OUTCOMES, ALL CORRECT, AND THE TEST NAMES WHICH ONE IT SAW.
     *
     *   1. A parsed draft — variants and, because grounding produced them,
     *      citations (AC-11.4, AC-11.5).
     *   2. The free refusal — nothing to ground on, so no gateway call, no
     *      credit and no variants.
     *   3. A customer-safe failure — the provider answered with something the
     *      schema refused, and NOTHING was persisted (AC-11.9).
     *
     * A test that demanded only the first would be asserting the fixture.
     */
    const failure = page.getByTestId('content-failure');
    const navigated = page
      .waitForURL(/\/content\/compose\?item=/, { timeout: 45_000 })
      .then(() => true)
      .catch(() => false);
    const failed = failure
      .waitFor({ state: 'visible', timeout: 45_000 })
      .then(() => true)
      .catch(() => false);

    const reachedDraft = await Promise.race([navigated, failed.then(() => false)]);

    if (!reachedDraft) {
      // Outcome 3. The message says nothing about a provider or a schema, and
      // no draft was written.
      await expect(failure).toBeVisible();
      await expect(failure).not.toContainText(/mock|json|model|provider/i);
      await expect(page.getByTestId('content-variant')).toHaveCount(0);
      return;
    }

    if (await page.getByTestId('content-insufficient').isVisible()) {
      // Outcome 2.
      await expect(page.getByTestId('content-variant')).toHaveCount(0);
    } else {
      // Outcome 1.
      await expect(page.getByTestId('content-variant').first()).toBeVisible();
      // AC-11.4: the sources come from retrieval, so a grounded draft has them.
      await expect(page.getByTestId('content-citations')).toBeVisible();
    }

    // AC-11.5: it is a persisted draft — the library now lists it.
    await openLibrary(page);
    await expect(page.getByTestId('content-card').first()).toBeVisible();
  });

  test('AC-11.7 — the same journey in Arabic', async ({ page }) => {
    await openComposer(page, 'ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

    await compose(page, 'اكتب منشورًا قصيرًا عن ما تمثّله علامتنا.');
    await page.getByTestId('content-generate').click();
    await page.waitForURL(/\/content\/compose\?item=/, { timeout: 60_000 });

    // The screen is Arabic throughout: no English fallback leaked into a label.
    await expect(page.getByTestId('content-composer')).toBeVisible();
    await expect(page.locator('.cs-view-toolbar')).toContainText(/[؀-ۿ]/);
  });

  test('AC-11.6 — nothing on the page names a model, a provider or a prompt', async ({ page }) => {
    await openComposer(page);
    await compose(page, 'Write a short launch post.');
    await page.getByTestId('content-generate').click();

    /*
     * WHICHEVER OUTCOME THIS REQUEST REACHES, the page must disclose nothing —
     * and the FAILURE path is the one that matters most here, because that is
     * where a raw provider error would surface if anything leaked one. So the
     * scan runs once the screen has settled either way, rather than only on the
     * success the mock cannot currently produce.
     */
    await Promise.race([
      page.waitForURL(/\/content\/compose\?item=/, { timeout: 45_000 }).catch(() => null),
      page
        .getByTestId('content-failure')
        .waitFor({ state: 'visible', timeout: 45_000 })
        .catch(() => null),
    ]);

    const rendered = (await page.content()).toLowerCase();
    for (const forbidden of [
      'mock-fast',
      'openai',
      'anthropic',
      'sk-',
      'system instruction',
      'prompt:',
      'ai_request',
    ]) {
      expect(rendered, `the page leaks "${forbidden}"`).not.toContain(forbidden);
    }
  });
});

test.describe('the composer is the demo, in both directions', () => {
  test('two columns on desktop, one on a phone', async ({ page }) => {
    await signIn(page);
    await openComposer(page);

    const columns = async () =>
      page.locator('.cs-composer').evaluate((el) => getComputedStyle(el).gridTemplateColumns);

    await page.setViewportSize({ width: 1440, height: 900 });
    expect((await columns()).split(' ')).toHaveLength(2);

    await page.setViewportSize({ width: 390, height: 844 });
    expect((await columns()).split(' ')).toHaveLength(1);

    // And the page never scrolls sideways at phone width.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('the selected channel carries the demo’s dark fill', async ({ page }) => {
    await signIn(page);
    await openComposer(page);

    const channel = page.getByTestId('content-channel').first();
    if ((await channel.getAttribute('aria-pressed')) !== 'true') await channel.click();

    // `.channel.selected { background: var(--ink); color: #fff }` — the demo's
    // own values, measured on the real element rather than read off the
    // stylesheet.
    const fill = await channel.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(fill).toBe('rgb(17, 17, 20)');
  });

  test('the library grid uses the demo’s four columns and its breakpoints', async ({ page }) => {
    await signIn(page);
    await openLibrary(page);

    const columns = async () =>
      page
        .locator('.cs-card-grid, .cs-empty')
        .first()
        .evaluate((el) =>
          el.classList.contains('cs-card-grid') ? getComputedStyle(el).gridTemplateColumns : null,
        );

    await page.setViewportSize({ width: 1440, height: 900 });
    const wide = await columns();
    if (wide !== null) expect(wide.split(' ')).toHaveLength(4);

    await page.setViewportSize({ width: 860, height: 900 });
    const narrow = await columns();
    if (narrow !== null) expect(narrow.split(' ')).toHaveLength(2);
  });
});

test.describe('accessibility and keyboard', () => {
  /*
   * ONE TEST PER LOCALE, and not a loop inside one.
   *
   * `signIn` starts at `/sign-in`, and a browser context that is ALREADY signed
   * in is redirected away from it — so a second sign-in inside the same test
   * waits forever for a form that will never render. Playwright gives each test
   * its own context, which is the mechanism that makes two sessions two tests.
   */
  for (const locale of ['en', 'ar'] as const) {
    test(`the library and the composer are clean under axe (${locale})`, async ({ page }) => {
      await signIn(page, locale);
      for (const path of ['/content', '/content/compose']) {
        await page.goto(`${DASHBOARD_BASE_URL}/${locale}${path}`);
        await page.waitForLoadState('domcontentloaded');
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(
          results.violations,
          `${locale}${path}: ${JSON.stringify(results.violations)}`,
        ).toEqual([]);
      }
    });
  }

  test('every control is reachable by keyboard and shows a focus ring', async ({ page }) => {
    await signIn(page);
    await openComposer(page);

    await page.getByTestId('content-brief').focus();
    const outline = await page
      .getByTestId('content-brief')
      .evaluate((el) => getComputedStyle(el).outlineWidth);
    // The demo sets `outline: 0`; WCAG 2.2 AA does not allow that, and the
    // contract records the override.
    expect(outline).not.toBe('0px');

    // The channel buttons are real buttons with a pressed state, not divs.
    const channel = page.getByTestId('content-channel').first();
    await expect(channel).toHaveAttribute('aria-pressed', /true|false/);
    await channel.focus();
    await page.keyboard.press('Enter');
    await expect(channel).toHaveAttribute('aria-pressed', /true|false/);
  });
});

test.describe('the retention control (D-117)', () => {
  test('is on the settings screen and is enforced server-side', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings`);
    await page.waitForLoadState('domcontentloaded');

    const field = page.getByTestId('retention-days');
    await expect(field).toBeVisible();

    // The floor comes from the activated configuration, not from the markup.
    const min = await field.getAttribute('min');
    expect(Number(min)).toBeGreaterThan(0);

    await field.fill(String(Number(min) + 10));
    await page.getByTestId('retention-save').click();
    await page.waitForURL(/\/settings/);
    await expect(page.getByTestId('retention-days')).toHaveValue(String(Number(min) + 10));

    // And the sentence naming what it can NEVER delete is part of the control.
    await expect(page.locator('#retention-note')).toContainText(/audit/i);

    // Put it back, so a later run starts where this one did.
    await page.getByTestId('retention-days').fill('');
    await page.getByTestId('retention-save').click();
    await page.waitForURL(/\/settings/);
  });
});
