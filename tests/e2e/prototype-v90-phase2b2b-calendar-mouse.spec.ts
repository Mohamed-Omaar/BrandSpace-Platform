import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import {
  dayWords,
  localPartsIn,
  moveBehindTheBack,
  nextUtcMonth,
  openCalendar,
  seedPost,
  slotState,
} from './calendar-seed';
import { E2E_CREDENTIALS_FILE, type E2eAdminCredentials } from './env';
import { enter, ownWorkspace } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';
import { mouseDrag } from './pointer-drag';
import { statusMessage } from '../../apps/dashboard/src/i18n/messages';

/**
 * §8.2 (Phase 2B-2b item 10, D-353) — THE CALENDAR DRAG WITH A MOUSE, on the
 * desktop month. A real mouse: press, 5 px, travel, release. The phone's REAL
 * touch drag is `prototype-v90-phase2b2b-calendar-touch.spec.ts`; this file
 * runs only in `chromium-desktop` and that one only in `chromium-mobile`
 * (playwright.config.ts), so neither skips anything.
 *
 * Every post lives in a workspace of its own, in UTC, so its days and
 * instants are known exactly and no other suite's posts share them.
 */

/** Counts server-action POSTs from now on: a cancelled drag must send none. */
function posts(page: Page): () => number {
  let count = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST') count += 1;
  });
  return () => count;
}

const chipOn = (page: Page, day: string, slotId: string) =>
  page.getByTestId(`calendar-day-${day}`).getByTestId(`calendar-post-${slotId}`);

