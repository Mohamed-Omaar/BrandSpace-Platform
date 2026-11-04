import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { signIn } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';

/**
 * PR 2 (D-598) — THE CONVERSATION STAYS AT ITS NEWEST MESSAGE, AND WAITS WITH
 * THE DOTS.
 *
 * Staging: after sending, the new bubble was cut off below and the owner had
 * to scroll; the side panel opened at the top of a long history; every reply
 * waited with "Working on a plan…". Now:
 *
 *   - the log opens at its newest message, on the page and in the panel;
 *   - sending brings the log to the person's own message;
 *   - scrolled up to read, it stays put and offers "New message ↓";
 *   - a turn waits with "Thinking…" and the landing page's three dots.
 *
 * Desktop and phone (the panel is the desktop's), English and Arabic.
 */

const atBottom = (log: Locator) =>
  log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight <= 48);

/** Give this person's conversation a long history, so the log must scroll. */
async function longHistory(page: Page): Promise<string> {
  // A first message opens (or finds) this person's one conversation (D-594).
  const marker = `Start ${randomUUID()}`;
  const tag = randomUUID().slice(0, 8);
  await send(page, marker);
  await expect(page.getByTestId('copilot-conversation').getByText(marker)).toBeVisible();
  await expect(page.getByTestId('copilot-working')).toHaveCount(0, { timeout: 60_000 });
  await withPlatformPrisma(async (prisma) => {
    const row = await prisma.copilotMessage.findFirstOrThrow({
      where: { body: marker },
      select: { workspaceId: true, sessionId: true },
    });
    const start = Date.now() - 60 * 60_000;
    await prisma.copilotMessage.createMany({
      data: Array.from({ length: 40 }, (_, index) => ({
        workspaceId: row.workspaceId,
        sessionId: row.sessionId,
        role: index % 2 === 0 ? ('USER' as const) : ('ASSISTANT' as const),
        body: `History ${tag} line ${index + 1}. ${'A longer sentence to fill the bubble. '.repeat(2)}`,
        correlationId: randomUUID(),
        kind: 'message',
        status: 'complete',
        // Before the marker, so the marker's turn stays the newest.
        createdAt: new Date(start + index * 1_000),
      })),
    });
  });
  return tag;
}

async function send(page: Page, text: string): Promise<void> {
  await expect
    .poll(async () => {
      await page.getByTestId('copilot-request').fill(text);
      return page.getByTestId('copilot-propose').isEnabled();
    })
    .toBe(true);
  await page.getByTestId('copilot-request').press('Enter');
}

for (const locale of ['en', 'ar'] as const) {
  test(`the page: opens at the newest message, follows a send, and offers "New message" when scrolled up (${locale})`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await signIn(page, locale);
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/copilot`);
    const tag = await longHistory(page);
    await page.reload();
    const log = page.getByTestId('copilot-conversation');
    await expect(log.getByText(`History ${tag} line 40.`)).toBeAttached();
    await expect.poll(() => atBottom(log)).toBe(true);

    // A turn waits with "Thinking…" and the three dots, then lands at the bottom.
    await page.route('**/api/copilot/turn', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.continue();
    });
    const mine = `Where are we now? ${randomUUID().slice(0, 6)}`;
    await send(page, mine);
    await expect(page.getByTestId('copilot-working-dots')).toBeVisible();
    await expect(page.getByTestId('copilot-working')).toContainText(
      locale === 'ar' ? 'يفكّر…' : 'Thinking…',
    );
    await expect(log.getByText(mine)).toBeInViewport();
    await expect(page.getByTestId('copilot-working')).toHaveCount(0, { timeout: 60_000 });
    await expect.poll(() => atBottom(log)).toBe(true);
    await expect(page.getByTestId('copilot-new-message')).toHaveCount(0);

    // Scrolled up to read while the next reply is on its way: the reply does
    // not pull the reader down; "New message" offers the way back.
    await page.route('**/api/copilot/turn', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      await route.continue();
    });
    const next = `And next? ${randomUUID().slice(0, 6)}`;
    await send(page, next);
    await expect(log.getByText(next)).toBeInViewport();
    await log.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(page.getByTestId('copilot-new-message')).toBeVisible({ timeout: 60_000 });
    expect(await atBottom(log)).toBe(false);
    await page.getByTestId('copilot-new-message').click();
    await expect.poll(() => atBottom(log)).toBe(true);
    await expect(page.getByTestId('copilot-new-message')).toHaveCount(0);
  });
}

test('the side panel opens at the newest message', async ({ page, isMobile }) => {
  test.skip(isMobile === true, 'the side panel is the desktop’s');
  test.setTimeout(120_000);
  await signIn(page, 'en');
  await page.goto(`${DASHBOARD_BASE_URL}/en/copilot`);
  const tag = await longHistory(page);
  await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
  await page.getByTestId('topbar-copilot').click();
  const drawer = page.getByTestId('copilot-drawer');
  await expect(drawer).toBeVisible();
  const log = drawer.getByTestId('copilot-conversation');
  await expect(log.getByText(`History ${tag} line 40.`)).toBeAttached({ timeout: 30_000 });
  await expect.poll(() => atBottom(log)).toBe(true);
});
