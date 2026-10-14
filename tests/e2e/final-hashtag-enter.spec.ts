import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { enter, ownWorkspace, type OwnWorkspace } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';

/**
 * FINAL REVIEW (owner, item 4) — ENTER IN THE HASHTAG FIELD NEVER POSTS THE
 * STUDIO FORM, BEFORE OR AFTER THE PAGE'S SCRIPTS LOAD.
 *
 * Before the scripts load the browser's implicit submission used to post the
 * form on Enter: an ordinary save, which on a post in review withdrew the
 * review. A disabled default button now stops it in plain HTML. A real save is
 * unchanged (`c-studio-save-keeps.spec.ts`, `r4-studio-autosave.spec.ts`).
 */

async function post(own: OwnWorkspace, status: 'DRAFT' | 'IN_REVIEW') {
  return withPlatformPrisma(async (prisma) => {
    const item = await prisma.contentItem.create({
      data: {
        workspaceId: own.workspaceId,
        brandId: own.brandId,
        title: `Enter on a ${status.toLowerCase()} post`,
        status,
        primaryLocale: 'EN',
        contentType: 'POST',
        createdByUserId: own.ownerId,
      },
      select: { id: true },
    });
    await prisma.contentVariant.create({
      data: {
        workspaceId: own.workspaceId,
        brandId: own.brandId,
        contentItemId: item.id,
        platformKey: 'instagram',
        locale: 'EN',
        body: 'Stored words',
        hashtags: ['stored'],
      },
    });
    return item.id;
  });
}

const stored = (itemId: string) =>
  withPlatformPrisma(async (prisma) => {
    const item = await prisma.contentItem.findUniqueOrThrow({
      where: { id: itemId },
      select: { status: true, variants: { select: { body: true, hashtags: true } } },
    });
    return { status: item.status, body: item.variants[0]?.body, tags: item.variants[0]?.hashtags };
  });

/** Every POST the page makes, and whether it was a server action call. */
function watchPosts(page: Page) {
  const posts: { url: string; action: boolean }[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST')
      posts.push({ url: request.url(), action: request.headers()['next-action'] !== undefined });
  });
  return posts;
}

const formPosts = (posts: { url: string; action: boolean }[]) =>
  posts.filter((entry) => entry.url.includes('/content/compose') && !entry.action);

for (const status of ['DRAFT', 'IN_REVIEW'] as const) {
  test(`before the scripts load, Enter in the hashtag field posts nothing (${status})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1536, height: 864 });
    const own = await ownWorkspace(`enter-${status.toLowerCase()}`);
    const itemId = await post(own, status);
    await enter(page, own.slug, 'en');
    const posts = watchPosts(page);

    // No script runs: React never hydrates, as for a person faster than the page.
    await page.route('**/_next/static/chunks/**', (route) => route.abort());
    await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?item=${itemId}`);
    const form = page.locator('form[data-testid="content-variant"][data-platform="instagram"]');
    await expect(form).toBeAttached();
    expect(
      await form.evaluate((node) =>
        Object.keys(node).some((key) => key.startsWith('__reactProps')),
      ),
    ).toBe(false);

    await form.locator('textarea[name="body"]').fill('Words that were never saved');
    const tag = form.getByTestId('content-hashtags-instagram');
    await tag.fill('typedbeforeload');
    const url = page.url();
    await tag.press('Enter');
    // Give a post every chance to leave.
    await page.waitForTimeout(1_500);

    expect(formPosts(posts)).toEqual([]);
    expect(page.url()).toBe(url);
    await expect(tag).toHaveValue('typedbeforeload');
    expect(await stored(itemId)).toEqual({ status, body: 'Stored words', tags: ['stored'] });
  });
}

test('with the page running, Enter adds the tag and leaves a post in review in review', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1536, height: 864 });
  const own = await ownWorkspace('enter-hydrated');
  const itemId = await post(own, 'IN_REVIEW');
  await enter(page, own.slug, 'en');
  const posts = watchPosts(page);
  await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?item=${itemId}`);
  await expect(page.getByTestId('editor-in-review-warning')).toBeVisible();
  const form = page.locator('form[data-testid="content-variant"][data-platform="instagram"]');
  await expect
    .poll(() =>
      form.evaluate((node) => Object.keys(node).some((key) => key.startsWith('__reactProps'))),
    )
    .toBe(true);

  const tag = form.getByTestId('content-hashtags-instagram');
  await tag.fill('typedafterload');
  await tag.press('Enter');
  // The tag is added on the page; nothing is posted and the review stands.
  await expect(page.locator('.bsp-st-tag', { hasText: '#typedafterload' }).first()).toBeVisible();
  await page.waitForTimeout(1_500);
  expect(formPosts(posts)).toEqual([]);
  expect((await stored(itemId)).status).toBe('IN_REVIEW');
});
