import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { withPlatformPrisma } from './platform-prisma';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

/**
 * PHASE 6 FINAL · D-277 §28, D-281 — NOTES AS CONVERSATIONS.
 *
 * Against the real services: a note posted in the composer with a TYPED
 * @-mention, marked Important with a due date; the Notes inbox deep-linking
 * back to that exact thread, highlighted; a note on an ASSET in the Asset
 * Library; and the panel clean under an accessibility scan in Arabic.
 *
 * Each test finds or creates what it needs; none relies on another's writes.
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

/** A draft in the primary brand, and a colleague with a name to mention. */
async function fixtures() {
  const loaded = credentials();
  const brandId = brandFixtures(loaded).primaryBrandId;
  return withPlatformPrisma(async (prisma) => {
    const item = await prisma.contentItem.create({
      data: {
        workspaceId: loaded.customer.workspaceId,
        brandId,
        title: `Notes journey ${randomUUID().slice(0, 6)}`,
        status: 'DRAFT',
      },
      select: { id: true },
    });
    const colleague = await prisma.membership.findFirstOrThrow({
      where: {
        workspaceId: loaded.customer.workspaceId,
        status: 'ACTIVE',
        user: { email: { not: loaded.customer.email }, name: { not: null } },
      },
      select: { user: { select: { name: true } } },
    });
    const asset = await prisma.asset.findFirst({
      where: {
        workspaceId: loaded.customer.workspaceId,
        brandId,
        deletedAt: null,
        status: 'READY',
      },
      select: { id: true },
    });
    return { itemId: item.id, colleague: colleague.user.name ?? '', assetId: asset?.id ?? null };
  });
}

test.describe('D-281 · notes as conversations', () => {
  test('a typed @-mention, Important, a due date, and a deep link back to the thread', async ({
    page,
  }) => {
    test.slow();
    const { itemId, colleague } = await fixtures();
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?item=${itemId}`);

    // --- @Sa → Sara: the typeahead offers the colleague, and Enter picks.
    const body = page.getByTestId('note-body');
    await body.fill('Please check the caption ');
    // A prefix of the colleague's LAST word: the typeahead matches any word's
    // start, and the seeded members share their first word ("E2E …").
    const lastWord = colleague.split(/\s+/).pop() ?? colleague;
    await body.pressSequentially(`@${lastWord.slice(0, 3)}`);
    const suggestions = page.getByTestId('note-body-suggestions');
    await expect(suggestions).toBeVisible();
    const option = suggestions.getByRole('option', { name: colleague });
    await expect(option).toBeVisible();
    // Keyboard: move to it, then Enter picks.
    const names = await suggestions.getByRole('option').allTextContents();
    for (let index = 0; index < names.indexOf(colleague); index += 1) {
      await body.press('ArrowDown');
    }
    await expect(option).toHaveAttribute('aria-selected', 'true');
    await body.press('Enter');
    await expect(body).toHaveValue(new RegExp(`@${colleague} $`));
    await page.getByTestId('note-submit').click();

    const thread = page.locator('[data-testid^="note-thread-"]').first();
    await expect(thread).toBeVisible();
    await expect(thread.locator('[data-testid^="note-mentions-"]')).toContainText(colleague);
    const threadId = ((await thread.getAttribute('data-testid')) ?? '').replace('note-thread-', '');

    // --- Important and due, from the thread's own options. The disclosure
    // keeps its open state across the refresh a save causes, so it is opened
    // only when it is closed.
    const options = page.getByTestId(`note-options-${threadId}`);
    const openOptions = async () => {
      if (!(await options.evaluate((node) => (node as HTMLDetailsElement).open))) {
        await options.locator('summary').click();
      }
    };
    await openOptions();
    await page.getByTestId(`note-importance-${threadId}`).click();
    await expect(page.getByTestId(`note-important-${threadId}`)).toBeVisible();
    await openOptions();
    await page.getByTestId(`note-due-input-${threadId}`).fill('2030-01-15');
    await page.getByTestId(`note-due-save-${threadId}`).click();
    await expect(page.getByTestId(`note-due-${threadId}`)).toContainText('2030');

    // --- The Notes inbox links to THIS thread, and it opens highlighted.
    await page.goto(`${DASHBOARD_BASE_URL}/en/notes`);
    const open = page.getByTestId(`notes-open-${threadId}`);
    await expect(open).toHaveAttribute(
      'href',
      `/en/content/compose?item=${itemId}&thread=${threadId}#thread-${threadId}`,
    );
    await open.click();
    await page.waitForURL(new RegExp(`thread=${threadId}`));
    await expect(page.locator(`#thread-${threadId}`)).toHaveAttribute('data-highlighted', 'true');
  });

  test('an asset has its own conversation in the Asset Library', async ({ page }) => {
    const { assetId } = await fixtures();
    test.skip(!assetId, 'the seeded brand has no ready asset');
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/assets?asset=${assetId}`);
    const panel = page.getByTestId('notes-panel');
    await expect(panel).toBeVisible();
    const text = `Is this the approved crop? ${randomUUID().slice(0, 6)}`;
    await page.getByTestId('note-body').fill(text);
    await page.getByTestId('note-submit').click();
    await expect(panel).toContainText(text);

    const stored = await withPlatformPrisma((prisma) =>
      prisma.noteThread.findFirst({
        where: { assetId, notes: { some: { body: text } } },
        select: { subjectType: true },
      }),
    );
    expect(stored?.subjectType).toBe('ASSET');
  });

  test('the panel is clean under an accessibility scan, right to left', async ({ page }) => {
    const { itemId } = await fixtures();
    await signIn(page, 'ar');
    await page.goto(`${DASHBOARD_BASE_URL}/ar/content/compose?item=${itemId}`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByTestId('notes-panel')).toBeVisible();
    const results = await new AxeBuilder({ page })
      .include('[data-testid="notes-panel"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      results.violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
      ),
    ).toEqual([]);
  });
});
