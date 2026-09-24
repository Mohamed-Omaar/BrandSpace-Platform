import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { withPlatformPrisma } from './platform-prisma';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

/**
 * PHASE 6 FINAL · D-277 §17-§19, D-283 — CREATE POST, HOW IT STARTS.
 *
 * Against the real services: the entry asks first; "write it yourself" makes
 * saving the primary action; the format decides which channels can carry the
 * post, from the seeded capability registry; an idea from a real empty
 * campaign opens the composer with that campaign chosen; and repurposing a real
 * post carries its words into the brief without touching it.
 *
 * Each test creates what it needs; none relies on another's writes.
 */

function credentials(): E2eAdminCredentials {
  return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
}

async function signIn(page: Page, locale = 'en'): Promise<void> {
  const loaded = credentials();
  const { customer } = loaded;
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

const compose = (locale: string, query = '') =>
  `${DASHBOARD_BASE_URL}/${locale}/content/compose${query}`;

test.describe('Create Post — the entry (§17)', () => {
  test('asks first, and each answer is an address', async ({ page }) => {
    await signIn(page);
    await page.goto(compose('en'));
    const entry = page.getByTestId('create-entry');
    await expect(entry).toContainText('What would you like to create?');
    for (const mode of ['ai', 'write', 'idea', 'repurpose']) {
      await expect(page.getByTestId(`create-mode-${mode}`)).toBeVisible();
    }
    // Nothing to fill in until a path is chosen.
    await expect(page.getByTestId('content-composer')).toHaveCount(0);

    await page.getByTestId('create-mode-write').click();
    await page.waitForURL((url) => url.searchParams.get('mode') === 'write');
    await expect(page.getByTestId('content-composer')).toBeVisible();
    // Writing it yourself: saving is the primary action, generating is not.
    await expect(page.getByTestId('content-write-manual')).toHaveClass(/cs-dark-button/);
    await expect(page.getByTestId('content-generate')).toHaveClass(/cs-ghost-button/);
    await expect(page.getByText('Your post', { exact: true })).toBeVisible();
    // No goal on a post the person writes word for word.
    await expect(page.getByTestId('content-goal')).toHaveCount(0);
  });

  test('the entry reads in Arabic, right to left', async ({ page }) => {
    await signIn(page, 'ar');
    await page.goto(compose('ar'));
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByTestId('create-entry')).toContainText('ماذا تريد أن تنشئ؟');
  });
});

test.describe('Create Post — format and goal (§18, §19)', () => {
  test('a format is offered only where a channel can carry it', async ({ page }) => {
    await signIn(page);
    await page.goto(compose('en', '?mode=ai'));
    const format = page.getByTestId('content-format');
    await expect(format).toBeVisible();

    // The seeded registry: reels on Instagram and TikTok, never on LinkedIn.
    await format.selectOption('REEL');
    await expect(
      page.locator('[data-testid="content-channel"][data-platform="linkedin"]'),
    ).toBeDisabled();
    await expect(
      page.locator('[data-testid="content-channel"][data-platform="instagram"]'),
    ).toBeEnabled();
    const pressed = page.locator('[data-testid="content-channel"][aria-pressed="true"]');
    await expect(pressed).not.toHaveCount(0);
    for (const key of await pressed.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-platform')),
    )) {
      expect(['instagram', 'tiktok', 'facebook']).toContain(key);
    }

    // Back to a plain post: every channel can carry it again.
    await format.selectOption('POST');
    await expect(
      page.locator('[data-testid="content-channel"][data-platform="linkedin"]'),
    ).toBeEnabled();
  });

  test('the goal travels in the generation ask', async ({ page }) => {
    await signIn(page);
    await page.goto(compose('en', '?mode=ai&goal=LEADS'));
    const goal = page.getByTestId('content-goal');
    await expect(goal).toHaveValue('LEADS');
    await page.getByTestId('content-brief').fill('A short post about our spring hours.');
    const generate = page.getByTestId('content-generate');
    const withLeads = await generate.getAttribute('data-generation-key');

    // A different goal is a different request — never a retry of the first.
    await goal.selectOption('EDUCATE');
    await expect(generate).not.toHaveAttribute('data-generation-key', withLeads ?? '');
  });
});

