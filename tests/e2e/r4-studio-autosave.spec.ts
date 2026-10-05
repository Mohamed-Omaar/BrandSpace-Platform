import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';
import { withPlatformPrisma } from './platform-prisma';

/**
 * ROUND 4, STEP 3 — THE STUDIO SAVES AS YOU TYPE (3.1), SHOWS EVERY FORMAT
 * (3.4) AND PREVIEWS AS THE PROTOTYPE'S CARD (3.5).
 *
 * The owner's decision: the first thing a person does on a new post — words,
 * a hashtag, opening Design, choosing When — creates the draft, through the
 * same `createManualDraftAction` the old "Save draft" posted to (same
 * permission, same audit, same credit rule: none). Opening the Studio and
 * leaving creates nothing. One visit is one draft.
 */

function credentials(): E2eAdminCredentials {
  return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
}

async function signIn(page: Page): Promise<void> {
  const loaded = credentials();
  const { customer } = loaded;
  // The brand the post is for, said out loud (D-191): the Studio needs one.
  await useBrand(page, customer.workspaceId, brandFixtures(loaded).primaryBrandId);
  await page.goto(`${DASHBOARD_BASE_URL}/en/sign-in`);
  await page.fill('#email', customer.email);
  await page.fill('#password', customer.password);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL((url) => !url.pathname.endsWith('/sign-in'));
  const choose = page.getByTestId(`choose-workspace-${customer.workspaceSlug}`);
  if (await choose.isVisible().catch(() => false)) await choose.click();
  await page.waitForURL(/\/en\/overview$/);
}

async function openNewPost(page: Page): Promise<void> {
  await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?mode=write`);
  await expect(page.getByTestId('content-composer')).toBeVisible();
  const channel = page.getByTestId('content-channel').first();
  if ((await channel.getAttribute('aria-pressed')) !== 'true') await channel.click();
}

async function awaitDraft(page: Page): Promise<URL> {
  await page.waitForURL((url) => url.searchParams.has('item'), { timeout: 60_000 });
  return new URL(page.url());
}

test.describe('Round 4 · 3.1 — the first input makes the draft', () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('a hashtag alone makes the draft, and the hashtag is on it', async ({ page }) => {
    await openNewPost(page);
    const tag = `rfour${Date.now().toString(36)}`;
    await page.getByTestId('composer-tag-input').fill(tag);
    await page.getByTestId('composer-tag-add').click();
    await expect(page.getByTestId('composer-tag-list')).toContainText(`#${tag}`);
    const url = await awaitDraft(page);
    const itemId = url.searchParams.get('item') ?? '';
    const variants = await withPlatformPrisma((prisma) =>
      prisma.contentVariant.findMany({
        where: { contentItemId: itemId },
        select: { hashtags: true },
      }),
    );
    expect(variants.length).toBeGreaterThan(0);
    for (const variant of variants) expect(variant.hashtags).toContain(tag);
  });

  test('opening Design makes the draft and opens it on Design', async ({ page }) => {
    await openNewPost(page);
    await page.getByTestId('studio-tab-visual').click();
    const url = await awaitDraft(page);
    expect(url.searchParams.get('open')).toBe('visual');
    await expect(page.getByTestId('studio-tab-visual')).toHaveAttribute('aria-pressed', 'true');
  });

  test('choosing When makes the draft and opens it on When', async ({ page }) => {
    await openNewPost(page);
    await page.getByTestId('composer-bar-when').click();
    const url = await awaitDraft(page);
    expect(url.searchParams.get('open')).toBe('when');
  });

  test('words typed while the draft is being made are kept, and saved', async ({ page }) => {
    await openNewPost(page);
    const caption = page.getByTestId('content-caption');
    const first = `Saved as typed ${Date.now().toString(36)}`;
    await caption.fill(first);
    const url = await awaitDraft(page);
    const itemId = url.searchParams.get('item') ?? '';

    // The editor is the same words, and the bar says they are saved.
    const words = page.locator('[data-testid="content-variant"] textarea').first();
    await expect(words).toHaveValue(first);
    await words.fill(`${first}, and then some.`);
    const saved = page.locator('[data-testid^="editor-saved-"]');
    await expect(saved).toHaveText('Saved just now', { timeout: 30_000 });

    await page.reload();
    await expect(page.locator('[data-testid="content-variant"] textarea').first()).toHaveValue(
      `${first}, and then some.`,
    );
    const items = await withPlatformPrisma((prisma) =>
      prisma.contentVariant.findMany({
        where: { body: { startsWith: first } },
        select: { contentItemId: true },
        distinct: ['contentItemId'],
      }),
    );
    expect(items.map((row) => row.contentItemId)).toStrictEqual([itemId]);
  });
});

