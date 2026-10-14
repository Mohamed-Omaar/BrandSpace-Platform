import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { enter, ownWorkspace, type OwnWorkspace } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';

/**
 * D-539 (OWNER, #82) — A STUDIO SAVE LOSES NOTHING, WHETHER THE PAGE IS
 * RUNNING OR ITS SCRIPTS HAVE NOT LOADED YET.
 *
 *   - BEFORE THE SCRIPTS LOAD (blocked outright here, so the page stays the
 *     server's HTML): a post the browser makes itself. The caption typed so
 *     far is saved, the typed hashtag is added, and the stored hashtags and
 *     TikTok options are kept. (Since the final review, Enter in the hashtag
 *     field no longer makes that post — `final-hashtag-enter.spec.ts` — so the
 *     form is posted directly here; what the server keeps is the same.)
 *   - RUNNING, ON A BRAND WITH NO TIKTOK ACCOUNT: the audience cannot be
 *     chosen (nothing is offered), and a save must not clear the one stored.
 *
 * Both were losses before D-539: the typed hashtag never reached the server,
 * and a disabled control's value was dropped, so the stored audience became
 * "not chosen".
 */

const OPTIONS = {
  privacyLevel: 'MUTUAL_FOLLOW_FRIENDS',
  allowComment: true,
  allowDuet: false,
  allowStitch: false,
  disclosure: { enabled: true, yourBrand: true, brandedContent: false },
};

/** A TikTok draft with stored words, hashtags and options; no TikTok account. */
async function storedDraft(own: OwnWorkspace, title: string) {
  return withPlatformPrisma(async (prisma) => {
    const item = await prisma.contentItem.create({
      data: {
        workspaceId: own.workspaceId,
        brandId: own.brandId,
        title,
        status: 'DRAFT',
        primaryLocale: 'EN',
        contentType: 'VIDEO',
        createdByUserId: own.ownerId,
      },
      select: { id: true },
    });
    const variant = await prisma.contentVariant.create({
      data: {
        workspaceId: own.workspaceId,
        brandId: own.brandId,
        contentItemId: item.id,
        platformKey: 'tiktok',
        locale: 'EN',
        body: 'Original words',
        hashtags: ['keep', 'these'],
        platformOptions: OPTIONS,
      },
      select: { id: true },
    });
    return { itemId: item.id, variantId: variant.id };
  });
}

const saved = (variantId: string) =>
  withPlatformPrisma((prisma) =>
    prisma.contentVariant.findUniqueOrThrow({
      where: { id: variantId },
      select: { body: true, hashtags: true, platformOptions: true },
    }),
  );

const hydrated = (page: Page) =>
  page
    .locator('form[data-testid="content-variant"][data-platform="tiktok"]')
    .evaluate((node) => Object.keys(node).some((key) => key.startsWith('__reactProps')));

test('a save the browser posts before the scripts load keeps everything and adds the typed hashtag', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1536, height: 864 });
  const own = await ownWorkspace('c-save-before-scripts');
  const ids = await storedDraft(own, 'Before the scripts');
  await enter(page, own.slug, 'en');

  const posts: { url: string; action: boolean }[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST')
      posts.push({ url: request.url(), action: request.headers()['next-action'] !== undefined });
  });
  // No script runs: React never hydrates, as for a person faster than the page.
  await page.route('**/_next/static/chunks/**', (route) => route.abort());
  await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?item=${ids.itemId}`);
  const form = page.locator('form[data-testid="content-variant"][data-platform="tiktok"]');
  await expect(form).toBeAttached();
  expect(await hydrated(page)).toBe(false);

  await form.locator('textarea[name="body"]').fill('New words before the scripts');
  const tag = form.getByTestId('content-hashtags-tiktok');
  await tag.fill('typedbeforeload');
  // The browser's own form post (Enter no longer makes one; see the header).
  await Promise.all([
    page.waitForURL(/ok=SAVED/),
    form.evaluate((node) => (node as HTMLFormElement).requestSubmit()),
  ]);

  // The browser's own post, not an action call.
  expect(posts.some((post) => post.url.includes('/content/compose') && !post.action)).toBe(true);
  const after = await saved(ids.variantId);
  expect(after.body).toBe('New words before the scripts');
  expect(after.hashtags).toEqual(['keep', 'these', 'typedbeforeload']);
  expect(after.platformOptions).toMatchObject(OPTIONS);
});

test('with no TikTok account to offer an audience, a save keeps the stored one', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1536, height: 864 });
  const own = await ownWorkspace('c-save-keeps-audience');
  const ids = await storedDraft(own, 'Audience kept');
  await enter(page, own.slug, 'en');
  await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?item=${ids.itemId}`);
  await expect(page.getByTestId('tiktok-options-tiktok-no-account')).toBeVisible();
  await expect(page.getByTestId('tiktok-options-tiktok-privacy')).toBeDisabled();
  await expect.poll(() => hydrated(page), { timeout: 30_000 }).toBe(true);

  // Words typed: the autosave sends the whole form.
  await page
    .locator('form[data-testid="content-variant"][data-platform="tiktok"] textarea[name="body"]')
    .fill('Words typed while the audience cannot be chosen');
  await expect
    .poll(async () => (await saved(ids.variantId)).body, { timeout: 20_000 })
    .toBe('Words typed while the audience cannot be chosen');
  expect((await saved(ids.variantId)).platformOptions).toMatchObject(OPTIONS);
});
