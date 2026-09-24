import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { withPlatformPrisma } from './platform-prisma';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

/**
 * PHASE 6 FINAL · D-277 §40-§41, D-297 — THE BELL OPENS A SOCIAL, USEFUL FEED.
 *
 * The suite writes its own mention (a colleague's note naming the signed-in
 * member, on the primary brand) and its own approval notification, then reads
 * them in the bell's sheet: who, the words, the object, when, and a link to
 * the exact place — under All, Mentions and Approvals. Its rows are marked
 * read / removed afterwards.
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

const RUN = randomUUID().slice(0, 6);
const WORDS = `Check the price before we publish ${RUN}`;
const TITLE = `Dental awareness reel ${RUN}`;
let threadId = '';
let notificationId = '';

test.beforeAll(async () => {
  const loaded = credentials();
  const workspaceId = loaded.customer.workspaceId;
  const brandId = brandFixtures(loaded).primaryBrandId;
  await withPlatformPrisma(async (prisma) => {
    const me = await prisma.user.findFirstOrThrow({
      where: { email: loaded.customer.email },
      select: { id: true },
    });
    const colleague = await prisma.user.findFirstOrThrow({
      where: { email: loaded.customer.viewerEmail },
      select: { id: true },
    });
    const thread = await prisma.noteThread.create({
      data: {
        workspaceId,
        brandId,
        subjectType: 'BRAND',
        status: 'OPEN',
        createdByUserId: colleague.id,
      },
      select: { id: true },
    });
    threadId = thread.id;
    const note = await prisma.note.create({
      data: { workspaceId, threadId, authorUserId: colleague.id, body: WORDS },
      select: { id: true },
    });
    await prisma.noteMention.create({
      data: { workspaceId, noteId: note.id, mentionedUserId: me.id },
    });
    notificationId = (
      await prisma.notification.create({
        data: {
          workspaceId,
          userId: me.id,
          templateKey: 'approval.requested',
          payload: { itemTitle: TITLE },
          linkPath: '/approvals',
          brandId,
          idempotencyKey: `e2e-feed-${RUN}`,
        },
        select: { id: true },
      })
    ).id;
  });
});

test.afterAll(async () => {
  await withPlatformPrisma(async (prisma) => {
    if (threadId) {
      await prisma.noteThread.deleteMany({ where: { id: threadId } });
    }
    if (notificationId) {
      await prisma.notification.deleteMany({ where: { id: notificationId } });
    }
  });
});

test.describe('D-297 · the bell', () => {
  test('a mention reads as a person, their words and a link to the thread', async ({ page }) => {
    await signIn(page);
    await page.getByTestId('topbar-notifications').click();
    const feed = page.getByTestId('notifications-feed');
    await expect(feed).toBeVisible();
    // Stays on the screen the reader was on.
    expect(new URL(page.url()).pathname).toBe('/en/overview');

    await feed.getByTestId('notifications-tab-mention').click();
    const mention = feed.getByTestId(`feed-m:${threadId}`);
    await expect(mention).toContainText('mentioned you');
    await expect(mention).toContainText(WORDS);
    await expect(mention).toHaveAttribute('data-kind', 'mention');
    // Mentions only under Mentions.
    await expect(feed.locator('[data-kind="approval"]')).toHaveCount(0);

    await mention.getByTestId(`feed-open-m:${threadId}`).click();
    await page.waitForURL(new RegExp(`thread=${threadId}`));
  });

  test('an approval reads as the post it is about, under Approvals', async ({ page }) => {
    await signIn(page);
    await page.getByTestId('topbar-notifications').click();
    const feed = page.getByTestId('notifications-feed');
    await feed.getByTestId('notifications-tab-approval').click();
    const row = feed.getByTestId(`feed-n:${notificationId}`);
    await expect(row).toContainText('waiting for your review');
    await expect(row).toContainText(TITLE);
    await expect(feed.locator('[data-kind="mention"]')).toHaveCount(0);
    await expect(row.getByTestId(`feed-open-n:${notificationId}`)).toHaveAttribute(
      'href',
      '/en/approvals',
    );
  });

  test('the feed is clean under axe in Arabic', async ({ page }) => {
    await signIn(page, 'ar');
    await page.getByTestId('topbar-notifications').click();
    await expect(page.getByTestId('notifications-feed-list')).toBeVisible();
    const results = await new AxeBuilder({ page })
      .include('[data-testid="notifications-feed"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
