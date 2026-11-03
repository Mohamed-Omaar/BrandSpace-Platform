import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { signIn } from './own-workspace';

/**
 * PR B (D-594), owner review of the Copilot page — THE BOTTOM OF THE PAGE.
 *
 *   - every card (the file's Add card, "Read N pages, found N facts", the
 *     answer's sources) is a message INSIDE the conversation, above the
 *     composer — never below it or outside the window;
 *   - the one composer is visible at the bottom, on a desktop and on a
 *     393×727 phone, however long the conversation is;
 *   - the Copilot page draws no Copilot button of its own (floating or header);
 *   - the message's price sits beside Send BEFORE sending, follows an attached
 *     file, and is gone when there is nothing to price; the credits pill names
 *     its unit, and says what it is to a screen reader;
 *   - the side panel: its toolbar (search, New topic, ⋯) is one row, and
 *     "Open in Copilot page" is a named icon button in its head.
 *
 * Runs on the desktop and the phone projects, in English and Arabic.
 */

async function send(page: Page, text: string): Promise<void> {
  const before = await page.getByTestId('copilot-message-assistant').count();
  await expect
    .poll(async () => {
      await page.getByTestId('copilot-request').fill(text);
      return page.getByTestId('copilot-propose').isEnabled();
    })
    .toBe(true);
  await page.getByTestId('copilot-request').press('Enter');
  await expect
    .poll(async () => page.getByTestId('copilot-message-assistant').count(), { timeout: 60_000 })
    .toBeGreaterThan(before);
}

/** The composer is on screen, at the bottom, under the whole conversation. */
async function composerAtTheBottom(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  const composer = page.getByTestId('copilot-request');
  await expect(composer).toBeInViewport({ ratio: 1 });
  const box = await composer.boundingBox();
  const log = await page.getByTestId('copilot-conversation').boundingBox();
  expect(box && viewport && box.y + box.height).toBeLessThanOrEqual(viewport?.height ?? 0);
  // Pinned at the bottom: under the conversation, in the lower third.
  expect((box?.y ?? 0) + 1).toBeGreaterThanOrEqual((log?.y ?? 0) + (log?.height ?? 0) - 1);
  expect(box?.y ?? 0).toBeGreaterThan((viewport?.height ?? 0) * 0.6);
}

/** A card is inside the conversation and above the composer. */
async function insideTheConversation(page: Page, testId: string): Promise<void> {
  const card = page.getByTestId(testId).first();
  await expect(card).toBeVisible();
  expect(
    await card.evaluate((el) => el.closest('[data-testid="copilot-conversation"]') !== null),
    `${testId} is inside the conversation`,
  ).toBe(true);
  await card.scrollIntoViewIfNeeded();
  const cardBox = await card.boundingBox();
  const composerBox = await page.getByTestId('copilot-request').boundingBox();
  expect((cardBox?.y ?? 0) + (cardBox?.height ?? 0)).toBeLessThanOrEqual((composerBox?.y ?? 0) + 1);
}

