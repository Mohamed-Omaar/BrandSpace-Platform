import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { signIn } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

/**
 * PR A2 — THE FIVE-STEP AI SMOKE, on the merged code against the development
 * AI double (no real provider is ever called):
 *
 *   1. a caption is written;
 *   2. one image per quality (low, medium, high) is generated;
 *   3. Copilot "Summarise approvals" from Home runs the approvals summary — and
 *      the Copilot answers from the Studio — never "That item no longer
 *      exists." (the double fills every argument the tool list asks for, as a
 *      real model does, so a prompt that asks for `brandId` fails here);
 *   4. an edit chip (Shorter) edits the caption and shows before/after with Undo;
 *   5. a Brand Brain chat message is answered.
 *
 * Each step asserts what the product guarantees, not what the double writes.
 */
function credentials(): E2eAdminCredentials {
  return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
}

const NOT_FOUND_TEXT = 'That item no longer exists.';

async function draftWith(body: string): Promise<string> {
  const loaded = credentials();
  const { customer } = loaded;
  const brandId = brandFixtures(loaded).primaryBrandId;
  return withPlatformPrisma(async (prisma) => {
    const owner = await prisma.user.findFirstOrThrow({
      where: { email: customer.email },
      select: { id: true },
    });
    const item = await prisma.contentItem.create({
      data: {
        workspaceId: customer.workspaceId,
        brandId,
        title: `Smoke ${randomUUID().slice(0, 6)}`,
        status: 'DRAFT',
        primaryLocale: 'EN',
        createdByUserId: owner.id,
      },
      select: { id: true },
    });
    await prisma.contentVariant.create({
      data: {
        workspaceId: customer.workspaceId,
        brandId,
        contentItemId: item.id,
        platformKey: 'instagram',
        locale: 'EN',
        body,
        characterCount: body.length,
        validationState: 'VALID',
      },
    });
    return item.id;
  });
}

/** Ask the open Copilot drawer; the plan or answer arrives, never a refusal. */
async function askCopilot(page: Page): Promise<void> {
  const drawer = page.getByTestId('copilot-drawer');
  await expect(drawer).toBeVisible();
  const request = drawer.getByTestId('copilot-request');
  await expect(request).not.toHaveValue('');
  await drawer.getByTestId('copilot-propose').click();
  await expect
    .poll(
      async () =>
        (await drawer.getByTestId('copilot-plan').count()) +
        (await drawer.getByTestId('copilot-answered').count()) +
        (await drawer.getByTestId('copilot-error').count()),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);
  await expect(drawer.getByTestId('copilot-error')).toHaveCount(0);
  await expect(drawer).not.toContainText(NOT_FOUND_TEXT);
}

test.describe('PR A2 — the five-step AI smoke (fake provider)', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeEach(({ isMobile }) => {
    test.skip(isMobile === true, 'one run is enough; the desktop run covers it');
  });

  test('1 · a caption is written', async ({ page }) => {
    test.setTimeout(150_000);
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?mode=ai`);
    await page.getByTestId('content-brief').fill('A short post about our autumn opening hours.');
    const channel = page.locator('[data-testid="content-channel"][data-platform="instagram"]');
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
    await expect(page.getByTestId('content-variant').first()).toBeVisible({ timeout: 120_000 });
    await expect(page.locator('textarea[name="body"]').first()).not.toHaveValue('');
  });

  for (const quality of ['low', 'medium', 'high'] as const) {
    test(`2 · an image is generated at ${quality} quality`, async ({ page }) => {
      test.setTimeout(150_000);
      await signIn(page);
      await page.goto(`${DASHBOARD_BASE_URL}/en/creative`);
      // A brief of this run's own: the double draws the same picture for the
      // same brief, and the library refuses a byte-identical second copy.
      await page
        .getByTestId('creative-brief')
        .fill(`A ceramic cup on a pale counter (${quality}, ${randomUUID().slice(0, 8)}).`);
      await page
        .locator(`[data-testid="creative-quality"] button[data-value="${quality}"]`)
        .click();
      await expect(page.getByTestId('creative-quality')).toHaveAttribute('data-value', quality);
      const answered = page.waitForResponse((response) =>
        response.url().includes('/api/creative/generate'),
      );
      await page.getByTestId('creative-generate').click();
      const response = await answered;
      const answer = response.ok() ? '' : await response.text();
      await expect
        .poll(
          async () =>
            (await page.getByTestId('creative-result-frame').count()) > 0 ||
            (await page.getByTestId('creative-failure').count()) > 0,
          { timeout: 120_000 },
        )
        .toBe(true);
      const why = (await page.getByTestId('creative-failure').count())
        ? await page.getByTestId('creative-failure').textContent()
        : null;
      expect(why, `the ${quality} image was refused: ${why ?? ''} ${answer}`).toBeNull();
    });
  }

  test('3 · Copilot "Summarise approvals" from Home answers', async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    await page.getByTestId('home-copilot-sug3').click();
    await askCopilot(page);
    // The approvals summary RAN (a read needs no confirmation) on this brand,
    // and its counts are shown under "What the Copilot found".
    await expect(
      page.getByTestId('copilot-drawer').getByTestId('copilot-inspection'),
    ).toContainText('waiting for review', { timeout: 60_000 });
  });

  test('3b · Copilot from the Studio answers on the open post', async ({ page }) => {
    test.setTimeout(120_000);
    const itemId = await draftWith('A caption the Copilot can read about our autumn hours.');
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?item=${itemId}`);
    await page.getByTestId('studio-copilot').click();
    const drawer = page.getByTestId('copilot-drawer');
    await expect(drawer).toBeVisible();
    await drawer.getByTestId('copilot-request').fill('Summarise this post in one line.');
    await askCopilot(page);
  });

  test('4 · an edit chip (Shorter) edits the caption, with before/after and Undo', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const original =
      'A long caption that a shorter version could say in far fewer words, surely, and kindly.';
    const itemId = await draftWith(original);
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?item=${itemId}`);
    await page.locator('[data-testid="content-tool"][data-tool="shorten"]').first().click();
    await expect(page.getByTestId('studio-spent-toast')).toBeVisible({ timeout: 60_000 });
    const compare = page.getByTestId('ai-edit-compare');
    await expect(compare).toBeVisible();
    await expect(compare.getByTestId('ai-edit-before')).toHaveText(original);
    const after = (await compare.getByTestId('ai-edit-after').textContent()) ?? '';
    expect(after.length).toBeLessThanOrEqual(Math.floor(original.length * 0.7));
    await expect(compare.getByTestId('ai-edit-undo')).toBeVisible();
  });

  test('5 · a Brand Brain chat message is answered', async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/brand-brain`);
    await page.getByTestId('orb-center').click();
    const panel = page.getByTestId('brand-chat');
    await expect(panel).toBeVisible();
    await page.fill('[data-testid="chat-input"]', 'Hello! What is our brand colour?');
    await page.getByTestId('chat-send').click();
    await expect
      .poll(
        async () =>
          (await panel.getByTestId('chat-message-assistant').count()) +
          (await panel.getByTestId('chat-error').count()),
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0);
    await expect(panel.getByTestId('chat-error')).toHaveCount(0);
    await expect(panel.getByTestId('chat-message-assistant').last()).not.toHaveText('');
  });
});