test.describe('Round 4 · 3.1 (review of 2a, 7) — the visit continues the SAME draft', () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('reload, Back then Forward, and a second tab: one post, never a second', async ({
    page,
    context,
  }) => {
    const words = `One post only ${Date.now().toString(36)}`;
    const postsWith = () =>
      withPlatformPrisma((prisma) =>
        prisma.contentVariant.findMany({
          where: { body: { startsWith: words } },
          select: { contentItemId: true },
          distinct: ['contentItemId'],
        }),
      ).then((rows) => rows.map((row) => row.contentItemId));

    // Where the person came from, so Back has somewhere to go.
    await page.goto(`${DASHBOARD_BASE_URL}/en/content`);
    await openNewPost(page);
    await page.getByTestId('content-caption').fill(words);
    const url = await awaitDraft(page);
    const itemId = url.searchParams.get('item') ?? '';
    await expect(page.locator('[data-testid^="editor-saved-"]')).toBeVisible({ timeout: 30_000 });
    expect(await postsWith()).toStrictEqual([itemId]);

    // 1. Reload: the URL is the draft's, so the same draft opens.
    await page.reload();
    await expect(page.getByTestId('draft-editor')).toBeVisible();
    expect(new URL(page.url()).searchParams.get('item')).toBe(itemId);

    // 2. Back leaves the Studio (the new-post address was replaced by the
    //    draft's); Forward returns to the same draft.
    await page.goBack();
    await page.waitForURL((current) => !current.pathname.endsWith('/content/compose'));
    await page.goForward();
    await page.waitForURL((current) => current.searchParams.get('item') === itemId);
    await expect(page.getByTestId('draft-editor')).toBeVisible();

    // 3. A second tab on the draft's address edits the same post.
    const second = await context.newPage();
    await second.goto(page.url());
    const secondWords = second.locator('[data-testid="content-variant"] textarea').first();
    await expect(secondWords).toHaveValue(words);
    await secondWords.fill(`${words}, from the second tab.`);
    await expect(second.locator('[data-testid^="editor-saved-"]')).toHaveText('Saved just now', {
      timeout: 30_000,
    });
    await second.close();

    expect(await postsWith()).toStrictEqual([itemId]);
  });
});

test.describe('Round 4 · 3.4 / 3.5 — every format, and the prototype preview card', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('a new post offers all four formats; one no channel takes says why', async ({ page }) => {
    await openNewPost(page);
    const formats = page.getByTestId('content-format').locator('button[data-value]');
    await expect(formats).toHaveCount(4);
    const unavailable = page
      .getByTestId('content-format')
      .locator('button[data-unavailable="true"]');
    const dimmed = await unavailable.count();
    for (let index = 0; index < dimmed; index += 1) {
      await expect(unavailable.nth(index)).toBeDisabled();
      await expect(unavailable.nth(index)).toHaveAttribute('title', /.+/);
    }
    await expect(page.getByTestId('content-format-unavailable')).toHaveCount(dimmed > 0 ? 1 : 0);
  });

  test('a saved post shows its format pressed and the others locked, with the reason', async ({
    page,
  }) => {
    await openNewPost(page);
    await page.getByTestId('content-caption').fill(`Locked format ${Date.now().toString(36)}`);
    await awaitDraft(page);
    const format = page.getByTestId('editor-format');
    await expect(format.locator('button[aria-pressed="true"]')).toHaveCount(1);
    const locked = format.locator('button[data-locked="true"]');
    expect(await locked.count()).toBeGreaterThan(0);
    await expect(locked.first()).toBeDisabled();
    await expect(page.getByTestId('editor-format-locked')).toBeVisible();
  });

  test('the preview is the prototype card, marked as a draft in its corner', async ({ page }) => {
    await openNewPost(page);
    await page.getByTestId('content-caption').fill(`Preview card ${Date.now().toString(36)}`);
    await awaitDraft(page);
    const card = page.locator('.bsp-pv-card').first();
    await expect(card).toBeVisible();
    await expect(card.locator('.bsp-pv-head .bsp-pv-av')).toBeVisible();
  });
});

