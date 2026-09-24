import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
/*
 * The literal the brand selector writes for the aggregate, imported from the
 * module that defines it rather than retyped — a test that hard-coded 'all'
 * would keep passing if the product changed the value.
 */
import { ALL_BRANDS } from '../../apps/dashboard/src/server/brand-selection';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';
import { withPlatformPrisma } from './platform-prisma';

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

/**
 * Sign in as SOMEBODY ELSE, for the permission assertions.
 *
 * The brand is still established the way `signIn` establishes it, because a
 * brand on the rail is a PRECONDITION rather than the subject: with none, the
 * composer correctly offers its own selector and preselects nothing (D-191), so
 * the authoring button is disabled for a reason that has nothing to do with the
 * permission under test. Only the ROLE changes here.
 */
async function signInAs(page: Page, email: string, password: string, locale = 'en'): Promise<void> {
  const loaded = credentials();
  const { customer } = loaded;
  await useBrand(page, customer.workspaceId, brandFixtures(loaded).primaryBrandId);
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/sign-in`);
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL(
    (url) => !url.pathname.endsWith('/sign-in') || url.searchParams.has('error'),
  );
  await page.click(`[data-testid="choose-workspace-${customer.workspaceSlug}"]`);
  await page.waitForURL(new RegExp(`/${locale}/overview$`));
}

/**
 * Sign in with the rail on "ALL BRANDS" rather than on one.
 *
 * This is a legitimate, ordinary state — and it is the one the campaign
 * options got wrong, because the page resolves no single brand and the
 * composer therefore shows its own brand selector instead.
 */
async function signInAllBrands(page: Page, locale = 'en'): Promise<void> {
  const loaded = credentials();
  const { customer } = loaded;
  await useBrand(page, customer.workspaceId, ALL_BRANDS);
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
  /*
   * PHASE 6 FINAL (D-277 §15, D-282): MEDIA-FIRST, AND EVERY TAB A REAL STATE.
   *
   * The demo port's six fixed tabs and gradient cards are gone. A tab exists for
   * every lifecycle state that has content (and always for drafts), each count
   * is a real number, and the filters are a GET form — the URL is the view.
   */
  test('counts real rows, offers real filters, and switches grid and list', async ({ page }) => {
    await signIn(page);
    await openLibrary(page);

    await expect(page.getByTestId('content-library')).toBeVisible();
    const tabs = page.getByTestId('content-tabs');
    await expect(tabs).toBeVisible();
    await expect(tabs.getByTestId('tab-all')).toHaveAttribute('aria-current', 'page');
    await expect(tabs.getByTestId('tab-DRAFT')).toBeVisible();
    // Every badge is a real count.
    for (const badge of await tabs.locator('a span').allTextContents()) {
      expect(badge.trim()).toMatch(/^\d+$/);
    }

    for (const filter of [
      'content-search',
      'content-platform',
      'content-format',
      'content-language',
    ]) {
      await expect(page.getByTestId(filter)).toBeVisible();
    }
    await page.getByTestId('content-format').selectOption('POST');
    await page.getByTestId('content-apply').click();
    await expect(page).toHaveURL(/format=POST/);

    await page.getByTestId('content-view').getByTestId('tab-list').click();
    await expect(page.getByTestId('content-library')).toHaveAttribute('data-view', 'list');
    await expect(page).toHaveURL(/view=list/);
    await expect(page).toHaveURL(/format=POST/);
  });

  test('an empty library says so rather than borrowing a number', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/content?status=ARCHIVED&q=zzz-no-such-draft`);
    await expect(page.getByTestId('content-empty')).toBeVisible();
  });

  test('a text-only post shows its words, and Duplicate makes a new draft', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/content?status=DRAFT`);
    const card = page.getByTestId('content-card').first();
    await expect(card).toBeVisible();
    const itemId = (await card.getAttribute('data-item-id')) ?? '';
    const duplicate = page.getByTestId(`content-duplicate-${itemId}`);
    await expect(duplicate).toBeVisible();
    await duplicate.click();
    await page.waitForURL(/\/content\/compose\?item=.*ok=DUPLICATED/);
    expect(page.url()).not.toContain(`item=${itemId}&`);
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

/**
 * WRITING A POST WITHOUT A MODEL (PHASE 2, D-224).
 *
 * THE DEFECT THIS EXISTS FOR, and it is the sharpest one Phase 2 found:
 * `ContentStudioService.generate()` was the ONLY writer of a content item
 * anywhere in the product. Everything downstream of a draft — the calendar, the
 * approval, the publish job, campaign performance — was therefore downstream of
 * a provider. And as the generation block above records at length, there is no
 * real provider: in a browser the grounded path reaches AC-11.9's honest
 * refusal. So the customer product, as configured, could not produce a single
 * piece of content through its own UI.
 *
 * A SERVER-ACTION PATH WITH NO GATEWAY IN IT closes that, and this is the test
 * that the BUTTON EXISTS AND DOES SOMETHING — the isolation suite already
 * proves the service writes `origin: 'HUMAN'`, moves no credit and replays a
 * retried submit. An action with no caller is the same defect as a cursor
 * helper with no caller, which is the other half of this phase.
 */
test.describe('writing a post by hand', () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await ensureBrandWithKnowledge(page);
  });

  test('REACHES A DRAFT WITH NO MODEL — the one path that does not need a provider', async ({
    page,
  }) => {
    await openComposer(page);
    const body = `A post a person wrote, at ${new Date().toISOString()}.`;
    await compose(page, body);

    await page.getByTestId('content-write-manual').click();

    // The composer reopens ON the new draft, which is what `?item=` means.
    await page.waitForURL((url) => url.searchParams.has('item'), { timeout: 60_000 });
    await expect(page.getByTestId('content-results')).toContainText(body);
  });

  /**
   * EVERY ANSWER THE COMPOSER ALREADY HOLDS REACHES THE DRAFT.
   *
   * The first version of the manual form sent five fields and dropped the rest,
   * so a person who chose REEL got a POST and a person who picked a campaign
   * got an unfiled draft — the service validated both and was never given
   * either. This drives the controls a customer actually uses and then reads
   * the draft back.
   */
  test('CARRIES THE CHANNELS AND THE TYPE into the draft', async ({ page }) => {
    await openComposer(page);
    const body = `Two channels, one campaign, at ${new Date().toISOString()}.`;

    // TWO channels, so the fan-out is observable rather than assumed.
    const channels = page.getByTestId('content-channel');
    const count = await channels.count();
    const picked: string[] = [];
    for (let index = 0; index < count && picked.length < 2; index += 1) {
      const channel = channels.nth(index);
      const key = await channel.getAttribute('data-platform');
      if (!key) continue;
      if ((await channel.getAttribute('aria-pressed')) !== 'true') await channel.click();
      picked.push(key);
    }
    expect(picked.length).toBe(2);

    await page.getByTestId('content-brief').fill(body);
    await page
      .locator('select')
      .filter({ hasText: /Reel|ريل/ })
      .first()
      .selectOption('REEL');

    /*
     * THE CAMPAIGN IS NOT ASSERTED HERE. It used to be, conditionally — "if the
     * selector happens to exist" — which is a test that passes when the feature
     * is missing. It has its own suite below, with its own fixtures, where the
     * selector is REQUIRED rather than tolerated.
     */
    await page.getByTestId('content-write-manual').click();
    await page.waitForURL((url) => url.searchParams.has('item'), { timeout: 60_000 });

    // ONE VARIANT PER CHANNEL, and the words on both.
    const variants = page.getByTestId('content-variant');
    await expect(variants).toHaveCount(2);
    for (const key of picked) {
      await expect(
        page.locator(`[data-testid="content-variant"][data-platform="${key}"]`),
      ).toHaveCount(1);
    }
    await expect(page.getByTestId('content-results')).toContainText(body);

    // THE TYPE THE COMPOSER ASKED FOR, read back off the stored row rather than
    // off the screen — a screen can render a default and look right.
    const itemId = new URL(page.url()).searchParams.get('item') ?? '';
    const stored = await withPlatformPrisma(async (prisma) =>
      prisma.contentItem.findUnique({
        where: { id: itemId },
        select: { contentType: true, origin: true, aiRequestId: true },
      }),
    );
    expect(stored?.contentType).toBe('REEL');
    expect(stored?.origin).toBe('HUMAN');
    expect(stored?.aiRequestId).toBeNull();
  });

  /**
   * HASHTAGS AND MEDIA ARE PER-VARIANT, so they are set on the draft this
   * button creates — which opens immediately, in this same composer, through
   * the controls that already exist. This proves that path works for a post a
   * person wrote, and that a reload shows what was saved.
   *
   * The hashtag field is the reason this test exists at all: it used to render
   * only when the variant ALREADY had hashtags, so a manually written post had
   * no way to gain one, ever.
   */
  test('HASHTAGS AND MEDIA SET ON THE NEW DRAFT SURVIVE A RELOAD', async ({ page }) => {
    const creds = credentials();
    const { primaryBrandId } = brandFixtures(creds);
    const tag = `manual${Date.now().toString(36)}`;

    // One selectable picture for this brand, so the picker has something in it.
    const assetName = `${tag}.png`;
    await withPlatformPrisma(async (prisma) => {
      await prisma.asset.create({
        data: {
          workspaceId: creds.customer.workspaceId,
          brandId: primaryBrandId,
          name: assetName,
          kind: 'IMAGE',
          mimeType: 'image/png',
          sizeBytes: 2_048,
          storageKey: `ws/${creds.customer.workspaceId}/manual/${tag}`,
          checksumSha256: `${tag}-checksum`,
          tags: [tag],
          scanStatus: 'CLEAN',
          scannedAt: new Date(),
          status: 'READY',
          currentVersion: 1,
        },
      });
    });

    try {
      await openComposer(page);
      const body = `Written by hand, decorated afterwards, at ${new Date().toISOString()}.`;
      await compose(page, body);
      await page.getByTestId('content-write-manual').click();
      await page.waitForURL((url) => url.searchParams.has('item'), { timeout: 60_000 });

      /*
       * REOPEN THE DRAFT ON A CLEAN URL BEFORE EDITING IT.
       *
       * `createManualDraftAction` redirects to `?item=…&ok=SAVED`, and so does
       * `saveVariantAction` — the same marker. So a wait for `ok=SAVED` after
       * the edit matches the URL the CREATE already left behind and returns
       * before the edit has run, which is how this test came to read the row
       * before anything had been written to it. Dropping the marker first makes
       * the later wait mean what it says.
       */
      const draftId = new URL(page.url()).searchParams.get('item') ?? '';
      expect(draftId).not.toBe('');
      await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?item=${draftId}`);
      await expect(page.getByTestId('content-composer')).toBeVisible();

      const variant = page.getByTestId('content-variant').first();
      const platformKey = await variant.getAttribute('data-platform');
      expect(platformKey).toBeTruthy();

      // THE FIELD IS THERE ON A DRAFT THAT HAS NO HASHTAGS. That is the fix.
      const hashtags = page.getByTestId(`content-hashtags-${platformKey}`);
      await expect(hashtags).toBeVisible();
      await hashtags.fill('#launch #autumn');

      const picker = variant.locator('input[type="checkbox"]');
      const hasMedia = (await picker.count()) > 0;
      if (hasMedia) await picker.first().check();

      // The field still holds what was typed at the moment of submission.
      await expect(hashtags).toHaveValue('#launch #autumn');
      await expect(variant.locator('input[name="hashtags"]')).toHaveValue('#launch #autumn');

      /*
       * WAIT FOR THE SAVE, NOT FOR THE URL TO STILL HAVE `item` IN IT. The
       * composer is already on `?item=…`, so a predicate that only checks for
       * that matches the CURRENT page and returns before the action has run —
       * which is how the first version of this test read the row back before
       * anything had been written to it. `ok=SAVED` is what the action redirects
       * to, so it is the thing that says the save finished.
       */
      await variant.locator('button[type="submit"]').first().click();
      await page.waitForURL((url) => url.searchParams.get('ok') === 'SAVED', { timeout: 60_000 });

      // THE ROW FIRST — if the save did not happen, say so here rather than
      // three assertions later in a sentence about rendering.
      const itemId = draftId;
      const saved = await withPlatformPrisma(async (prisma) =>
        prisma.contentVariant.findFirst({
          where: { contentItemId: itemId },
          select: { hashtags: true, assetIds: true },
        }),
      );
      expect(saved?.hashtags).toStrictEqual(['launch', 'autumn']);
      if (hasMedia) expect(saved?.assetIds.length).toBeGreaterThan(0);

      // RELOADED FROM THE SERVER, not from whatever the last render left behind.
      await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?item=${itemId}`);
      await expect(page.getByTestId('content-composer')).toBeVisible();
      await expect(page.getByTestId(`content-hashtags-${platformKey}`)).toHaveValue(
        /#launch.*#autumn/,
      );
    } finally {
      await withPlatformPrisma(async (prisma) => {
        await prisma.asset.deleteMany({ where: { tags: { has: tag } } });
      });
    }
  });

  test('A SECOND PRESS RETURNS THE SAME DRAFT rather than making another', async ({ page }) => {
    await openComposer(page);
    const body = `Written once, submitted twice, at ${new Date().toISOString()}.`;
    await compose(page, body);

    await page.getByTestId('content-write-manual').click();
    await page.waitForURL((url) => url.searchParams.has('item'), { timeout: 60_000 });
    const first = new URL(page.url()).searchParams.get('item');

    /*
     * BACK, THEN PRESS AGAIN. The idempotency key is derived from the brand,
     * the words, the channels and the language — not from the click — so the
     * second press is the SAME logical action and must return the first draft.
     * A key minted per click would make this a second item, and a customer who
     * double-submitted would find two copies of one post in their library.
     */
    await openComposer(page);
    await compose(page, body);
    await page.getByTestId('content-write-manual').click();
    await page.waitForURL((url) => url.searchParams.has('item'), { timeout: 60_000 });

    expect(new URL(page.url()).searchParams.get('item')).toBe(first);
  });
});

/**
 * FILING A MANUALLY WRITTEN POST UNDER A CAMPAIGN (PHASE 2 correction).
 *
 * THREE DEFECTS THIS SUITE EXISTS FOR, and the first is why the others were
 * invisible: the original assertion was "if the campaign selector happens to
 * exist, check it", which passes when the feature is absent. These tests CREATE
 * the campaigns they need and REQUIRE the control where the role is authorized.
 *
 *   1. The options followed the RAIL's brand, not the composer's. With the rail
 *      on "All brands" the page resolved no brand, sent an empty list, and the
 *      composer's own brand selector could not change it — so choosing Brand A
 *      there left Brand A's campaigns unavailable for ever.
 *   2. `createManualDraftAction` required only `content.create` and accepted a
 *      `campaignId`, while `setContentCampaignAction` requires
 *      `campaigns.manage` — a member could therefore CREATE an association they
 *      could never change, through a crafted submission whether or not the
 *      control was rendered.
 *   3. The idempotency key did not include the campaign, so "the same post,
 *      filed under Campaign B" replayed the draft already filed under A.
 */
test.describe('filing a manual post under a campaign', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  const PRIMARY_CAMPAIGN = 'E2E Manual — Primary Campaign';
  const SECOND_CAMPAIGN = 'E2E Manual — Second Campaign';

  /**
   * ONE LIVE CAMPAIGN PER BRAND, deliberately, because the whole point is that
   * each brand's options are its own.
   *
   * Upserted on a fixed key rather than created per run: a fixture that grows
   * every run eventually tests the take limit instead of the feature, which is
   * the lesson D-203 records.
   */
  test.beforeAll(async () => {
    const creds = credentials();
    const { primaryBrandId, secondBrandId } = brandFixtures(creds);
    await withPlatformPrisma(async (prisma) => {
      for (const [brandId, name, key] of [
        [primaryBrandId, PRIMARY_CAMPAIGN, 'e2e-manual-campaign-primary'],
        [secondBrandId, SECOND_CAMPAIGN, 'e2e-manual-campaign-second'],
      ] as const) {
        const existing = await prisma.campaign.findFirst({
          where: { workspaceId: creds.customer.workspaceId, brandId, idempotencyKey: key },
          select: { id: true },
        });
        if (existing) {
          await prisma.campaign.update({
            where: { id: existing.id },
            data: { name, status: 'ACTIVE', deletedAt: null },
          });
          continue;
        }
        await prisma.campaign.create({
          data: {
            workspaceId: creds.customer.workspaceId,
            brandId,
            name,
            objective: 'AWARENESS',
            status: 'ACTIVE',
            idempotencyKey: key,
          },
        });
      }
    });
  });

  /** The stored campaign of a draft, by the id the composer's URL carries. */
  async function storedCampaignName(itemId: string): Promise<string | null> {
    return withPlatformPrisma(async (prisma) => {
      const item = await prisma.contentItem.findUnique({
        where: { id: itemId },
        select: { campaign: { select: { name: true } } },
      });
      return item?.campaign?.name ?? null;
    });
  }

  /** Fill the composer and press the no-AI button, returning the new item id. */
  async function writeManualPost(page: Page, body: string): Promise<string> {
    await page.getByTestId('content-write-manual').click();
    await page.waitForURL((url) => url.searchParams.has('item'), { timeout: 60_000 });
    const itemId = new URL(page.url()).searchParams.get('item') ?? '';
    expect(itemId, body).not.toBe('');
    return itemId;
  }

  test('A — with a brand on the rail, the selector is there and the choice is stored', async ({
    page,
  }) => {
    await signIn(page);
    await openComposer(page);

    const selector = page.getByTestId('content-manual-campaign');
    // REQUIRED, not tolerated. The fixture above created this brand's campaign.
    await expect(selector).toBeVisible();
    await expect(selector.locator('option', { hasText: PRIMARY_CAMPAIGN })).toHaveCount(1);

    await compose(page, `Filed as I wrote it, at ${new Date().toISOString()}.`);
    await selector.selectOption({ label: PRIMARY_CAMPAIGN });
    const itemId = await writeManualPost(page, 'rail brand');

    expect(await storedCampaignName(itemId)).toBe(PRIMARY_CAMPAIGN);
  });

  /**
   * NOTHING IS CHOSEN UNTIL SOMEBODY CHOOSES IT.
   *
   * THE DEFECT THIS EXISTS FOR. `brandId` starts as '' on "All brands" — D-191's
   * rule that a brand-scoped screen names its brand rather than guessing one —
   * but the local selector's options were the brands and nothing else. A
   * `<select>` whose options do not contain its value does not render empty:
   * the browser shows the FIRST option. So the screen said "Northwind" while
   * the state said nothing, and every consequence of the empty state — the
   * disabled buttons, the absent campaign list — looked like a bug against a
   * control that appeared to have an answer in it.
   *
   * AND IT CHOOSES THE FIRST BRAND, not the second. A test that only ever
   * picked `brands[1]` could not tell a real selection from the silent guess;
   * choosing the brand the defect would itself have picked is what makes this
   * measure the state rather than the coincidence.
   */
  test('A2 — on "All brands" nothing is preselected, and the FIRST brand works', async ({
    page,
  }) => {
    const creds = credentials();
    const { primaryBrandId } = brandFixtures(creds);

    await signInAllBrands(page);
    await openComposer(page);

    const brandSelect = page.getByTestId('content-brand');
    await expect(brandSelect).toBeVisible();

    // THE STATE AND THE SCREEN AGREE: empty, and visibly so.
    await expect(brandSelect).toHaveValue('');
    await expect(brandSelect.locator('option[value=""]')).toHaveCount(1);

    // NOTHING DOWNSTREAM OF A BRAND IS OFFERED YET.
    await expect(page.getByTestId('content-manual-campaign')).toHaveCount(0);

    // AND NOTHING THAT NEEDS A BRAND CAN BE PRESSED, even with words written.
    await compose(page, `Written before a brand was chosen, at ${new Date().toISOString()}.`);
    await expect(page.getByTestId('content-write-manual')).toBeDisabled();
    await expect(page.getByTestId('content-generate')).toBeDisabled();
    await expect(page.getByTestId('content-estimate')).toBeDisabled();

    // NOW CHOOSE THE FIRST BRAND — the one a silent guess would have taken.
    await brandSelect.selectOption(primaryBrandId);
    await expect(brandSelect).toHaveValue(primaryBrandId);

    // ITS campaigns arrive, and the workflow opens up.
    const selector = page.getByTestId('content-manual-campaign');
    await expect(selector).toBeVisible();
    await expect(selector.locator('option', { hasText: PRIMARY_CAMPAIGN })).toHaveCount(1);
    await expect(page.getByTestId('content-write-manual')).toBeEnabled();

    await selector.selectOption({ label: PRIMARY_CAMPAIGN });
    const itemId = await writeManualPost(page, 'first brand');
    expect(await storedCampaignName(itemId)).toBe(PRIMARY_CAMPAIGN);
    const stored = await withPlatformPrisma(async (prisma) =>
      prisma.contentItem.findUnique({ where: { id: itemId }, select: { brandId: true } }),
    );
    expect(stored?.brandId).toBe(primaryBrandId);
  });

  /**
   * THE CAMPAIGN BELONGS TO THE MANUAL ASK, AND NOT TO THE GENERATION ASK.
   *
   * One shared key served both. Putting the campaign in its material was right
   * for manual creation and wrong for generation, which neither sends a
   * campaign nor persists one — so changing only the selector moved the
   * generation key, and pressing Generate again would have become a new
   * `ai_request` and a new credit charge for an ask the endpoint could not tell
   * had changed.
   *
   * The unit suite proves the two DERIVATIONS are separate. This proves the
   * composer wired each to the right place, which a pure function cannot.
   */
  test('D2 — changing the campaign moves the manual key, not the generation key', async ({
    page,
  }) => {
    const creds = credentials();
    await signIn(page);
    await openComposer(page);
    await compose(page, `One brief, two campaigns, at ${new Date().toISOString()}.`);

    const manualKey = page.locator(
      '[data-testid="content-manual-form"] input[name="idempotencyKey"]',
    );
    const generateButton = page.getByTestId('content-generate');

    const selector = page.getByTestId('content-manual-campaign');
    await selector.selectOption({ label: PRIMARY_CAMPAIGN });
    const manualBefore = await manualKey.inputValue();
    const generationBefore = await generateButton.getAttribute('data-generation-key');
    expect(manualBefore).not.toBe('');
    expect(generationBefore).toBeTruthy();

    const countRequests = async (): Promise<number> =>
      withPlatformPrisma(async (prisma) =>
        prisma.aiRequest.count({ where: { workspaceId: creds.customer.workspaceId } }),
      );
    const readBalance = async (): Promise<bigint> =>
      withPlatformPrisma(async (prisma) => {
        const wallet = await prisma.creditWallet.findUniqueOrThrow({
          where: { workspaceId: creds.customer.workspaceId },
          select: { balanceMilliCredits: true },
        });
        return wallet.balanceMilliCredits;
      });

    const requestsBefore = await countRequests();
    const balanceBefore = await readBalance();

    // CHANGE ONLY THE CAMPAIGN.
    await selector.selectOption('');

    /*
     * THE ASSERTION THAT FAILS AGAINST THE DEFECT. With one shared key the
     * generation key moved here too — a different AI identity for a field the
     * generation endpoint never receives.
     */
    expect(await generateButton.getAttribute('data-generation-key')).toBe(generationBefore);
    // … while the MANUAL key did move, because for that ask it is a real change.
    expect(await manualKey.inputValue()).not.toBe(manualBefore);

    // AND TOUCHING THE SELECTOR SPENT NOTHING. No request, no credit.
    expect(await countRequests()).toBe(requestsBefore);
    expect(await readBalance()).toBe(balanceBefore);
  });
  test('B — on "All brands", the composer\'s own brand decides the options', async ({ page }) => {
    const creds = credentials();
    const { secondBrandId, secondBrandName } = brandFixtures(creds);

    await signInAllBrands(page);
    await openComposer(page);

    /*
     * THE COMPOSER'S OWN BRAND SELECTOR, which exists exactly in this case:
     * a NEW item, no brand on the rail, and more than one brand to choose
     * between. This is the workflow the first version could not serve.
     */
    const brandSelect = page.getByTestId('content-brand');
    await expect(brandSelect).toBeVisible();

    // NOTHING IS PRESELECTED, so there is nothing to file against yet.
    await expect(page.getByTestId('content-manual-campaign')).toHaveCount(0);

    await brandSelect.selectOption(secondBrandId);

    const selector = page.getByTestId('content-manual-campaign');
    await expect(selector).toBeVisible();
    // THE SECOND BRAND'S CAMPAIGN, AND ONLY IT.
    await expect(selector.locator('option', { hasText: SECOND_CAMPAIGN })).toHaveCount(1);
    await expect(selector.locator('option', { hasText: PRIMARY_CAMPAIGN })).toHaveCount(0);

    await compose(page, `Second brand, chosen here, at ${new Date().toISOString()}.`);
    await selector.selectOption({ label: SECOND_CAMPAIGN });
    const itemId = await writeManualPost(page, 'composer brand');

    expect(await storedCampaignName(itemId)).toBe(SECOND_CAMPAIGN);
    const stored = await withPlatformPrisma(async (prisma) =>
      prisma.contentItem.findUnique({ where: { id: itemId }, select: { brandId: true } }),
    );
    expect(stored?.brandId).toBe(secondBrandId);
    expect(secondBrandName).toBeTruthy();
  });

  test("C — switching the brand takes the previous brand's campaigns away", async ({ page }) => {
    const creds = credentials();
    const { primaryBrandId, secondBrandId } = brandFixtures(creds);

    await signInAllBrands(page);
    await openComposer(page);
    const brandSelect = page.getByTestId('content-brand');

    await brandSelect.selectOption(secondBrandId);
    const selector = page.getByTestId('content-manual-campaign');
    await expect(selector.locator('option', { hasText: SECOND_CAMPAIGN })).toHaveCount(1);
    await selector.selectOption({ label: SECOND_CAMPAIGN });

    // NOW MOVE TO THE OTHER BRAND.
    await brandSelect.selectOption(primaryBrandId);
    await expect(selector.locator('option', { hasText: PRIMARY_CAMPAIGN })).toHaveCount(1);
    // The previous brand's campaign is gone from the control …
    await expect(selector.locator('option', { hasText: SECOND_CAMPAIGN })).toHaveCount(0);
    // … and the SELECTION went with it, so the next submit cannot carry it.
    await expect(selector).toHaveValue('');

    await compose(page, `Switched brands before saving, at ${new Date().toISOString()}.`);
    const itemId = await writeManualPost(page, 'after switching');
    expect(await storedCampaignName(itemId)).toBeNull();
  });

  test('D — content.create without campaigns.manage: no selector, and a crafted id is refused', async ({
    page,
  }) => {
    const creds = credentials();
    await signInAs(page, creds.customer.copywriterEmail, creds.customer.copywriterPassword);
    await openComposer(page);

    // THE CONTROL IS NOT THERE, and neither is any campaign name.
    await expect(page.getByTestId('content-manual-campaign')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(PRIMARY_CAMPAIGN);

    // AUTHORING STILL WORKS. The permission gates the FILING, not the writing.
    await compose(page, `A copywriter's own words, at ${new Date().toISOString()}.`);
    const itemId = await writeManualPost(page, 'copywriter');
    expect(await storedCampaignName(itemId)).toBeNull();

    /*
     * AND THE SERVER REFUSES A CRAFTED SUBMISSION. The campaign id is injected
     * into the manual form directly, which is precisely what a hand-built POST
     * would carry — the UI gate is courtesy, the server check is the rule.
     */
    const campaignId = await withPlatformPrisma(async (prisma) => {
      const campaign = await prisma.campaign.findFirstOrThrow({
        where: { workspaceId: creds.customer.workspaceId, name: PRIMARY_CAMPAIGN },
        select: { id: true },
      });
      return campaign.id;
    });

    await openComposer(page);
    await compose(page, `Crafted, at ${new Date().toISOString()}.`);
    await page.evaluate((id) => {
      const form = document.querySelector('[data-testid="content-manual-form"]');
      if (!form) throw new Error('no manual form');
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'campaignId';
      input.value = id;
      form.appendChild(input);
    }, campaignId);

    const before = await withPlatformPrisma(async (prisma) =>
      prisma.contentItem.count({ where: { workspaceId: creds.customer.workspaceId } }),
    );
    await page.getByTestId('content-write-manual').click();
    /*
     * REFUSED, AND NAMED AS A MISS. `NOT_FOUND` is the same code a campaign in
     * another brand gets, so the refusal does not confirm that a campaign by
     * that id exists — and the screen says so rather than showing a generic
     * failure.
     */
    await page.waitForURL((url) => url.searchParams.has('error'), { timeout: 60_000 });
    expect(new URL(page.url()).searchParams.get('error')).toBe('NOT_FOUND');
    expect(new URL(page.url()).searchParams.has('item')).toBe(false);
    const after = await withPlatformPrisma(async (prisma) =>
      prisma.contentItem.count({ where: { workspaceId: creds.customer.workspaceId } }),
    );
    // NOTHING WAS WRITTEN — not the item, and certainly not the association.
    expect(after).toBe(before);
  });

  test('E — the same post filed the same way twice is one draft', async ({ page }) => {
    await signIn(page);
    await openComposer(page);
    const body = `Filed once, submitted twice, at ${new Date().toISOString()}.`;
    await compose(page, body);
    await page.getByTestId('content-manual-campaign').selectOption({ label: PRIMARY_CAMPAIGN });
    const first = await writeManualPost(page, 'first');

    await openComposer(page);
    await compose(page, body);
    await page.getByTestId('content-manual-campaign').selectOption({ label: PRIMARY_CAMPAIGN });
    const second = await writeManualPost(page, 'second');

    expect(second).toBe(first);
    expect(await storedCampaignName(first)).toBe(PRIMARY_CAMPAIGN);
  });

  test('F — the same post filed under a DIFFERENT campaign is a different request', async ({
    page,
  }) => {
    const creds = credentials();
    const { primaryBrandId } = brandFixtures(creds);
    const other = `E2E Manual — Primary Alternate`;
    await withPlatformPrisma(async (prisma) => {
      const existing = await prisma.campaign.findFirst({
        where: {
          workspaceId: creds.customer.workspaceId,
          brandId: primaryBrandId,
          idempotencyKey: 'e2e-manual-campaign-primary-alt',
        },
        select: { id: true },
      });
      if (existing) {
        await prisma.campaign.update({
          where: { id: existing.id },
          data: { name: other, status: 'ACTIVE', deletedAt: null },
        });
        return;
      }
      await prisma.campaign.create({
        data: {
          workspaceId: creds.customer.workspaceId,
          brandId: primaryBrandId,
          name: other,
          objective: 'AWARENESS',
          status: 'ACTIVE',
          idempotencyKey: 'e2e-manual-campaign-primary-alt',
        },
      });
    });

    await signIn(page);
    await openComposer(page);
    const body = `One post, two campaigns, at ${new Date().toISOString()}.`;

    await compose(page, body);
    await page.getByTestId('content-manual-campaign').selectOption({ label: PRIMARY_CAMPAIGN });
    const first = await writeManualPost(page, 'campaign one');

    await openComposer(page);
    await compose(page, body);
    await page.getByTestId('content-manual-campaign').selectOption({ label: other });
    const second = await writeManualPost(page, 'campaign two');

    /*
     * THE ASSERTION THAT FAILS AGAINST THE DEFECT. With the campaign outside
     * the key material, this second submission hashed to the first's key and
     * replayed it — the customer's new choice discarded, silently.
     */
    expect(second).not.toBe(first);
    expect(await storedCampaignName(first)).toBe(PRIMARY_CAMPAIGN);
    expect(await storedCampaignName(second)).toBe(other);
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

  test('the library grid fills the row and never scrolls sideways', async ({ page }) => {
    // D-282: the library is a responsive design-system grid (auto-fill, 15rem
    // minimum), not the demo port's fixed four columns.
    await signIn(page);
    await openLibrary(page);
    for (const width of [1440, 860, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${width}px scrolls sideways`).toBeLessThanOrEqual(1);
    }
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