test.describe('Create Post — ideas and repurposing (§17)', () => {
  test('an idea from a real empty campaign opens the composer with that campaign', async ({
    page,
  }) => {
    const loaded = credentials();
    const brandId = brandFixtures(loaded).primaryBrandId;
    const name = `Idea campaign ${randomUUID().slice(0, 6)}`;
    const campaignId = await withPlatformPrisma(
      async (prisma) =>
        (
          await prisma.campaign.create({
            data: {
              workspaceId: loaded.customer.workspaceId,
              brandId,
              name,
              objective: 'LAUNCH',
              status: 'PLANNED',
            },
            select: { id: true },
          })
        ).id,
    );

    await signIn(page);
    await page.goto(compose('en', '?mode=idea'));
    const idea = page.getByTestId(`create-idea-campaign-${campaignId}`);
    await expect(idea).toContainText(name);
    await expect(idea).toContainText('This campaign has no content yet.');
    await page.getByTestId(`create-idea-use-campaign-${campaignId}`).click();

    await page.waitForURL((url) => url.searchParams.get('mode') === 'ai');
    await expect(page.getByTestId('content-brief')).toHaveValue(new RegExp(name));
    await expect(page.getByTestId('content-manual-campaign')).toHaveValue(campaignId);
  });

  test('repurposing carries a real post’s words and leaves the original alone', async ({
    page,
  }) => {
    const loaded = credentials();
    const brandId = brandFixtures(loaded).primaryBrandId;
    const title = `Repurpose source ${randomUUID().slice(0, 6)}`;
    const body = `Our original words, ${randomUUID().slice(0, 6)}.`;
    const sourceId = await withPlatformPrisma(async (prisma) => {
      const item = await prisma.contentItem.create({
        data: {
          workspaceId: loaded.customer.workspaceId,
          brandId,
          title,
          status: 'APPROVED',
          primaryLocale: 'EN',
        },
        select: { id: true },
      });
      await prisma.contentVariant.create({
        data: {
          workspaceId: loaded.customer.workspaceId,
          brandId,
          contentItemId: item.id,
          platformKey: 'instagram',
          locale: 'EN',
          body,
          characterCount: body.length,
        },
      });
      return item.id;
    });

    await signIn(page);
    await page.goto(compose('en', `?mode=repurpose&q=${encodeURIComponent(title)}`));
    await expect(page.getByTestId(`create-source-${sourceId}`)).toContainText(title);
    await page.getByTestId(`create-source-use-${sourceId}`).click();

    await page.waitForURL((url) => url.searchParams.get('source') === sourceId);
    await expect(page.getByTestId('content-repurpose-source')).toContainText(title);
    await expect(page.getByTestId('content-brief')).toHaveValue(
      new RegExp(body.replace('.', '\\.')),
    );

    const untouched = await withPlatformPrisma((prisma) =>
      prisma.contentItem.findUniqueOrThrow({
        where: { id: sourceId },
        select: { status: true, variants: { select: { body: true } } },
      }),
    );
    expect(untouched.status).toBe('APPROVED');
    expect(untouched.variants.map((variant) => variant.body)).toEqual([body]);
  });
});

/** A draft with two platform versions, written straight to the database. */
async function twoVariantDraft(
  status: 'DRAFT' | 'APPROVED',
  linkedinComment: string | null = null,
): Promise<string> {
  const loaded = credentials();
  const brandId = brandFixtures(loaded).primaryBrandId;
  return withPlatformPrisma(async (prisma) => {
    const item = await prisma.contentItem.create({
      data: {
        workspaceId: loaded.customer.workspaceId,
        brandId,
        title: `Editor ${randomUUID().slice(0, 6)}`,
        status,
        primaryLocale: 'EN',
      },
      select: { id: true },
    });
    for (const [platformKey, body] of [
      ['instagram', 'The saved Instagram caption.'],
      ['linkedin', 'The saved LinkedIn caption.'],
    ] as const) {
      await prisma.contentVariant.create({
        data: {
          workspaceId: loaded.customer.workspaceId,
          brandId,
          contentItemId: item.id,
          platformKey,
          locale: 'EN',
          body,
          characterCount: body.length,
          validationState: 'VALID',
          ...(platformKey === 'linkedin' && linkedinComment
            ? { firstComment: linkedinComment }
            : {}),
        },
      });
    }
    return item.id;
  });
}

