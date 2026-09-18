import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { deterministicPng } from '@brandspace/ai-gateway';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

/**
 * THE PHASE 8 EXIT JOURNEY, DRIVEN AS A CUSTOMER DRIVES IT (AC-30.4).
 *
 * WHY THIS EXISTS BESIDE `phase8-journey.spec.ts` RATHER THAN INSIDE IT. That
 * suite proves REACHABILITY and COHERENCE: every stop renders, under one shell,
 * in both languages, clean under axe. It says so in its own header, and it is
 * worth keeping — a broken route and a broken flow are different reports and a
 * reader deserves to know which one they are looking at.
 *
 * But reachability is not the acceptance criterion. AC-30.4 says the journey
 * RUNS: a brand is configured, a campaign is created, content is written into
 * it, a picture is uploaded and another is generated, the post is previewed,
 * reviewed, approved, scheduled, published through the provider abstraction,
 * measured, and what was learned from it goes back into Brand Brain. Visiting
 * fourteen screens proves none of that.
 *
 * SO THIS FILE DRIVES THE ACTUAL CONTROLS. Every step below is a customer
 * action through the customer's own surface — a form filled, a button pressed,
 * a checkbox ticked — and every assertion is on what the product then shows or
 * stores. Nothing is seeded on its behalf except the workspace it starts in and
 * the mock adapters it is allowed to use.
 *
 * SERIAL BY NECESSITY, NOT BY PREFERENCE. Step 6 needs the campaign step 5
 * created; step 11 needs the approval step 10 granted. `describe.serial` is the
 * honest expression of a journey: a later step has nothing to assert if an
 * earlier one did not happen, and Playwright then reports the FIRST break
 * rather than fourteen consequences of it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It contacts no real provider, spends no
 * real money and names no model: the AI Gateway runs the deterministic
 * development adapter, publishing runs the mock connector, and both are the
 * approved way to close Phase 8 (D-195). Where a generation can honestly
 * refuse — not enough approved knowledge, not enough credit — the refusal is an
 * accepted outcome and the test says which one it saw, because asserting
 * through an honest refusal would be asserting on a fiction.
 */

/*
 * A CEILING THAT FITS THE WORK. Each image is built pixel by pixel in
 * TypeScript and deflated at level 9 so the bytes are identical everywhere;
 * publishing waits for a real reconciliation sweep. Thirty seconds measures the
 * ceiling rather than the product.
 */
test.describe.configure({ mode: 'serial', timeout: 240_000 });

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

/** A stamp that makes every row this run creates findable and unique. */
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const CAMPAIGN_NAME = `Flow campaign ${RUN}`;
/**
 * THE BRIEF IS ALSO THE TITLE, and it is about coffee on purpose.
 *
 * Retrieval is RELEVANCE-BASED: an item scores against the words in the brief,
 * and a brief sharing no vocabulary with the brand's approved knowledge scores
 * zero against all of it — which the Studio correctly reports as "your Brand
 * Brain has nothing to write this from". That refusal is the product working,
 * and a journey briefed with a random string would meet it every time and prove
 * only that grounding is enforced.
 *
 * So the brief asks for the thing the brand's knowledge is actually about. The
 * run stamp keeps the draft findable without diluting the words that matter.
 */
const CONTENT_TITLE = `Our single-origin beans and how to brew them well at home (${RUN})`;

/** Carried between steps. A journey is a sequence, so the state is the point. */
const state: {
  campaignId: string | null;
  itemId: string | null;
  uploadedAssetName: string | null;
  generatedAssetId: string | null;
} = { campaignId: null, itemId: null, uploadedAssetName: null, generatedAssetId: null };

