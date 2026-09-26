import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { withPlatformPrisma } from './platform-prisma';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

/**
 * Q12, SECOND RELEASE — THE REAL VIEWER, IN A REAL BROWSER.
 *
 * The seeded Viewer is the `client_viewer` system role as the seed writes it
 * from `ROLE_DEFINITIONS`: `workspace.read` and `content.read`, and no grant is
 * added here. It reads Content, the Studio, the Calendar and Approvals, starts
 * note threads and answers open ones — and is offered NO control it would be
 * refused. What a browser cannot do is forge a server action (its generated
 * id cannot be guessed), so the SERVER's refusals are proven against
 * PostgreSQL with this same role's grants in tests/isolation
 * (content-approvals, phase6-notes-isolation, phase8-campaigns).
 *
 * Runs in the serial `approvals` project with `viewer-read-only.spec.ts`: it
 * writes a draft and a note thread, and removes them afterwards.
 */

function credentials(): E2eAdminCredentials {
  try {
    return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
  } catch {
    throw new Error('The end-to-end credentials file is missing. Run `pnpm e2e:seed` first.');
  }
}

async function signInAsViewer(page: Page, locale: 'en' | 'ar' = 'en'): Promise<void> {
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

/** A draft in the Viewer's brand, written by the workspace owner. */
async function ownersDraft(): Promise<{ itemId: string; title: string }> {
  const loaded = credentials();
  const workspaceId = loaded.customer.workspaceId;
  const brandId = brandFixtures(loaded).primaryBrandId;
  const title = `Viewer reads ${randomUUID().slice(0, 6)}`;
  return withPlatformPrisma(async (prisma) => {
    const owner = await prisma.user.findFirstOrThrow({
      where: { email: loaded.customer.email },
      select: { id: true },
    });
    const item = await prisma.contentItem.create({
      data: {
        workspaceId,
        brandId,
        title,
        status: 'DRAFT',
        primaryLocale: 'EN',
        createdByUserId: owner.id,
      },
      select: { id: true },
    });
    await prisma.contentVariant.create({
      data: {
        workspaceId,
        brandId,
        contentItemId: item.id,
        platformKey: 'instagram',
        locale: 'EN',
        body: `${title} words`,
      },
    });
    created.push(item.id);
    return { itemId: item.id, title };
  });
}

test.describe('Q12 · the real Viewer reads Content, and is offered nothing it would be refused', () => {
  for (const locale of ['en', 'ar'] as const) {
    test(`Content opens with the brand's posts, read-only (${locale})`, async ({ page }) => {
      const { itemId, title } = await ownersDraft();
      await signInAsViewer(page, locale);
      const response = await page.goto(
        `${DASHBOARD_BASE_URL}/${locale}/content?q=${encodeURIComponent(title)}`,
      );
      expect(response?.status()).toBe(200);
      await expect(page.getByTestId('route-no-access')).toHaveCount(0);
      await expect(page.getByTestId(`content-text-${itemId}`)).toBeVisible();
      // The card OPENS the post; nothing on it creates, edits, submits or schedules.
      await expect(page.getByTestId(`content-edit-${itemId}`)).toHaveText(
        locale === 'ar' ? 'فتح' : 'Open',
      );
      for (const id of [
        'content-create',
        'content-empty-create',
        `content-request-approval-${itemId}`,
        `content-schedule-${itemId}`,
        `content-duplicate-${itemId}`,
        `post-menu-${itemId}`,
      ]) {
        await expect(page.getByTestId(id), id).toHaveCount(0);
      }
    });
  }

  test('the Studio without a post answers "No access" naming content.create', async ({ page }) => {
    await signInAsViewer(page);
    for (const path of ['en/content/compose', 'en/content/compose?mode=write']) {
      const response = await page.goto(`${DASHBOARD_BASE_URL}/${path}`);
      expect(response?.status(), path).toBe(200);
      const screen = page.getByTestId('route-no-access');
      await expect(screen, path).toBeVisible();
      await expect(screen, path).toContainText("doesn't have the");
      await expect(page.getByTestId('create-mode-write'), path).toHaveCount(0);
    }
  });

  test('an existing post opens read-only: no media, AI, save, submit or archive control', async ({
    page,
  }) => {
    const { itemId } = await ownersDraft();
    await signInAsViewer(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?item=${itemId}`);
    await expect(page.getByTestId('content-composer')).toBeVisible();
    await expect(page.getByTestId('content-media-instagram')).toBeVisible();
    for (const selector of [
      '[data-testid="content-media-instagram-add"]',
      '[data-testid^="content-media-instagram-replace-"]',
      '[data-testid^="content-media-instagram-remove-"]',
      '[data-testid="editor-save-instagram"]',
      '[data-testid="content-tool"]',
      '[data-testid="archive-disclosure"]',
      '[data-testid="submit-for-review"]',
      '[data-testid="withdraw-review"]',
      '[data-testid="editor-schedule"]',
      '[data-testid="content-campaign-form"]',
    ]) {
      await expect(page.locator(selector), selector).toHaveCount(0);
    }
  });
});

test.describe('Q12 · the real Viewer comments, and triages nothing', () => {
  test('starts a thread, answers it, and is offered no resolve, reopen, assign, due date or importance', async ({
    page,
  }) => {
    const { itemId } = await ownersDraft();
    await signInAsViewer(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?item=${itemId}`);

    const start = page.getByTestId('note-start-form');
    await expect(start).toBeVisible();
    const opening = `A question from the Viewer ${randomUUID().slice(0, 6)}`;
    await start.locator('textarea[name="body"]').fill(opening);
    await page.getByTestId('note-submit').click();

    const thread = page.locator('[data-testid^="note-thread-"]', { hasText: opening });
    await expect(thread).toBeVisible();
    const threadId = ((await thread.getAttribute('data-testid')) ?? '').replace('note-thread-', '');
    expect(threadId).toMatch(/^[0-9a-f-]{36}$/);

    // Answer the OPEN thread.
    const reply = `And one more thing ${randomUUID().slice(0, 6)}`;
    await expect(page.getByTestId(`note-reply-form-${threadId}`)).toBeVisible();
    await page.getByTestId(`note-reply-${threadId}`).fill(reply);
    await page.getByTestId(`note-reply-submit-${threadId}`).click();
    await expect(page.getByTestId(`note-thread-${threadId}`)).toContainText(reply);

    // Triage is not on offer to a member without notes.manage.
    for (const id of [
      `note-resolve-${threadId}`,
      `note-reopen-${threadId}`,
      `note-options-${threadId}`,
      `note-assign-${threadId}`,
      `note-due-input-${threadId}`,
      `note-importance-${threadId}`,
    ]) {
      await expect(page.getByTestId(id), id).toHaveCount(0);
    }

    // Once somebody who may triage resolves it, the Viewer can no longer answer
    // it — and cannot reopen it either.
    await withPlatformPrisma(async (prisma) => {
      const owner = await prisma.user.findFirstOrThrow({
        where: { email: credentials().customer.email },
        select: { id: true },
      });
      await prisma.noteThread.update({
        where: { id: threadId },
        data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedByUserId: owner.id },
      });
    });
    await page.reload();
    await expect(page.getByTestId(`note-thread-${threadId}`)).toBeVisible();
    await expect(page.getByTestId(`note-reply-form-${threadId}`)).toHaveCount(0);
    await expect(page.getByTestId(`note-reopen-${threadId}`)).toHaveCount(0);
  });
});

