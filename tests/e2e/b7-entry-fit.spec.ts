import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { scaledEntry } from './scale';

/**
 * BATCH 7 PR C (2a, 2b) — THE ENTRY SCREENS AT 0.80, AND THE PASSWORD HINTS.
 *
 *   - Every entry screen draws the prototype at 0.80 (D-484 amended): the
 *     540px card is 432px wide.
 *   - Sign-up fits a 1536×864 and a 1920×1080 window in both languages with no
 *     scroll, neither in the page nor inside the card (it used to scroll
 *     inside the card).
 *   - The shared password hints ("At least 8 characters", "A phrase with
 *     spaces is fine") never touch what follows them: the hint list's own
 *     margin was invalid CSS and was dropped, and its lines were shorter than
 *     their text.
 */

const VIEWPORTS = [
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
] as const;

async function overflow(page: Page) {
  return page.evaluate(() => {
    const card = document.querySelector<HTMLElement>('.bsp-auth-card');
    const scroller = document.scrollingElement ?? document.documentElement;
    return {
      page: scroller.scrollHeight - scroller.clientHeight,
      card: card ? card.scrollHeight - card.clientHeight : null,
      cardWidth: card ? card.getBoundingClientRect().width : null,
    };
  });
}

test.describe('Batch 7 PR C · the entry screens at 0.80', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop sizes; the phone layout is post-launch');

  for (const viewport of VIEWPORTS) {
    test(`sign-in, sign-up and forgot password fit ${viewport.width}×${viewport.height}, en and ar`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      const offenders: string[] = [];
      for (const locale of ['en', 'ar']) {
        for (const path of ['/sign-in', '/sign-up', '/reset']) {
          await page.goto(`${DASHBOARD_BASE_URL}/${locale}${path}`);
          const measured = await overflow(page);
          if (measured.page > 0) offenders.push(`${locale}${path}: page ${measured.page}px`);
          if ((measured.card ?? 0) > 0) {
            offenders.push(`${locale}${path}: card ${measured.card}px`);
          }
          expect(
            Math.abs((measured.cardWidth ?? 0) - scaledEntry(540)),
            `${locale}${path} card width`,
          ).toBeLessThanOrEqual(1);
        }
      }
      expect(offenders).toEqual([]);
    });
  }

  test('the password hints keep clear of what follows them', async ({ page }) => {
    await page.setViewportSize({ width: 1536, height: 864 });
    for (const locale of ['en', 'ar']) {
      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/sign-up`);
      const gaps = await page.evaluate(() => {
        const list = document.querySelector<HTMLElement>('ul[data-testid$="-rules"]');
        if (!list) return null;
        const items = [...list.querySelectorAll('li')];
        // Each line box holds its text: at least 1.3× the type (it was 10.5px
        // for 11px type), with at most a pixel of a tall glyph's overhang.
        const spilled = items.filter(
          (item) =>
            item.scrollHeight > item.clientHeight + 1 ||
            parseFloat(getComputedStyle(item).lineHeight) <
              1.3 * parseFloat(getComputedStyle(item).fontSize),
        ).length;
        // The first visible element that follows the list in the page.
        const bottom = list.getBoundingClientRect().bottom;
        const following = [...document.querySelectorAll<HTMLElement>('.bsp-auth-card *')].filter(
          (element) =>
            !list.contains(element) &&
            !element.contains(list) &&
            (list.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&
            element.getBoundingClientRect().height > 0,
        );
        const below =
          following.length > 0
            ? Math.min(...following.map((element) => element.getBoundingClientRect().top)) - bottom
            : null;
        return { spilled, below, margin: getComputedStyle(list).marginBlockEnd };
      });
      expect(gaps, `${locale}: no hint list`).not.toBeNull();
      expect(gaps!.spilled, `${locale}: a hint line spills out of its box`).toBe(0);
      expect(gaps!.margin, `${locale}: the list's margin is applied`).not.toBe('0px');
      expect(gaps!.below ?? 0, `${locale}: space under the hints`).toBeGreaterThanOrEqual(4);
    }
  });

  test('"check your email" covers both cases and counts down to "Send it again"', async ({
    page,
  }) => {
    const email = `b7-countdown-${Date.now()}@example.test`;
    await page.goto(
      `${DASHBOARD_BASE_URL}/en/sign-up/sent?email=${encodeURIComponent(email)}&at=${Date.now()}&wait=4`,
    );
    await expect(page.getByTestId('signup-sent')).toHaveText(
      'If this address can be used, we have sent you an email. Check spam too.',
    );
    const resend = page.getByTestId('signup-resend');
    await expect(resend).toBeDisabled();
    await expect(resend).toContainText(/You can send it again in 0:0[1-4]/);
    await expect(resend).toBeEnabled({ timeout: 8_000 });
    await expect(resend).toHaveText('Send it again');
    await resend.click();
    await page.waitForURL(/again=1/);
    await expect(page.getByTestId('signup-resent')).toBeVisible();

    await page.goto(
      `${DASHBOARD_BASE_URL}/ar/sign-up/sent?email=${encodeURIComponent(email)}&at=${Date.now()}&wait=60`,
    );
    await expect(page.getByTestId('signup-resend')).toContainText('يمكنك إعادة الإرسال بعد');
  });
});