test.describe('§8.2 · dragging a post with a mouse', () => {
  // Tall enough that the whole month is on screen: the drag does not scroll.
  test.use({ viewport: { width: 1280, height: 1600 } });

  test('a drag moves it at the same time; the label says where; Undo puts it back', async ({
    page,
  }) => {
    const workspace = await ownWorkspace('drag-mouse');
    const { month, day } = nextUtcMonth();
    const post = await seedPost(workspace, `${day(8)}T12:00`);
    await enter(page, workspace.slug);
    await openCalendar(page, month);

    // A plain click is not a drag: it still opens the post — its popover
    // (D-468), whose Details is the post drawer.
    await chipOn(page, day(8), post.slotId).click();
    await expect(page.getByTestId(`calendar-post-pop-${post.slotId}`)).toBeVisible();
    await page.getByTestId('calendar-pop-details').click();
    await expect(page.getByTestId('reschedule-time')).toHaveValue('12:00');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('reschedule-time')).toHaveCount(0);

    const target = page.getByTestId(`calendar-day-${day(22)}`);
    await mouseDrag(page, chipOn(page, day(8), post.slotId), target, async () => {
      // Preview only: the label, the day's look, the placeholder — nothing saved.
      await expect(page.getByTestId('calendar-drag-label')).toHaveText(
        `${dayWords(day(22))} · 12:00`,
      );
      await expect(target).toHaveAttribute('data-drop-over', 'ok');
      await expect(chipOn(page, day(8), post.slotId)).toHaveClass(/bs-drag-origin/);
      expect((await slotState(post.slotId)).moves).toBe(0);
    });

    // Drawn on its new day at once, and saved by the one reschedule.
    await expect(chipOn(page, day(22), post.slotId)).toBeVisible();
    await expect(page.getByTestId('toast')).toContainText(`Moved to ${dayWords(day(22))} · 12:00.`);
    await expect
      .poll(() => slotState(post.slotId))
      .toEqual({
        localTime: `${day(22)}T12:00`,
        utc: `${day(22)}T12:00:00.000Z`,
        moves: 1,
      });
    await expect(target).not.toHaveAttribute('data-drop-over');
    await expect(page.getByTestId('calendar-drag-copy')).toHaveCount(0);

    // Undo — the same path back, once; the toast that offered it is gone.
    await page.getByTestId('calendar-undo').click();
    await expect(page.getByTestId('toast')).toContainText(
      `Moved back to ${dayWords(day(8))} · 12:00.`,
    );
    await expect
      .poll(() => slotState(post.slotId))
      .toEqual({ localTime: `${day(8)}T12:00`, utc: `${day(8)}T12:00:00.000Z`, moves: 2 });
    await expect(chipOn(page, day(8), post.slotId)).toBeVisible();
    await expect(page.getByTestId('calendar-undo')).toHaveCount(0);
  });

  test('Undo after somebody else moved it changes nothing and says why', async ({ page }) => {
    const workspace = await ownWorkspace('drag-undo');
    const { month, day } = nextUtcMonth();
    const post = await seedPost(workspace, `${day(9)}T09:30`);
    await enter(page, workspace.slug);
    await openCalendar(page, month);

    await mouseDrag(
      page,
      chipOn(page, day(9), post.slotId),
      page.getByTestId(`calendar-day-${day(16)}`),
    );
    await expect.poll(async () => (await slotState(post.slotId)).moves).toBe(1);
    // Moved again elsewhere before this page's Undo is pressed.
    await moveBehindTheBack(post.slotId, `${day(16)}T15:00`);

    await page.getByTestId('calendar-undo').click();
    await expect(page.getByTestId('calendar-move-refused')).toContainText(
      statusMessage('SLOT_MOVED_SINCE', 'en') ?? 'moved since',
    );
    // It keeps the moved state: nothing went back.
    await expect(chipOn(page, day(16), post.slotId)).toBeVisible();
    expect(await slotState(post.slotId)).toMatchObject({ localTime: `${day(16)}T15:00`, moves: 1 });
  });

  test('cancel: the same day, outside any day, or Escape — it glides back and nothing is sent', async ({
    page,
  }) => {
    const workspace = await ownWorkspace('drag-cancel');
    const { month, day } = nextUtcMonth();
    const post = await seedPost(workspace, `${day(12)}T18:00`);
    await enter(page, workspace.slug);
    await openCalendar(page, month);
    const sent = posts(page);
    const chip = () => chipOn(page, day(12), post.slotId);

    await mouseDrag(page, chip(), page.getByTestId(`calendar-day-${day(12)}`));
    await expect(page.getByTestId('calendar-drag-copy')).toHaveCount(0);
    await mouseDrag(page, chip(), page.getByTestId('calendar-period'));
    await expect(page.getByTestId('calendar-drag-copy')).toHaveCount(0);
    await mouseDrag(page, chip(), page.getByTestId(`calendar-day-${day(20)}`), async () => {
      await page.keyboard.press('Escape');
      await expect(page.getByTestId(`calendar-day-${day(20)}`)).not.toHaveAttribute(
        'data-drop-over',
      );
    });
    await expect(page.getByTestId('calendar-drag-copy')).toHaveCount(0);

    await expect(chip()).toBeVisible();
    await expect(chip()).not.toHaveClass(/bs-drag-origin/);
    expect(sent()).toBe(0);
    expect(await slotState(post.slotId)).toMatchObject({ localTime: `${day(12)}T18:00`, moves: 0 });
  });

  test('F2: a day that has passed turns grey, says so, and refuses the drop', async ({ page }) => {
    /*
     * FINAL REVIEW (owner, item 6) — A WORKSPACE WHOSE DAY ALWAYS HAS A PAST.
     * The drag needs a passed day and a day still to come in the month on
     * screen. In UTC that is impossible on the 1st (the test skipped itself),
     * and in the last hour of a month the 23:59 post has nearly passed. The
     * workspace's zone is chosen for the moment of the run instead: UTC, or
     * one of two zones without daylight saving whose local day is the 2nd
     * (UTC+14) or the month's last day well before its end (UTC−11).
     */
    const now = new Date();
    const timezone =
      ['UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'].find((zone) => {
        const p = localPartsIn(now, zone);
        const lastOfMonth = new Date(Date.UTC(p.year, p.month, 0)).getUTCDate();
        const minutesLeft = 24 * 60 - (p.hour * 60 + p.minute);
        return p.day >= 2 && !(p.day === lastOfMonth && minutesLeft < 60);
      }) ?? 'UTC';
    const local = localPartsIn(now, timezone);
    const month = `${local.year}-${String(local.month).padStart(2, '0')}`;
    const workspace = await ownWorkspace('drag-past', { timezone });
    // The month's last day, late: still to come for the whole of today.
    const last = new Date(Date.UTC(local.year, local.month, 0)).toISOString().slice(0, 10);
    const post = await seedPost(workspace, `${last}T23:59`, 'SCHEDULED', timezone);
    await enter(page, workspace.slug);
    await openCalendar(page, month);
    const sent = posts(page);
    const past = page.getByTestId(`calendar-day-${month}-01`);
    await expect(past).toHaveAttribute('data-drop-state', 'past');

    await mouseDrag(page, chipOn(page, last, post.slotId), past, async () => {
      await expect(past).toHaveAttribute('data-drop-over', 'past');
      await expect(page.getByTestId('calendar-drag-label')).toHaveText(
        'This day has passed — it can’t be used',
      );
      await expect(page.getByTestId('calendar-drag-label')).toHaveAttribute('data-state', 'past');
    });
    await expect(page.getByTestId('calendar-past-day')).toContainText('That day has passed');
    await expect(chipOn(page, last, post.slotId)).toBeVisible();
    expect(sent()).toBe(0);
    expect((await slotState(post.slotId)).moves).toBe(0);
  });

  test('a published post cannot be dragged; it still opens', async ({ page }) => {
    const workspace = await ownWorkspace('drag-published');
    const { month, day } = nextUtcMonth();
    const post = await seedPost(workspace, `${day(5)}T10:00`, 'PUBLISHED');
    await enter(page, workspace.slug);
    await openCalendar(page, month);
    const chip = chipOn(page, day(5), post.slotId);
    await expect(chip).not.toHaveAttribute('data-drag-payload');

    const box = await chip.boundingBox();
    if (!box) throw new Error('the chip is not on screen');
    await page.mouse.move(box.x + 10, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(box.x + 60, box.y + 80, { steps: 8 });
    await expect(page.getByTestId('calendar-drag-copy')).toHaveCount(0);
    await page.mouse.up();
    expect((await slotState(post.slotId)).moves).toBe(0);
  });

  test('without content.schedule nothing can be dragged or dropped (the view-as rule)', async ({
    page,
  }) => {
    const workspace = await ownWorkspace('drag-viewer');
    const { month, day } = nextUtcMonth();
    const post = await seedPost(workspace, `${day(6)}T11:00`);
    const { customer } = JSON.parse(
      readFileSync(E2E_CREDENTIALS_FILE, 'utf8'),
    ) as E2eAdminCredentials;
    // The seeded read-only member joins this workspace as a client viewer.
    await withPlatformPrisma(async (prisma) => {
      const viewer = await prisma.user.findFirstOrThrow({
        where: { email: customer.viewerEmail },
        select: { id: true },
      });
      const role = await prisma.role.findFirstOrThrow({
        where: { key: 'client_viewer', workspaceId: null },
        select: { id: true },
      });
      await prisma.membership.create({
        data: {
          workspaceId: workspace.workspaceId,
          userId: viewer.id,
          roleId: role.id,
          status: 'ACTIVE',
          acceptedAt: new Date(),
        },
      });
    });
    await page.goto(`${DASHBOARD_BASE_URL}/en/sign-in`);
    await page.fill('#email', customer.viewerEmail);
    await page.fill('#password', customer.viewerPassword);
    await page.click('[data-testid="signin-submit"]');
    await page.waitForURL((url) => !url.pathname.endsWith('/sign-in'));
    await page.goto(`${DASHBOARD_BASE_URL}/en/workspaces`);
    await page.click(`[data-testid="choose-workspace-${workspace.slug}"]`);
    await page.waitForURL(/\/en\/overview$/);
    await openCalendar(page, month);

    const chip = chipOn(page, day(6), post.slotId);
    await expect(chip).toBeVisible();
    await expect(chip).not.toHaveAttribute('data-drag-payload');
    await expect(page.locator('[data-drop-day]')).toHaveCount(0);
    const box = await chip.boundingBox();
    if (!box) throw new Error('the chip is not on screen');
    await page.mouse.move(box.x + 10, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(box.x + 60, box.y + 120, { steps: 8 });
    await expect(page.getByTestId('calendar-drag-copy')).toHaveCount(0);
    await page.mouse.up();
    expect((await slotState(post.slotId)).moves).toBe(0);
  });
});
