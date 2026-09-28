import { expect, test, type Page } from '@playwright/test';
import { dayWords, openCalendar, seedPost, slotState, utcDay } from './calendar-seed';
import { enter, ownWorkspace } from './own-workspace';
import { finger } from './pointer-drag';
import { statusMessage } from '../../apps/dashboard/src/i18n/messages';

/**
 * §8.2 (Phase 2B-2b item 10, D-353) — THE CALENDAR DRAG WITH A FINGER.
 *
 * Runs only in `chromium-mobile` (Pixel 5: a touch-capable, mobile context —
 * playwright.config.ts), where the calendar is the Agenda list. The finger is
 * REAL touch input sent through the DevTools Protocol
 * (`Input.dispatchTouchEvent`): the browser raises `touchstart`, `touchmove`
 * and `touchend` itself. No mouse is used anywhere in this file.
 *
 * The sequence each test drives: touchStart on a post; hold (the lift must
 * come at 380 ms, not before); touchMove in steps onto a day of the 14-day
 * strip; touchEnd. Then the server's answer is read back: the slot's local
 * time and UTC instant, and its audit trail.
 */

async function hold(page: Page, ms: number): Promise<void> {
  await page.waitForTimeout(ms);
}

/** The strip slides up over 300 ms; aim at a day once it has arrived. */
async function stripSettled(page: Page): Promise<void> {
  const strip = page.getByTestId('calendar-drop-strip');
  await expect(strip).toBeVisible();
  // `fill: both` keeps a finished entrance listed, so ask whether it has finished.
  await expect
    .poll(() => strip.evaluate((el) => el.getAnimations().every((a) => a.playState === 'finished')))
    .toBe(true);
}

const listChip = (page: Page, slotId: string) =>
  page.getByTestId('calendar-agenda').getByTestId(`calendar-post-${slotId}`);