test.describe('Round 4 · 3.1 — the server saves as typed only what a save leaves alone', () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('an autosave posted against a post in review is refused, and the review stands', async ({
    page,
  }) => {
    await openNewPost(page);
    const first = `In review ${Date.now().toString(36)}`;
    await page.getByTestId('content-caption').fill(first);
    const url = await awaitDraft(page);
    const itemId = url.searchParams.get('item') ?? '';
    await expect(page.locator('[data-testid^="editor-saved-"]')).toBeVisible({ timeout: 30_000 });

    // Sent for review: from here a save would withdraw it (`revokeApprovalOnEdit`).
    await expect(page.getByTestId('submit-for-review')).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId('submit-for-review').click();
    await expect
      .poll(
        () =>
          withPlatformPrisma((prisma) =>
            prisma.contentItem.findUniqueOrThrow({
              where: { id: itemId },
              select: { status: true },
            }),
          ).then((row) => row.status),
        { timeout: 30_000 },
      )
      .toBe('IN_REVIEW');
    await page.reload();
    await expect(page.getByTestId('editor-in-review-warning')).toBeVisible();

    /*
     * What a late or hand-built autosave would carry: the panel's own form,
     * new words and `autosave=1`. The client never sends this for a post in
     * review; the server must refuse it too.
     */
    // The server action's own answer (the page also posts its cost quotes).
    const posted = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.request().headers()['next-action'] !== undefined,
    );
    await page.evaluate(() => {
      const form = document.querySelector<HTMLFormElement>('form[data-testid="content-variant"]');
      if (!form) throw new Error('no variant form');
      const words = form.querySelector('textarea');
      if (words) words.value = 'Typed after it was sent for review.';
      const flag = document.createElement('input');
      flag.type = 'hidden';
      flag.name = 'autosave';
      flag.value = '1';
      form.appendChild(flag);
      form.requestSubmit();
    });
    await posted;

    const after = await withPlatformPrisma((prisma) =>
      prisma.contentItem.findUniqueOrThrow({
        where: { id: itemId },
        select: { status: true, variants: { select: { body: true } } },
      }),
    );
    expect(after.status).toBe('IN_REVIEW');
    for (const variant of after.variants) {
      expect(variant.body).not.toContain('Typed after it was sent for review.');
    }
  });
});

test.describe('Round 4 · 3.3 (review of 2a, 6) — a day carried to a brand that needs approval', () => {
  test.describe.configure({ timeout: 120_000 });

  test('the Studio says the day is not kept, and offers no time it would drop', async ({
    page,
  }) => {
    const loaded = credentials();
    const { customer } = loaded;
    const suffix = Date.now().toString(36);
    const brandId = await withPlatformPrisma(async (prisma) => {
      const brand = await prisma.brand.create({
        data: {
          workspaceId: customer.workspaceId,
          name: `Approval first ${suffix}`,
          slug: `approval-first-${suffix}`,
          status: 'ACTIVE',
          defaultLocale: 'EN',
          supportedLocales: ['EN'],
        },
        select: { id: true },
      });
      await prisma.approvalPolicy.create({
        data: {
          workspaceId: customer.workspaceId,
          brandId: brand.id,
          requireApprovalBeforeScheduling: true,
        },
      });
      return brand.id;
    });
    await useBrand(page, customer.workspaceId, brandId);
    await page.goto(`${DASHBOARD_BASE_URL}/en/sign-in`);
    await page.fill('#email', customer.email);
    await page.fill('#password', customer.password);
    await page.click('[data-testid="signin-submit"]');
    await page.waitForURL((url) => !url.pathname.endsWith('/sign-in'));
    const choose = page.getByTestId(`choose-workspace-${customer.workspaceSlug}`);
    if (await choose.isVisible().catch(() => false)) await choose.click();
    await page.waitForURL(/\/en\/overview$/);

    const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?mode=write&date=${day}`);
    await expect(page.getByTestId('composer-planned-date')).toBeVisible();
    // Said where the day is named, before anything is written.
    await expect(page.getByTestId('composer-planned-approval-first')).toContainText(
      'this day is not kept',
    );

    // The draft's When offers no date or time to choose — only the reason.
    const channel = page.getByTestId('content-channel').first();
    if ((await channel.getAttribute('aria-pressed')) !== 'true') await channel.click();
    await page.getByTestId('content-caption').fill(`Approval first ${suffix}`);
    await page.waitForURL((url) => url.searchParams.has('item'), { timeout: 60_000 });
    await page.getByTestId('editor-when').click();
    const panel = page.getByTestId('editor-when-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('this day is not kept');
    await expect(panel.locator('input[type="date"], input[type="time"]')).toHaveCount(0);
    await expect(page.getByTestId('editor-schedule')).toHaveCount(0);
  });
});