test.describe('Create Post — the draft editor (§20-§22, §27)', () => {
  test('context, one tab per platform, and a preview that follows every keystroke', async ({
    page,
  }) => {
    const itemId = await twoVariantDraft('DRAFT');
    await signIn(page);
    await page.goto(compose('en', `?item=${itemId}`));

    await expect(page.getByTestId('draft-context')).toContainText('Using');
    await expect(page.getByTestId('variant-tab-instagram')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const caption = page.locator(
      '[data-testid="content-variant"][data-platform="instagram"] textarea',
    );
    await caption.fill('A caption typed just now.');
    await expect(page.getByTestId('content-preview-instagram')).toContainText(
      'A caption typed just now.',
    );
    await expect(page.getByTestId('editor-saved-instagram')).toHaveText('Unsaved changes');
    // An AI edit starts from the SAVED words, so it waits for Save.
    await expect(
      page.locator('[data-testid="editor-ai-instagram"] [data-action="shorten"]'),
    ).toBeDisabled();

    // The other platform's version is one tab away — and the keyboard gets there too.
    await page.getByTestId('variant-tab-instagram').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('variant-tab-linkedin')).toHaveAttribute('aria-selected', 'true');
    await expect(
      page.locator('[data-testid="content-variant"][data-platform="linkedin"]'),
    ).toBeVisible();

    await page.getByTestId('preview-compare').click();
    await expect(page.getByTestId('content-preview-instagram')).toBeVisible();
    await expect(page.getByTestId('content-preview-linkedin')).toBeVisible();
  });

  test('over the limit says so in words, with the fix beside it', async ({ page }) => {
    const itemId = await twoVariantDraft('DRAFT');
    await signIn(page);
    await page.goto(compose('en', `?item=${itemId}`));
    const caption = page.locator(
      '[data-testid="content-variant"][data-platform="instagram"] textarea',
    );
    await caption.fill('x'.repeat(2_300));
    const issues = page.getByTestId('editor-issues-instagram');
    await expect(issues).toContainText(/Your Instagram caption is \d+ characters over the limit\./);
    await expect(issues.getByRole('button', { name: 'Shorten with AI' })).toBeVisible();
  });

  test('an approved post warns BEFORE Save, and saving returns it to Draft', async ({ page }) => {
    const itemId = await twoVariantDraft('APPROVED');
    await signIn(page);
    await page.goto(compose('en', `?item=${itemId}`));
    await expect(page.getByTestId('editor-approved-warning')).toContainText(
      'Editing its content or media will return it to Draft',
    );
    const form = page.locator('[data-testid="content-variant"][data-platform="instagram"]');
    await form.locator('textarea').fill('Changed after approval.');
    await page.getByTestId('editor-save-instagram').click();
    await page.waitForURL((url) => url.searchParams.get('ok') === 'SAVED', { timeout: 60_000 });
    await expect(page.getByTestId('editor-saved-instagram')).toHaveText('Saved just now');

    const stored = await withPlatformPrisma((prisma) =>
      prisma.contentItem.findUniqueOrThrow({ where: { id: itemId }, select: { status: true } }),
    );
    expect(stored.status).toBe('DRAFT');
  });

  test('a first comment is saved where the platform takes one, and never erased elsewhere', async ({
    page,
  }) => {
    const kept = `Kept comment ${randomUUID().slice(0, 6)}`;
    const itemId = await twoVariantDraft('DRAFT', kept);
    await signIn(page);
    await page.goto(compose('en', `?item=${itemId}`));

    await page.getByTestId('content-first-comment-instagram').fill('Link in bio.');
    await page.getByTestId('editor-save-instagram').click();
    await page.waitForURL((url) => url.searchParams.get('ok') === 'SAVED', { timeout: 60_000 });

    // LinkedIn takes no first comment: no field, and saving it keeps the stored one.
    await page.getByTestId('variant-tab-linkedin').click();
    await expect(page.getByTestId('content-first-comment-linkedin')).toHaveCount(0);
    await page
      .locator('[data-testid="content-variant"][data-platform="linkedin"] textarea')
      .fill('LinkedIn words, edited.');
    await page.getByTestId('editor-save-linkedin').click();
    await page.waitForURL((url) => url.searchParams.get('ok') === 'SAVED', { timeout: 60_000 });

    const variants = await withPlatformPrisma((prisma) =>
      prisma.contentVariant.findMany({
        where: { contentItemId: itemId },
        select: { platformKey: true, firstComment: true },
      }),
    );
    const byKey = Object.fromEntries(variants.map((v) => [v.platformKey, v.firstComment]));
    expect(byKey['instagram']).toBe('Link in bio.');
    expect(byKey['linkedin']).toBe(kept);
  });

  test('the editor is clean under axe in Arabic', async ({ page }) => {
    const itemId = await twoVariantDraft('DRAFT');
    await signIn(page, 'ar');
    await page.goto(compose('ar', `?item=${itemId}`));
    await expect(page.getByTestId('draft-editor')).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations)).toEqual([]);
  });
});

