import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { withPlatformPrisma } from './platform-prisma';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';
import { openStudioNotes } from './studio-bar';

/**
 * PR D — NOTES (audit Notes 1–5).
 *
 *   1. "@ Mention" opens the people list.
 *   2. Posting says "Posted · X will be notified".
 *   3. An unassigned thread says "Not assigned".
 *   4. A mention is drawn highlighted in the message.
 *   5. Opening a thread marks its mentions read (the reader pressed it).
 */

function credentials(): E2eAdminCredentials {
  return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
}

async function signInAs(page: Page, who: 'owner' | 'viewer', locale: string): Promise<void> {
  const loaded = credentials();
  const { customer } = loaded;
  await useBrand(page, customer.workspaceId, brandFixtures(loaded).primaryBrandId);
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/sign-in`);
  await page.fill('#email', who === 'owner' ? customer.email : customer.viewerEmail);
  await page.fill('#password', who === 'owner' ? customer.password : customer.viewerPassword);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL(
    (url) => !url.pathname.endsWith('/sign-in') || url.searchParams.has('error'),
  );
  await page.click(`[data-testid="choose-workspace-${customer.workspaceSlug}"]`);
  await page.waitForURL(new RegExp(`/${locale}/overview$`));
}

const created: string[] = [];
test.afterAll(async () => {
  if (created.length === 0) return;
  await withPlatformPrisma(async (prisma) => {
    await prisma.contentItem.updateMany({
      where: { id: { in: created } },
      data: { deletedAt: new Date() },
    });
  });
});

async function ownersDraft(): Promise<string> {
  const loaded = credentials();
  return withPlatformPrisma(async (prisma) => {
    const owner = await prisma.user.findFirstOrThrow({
      where: { email: loaded.customer.email },
      select: { id: true },
    });
    const item = await prisma.contentItem.create({
      data: {
        workspaceId: loaded.customer.workspaceId,
        brandId: brandFixtures(loaded).primaryBrandId,
        title: `Notes ${randomUUID().slice(0, 6)}`,
        status: 'DRAFT',
        primaryLocale: 'EN',
        createdByUserId: owner.id,
      },
      select: { id: true },
    });
    created.push(item.id);
    return item.id;
  });
}

for (const locale of ['en', 'ar'] as const) {
  test(`Notes: mention, posted toast, not-assigned pill, highlight, read on open (${locale})`, async ({
    page,
    browser,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'the desktop run covers it');
    test.setTimeout(120_000);
    const itemId = await ownersDraft();
    await signInAs(page, 'owner', locale);

    // A thread on the post, from its Studio notes card.
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/content/compose?item=${itemId}`);
    await openStudioNotes(page);
    const opening = `Opening ${randomUUID().slice(0, 6)}`;
    await page.getByTestId('note-start-form').locator('textarea[name="body"]').fill(opening);
    await page.getByTestId('note-submit').click();
    const thread = page.locator('[data-testid^="note-thread-"]', { hasText: opening });
    await expect(thread).toBeVisible();
    const threadId = ((await thread.getAttribute('data-testid')) ?? '').replace('note-thread-', '');

    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/notes?thread=${threadId}`);
    // 3. Not assigned.
    await expect(page.getByTestId(`note-unassigned-${threadId}`)).toBeVisible();

    // 1. "@ Mention" opens the list; pick the Viewer by name.
    const viewerName = await withPlatformPrisma(async (prisma) => {
      const user = await prisma.user.findFirstOrThrow({
        where: { email: credentials().customer.viewerEmail },
        select: { name: true, email: true },
      });
      return user.name?.trim() || user.email;
    });
    await page.getByTestId(`note-mention-${threadId}`).click();
    const suggestions = page.getByTestId(`note-reply-${threadId}-suggestions`);
    await expect(suggestions).toBeVisible();
    await suggestions.getByRole('option', { name: viewerName }).dispatchEvent('mousedown');
    await page.getByTestId(`note-reply-${threadId}`).press('End');
    await page.keyboard.type('please look');
    await page.getByTestId(`note-reply-submit-${threadId}`).click();

    // 2. Posted · <name> will be notified.
    await expect(page.getByTestId('note-posted-toast')).toContainText(viewerName);

    // 4. The mention is drawn highlighted.
    await expect(
      page.locator('.bsp-nts-mention', { hasText: `@${viewerName}` }).first(),
    ).toBeVisible();
    await page.context().close();

    // 5. The Viewer opens the thread they were mentioned in: it reads as read.
    const viewerContext = await browser.newContext();
    const viewer = await viewerContext.newPage();
    await signInAs(viewer, 'viewer', locale);
    await viewer.goto(`${DASHBOARD_BASE_URL}/${locale}/notes`);
    const entry = viewer.getByTestId(`notes-thread-${threadId}`);
    await expect(entry).not.toHaveAttribute('data-unread', '0');
    await entry.click();
    await viewer.waitForURL(new RegExp(`thread=${threadId}`));
    await expect
      .poll(async () => {
        await viewer.goto(`${DASHBOARD_BASE_URL}/${locale}/notes`);
        return viewer.getByTestId(`notes-thread-${threadId}`).getAttribute('data-unread');
      })
      .toBe('0');
    await viewerContext.close();
  });
}