test.describe('Q12 · the real Viewer reads Approvals, and decides nothing', () => {
  for (const locale of ['en', 'ar'] as const) {
    test(`Approvals opens with no decision controls (${locale})`, async ({ page }) => {
      await signInAsViewer(page, locale);
      for (const tab of ['', '?tab=forMe', '?tab=sent']) {
        const response = await page.goto(`${DASHBOARD_BASE_URL}/${locale}/approvals${tab}`);
        expect(response?.status(), tab).toBe(200);
        await expect(page.getByTestId('route-no-access'), tab).toHaveCount(0);
        await expect(page.getByTestId('approvals-tabs'), tab).toBeVisible();
        for (const selector of [
          '[data-testid^="approve-"]',
          '[data-testid^="reject-"]',
          'input[name="verdict"]',
          'button[name="verdict"]',
          '[data-testid^="withdraw-"]',
          '[data-testid="approvals-policy"]',
        ]) {
          await expect(page.locator(selector), `${tab} ${selector}`).toHaveCount(0);
        }
      }
    });
  }
});

test.describe('Q12 · Home and the Calendar for the real Viewer (E7)', () => {
  test('Home shows the feedback section, and its link opens a read-only calendar', async ({
    page,
  }) => {
    await signInAsViewer(page);
    await expect(page.getByTestId('home-feedback')).toBeVisible();
    for (const id of ['home-review-queue', 'home-my-work', 'home-top-posts']) {
      await expect(page.getByTestId(id), id).toHaveCount(0);
    }
    // Comment-only: nothing on Home submits anything.
    await expect(page.locator('main form')).toHaveCount(0);

    await page.getByTestId('home-feedback-calendar').click();
    await page.waitForURL(/\/en\/calendar$/);
    await expect(page.getByTestId('calendar-page')).toBeVisible();
    for (const selector of [
      '[data-testid="calendar-schedule-open"]',
      '[data-testid="calendar-empty-schedule"]',
      '[data-testid^="calendar-tray-schedule-"]',
      '[data-testid^="calendar-new-"]',
    ]) {
      await expect(page.locator(selector), selector).toHaveCount(0);
    }
  });

  for (const locale of ['en', 'ar'] as const) {
    test(`Home's cards describe, and do not ask the Viewer to act (${locale})`, async ({
      page,
    }) => {
      await signInAsViewer(page, locale);
      await expect(page.getByTestId('home-feedback')).toBeVisible();
      const words = {
        'attention-action-content-in-review':
          locale === 'ar' ? 'مستني موافقة' : 'Waiting for approval',
        'attention-action-calendar-gap': locale === 'ar' ? 'شوف التقويم' : 'See the calendar',
      };
      // The seeded brand always has posts in review, so that card is always here.
      await expect(page.getByTestId('attention-action-content-in-review')).toHaveText(
        words['attention-action-content-in-review'],
      );
      // A calendar gap depends on the dates; when the card is there, it says this.
      const gap = page.getByTestId('attention-action-calendar-gap');
      if ((await gap.count()) > 0) {
        await expect(gap).toHaveText(words['attention-action-calendar-gap']);
      }
    });
  }
});