/** A READY, CLEAN asset of the primary brand, written straight to the library. */
async function libraryAsset(kind: 'IMAGE' | 'VIDEO', name: string): Promise<string> {
  const loaded = credentials();
  const brandId = brandFixtures(loaded).primaryBrandId;
  return withPlatformPrisma(
    async (prisma) =>
      (
        await prisma.asset.create({
          data: {
            workspaceId: loaded.customer.workspaceId,
            brandId,
            name,
            kind,
            mimeType: kind === 'IMAGE' ? 'image/png' : 'video/mp4',
            sizeBytes: 4_096,
            width: kind === 'IMAGE' ? 1080 : 1080,
            height: kind === 'IMAGE' ? 1080 : 1920,
            ...(kind === 'VIDEO' ? { durationMs: 15_000 } : {}),
            storageKey: `e2e/p6/${randomUUID()}`,
            checksumSha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
            status: 'READY',
            scanStatus: 'CLEAN',
          },
          select: { id: true },
        })
      ).id,
  );
}

async function formatDraft(
  contentType: 'CAROUSEL' | 'REEL' | 'POST',
  assetIds: string[],
): Promise<{ itemId: string; variantId: string }> {
  const loaded = credentials();
  const brandId = brandFixtures(loaded).primaryBrandId;
  return withPlatformPrisma(async (prisma) => {
    const item = await prisma.contentItem.create({
      data: {
        workspaceId: loaded.customer.workspaceId,
        brandId,
        title: `${contentType} ${randomUUID().slice(0, 6)}`,
        status: 'DRAFT',
        contentType,
        primaryLocale: 'EN',
      },
      select: { id: true },
    });
    const variant = await prisma.contentVariant.create({
      data: {
        workspaceId: loaded.customer.workspaceId,
        brandId,
        contentItemId: item.id,
        platformKey: 'instagram',
        locale: 'EN',
        body: `A ${contentType.toLowerCase()} caption.`,
        assetIds,
      },
      select: { id: true },
    });
    return { itemId: item.id, variantId: variant.id };
  });
}

const storedVariant = (variantId: string) =>
  withPlatformPrisma((prisma) =>
    prisma.contentVariant.findUniqueOrThrow({
      where: { id: variantId },
      select: { assetIds: true, coverAssetId: true },
    }),
  );

