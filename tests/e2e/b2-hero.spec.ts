import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { signIn } from './own-workspace';

/**
 * B2 (owner, 2026-11-14) — THE HOME HERO PAINTS AT MOST 30 TIMES A SECOND,
 * AND NOT AT ALL WHERE NOBODY SEES IT.
 *
 * Every repaint starts with `clearRect`, so the page counts those: on screen
 * it is at most 30 a second (it used to be one per display frame, 60 or
 * more), scrolled away it is none, and in a hidden tab it is none. Back in
 * view it paints again.
 */

async function countPaints(page: Page) {
  await page.addInitScript(() => {
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    (window as unknown as { __paints: number }).__paints = 0;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      (window as unknown as { __paints: number }).__paints += 1;
      return clear.apply(this, args);
    };
  });
}

const paintsOver = async (page: Page, ms: number) => {
  const before = await page.evaluate(() => (window as unknown as { __paints: number }).__paints);
  await page.waitForTimeout(ms);
  const after = await page.evaluate(() => (window as unknown as { __paints: number }).__paints);
  return after - before;
};

test('the home hero: at most 30 paints a second on screen, none off screen or hidden', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await countPaints(page);
  await signIn(page, 'en');
  await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
  const hero = page.getByTestId('overview-hero');
  await expect(hero).toBeVisible();
  await page.waitForTimeout(500);

  // On screen: it moves, at no more than 30 frames a second (2 s, with slack
  // for the first frame).
  const onScreen = await paintsOver(page, 2_000);
  expect(onScreen).toBeGreaterThan(10);
  expect(onScreen).toBeLessThanOrEqual(62);

  // Scrolled out of view: nothing is painted.
  // Whatever scrolls the page (the window or the shell's own pane) is
  // scrolled until the hero has gone.
  await hero.evaluate((element) => {
    const spacer = document.createElement('div');
    spacer.style.blockSize = '400vh';
    element.parentElement?.append(spacer);
    let box: HTMLElement | null = element.parentElement;
    while (
      box &&
      !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY))
    ) {
      box = box.parentElement;
    }
    (box ?? document.scrollingElement ?? document.documentElement).scrollTop = 1e6;
    window.scrollTo(0, 1e6);
  });
  await expect(hero).not.toBeInViewport();
  await page.waitForTimeout(300);
  expect(await paintsOver(page, 1_500)).toBe(0);

  // Back in view: it carries on.
  await hero.evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await expect(hero).toBeInViewport();
  await page.waitForTimeout(300);
  expect(await paintsOver(page, 1_000)).toBeGreaterThan(5);

  // A hidden tab: nothing.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(300);
  expect(await paintsOver(page, 1_500)).toBe(0);
});