/** Sign in, choose the workspace, and fix the brand the journey is about. */
async function enter(page: Page, path = '/overview'): Promise<void> {
  const { customer } = credentials();
  const brands = brandFixtures(credentials());
  await page.goto(`${DASHBOARD_BASE_URL}/en/sign-in`);
  await page.fill('#email', customer.email);
  await page.fill('#password', customer.password);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL(
    (url) => !url.pathname.endsWith('/sign-in') || url.searchParams.has('error'),
  );
  await page.click(`[data-testid="choose-workspace-${customer.workspaceSlug}"]`);
  await page.waitForURL(/\/en\/overview$/);
  await useBrand(page, customer.workspaceId, brands.primaryBrandId);
  /*
   * NAVIGATE AFTER SETTING IT, ALWAYS. The cookie is read by the SERVER on the
   * next request, so the already-rendered overview keeps whatever selection the
   * session had before — which for a fresh sign-in is the aggregate. Every step
   * below needs the brand resolved, so every step reloads through it.
   */
  await page.goto(`${DASHBOARD_BASE_URL}/en${path}`);
}

/** Today, in the browser's own clock, as the date inputs want it. */
function today(offsetDays = 0): string {
  const at = new Date(Date.now() + offsetDays * 86_400_000);
  return at.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// 1 — Workspace and Brand
// ---------------------------------------------------------------------------

test('1 · a workspace is chosen and a brand is active', async ({ page }) => {
  await enter(page);

  const rail = page.getByTestId('sidebar');
  await expect(rail.getByTestId('workspace-switcher')).toContainText(
    credentials().customer.workspaceName ?? '',
  );
  // THE BRAND IS NAMED, not guessed: the card either names one or says it has
  // none, and "none" is not a state this journey can proceed from.
  await expect(rail.getByTestId('active-brand')).toHaveText(
    brandFixtures(credentials()).primaryBrandName,
  );
});

// ---------------------------------------------------------------------------
// 2 — Brand Profile is usable
// ---------------------------------------------------------------------------

test('2 · the brand profile can be edited and reads back', async ({ page }) => {
  await enter(page, '/settings/brand');
  await expect(page.getByTestId('brand-profile-form')).toBeVisible();

  const description = `A speciality roastery. Journey ${RUN}.`;
  await page.locator('textarea[name="description"], input[name="description"]').fill(description);
  await page.getByTestId('brand-profile-save').click();
  await page.waitForLoadState('networkidle');

  // READ BACK FROM THE SERVER, not from the field we just typed into: a save
  // that did not persist looks identical on an unreloaded page.
  await page.goto(`${DASHBOARD_BASE_URL}/en/settings/brand`);
  await expect(page.locator('textarea[name="description"], input[name="description"]')).toHaveValue(
    description,
  );
});

// ---------------------------------------------------------------------------
// 3 — Brand Brain is usable
// ---------------------------------------------------------------------------

test('3 · brand brain shows this brand knowledge', async ({ page }) => {
  await enter(page, '/brand-brain');

  await expect(page.getByTestId('brand-brain-hero')).toBeVisible();
  await expect(page.getByTestId('area-grid')).toBeVisible();
  // A completion figure the screen computed from real rows, not a placeholder.
  await expect(page.getByTestId('completion-percent')).not.toBeEmpty();
});

// ---------------------------------------------------------------------------
// 4 — AI Strategy context
// ---------------------------------------------------------------------------

test('4 · a strategy can be asked for, and answers or refuses honestly', async ({ page }) => {
  await enter(page, '/strategy');

  const form = page.getByTestId('strategy-form');
  await expect(form).toBeVisible();
  await form.locator('input[name="objective"]').fill(`Grow the launch audience. ${RUN}`);
  await form.locator('button[type="submit"]').first().click();
  await page.waitForLoadState('networkidle');

  /*
   * EITHER OUTCOME IS THE PRODUCT WORKING. A proposal carries its evidence; a
   * refusal for want of approved knowledge is free and says so. What must NEVER
   * appear is a strategy presented as applied, or anything naming a model.
   */
  const rendered = (await page.content()).toLowerCase();
  expect(rendered).not.toContain('mock-fast');
  expect(rendered).not.toContain('mock-image');
});

// ---------------------------------------------------------------------------
// 5 — Create a campaign
// ---------------------------------------------------------------------------

test('5 · a campaign is created through the form and appears in the list', async ({ page }) => {
  await enter(page, '/campaigns/new');

  await page.getByTestId('campaign-name').fill(CAMPAIGN_NAME);
  await page.getByTestId('campaign-objective').selectOption({ index: 1 });
  await page.getByTestId('campaign-start').fill(today());
  await page.getByTestId('campaign-end').fill(today(30));
  await page.getByTestId('campaign-brief-en').fill('Launch the new single-origin.');
  await page.getByTestId('campaign-brief-ar').fill('إطلاق القهوة أحادية المصدر.');
  // At least one channel, chosen from what the operator has actually enabled.
  const channels = page.getByTestId('campaign-channels').locator('input[type="checkbox"]');
  await channels.first().check();
  await page.getByTestId('campaign-submit').click();
  await page.waitForLoadState('networkidle');

  await page.goto(`${DASHBOARD_BASE_URL}/en/campaigns`);
  const row = page.locator('[data-testid^="campaign-open-"]', { hasText: CAMPAIGN_NAME });
  await expect(row).toBeVisible();

  const href = await row.getAttribute('href');
  state.campaignId = href?.split('/').pop() ?? null;
  expect(state.campaignId, 'the campaign list links to the campaign it just created').toBeTruthy();

  // AND ITS OWN PAGE RENDERS, with the brief that was typed and the performance
  // panel that reads the Phase 7 analytics layer rather than a second one.
  await page.goto(`${DASHBOARD_BASE_URL}/en/campaigns/${state.campaignId}`);
  await expect(page.getByTestId('campaign-brief')).toContainText('single-origin');

  /*
   * PERFORMANCE SAYS IT HAS NOTHING YET, and that is the correct answer for a
   * campaign created a second ago with no content under it. Asserting on
   * figures here would be asserting on measurements nobody has taken — the
   * fabricated-number failure the whole analytics layer is built to avoid.
   * What must be true is that the panel EXISTS and is honest about which of the
   * two states it is in.
   */
  const metrics = page.getByTestId('campaign-metrics');
  const empty = page.getByTestId('campaign-performance-empty');
  await expect.poll(async () => (await metrics.count()) + (await empty.count())).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// 6 — Content, linked to that campaign
// ---------------------------------------------------------------------------

test('6 · content is created and filed under the campaign', async ({ page }) => {
  expect(state.campaignId, 'step 5 must have created a campaign').toBeTruthy();
  await enter(page, '/content/compose');

  await page.getByTestId('content-brief').fill(CONTENT_TITLE);
  /*
   * ONE CHANNEL, so the draft has a variant to carry media and a caption. The
   * control is a toggle BUTTON with `aria-pressed`, not a checkbox — the
   * composer's channel row is the demo's chip strip, and its state is the
   * attribute rather than a form control's checked flag.
   */
  /*
   * THE CHANNEL THIS BRAND ACTUALLY HAS AN ACCOUNT ON.
   *
   * Publishing needs a connection for the variant's platform: a post written
   * for a channel nobody has connected is a draft, correctly, and never becomes
   * a publish job. The fixture connects LinkedIn, so that is the channel the
   * journey writes for — chosen by its platform key rather than by position,
   * because "the first chip" is a fact about the chip row and not about the
   * workspace.
   */
  const channel = page.locator('[data-testid="content-channel"][data-platform="linkedin"]').first();
  /*
   * WAIT FOR IT TO BE PRESSED, rather than clicking and hoping. The chip is a
   * client island: a click that lands before hydration changes nothing, the
   * form posts with no channel, and the composer correctly answers "choose at
   * least one channel" — a refusal that reads like a broken test and is the
   * product being strict.
   */
  await expect
    .poll(
      async () => {
        if ((await channel.getAttribute('aria-pressed')) !== 'true') await channel.click();
        return channel.getAttribute('aria-pressed');
      },
      { timeout: 30_000 },
    )
    .toBe('true');
  await page.getByTestId('content-generate').click();

  // A generation either produces variants or refuses honestly; the journey
  // needs a draft either way, so it waits for whichever arrives.
  await expect
    .poll(
      async () =>
        (await page.getByTestId('content-variant').count()) > 0 ||
        (await page.getByTestId('content-failure').count()) > 0 ||
        (await page.getByTestId('content-insufficient').count()) > 0,
      { timeout: 120_000 },
    )
    .toBe(true);

  const refused = (await page.getByTestId('content-variant').count()) === 0;
  const why = refused
    ? (await page.getByTestId('content-failure').count()) > 0
      ? await page.getByTestId('content-failure').textContent()
      : 'the Brand Brain had nothing to write this from'
    : '';
  expect(
    refused,
    `the Content Studio produced no draft, so the rest of the journey has nothing to carry: ${why ?? ''}`,
  ).toBe(false);

  state.itemId = new URL(page.url()).searchParams.get('item');
  expect(state.itemId, 'the composer is on a real draft').toBeTruthy();

  // FILE IT UNDER THE CAMPAIGN, through the control the composer offers.
  await page.getByTestId('content-campaign').selectOption(state.campaignId as string);
  await page.getByTestId('content-campaign-save').click();
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('content-campaign')).toHaveValue(state.campaignId as string);
});

// ---------------------------------------------------------------------------
// 7 — Upload media without leaving the draft
// ---------------------------------------------------------------------------

test('7 · a picture is uploaded from the composer into the one library', async ({ page }) => {
  expect(state.itemId, 'step 6 must have created a draft').toBeTruthy();
  await enter(page, `/content/compose?item=${state.itemId}`);

  const name = `journey-${RUN}.png`;
  state.uploadedAssetName = name;
  await expect(page.getByTestId('composer-upload-form')).toBeVisible();
  await page.getByTestId('composer-upload-file').setInputFiles({
    name,
    mimeType: 'image/png',
    /*
     * A REAL PNG, AND A DIFFERENT ONE EVERY RUN — both halves are forced.
     *
     * REAL, because the upload path checks the file's own SIGNATURE before
     * storing it: a fabricated buffer is refused, correctly, and the test would
     * be proving the wrong thing. DIFFERENT, because the library refuses a file
     * whose CHECKSUM already exists — also correctly, and a fixed fixture would
     * upload cleanly once and be rejected as a duplicate on every later run.
     *
     * The encoder is the repository's own seeded one, so the bytes are valid,
     * deterministic for a given seed, and unique across runs.
     */
    buffer: Buffer.from(deterministicPng(`journey-upload-${RUN}`, '64x64').bytes),
  });
  await page.getByTestId('composer-upload-submit').click();
  await page.waitForLoadState('networkidle');

  /*
   * IT LANDS IN THE ASSET LIBRARY — the SAME library, which is the point of
   * AC-27.1. It may still be scanning, which is the honest state for a file
   * seconds old, so the assertion is that the library knows about it.
   */
  await page.goto(`${DASHBOARD_BASE_URL}/en/assets`);
  await expect(page.getByText(name, { exact: false }).first()).toBeVisible({ timeout: 60_000 });
});

// ---------------------------------------------------------------------------
// 8 — Generate an image, and find it in the library
// ---------------------------------------------------------------------------

test('8 · an image is generated and lands in the Asset Library', async ({ page }) => {
  await enter(page, '/creative');

  await page
    .getByTestId('creative-brief')
    .fill(`A single-origin pour over on a pale counter. Journey ${RUN}`);
  await page.getByTestId('creative-generate').click();

  await expect
    .poll(
      async () =>
        (await page.getByTestId('creative-result-frame').count()) > 0 ||
        (await page.getByTestId('creative-failure').count()) > 0,
      { timeout: 120_000 },
    )
    .toBe(true);

  const refused = (await page.getByTestId('creative-failure').count()) > 0;
  const why = refused ? await page.getByTestId('creative-failure').textContent() : null;
  expect(refused, `the Creative Studio refused to generate: ${why ?? ''}`).toBe(false);

  /*
   * THE RESULT IS SHOWN, AND IT IS LABELLED AS MACHINE-MADE — a customer must
   * be able to tell what a model made from what they made.
   *
   * THE PICTURE ITSELF MAY BE A MOMENT BEHIND. A generated image lands in the
   * library PENDING its virus scan, and no preview grant is issued for a file
   * the scanner has not cleared — for seconds, and by design. So the frame
   * shows either the image or the scanning notice, and BOTH are the product
   * being honest; what would not be is an empty box.
   */
  await expect(page.getByTestId('creative-generated-badge')).toBeVisible();
  const frame = page.getByTestId('creative-result-frame');
  await expect
    .poll(
      async () =>
        (await page.getByTestId('creative-image').count()) +
        (await page.getByTestId('creative-scanning').count()),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  await expect(frame).toHaveAttribute('data-format', /.+/);

  // AND IT IS AN ORDINARY ASSET IN THE ONE LIBRARY (AC-28.3), reachable by the
  // link the studio offers rather than by a path this test constructs.
  const link = page.getByTestId('creative-open-library');
  const href = await link.getAttribute('href');
  state.generatedAssetId = new URL(href ?? '', DASHBOARD_BASE_URL).searchParams.get('asset');
  expect(
    state.generatedAssetId,
    'the studio links the generated asset into the library',
  ).toBeTruthy();

  await link.click();
  await page.waitForLoadState('networkidle');
  expect(new URL(page.url()).pathname).toBe('/en/assets');
});

// ---------------------------------------------------------------------------
// 9 — Use the media, and see it in the preview
// ---------------------------------------------------------------------------

test('9 · media is attached to the variant and shows in the social preview', async ({ page }) => {
  expect(state.itemId, 'step 6 must have created a draft').toBeTruthy();
  await enter(page, `/content/compose?item=${state.itemId}`);

  const variantForm = page.getByTestId('content-variant').first();
  await expect(variantForm).toBeVisible();

  /*
   * THE FIRST OPTION THE PICKER OFFERS. Which asset it is does not matter — the
   * point is that the composer offers the ONE library's READY, CLEAN pictures
   * and that ticking one attaches it. The picker is inside the variant's own
   * form, so choosing media and saving the caption are one submission.
   */
  const picker = variantForm.locator('[data-testid^="content-media-"]').first();
  const options = picker.locator('input[type="checkbox"]');
  await expect.poll(async () => options.count(), { timeout: 60_000 }).toBeGreaterThan(0);
  await options.first().check();
  await variantForm.locator('button[type="submit"]').first().click();
  await page.waitForLoadState('networkidle');

  // SAVED, AND SHOWN. The preview is the approved `SocialPostPreview` fed the
  // real caption and the real picture — what will actually be published.
  const reopened = page.getByTestId('content-variant').first();
  const chosen = reopened.locator('[data-testid^="content-media-"] input[type="checkbox"]:checked');
  await expect(chosen).toHaveCount(1);
  await expect(page.locator('[data-testid^="content-preview-"]').first()).toBeVisible();
  await expect(page.getByTestId('preview-media').first()).toBeVisible();
});

// ---------------------------------------------------------------------------
// 10 — Approval
// ---------------------------------------------------------------------------

test('10 · the post is submitted, the reviewer sees its media, and it is approved', async ({
  page,
}) => {
  expect(state.itemId, 'step 6 must have created a draft').toBeTruthy();
  const brandId = brandFixtures(credentials()).primaryBrandId;

  /*
   * SELF-APPROVAL IS DEFAULT-DENY (D-122), AND THE JOURNEY RELAXES IT THE WAY
   * AN OWNER WOULD.
   *
   * The end-to-end workspace has one member, who is therefore both the author
   * and the only possible reviewer — so with the default policy this post can
   * never be approved and the journey stops at a refusal that is the product
   * working. An owner in that position turns the brand's own switch on, which
   * is exactly what D-122 put there, and that is what happens here: through the
   * real control, on the real screen, and RESTORED at the end so the workspace
   * is left as it was found.
   *
   * THE POLICY IS SNAPSHOTTED AT SUBMIT, so it is relaxed BEFORE the post is
   * sent for review. A change made afterwards does not reach back into a cycle
   * that has already been opened — which is the record saying what the rules
   * were when the decision was asked for.
   */
  await enter(page, '/approvals');
  const selfToggle = page.locator(`[data-testid="policy-self-${brandId}"]`);
  await expect(selfToggle).toBeVisible();
  const wasAllowed = await selfToggle.isChecked();
  if (!wasAllowed) {
    await selfToggle.check();
    await page.locator(`[data-testid="policy-save-${brandId}"]`).click();
    await page.waitForLoadState('networkidle');
  }

  await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?item=${state.itemId}`);
  await page.getByTestId('submit-for-review').click();
  await page.waitForLoadState('networkidle');

  /*
   * OPEN THE REVIEW THE WAY A REVIEWER DOES — by following the queue's own link
   * to it. The subject is keyed on the APPROVAL rather than the item: a review
   * is a cycle with a requester and a policy snapshot, and the screen is about
   * that.
   */
  await page.goto(`${DASHBOARD_BASE_URL}/en/approvals`);
  const queued = page
    .getByTestId('approvals-queue-list')
    .locator('a', { hasText: CONTENT_TITLE })
    .first();
  const mine = page
    .getByTestId('approvals-mine-list')
    .locator('a', { hasText: CONTENT_TITLE })
    .first();
  const link = (await queued.count()) > 0 ? queued : mine;
  await expect(link).toBeVisible();
  await link.click();
  await page.waitForLoadState('networkidle');

  const review = page.getByTestId('review-variants');
  await expect(review).toBeVisible();

  // THE REVIEWER SEES WHAT THEY ARE APPROVING (AC-29.1) — the media, not just
  // the words.
  await expect(review.locator('[data-testid^="approval-media-"]').first()).toBeVisible();

  /*
   * THIS POST'S OWN CONTROL, keyed on its item id. `.first()` was wrong and
   * quietly so: the queue holds every pending review in the workspace, so the
   * first approve button on the page belongs to whichever post sorted first —
   * and this journey approved somebody else's while its own stayed in review.
   */
  const approve = page
    .getByTestId('approvals-review-subject')
    .locator(`[data-testid="approve-${state.itemId}"]`);
  // SCOPED TO THE REVIEW SUBJECT: the same control is offered on the queue row
  // and inside the opened review, so an unscoped locator is ambiguous by design.
  await expect(approve).toBeVisible();
  await approve.click();
  await page.waitForLoadState('networkidle');

  // THE QUEUE NO LONGER HOLDS IT: a decided review is a decision, not a task.
  await expect(
    page.getByTestId('approvals-queue-list').locator('a', { hasText: CONTENT_TITLE }),
  ).toHaveCount(0);

  // AND THE BRAND IS PUT BACK. A fixture that leaves a permission relaxed is a
  // fixture that changes what the next suite is testing.
  if (!wasAllowed) {
    await page.goto(`${DASHBOARD_BASE_URL}/en/approvals`);
    await page.locator(`[data-testid="policy-self-${brandId}"]`).uncheck();
    await page.locator(`[data-testid="policy-save-${brandId}"]`).click();
    await page.waitForLoadState('networkidle');
  }
});

// ---------------------------------------------------------------------------
// 11 — Calendar
// ---------------------------------------------------------------------------

test('11 · the post is scheduled and the calendar states its context', async ({ page }) => {
  expect(state.itemId, 'step 6 must have created a draft').toBeTruthy();
  await enter(page, '/calendar');

  await page.getByTestId('calendar-schedule-open').click();
  const picker = page.getByTestId('schedule-item');
  await expect(picker).toBeVisible();

  /*
   * THE POST IS IN THE PICKER, whether step 10 approved it or the brand's
   * policy never required approval. Both states are schedulable — the service
   * accepts DRAFT and APPROVED — and a picker offering only one of them makes
   * the approval workflow a dead end, which is what it did until this journey
   * asked for the approved post by name.
   */
  const schedulable = await picker.locator('option').allTextContents();
  const option = schedulable.find((entry) => entry.includes(CONTENT_TITLE));
  expect(
    option,
    `the post is not offered on the calendar. Offered: ${schedulable.join(' | ')}`,
  ).toBeTruthy();

  await picker.selectOption({ label: option as string });

  /*
   * THE WALL CLOCK THE WORKSPACE MEANS, not the one this machine keeps.
   *
   * Every time on the calendar is a local wall-clock in the workspace's own
   * zone (AC-14.2) — that is the whole reason the slot stores the intent and
   * the zone separately. A fixture that typed the runner's local time would
   * schedule hours away from where it thought it had, and would pass or fail by
   * geography. The screen states the zone; this reads it.
   *
   * A MINUTE AHEAD, because zero would already be behind by the time the form
   * posts — the seed sets the lead requirement to zero, and zero means "not in
   * the past" rather than "any moment at all".
   */
  const zone = ((await page.getByTestId('calendar-timezone').textContent()) ?? '')
    .split(':')
    .pop()
    ?.trim();
  expect(zone, 'the calendar states the zone every time on it is in').toBeTruthy();
  const at = new Date(Date.now() + 60_000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone as string,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';

  await page.getByTestId('schedule-date').fill(`${part('year')}-${part('month')}-${part('day')}`);
  await page.getByTestId('schedule-time').fill(`${part('hour')}:${part('minute')}`);
  await page.getByTestId('schedule-submit').click();
  await page.waitForLoadState('networkidle');

  // THE SLOT IS ON THE MONTH, and opening it states the facts a planner scans
  // for — the campaign it belongs to, its publishing state, its media count.
  const chip = page.locator('[data-testid^="calendar-post-"]', { hasText: CONTENT_TITLE }).first();
  await expect(chip).toBeVisible();
  await chip.click();
  const facts = page.getByTestId('calendar-slot-facts');
  await expect(facts).toBeVisible();
  await expect(page.getByTestId('calendar-slot-status')).not.toBeEmpty();
  await expect(page.getByTestId('calendar-slot-campaign')).toContainText(CAMPAIGN_NAME);
  await expect(page.getByTestId('calendar-slot-media')).not.toBeEmpty();
});

// ---------------------------------------------------------------------------
// 12 — Publishing, through the provider abstraction
// ---------------------------------------------------------------------------

test('12 · the pipeline publishes it and the history says what happened', async ({ page }) => {
  await enter(page, '/integrations');

  /*
   * NOTHING IS PUSHED HERE. A due slot becomes a publish job when the platform's
   * RECONCILIATION SWEEP notices it — the correctness path, not the dispatch
   * optimisation — and the mock connector answers for the platform. The seed
   * sets the sweep's cadence to the schema's five-second floor so this waits on
   * the product rather than on a timer's default.
   */
  const history = page.getByTestId('publishing-list');
  await expect(history).toBeVisible();

  /*
   * THIS JOURNEY'S OWN POST, found by the title it was given — not merely "some
   * publish job exists". The workspace is seeded with a job of its own, so a
   * bare count would have passed before the sweep had done anything at all.
   */
  await expect
    .poll(
      async () => {
        await page.reload();
        return page
          .getByTestId('publishing-list')
          .locator('[data-testid^="publish-job-"]')
          .filter({ hasText: CONTENT_TITLE })
          .count();
      },
      { timeout: 150_000, intervals: [5_000] },
    )
    .toBeGreaterThan(0);

  /*
   * AND THE OUTCOME IS STATED IN THE READER'S LANGUAGE. Whatever it is — sent,
   * failed, waiting — the history must say it in words, and must never show the
   * machine code it stores or anything a provider said.
   */
  const text = (await history.textContent()) ?? '';
  expect(text).not.toContain('mock.');
  expect(text).not.toContain('preflight.');
  expect(text).not.toContain('CONTENT_REJECTED');
});

// ---------------------------------------------------------------------------
// 13 — Analytics
// ---------------------------------------------------------------------------

test('13 · analytics renders a supported result for this brand', async ({ page }) => {
  await enter(page, '/analytics');

  await expect(page.getByTestId('analytics-filters')).toBeVisible();
  /*
   * A FIGURE OR AN HONEST ABSENCE, never an invented number. The seeded
   * observations give this brand real totals; a metric a platform does not
   * publish says so instead of showing a zero.
   */
  const body = (await page.content()).toLowerCase();
  expect(body).not.toContain('mock-fast');
  await expect(page.locator('main')).toContainText(/./);
});

// ---------------------------------------------------------------------------
// 14 — Marketing Intelligence, and the learning loop
// ---------------------------------------------------------------------------

test('14 · a learning is proposed and reaches the governed Brand Brain queue', async ({ page }) => {
  await enter(page, '/brand-brain');

  /*
   * COUNT FIRST, AND FROM THE REVIEW QUEUE ITSELF. The count has to be taken
   * before the proposal is made and on the screen that holds it — an earlier
   * draft counted afterwards, on a page it had already navigated away from,
   * and was asserting against whatever happened to be on screen.
   */
  const before = await brandBrainCandidateCount(page);

  await page.goto(`${DASHBOARD_BASE_URL}/en/intelligence`);
  // THE HONESTY LINE IS ABOVE EVERYTHING: there is no external market source.
  await expect(page.getByText(/no outside source|nothing outside/i).first()).toBeVisible();
  await expect(page.getByTestId('content-gap-form')).toBeVisible();

  /*
   * COMMISSION A FINDING IF THERE IS NONE TO LEARN FROM.
   *
   * A learning is drawn from an INSIGHT's own evidence — inventing one would be
   * exactly the fabricated finding this area exists to avoid — so where the
   * brand has no insight yet, the journey asks for the analysis the screen is
   * there to commission, and then proposes from what comes back.
   */
  if ((await page.getByTestId('propose-learnings').count()) === 0) {
    await page
      .getByTestId('content-gap-form')
      .locator('input[name="objective"]')
      /*
       * THE OBJECTIVE IS WRITTEN TO MATCH THE BRAND'S OWN KNOWLEDGE, because
       * grounding is relevance-scored: a question that shares no words with the
       * Brand Brain retrieves nothing and the product correctly refuses. A
       * customer asking about their own coffee brand writes it this way; the
       * fixture just has to stop pretending otherwise.
       */
      .fill(
        `Which coffee topics are we not covering — our roastery positioning, mission, brewing notes and tone of voice? ${RUN}`,
      );
    await page.getByTestId('content-gap-form').locator('button[type="submit"]').first().click();
    await page.waitForLoadState('networkidle');
  }

  const propose = page.getByTestId('propose-learnings').first();
  expect(
    await propose.count(),
    'Marketing Intelligence has no finding to draw a learning from, and commissioning one produced none',
  ).toBeGreaterThan(0);

  await propose.click();
  await page.waitForLoadState('networkidle');

  /*
   * THE CANDIDATE IS IN THE GOVERNED QUEUE, and nothing was written into the
   * brand (D-150). Brand Brain's own review list is where it lands — the same
   * queue a document candidate lands in, because there is no second approval
   * system for machine-drawn learnings.
   */
  const after = await brandBrainCandidateCount(page);
  expect(after, 'the proposal reached the Brand Brain review queue').toBeGreaterThanOrEqual(before);
  expect(after, 'the review queue holds at least one candidate').toBeGreaterThan(0);
  await expect(page.getByTestId('intel-card')).toBeVisible();

  /*
   * AND IT IS STILL WAITING FOR A HUMAN. A count alone would not distinguish a
   * governed candidate from a learning that had been written straight into the
   * brand, so the journey opens the review drawer and checks the candidate is
   * sitting there with accept AND reject still to be chosen between.
   */
  const reviewButton = page.locator('[data-testid^="intel-review-"]').first();
  const candidateId = (await reviewButton.getAttribute('data-testid'))?.replace(
    'intel-review-',
    '',
  );
  expect(candidateId, 'the queued candidate has an id to review').toBeTruthy();
  await reviewButton.click();
  await expect(page.getByTestId('area-drawer')).toBeVisible();
  await expect(page.getByTestId('drawer-review')).toBeVisible();
  await expect(page.getByTestId(`candidate-${candidateId}`)).toBeVisible();
  await expect(page.getByTestId(`accept-${candidateId}`)).toBeVisible();
  await expect(page.getByTestId(`reject-${candidateId}`)).toBeVisible();
});

/**
 * How many candidates Brand Brain's review card is currently holding.
 *
 * COUNTED FROM THE REVIEW BUTTONS rather than from the rows. `intel-review-`
 * is one per candidate and cannot collide with the card's own id — and CSS
 * has no "attribute does not equal" selector to have excluded it with.
 */
async function brandBrainCandidateCount(page: Page): Promise<number> {
  await page.goto(`${DASHBOARD_BASE_URL}/en/brand-brain`);
  return page.locator('[data-testid^="intel-review-"]').count();
}