test.describe('Create Post — carousel, reel and the media drawer (§23-§26)', () => {
  test('a carousel is ordered slides: reorder, save, and page through the preview', async ({
    page,
  }) => {
    const tag = randomUUID().slice(0, 6);
    const slides = [
      await libraryAsset('IMAGE', `slide-a-${tag}.png`),
      await libraryAsset('IMAGE', `slide-b-${tag}.png`),
      await libraryAsset('IMAGE', `slide-c-${tag}.png`),
    ];
    const { itemId, variantId } = await formatDraft('CAROUSEL', slides);
    await signIn(page);
    await page.goto(compose('en', `?item=${itemId}`));

    const media = page.getByTestId('content-media-instagram');
    await expect(media.getByTestId('content-media-instagram-slide-0')).toContainText('Slide 01');
    await media.getByTestId('content-media-instagram-later-0').click();
    await expect(media.getByTestId('content-media-instagram-slide-0')).toHaveAttribute(
      'data-asset-id',
      slides[1]!,
    );

    const preview = page.getByTestId('content-preview-instagram');
    await expect(preview.getByTestId('preview-carousel-badge')).toHaveText('Slide 1 of 3');
    await preview.getByTestId('preview-slide-next').click();
    await expect(preview.getByTestId('preview-carousel-badge')).toHaveText('Slide 2 of 3');

    await page.getByTestId('editor-save-instagram').click();
    await page.waitForURL((url) => url.searchParams.get('ok') === 'SAVED', { timeout: 60_000 });
    expect((await storedVariant(variantId)).assetIds).toEqual([slides[1], slides[0], slides[2]]);
  });

  test('a reel’s cover survives a reload', async ({ page }) => {
    const tag = randomUUID().slice(0, 6);
    const video = await libraryAsset('VIDEO', `reel-${tag}.mp4`);
    const image = await libraryAsset('IMAGE', `cover-${tag}.png`);
    const { itemId, variantId } = await formatDraft('REEL', [video, image]);
    await signIn(page);
    await page.goto(compose('en', `?item=${itemId}`));

    // The video shows its measured length; only the image can be the cover.
    await expect(page.getByTestId('content-media-instagram-slide-0')).toContainText('0:15');
    await expect(page.getByTestId('content-media-instagram-cover-0')).toHaveCount(0);
    await page.getByTestId('content-media-instagram-cover-1').click();
    await page.getByTestId('editor-save-instagram').click();
    await page.waitForURL((url) => url.searchParams.get('ok') === 'SAVED', { timeout: 60_000 });

    await page.reload();
    await expect(page.getByTestId('content-media-instagram-cover-1')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect((await storedVariant(variantId)).coverAssetId).toBe(image);
  });

  test('media is chosen from the library in a drawer, without leaving the post', async ({
    page,
  }) => {
    const tag = randomUUID().slice(0, 6);
    const picture = await libraryAsset('IMAGE', `drawer-${tag}.png`);
    const { itemId, variantId } = await formatDraft('POST', []);
    await signIn(page);
    await page.goto(compose('en', `?item=${itemId}`));

    await page.getByTestId('content-media-instagram-add').click();
    const drawer = page.getByTestId('media-drawer');
    await expect(drawer).toBeVisible();
    await drawer.getByTestId(`media-choose-${picture}`).click();
    await expect(drawer).toHaveCount(0);
    await expect(page.getByTestId('content-media-instagram-slide-0')).toHaveAttribute(
      'data-asset-id',
      picture,
    );
    await page.getByTestId('editor-save-instagram').click();
    await page.waitForURL((url) => url.searchParams.get('ok') === 'SAVED', { timeout: 60_000 });
    expect((await storedVariant(variantId)).assetIds).toEqual([picture]);
  });

  test('an image from the Creative Studio arrives on the new post, unsaved until Save', async ({
    page,
  }) => {
    const tag = randomUUID().slice(0, 6);
    const picture = await libraryAsset('IMAGE', `creative-${tag}.png`);
    await signIn(page);
    await page.goto(compose('en', `?mode=write&asset=${picture}`));
    await expect(page.getByTestId('content-carried-media')).toContainText(`creative-${tag}.png`);

    await page.getByTestId('content-brief').fill(`Carried from Creative, ${tag}.`);
    await page.getByTestId('content-write-manual').click();
    await page.waitForURL((url) => url.searchParams.get('attach') === picture, {
      timeout: 60_000,
    });
    await expect(page.getByTestId('editor-attached-media')).toBeVisible();
    const form = page.locator('[data-testid="content-variant"]').first();
    const platform = (await form.getAttribute('data-platform')) ?? '';
    await expect(page.getByTestId(`content-media-${platform}-slide-0`)).toHaveAttribute(
      'data-asset-id',
      picture,
    );
    await page.getByTestId(`editor-save-${platform}`).click();
    await page.waitForURL(
      (url) => url.searchParams.get('ok') === 'SAVED' && !url.searchParams.has('attach'),
      {
        timeout: 60_000,
      },
    );
    const itemId = new URL(page.url()).searchParams.get('item') ?? '';
    const variant = await withPlatformPrisma((prisma) =>
      prisma.contentVariant.findFirstOrThrow({
        where: { contentItemId: itemId, platformKey: platform },
        select: { assetIds: true },
      }),
    );
    expect(variant.assetIds).toEqual([picture]);
  });

  test('an image generated in the drawer joins the post once it has been checked', async ({
    page,
  }) => {
    test.slow();
    const { itemId, variantId } = await formatDraft('POST', []);
    await signIn(page);
    await page.goto(compose('en', `?item=${itemId}`));

    await page.getByTestId('content-media-instagram-add').click();
    await page.getByTestId('media-tab-generate').click();
    await page.getByTestId('media-generate-quote').click();
    await expect(page.getByTestId('media-generate-estimate')).toContainText('credits');
    await page.getByTestId('media-generate-prompt').fill(`A calm spring window, ${randomUUID()}`);
    await page.getByTestId('media-generate-submit').click();
    await expect(page.getByTestId('media-generating')).toBeVisible();

    const slide = page.getByTestId('content-media-instagram-slide-0');
    await expect(slide).toBeVisible({ timeout: 120_000 });
    const assetId = (await slide.getAttribute('data-asset-id')) ?? '';
    await page.getByTestId('editor-save-instagram').click();
    await page.waitForURL((url) => url.searchParams.get('ok') === 'SAVED', { timeout: 60_000 });

    expect((await storedVariant(variantId)).assetIds).toEqual([assetId]);
    const generated = await withPlatformPrisma((prisma) =>
      prisma.asset.findUniqueOrThrow({ where: { id: assetId }, select: { source: true } }),
    );
    expect(generated.source).toBe('AI_GENERATED');
  });
});
