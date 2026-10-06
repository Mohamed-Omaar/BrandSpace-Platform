import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { nextUtcMonth, seedPost } from './calendar-seed';
import { enter, ownWorkspace } from './own-workspace';

/**
 * ROUND 5 (D) — A POST'S POPOVER STAYS INSIDE THE FRAME, ON ANY DAY.
 *
 * Opened on the last row it ran under the page's foot, and its Edit and
 * "Move to another day" could not be reached. A post on each of the last
 * seven days of a month covers the last row and the last column, in both
 * directions: every popover must be inside the window, and its buttons must
 * be what a press there lands on.
 */

async function insideAndReachable(page: Page, testId: string): Promise<void> {
  const pop = page.getByTestId(testId);
  await expect(pop).toBeVisible();
  const box = await pop.boundingBox();
  const viewport = page.viewportSize();
  if (!box || !viewport) throw new Error('the popover has no box');
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  for (const button of ['calendar-pop-edit', 'calendar-pop-move']) {
    const target = pop.getByTestId(button);
    if ((await target.count()) === 0) continue;
    const hit = await target.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return top === el || el.contains(top);
    });
    expect(hit, `${testId} ${button} is under something`).toBe(true);
  }
}

for (const locale of ['en', 'ar'] as const) {
  test(`a post's popover is inside the frame on the last row and column (${locale})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'the phone draws the agenda, not the month grid');
    test.setTimeout(120_000);
    const own = await ownWorkspace(`r5-pop-${locale}`);
    const { month, day } = nextUtcMonth();
    const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0));
    const lastDay = last.getUTCDate();
    const posts = [];
    for (let d = lastDay - 6; d <= lastDay; d += 1) {
      posts.push(await seedPost(own, `${day(d)}T10:00`));
    }
    await enter(page, own.slug, locale);
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/calendar?month=${month}`);
    await expect(page.getByTestId('content-calendar')).toBeVisible();
    for (const post of posts) {
      const chip = page.locator(`[data-testid^="calendar-post-"][data-pid]`).filter({
        has: page.locator(`text=${post.title}`),
      });
      const opener = (await chip.count()) > 0 ? chip.first() : null;
      if (!opener) continue;
      await opener.scrollIntoViewIfNeeded();
      await opener.click();
      const popId = await page
        .locator('[data-testid^="calendar-post-pop-"]')
        .first()
        .getAttribute('data-testid');
      await insideAndReachable(page, popId ?? '');
      await page.keyboard.press('Escape');
    }
  });
}