test.describe('PR B · the Copilot page: one composer, cards in the conversation', () => {
  test.describe.configure({ mode: 'serial' });

  for (const locale of ['en', 'ar'] as const) {
    test(`no Copilot button on the page; the composer stays at the bottom; cards are messages (${locale})`, async ({
      page,
    }) => {
      test.setTimeout(240_000);
      await signIn(page, locale);
      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/copilot`);
      await expect(page.getByTestId('copilot-request')).toBeVisible();

      // No button over the page that is the conversation.
      await expect(page.getByTestId('topbar-copilot')).toHaveCount(0);
      await expect(page.locator('.bsp-fab')).toHaveCount(0);
      // One chat composer: "Message Copilot…", no plan box above it.
      await expect(page.getByTestId('copilot-request')).toHaveAttribute(
        'placeholder',
        locale === 'ar' ? 'اكتب رسالة إلى المساعد…' : 'Message Copilot…',
      );
      await expect(page.getByTestId('copilot-attach')).toBeVisible();
      await composerAtTheBottom(page);

      // A long conversation: the messages scroll, the composer does not move.
      for (const text of ['One.', 'Two.', 'Three.', 'Four.', 'Five.']) {
        await send(page, `${text} ${Date.now()} What is our positioning?`);
      }
      await composerAtTheBottom(page);
      const scrolls = await page.getByTestId('copilot-conversation').evaluate((el) => {
        for (let node: Element | null = el; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (['auto', 'scroll'].includes(style.overflowY) && node.scrollHeight > node.clientHeight)
            return node.closest('[data-testid="copilot-view"]') !== null;
        }
        return false;
      });
      expect(scrolls, 'only the conversation scrolls').toBe(true);
      await insideTheConversation(page, 'copilot-message-assistant');

      // The file card and its result are messages, above the composer.
      await page.getByTestId('copilot-attach-input').setInputFiles({
        name: 'menu.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from(
          `Our service includes a monthly tasting menu for local offices (${locale} ${Date.now()}).`,
        ),
      });
      // It comes into view by itself, as a new message does.
      await expect(page.getByTestId('copilot-source-card')).toBeInViewport();
      await insideTheConversation(page, 'copilot-source-card');
      await page.getByTestId('copilot-source-add').click();
      await expect(page.getByTestId('copilot-source-coverage')).toBeVisible({ timeout: 120_000 });
      await insideTheConversation(page, 'copilot-source-coverage');
      await composerAtTheBottom(page);
    });
  }

  for (const locale of ['en', 'ar'] as const) {
    test(`the price beside Send before sending, with a file too; the credits pill has its unit (${locale})`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await signIn(page, locale);
      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/copilot`);
      await expect(page.getByTestId('copilot-request')).toBeVisible();

      const unit = locale === 'ar' ? 'رصيد' : 'credits';
      const credits = page.getByTestId('copilot-credits');
      await expect(credits).toHaveText(new RegExp(`^[\\d,]+ ${unit}$`));
      await expect(credits).toHaveAttribute(
        'aria-label',
        new RegExp(`^${locale === 'ar' ? 'الرصيد المتبقي' : 'Credits left'}: [\\d,]+$`),
      );

      const price = page.getByTestId('copilot-message-price');
      const amount = async (): Promise<number> => {
        const text = (await price.textContent()) ?? '';
        const match = /(\d[\d,]*)/.exec(text);
        return match ? Number(match[1]!.replace(/,/g, '')) : Number.NaN;
      };
      // Nothing typed, nothing attached: no price at all.
      await expect(price).toHaveCount(0);
      await page.getByTestId('copilot-request').fill('What is our positioning?');
      await expect(price).toHaveText(new RegExp(`\\d+ ${unit}$`), { timeout: 15_000 });
      const textOnly = await amount();
      expect(textOnly).toBeGreaterThan(0);
      // Beside Send, in the composer's own row.
      const send = await page.getByTestId('copilot-propose').boundingBox();
      const priceBox = await price.boundingBox();
      expect(
        Math.abs(
          (priceBox?.y ?? 0) +
            (priceBox?.height ?? 0) / 2 -
            ((send?.y ?? 0) + (send?.height ?? 0) / 2),
        ),
      ).toBeLessThan(12);

      // A file waiting for Add: the price is the message AND the file's reading.
      await page.getByTestId('copilot-attach-input').setInputFiles({
        name: 'menu.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from(`Our service includes a tasting menu (${locale} ${Date.now()}).`),
      });
      await expect(page.getByTestId('copilot-source-ask')).toBeVisible();
      await expect.poll(amount, { timeout: 15_000 }).toBeGreaterThan(textOnly);
      // Not now: the file is gone, and so is its price.
      await page.getByTestId('copilot-source-not-now').click();
      await expect.poll(amount, { timeout: 15_000 }).toBe(textOnly);
      // Nothing left to price: no number at all, never a stale one.
      await page.getByTestId('copilot-request').fill('');
      await expect(price).toHaveCount(0);
    });
  }

  test('the side panel: one toolbar row, "Open in Copilot page" as a named icon in its head, the price beside Send', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'the side panel is the desktop’s');
    test.setTimeout(120_000);
    await signIn(page, 'en');
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    await page.getByTestId('topbar-copilot').click();
    const drawer = page.getByTestId('copilot-drawer');
    await expect(drawer).toBeVisible();

    // "Open in Copilot page": an icon button in the head, named, with a tooltip.
    const open = page.getByTestId('copilot-header').getByTestId('copilot-open-full');
    await expect(open).toBeVisible();
    await expect(open).toHaveAttribute('aria-label', 'Open in Copilot page');
    await expect(open).toHaveAttribute('title', 'Open in Copilot page');
    await expect(open).toHaveText('');
    await expect(drawer.getByTestId('copilot-open-full')).toHaveCount(1);
    await expect(page.getByTestId('copilot-header').getByTestId('copilot-credits')).toHaveText(
      /^[\d,]+ credits$/,
    );

    // The toolbar: search, New topic and ⋯ on one row.
    const centre = async (testId: string): Promise<number> => {
      const box = await drawer.getByTestId(testId).first().boundingBox();
      return (box?.y ?? 0) + (box?.height ?? 0) / 2;
    };
    const row = await centre('copilot-search');
    expect(Math.abs((await centre('copilot-new-topic')) - row)).toBeLessThan(6);
    expect(Math.abs((await centre('copilot-more')) - row)).toBeLessThan(6);

    // The price beside Send, in the panel as on the page.
    await drawer.getByTestId('copilot-request').fill('What is our positioning?');
    await expect(drawer.getByTestId('copilot-message-price')).toHaveText(/\d+ credits$/, {
      timeout: 15_000,
    });

    await open.click();
    await expect(page).toHaveURL(/\/en\/copilot/);
  });
});
