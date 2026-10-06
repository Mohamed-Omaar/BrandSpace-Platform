import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { withPlatformPrisma } from './platform-prisma';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

/**
 * FIX PR 1 · F3 (D-409) — THE REAL VIEWER'S NOTES INBOX SHOWS ONLY THREADS
 * ABOUT CONTENT.
 *
 * The seeded Viewer is the `client_viewer` system role: `content.read` and
 * `workspace.read`, no `campaigns.read`, `assets.read` or `brand_brain.read`.
 * Four threads are written by the owner in the Viewer's brand, one per subject,
 * each naming the Viewer. Only the content thread may reach the Viewer — in the
 * Notes inbox, the top-bar dot and the incoming-mention notice. The server's
 * refusal on every path is proven against PostgreSQL in
 * tests/isolation/notes-subject-permission.test.ts.
 *
 * English and Arabic (RTL), keyboard to open the thread, axe on the inbox. Runs
 * in the serial `approvals` project with the other Viewer specs, and removes
 * what it wrote.
 */

function credentials(): E2eAdminCredentials {
  try {
    return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
  } catch {
    throw new Error('The end-to-end credentials file is missing. Run `pnpm e2e:seed` first.');
  }
}

async function signInAsViewer(page: Page, locale: 'en' | 'ar'): Promise<void> {
  const loaded = credentials();
  const { customer } = loaded;
  await useBrand(page, customer.workspaceId, brandFixtures(loaded).primaryBrandId);
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/sign-in`);
  await page.fill('#email', customer.viewerEmail);
  await page.fill('#password', customer.viewerPassword);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL(
    (url) => !url.pathname.endsWith('/sign-in') || url.searchParams.has('error'),
  );
  await page.click(`[data-testid="choose-workspace-${customer.workspaceSlug}"]`);
  await page.waitForURL(new RegExp(`/${locale}/overview$`));
}

const RUN = randomUUID().slice(0, 6);
const threads: Record<'content' | 'campaign' | 'asset' | 'brand', string | null> = {
  content: null,
  campaign: null,
  asset: null,
  brand: null,
};
const cleanup = { itemId: '', campaignId: '' };

test.beforeAll(async () => {
  const loaded = credentials();
  const workspaceId = loaded.customer.workspaceId;
  const brandId = brandFixtures(loaded).primaryBrandId;
  await withPlatformPrisma(async (prisma) => {
    const owner = await prisma.user.findFirstOrThrow({
      where: { email: loaded.customer.email },
      select: { id: true },
    });
    const viewer = await prisma.user.findFirstOrThrow({
      where: { email: loaded.customer.viewerEmail },
      select: { id: true },
    });
    const item = await prisma.contentItem.create({
      data: {
        workspaceId,
        brandId,
        title: `F3 content ${RUN}`,
        status: 'DRAFT',
        primaryLocale: 'EN',
        createdByUserId: owner.id,
      },
      select: { id: true },
    });
    cleanup.itemId = item.id;
    const campaign = await prisma.campaign.create({
      data: { workspaceId, brandId, name: `F3 campaign ${RUN}`, objective: 'AWARENESS' },
      select: { id: true },
    });
    cleanup.campaignId = campaign.id;
    const asset = await prisma.asset.findFirst({
      where: { workspaceId, brandId, deletedAt: null, status: 'READY' },
      select: { id: true },
    });

    // Each thread as the owner writes it, naming the Viewer — rows the rule
    // must hide whatever wrote them.
    const thread = async (
      subject:
        | { subjectType: 'CONTENT_ITEM'; contentItemId: string }
        | { subjectType: 'CAMPAIGN'; campaignId: string }
        | { subjectType: 'ASSET'; assetId: string }
        | { subjectType: 'BRAND' },
      words: string,
    ): Promise<string> => {
      const created = await prisma.noteThread.create({
        data: { workspaceId, brandId, status: 'OPEN', createdByUserId: owner.id, ...subject },
        select: { id: true },
      });
      const note = await prisma.note.create({
        data: { workspaceId, threadId: created.id, authorUserId: owner.id, body: words },
        select: { id: true },
      });
      await prisma.noteMention.create({
        data: { workspaceId, noteId: note.id, mentionedUserId: viewer.id },
      });
      return created.id;
    };
    threads.content = await thread(
      { subjectType: 'CONTENT_ITEM', contentItemId: item.id },
      `F3 content note ${RUN}`,
    );
    threads.campaign = await thread(
      { subjectType: 'CAMPAIGN', campaignId: campaign.id },
      `F3 campaign note ${RUN}`,
    );
    threads.asset = asset
      ? await thread({ subjectType: 'ASSET', assetId: asset.id }, `F3 asset note ${RUN}`)
      : null;
    threads.brand = await thread({ subjectType: 'BRAND' }, `F3 brand note ${RUN}`);
  });
});

test.afterAll(async () => {
  await withPlatformPrisma(async (prisma) => {
    const ids = Object.values(threads).filter((id): id is string => id !== null);
    if (ids.length > 0) await prisma.noteThread.deleteMany({ where: { id: { in: ids } } });
    if (cleanup.itemId) {
      await prisma.contentItem.updateMany({
        where: { id: cleanup.itemId },
        data: { deletedAt: new Date() },
      });
    }
    if (cleanup.campaignId) {
      await prisma.campaign.updateMany({
        where: { id: cleanup.campaignId },
        data: { deletedAt: new Date() },
      });
    }
  });
});

test.describe('F3 · D-409 — the Viewer sees threads about content only', () => {
  for (const locale of ['en', 'ar'] as const) {
    test(`the Notes inbox, the dot and the notice carry the content thread alone (${locale})`, async ({
      page,
    }) => {
      await signInAsViewer(page, locale);
      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/notes`);
      if (locale === 'ar') await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

      const forYou = page.getByTestId('notes-for-you');
      await expect(forYou).toBeVisible();
      await expect(page.getByTestId(`notes-thread-${threads.content}`)).toBeVisible();
      for (const hidden of [threads.campaign, threads.asset, threads.brand]) {
        if (hidden) await expect(page.getByTestId(`notes-thread-${hidden}`)).toHaveCount(0);
      }
      // Not one of the hidden threads' words anywhere on the page.
      await expect(page.locator('body')).not.toContainText(`F3 campaign note ${RUN}`);
      await expect(page.locator('body')).not.toContainText(`F3 brand note ${RUN}`);
      await expect(page.locator('body')).not.toContainText(`F3 asset note ${RUN}`);

      // The top-bar dot counts exactly the unread mentions the inbox lists — so
      // the hidden threads' mentions of the Viewer are not in it.
      const listed = await page
        .locator('[data-testid^="notes-thread-"]')
        .evaluateAll((rows) =>
          rows.reduce((sum, row) => sum + Number(row.getAttribute('data-unread') ?? 0), 0),
        );
      expect(listed).toBeGreaterThan(0);
      await expect(page.getByTestId('topbar-notes')).toHaveAttribute(
        'data-indicator',
        String(listed),
      );

      const results = await new AxeBuilder({ page })
        .include('[data-testid="notes-for-you"]')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations).toEqual([]);

      // Keyboard only: choose the thread in the list (Gate 2b — the prototype's
      // two panes), then focus its Open link and follow it to the post.
      const row = page.getByTestId(`notes-thread-${threads.content}`);
      await row.focus();
      await page.keyboard.press('Enter');
      await page.waitForURL((url) => url.searchParams.get('thread') === threads.content);
      const open = page.getByTestId(`notes-open-${threads.content}`);
      await open.focus();
      await expect(open).toBeFocused();
      await page.keyboard.press('Enter');
      await page.waitForURL(/\/content\/compose/);
      await expect(page.getByTestId(`note-thread-${threads.content}`)).toBeVisible();
    });
  }

  test('the incoming-mention notice never names a thread the Viewer may not read', async ({
    page,
  }) => {
    await signInAsViewer(page, 'en');
    await page.goto(`${DASHBOARD_BASE_URL}/en/notes`);
    const notice = page.getByTestId('incoming-mention');
    if ((await notice.count()) > 0) {
      await expect(notice).not.toContainText(`F3 campaign note ${RUN}`);
      await expect(notice).not.toContainText(`F3 brand note ${RUN}`);
      await expect(notice).not.toContainText(`F3 asset note ${RUN}`);
    }
  });
});
