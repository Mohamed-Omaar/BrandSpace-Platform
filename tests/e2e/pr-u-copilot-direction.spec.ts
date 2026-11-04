import { expect, test, type Locator, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { signIn } from './own-workspace';

/**
 * PR U — EVERY BUBBLE, CARD AND INPUT TAKES ITS DIRECTION FROM ITS TEXT.
 *
 * Staging: Arabic in the English UI was laid out left to right, so "؟" sat at
 * the start of the line and mixed Arabic/English words were out of order.
 * `dir="auto"` lets the text decide. Checked both ways — Arabic in the English
 * UI, English in the Arabic UI — on the Copilot page and in the side panel
 * (one conversation, D-594; the panel is the desktop's), on the desktop and
 * the phone projects.
 *
 * What is measured is the browser's own answer (`:dir()`) and, for the
 * question mark, where it is drawn: at the END of an Arabic sentence, which is
 * its LEFT edge.
 */

const ARABIC = 'ما الذي يقدمه Vetsvan؟';
const ENGLISH = 'What does Vetsvan offer?';

async function send(page: Page, text: string): Promise<void> {
  const before = await page.getByTestId('copilot-message-user').count();
  await expect
    .poll(async () => {
      await page.getByTestId('copilot-request').fill(text);
      return page.getByTestId('copilot-propose').isEnabled();
    })
    .toBe(true);
  await page.getByTestId('copilot-request').press('Enter');
  await expect
    .poll(async () => page.getByTestId('copilot-message-user').count(), { timeout: 60_000 })
    .toBeGreaterThan(before);
  // Wait for the answer, so the next turn does not race this one.
  await expect(page.getByTestId('copilot-streaming')).toHaveCount(0, { timeout: 60_000 });
}

const direction = (locator: Locator) =>
  locator.evaluate((el) => (el.matches(':dir(rtl)') ? 'rtl' : 'ltr'));

/** The bubble holding `text`, last one first. */
const bubbleWith = (scope: Page | Locator, text: string) =>
  scope.locator('.bs-cpb-bubble', { hasText: text }).last();

/** Where "؟" is drawn relative to the first letter: left of it in RTL. */
async function questionMarkIsAtTheEnd(bubble: Locator): Promise<boolean> {
  return bubble.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node: Text | null = null;
    while (walker.nextNode()) {
      const text = walker.currentNode as Text;
      if (text.data.includes('؟')) node = text;
    }
    if (!node) return false;
    const rect = (start: number) => {
      const range = document.createRange();
      range.setStart(node as Text, start);
      range.setEnd(node as Text, start + 1);
      return range.getBoundingClientRect();
    };
    const mark = rect((node as Text).data.indexOf('؟'));
    const first = rect((node as Text).data.search(/\S/));
    return mark.left < first.left;
  });
}

test.describe('PR U · text direction follows the text, page and panel', () => {
  test.describe.configure({ mode: 'serial' });

  test('Arabic in the English UI reads right to left; the composer follows what is typed', async ({
    page,
    isMobile,
  }) => {
    test.setTimeout(180_000);
    await signIn(page, 'en');
    await page.goto(`${DASHBOARD_BASE_URL}/en/copilot`);
    await expect(page.getByTestId('copilot-request')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.dir)).not.toBe('rtl');

    // The composer: Arabic typed into an English page.
    const composer = page.getByTestId('copilot-request');
    await expect(composer).toHaveAttribute('dir', 'auto');
    await composer.fill(ARABIC);
    expect(await direction(composer)).toBe('rtl');
    await composer.fill(ENGLISH);
    expect(await direction(composer)).toBe('ltr');
    await composer.fill('');

    await send(page, ARABIC);
    const bubble = bubbleWith(page, 'Vetsvan');
    await expect(bubble).toHaveAttribute('dir', 'auto');
    expect(await direction(bubble)).toBe('rtl');
    expect(await questionMarkIsAtTheEnd(bubble)).toBe(true);

    // Every bubble and the search box carry dir="auto".
    for (const el of await page.locator('.bs-cpb-bubble').all()) {
      await expect(el).toHaveAttribute('dir', 'auto');
    }
    await expect(page.getByTestId('copilot-search')).toHaveAttribute('dir', 'auto');

    // The side panel shows the same conversation, the same way. It is the
    // desktop's (the phone's Copilot is the page, B2).
    if (isMobile) return;
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    await page.getByTestId('topbar-copilot').click();
    const panel = page.getByTestId('copilot-drawer');
    await expect(panel).toBeVisible();
    const inPanel = bubbleWith(panel, 'Vetsvan');
    await expect(inPanel).toBeVisible({ timeout: 30_000 });
    await expect(inPanel).toHaveAttribute('dir', 'auto');
    expect(await direction(inPanel)).toBe('rtl');
    await expect(panel.getByTestId('copilot-request')).toHaveAttribute('dir', 'auto');
  });

  test('English in the Arabic UI reads left to right, page and panel', async ({
    page,
    isMobile,
  }) => {
    test.setTimeout(180_000);
    await signIn(page, 'ar');
    await page.goto(`${DASHBOARD_BASE_URL}/ar/copilot`);
    await expect(page.getByTestId('copilot-request')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl');

    const composer = page.getByTestId('copilot-request');
    await composer.fill(ENGLISH);
    expect(await direction(composer)).toBe('ltr');
    await composer.fill('');

    await send(page, ENGLISH);
    const bubble = bubbleWith(page, ENGLISH);
    await expect(bubble).toHaveAttribute('dir', 'auto');
    expect(await direction(bubble)).toBe('ltr');

    if (isMobile) return;
    await page.goto(`${DASHBOARD_BASE_URL}/ar/overview`);
    await page.getByTestId('topbar-copilot').click();
    const panel = page.getByTestId('copilot-drawer');
    await expect(panel).toBeVisible();
    const inPanel = bubbleWith(panel, ENGLISH);
    await expect(inPanel).toBeVisible({ timeout: 30_000 });
    expect(await direction(inPanel)).toBe('ltr');
  });
});