test.describe('§8.2 · dragging a post with a finger (phone)', () => {
  test.beforeEach(({ page }, testInfo) => {
    expect(testInfo.project.use.hasTouch, 'a touch-capable context').toBe(true);
    expect(page.viewportSize()?.width ?? 0).toBeLessThan(768);
  });

  test('a 380 ms long-press lifts it; the 14-day strip takes it; the move is saved; Undo', async ({
    page,
  }) => {
    const workspace = await ownWorkspace('touch-move');
    const from = utcDay(2);
    const to = utcDay(5);
    const post = await seedPost(workspace, `${from}T12:00`);
    await enter(page, workspace.slug);
    await openCalendar(page, from.slice(0, 7));
    await expect(page.getByTestId('calendar-move-note')).toHaveText(
      'Press and hold a post, then drag it to its new day.',
    );

    const touch = await finger(page);
    const started = Date.now();
    await touch.start(listChip(page, post.slotId));
    // Not yet: well inside the long-press, nothing has lifted.
    await hold(page, 150);
    await expect(page.getByTestId('calendar-drag-copy')).toHaveCount(0);
    await expect(page.getByTestId('calendar-drag-copy')).toBeVisible();
    expect(Date.now() - started).toBeGreaterThanOrEqual(380);

    // The strip: the next 14 days, today first.
    const strip = page.getByTestId('calendar-drop-strip');
    await expect(strip).toBeVisible();
    const days = strip.locator('[data-drop-day]');
    await expect(days).toHaveCount(14);
    await expect(days.first()).toHaveAttribute('data-drop-day', utcDay(0));
    await expect(days.last()).toHaveAttribute('data-drop-day', utcDay(13));

    const target = page.getByTestId(`calendar-strip-${to}`);
    await stripSettled(page);
    await touch.moveOnto(target);
    await expect(target).toHaveAttribute('data-drop-over', 'ok');
    await expect(page.getByTestId('calendar-drag-label')).toHaveText(`${dayWords(to)} · 12:00`);
    // Preview only: nothing has been sent yet.
    expect((await slotState(post.slotId)).moves).toBe(0);
    await touch.end();

    await expect(strip).toHaveCount(0);
    await expect(page.getByTestId('toast')).toContainText(`Moved to ${dayWords(to)} · 12:00.`);
    await expect
      .poll(() => slotState(post.slotId))
      .toEqual({ localTime: `${to}T12:00`, utc: `${to}T12:00:00.000Z`, moves: 1 });

    await page.getByTestId('calendar-undo').tap();
    await expect(page.getByTestId('toast')).toContainText(
      `Moved back to ${dayWords(from)} · 12:00.`,
    );
    await expect
      .poll(() => slotState(post.slotId))
      .toEqual({ localTime: `${from}T12:00`, utc: `${from}T12:00:00.000Z`, moves: 2 });
  });

  test('a short press opens the post; moving before the long-press scrolls, and lifts nothing', async ({
    page,
  }) => {
    const workspace = await ownWorkspace('touch-short');
    const day = utcDay(3);
    const post = await seedPost(workspace, `${day}T08:15`);
    await enter(page, workspace.slug);
    await openCalendar(page, day.slice(0, 7));

    const touch = await finger(page);
    // Moving 40 px within the first 100 ms is a scroll, not a lift.
    const at = await touch.start(listChip(page, post.slotId));
    await touch.moveTo(at.x, at.y - 40, 4);
    await hold(page, 600);
    await expect(page.getByTestId('calendar-drag-copy')).toHaveCount(0);
    await expect(page.getByTestId('calendar-drop-strip')).toHaveCount(0);
    await touch.end();

    // A tap shorter than the long-press is a tap: the post opens.
    await touch.start(listChip(page, post.slotId));
    await hold(page, 120);
    await touch.end();
    await expect(page.getByTestId('reschedule-time')).toHaveValue('08:15');
    await expect(page.getByTestId('calendar-drag-copy')).toHaveCount(0);
    expect((await slotState(post.slotId)).moves).toBe(0);
  });

  test('F2: a drop that would put it in the past is refused by the server, and it stays', async ({
    page,
  }) => {
    const workspace = await ownWorkspace('touch-f2');
    // Midnight tomorrow; dropped on TODAY it would be midnight today — passed.
    const tomorrow = utcDay(1);
    const post = await seedPost(workspace, `${tomorrow}T00:00`);
    await enter(page, workspace.slug);
    await openCalendar(page, tomorrow.slice(0, 7));

    const touch = await finger(page);
    await touch.start(listChip(page, post.slotId));
    await expect(page.getByTestId('calendar-drag-copy')).toBeVisible();
    await stripSettled(page);
    await touch.moveOnto(page.getByTestId(`calendar-strip-${utcDay(0)}`));
    await touch.end();

    await expect(page.getByTestId('calendar-move-refused')).toContainText(
      statusMessage('SCHEDULE_IN_PAST', 'en') ?? 'past',
    );
    await expect(
      page.getByTestId(`agenda-day-${tomorrow}`).getByTestId(`calendar-post-${post.slotId}`),
    ).toBeVisible();
    expect(await slotState(post.slotId)).toMatchObject({
      localTime: `${tomorrow}T00:00`,
      moves: 0,
    });
  });

  test('a published post does not lift on a long-press', async ({ page }) => {
    const workspace = await ownWorkspace('touch-published');
    const day = utcDay(4);
    const post = await seedPost(workspace, `${day}T10:00`, 'PUBLISHED');
    await enter(page, workspace.slug);
    await openCalendar(page, day.slice(0, 7));
    await expect(listChip(page, post.slotId)).not.toHaveAttribute('data-drag-payload');

    const touch = await finger(page);
    await touch.start(listChip(page, post.slotId));
    await hold(page, 700);
    await expect(page.getByTestId('calendar-drag-copy')).toHaveCount(0);
    await expect(page.getByTestId('calendar-drop-strip')).toHaveCount(0);
    await touch.end();
    expect((await slotState(post.slotId)).moves).toBe(0);
  });
});
