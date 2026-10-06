import { expect, test } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { enter, ownWorkspace } from './own-workspace';

/**
 * ROUND 5 (F3) — VOICE WORDS ARE CHIPS, EACH WITH ITS OWN "×", AND ONE
 * "ADD A WORD" FIELD.
 *
 * The prototype draws the brand's voice words as chips (`x.voiceChips`). One
 * or more words are added at a time (a comma splits them), a chip's "×"
 * removes that word alone, and every change survives a reload. Only the
 * reader's language is written.
 */

for (const locale of ['en', 'ar'] as const) {
  test(`voice words are added and removed one chip at a time (${locale})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    test.setTimeout(90_000);
    const own = await ownWorkspace(`r5-voice-${locale}`);
    await enter(page, own.slug, locale);
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/brand-brain?tab=look`);
    const chips = page.getByTestId('voice-words-value').locator('.bsp-chip');
    const [one, two, three] =
      locale === 'ar' ? ['ودود', 'واضح', 'جريء'] : ['warm', 'clear', 'bold'];

    await page.getByTestId(`voice-words-${locale}`).fill(`${one}, ${two}`);
    await page.getByTestId('voice-words-save').click();
    await expect(chips).toHaveText([one, two]);

    await page.getByTestId(`voice-words-${locale}`).fill(three);
    await page.getByTestId('voice-words-save').click();
    await expect(chips).toHaveText([one, two, three]);

    // The "×" names the word it removes, and removes that word alone.
    const remove = page.getByTestId('voice-words-remove-1');
    await expect(remove).toHaveAccessibleName(new RegExp(two));
    await remove.click();
    await expect(chips).toHaveText([one, three]);

    await page.reload();
    await expect(chips).toHaveText([one, three]);
  });
}
