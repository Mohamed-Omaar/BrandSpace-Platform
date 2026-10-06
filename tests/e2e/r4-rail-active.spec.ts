import { expect, test } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { signIn } from './own-workspace';

/**
 * REVIEW OF #68, ROUND 4, 2.3 — EVERY PAGE MARKS ITS RAIL ITEM.
 *
 * The owner found Notes marking nothing and Billing marking an item scrolled
 * out of sight. On every customer page with a rail item: exactly one item is
 * current, it is the page's own or its parent's (a Settings section marks
 * Settings, Roles & permissions marks Team as the prototype's "Team & roles"
 * does, a sub-page marks the page it belongs to), it is scrolled into the
 * rail's view, and the one moving pill sits on it.
 *
 * 720px tall, so the rail scrolls and "scrolled into view" means something.
 */

const EXPECTED: readonly (readonly [string, string])[] = [
  ['/overview', 'nav-overview'],
  ['/brand-brain', 'nav-brand-brain'],
  ['/brand-brain?tab=look', 'nav-brand-brain'],
  ['/strategy', 'nav-strategy'],
  ['/campaigns', 'nav-campaigns'],
  ['/campaigns/new', 'nav-campaigns'],
  ['/content', 'nav-content'],
  ['/content/compose?mode=write', 'nav-content'],
  ['/assets', 'nav-assets'],
  ['/approvals', 'nav-approvals'],
  ['/calendar', 'nav-calendar'],
  ['/publishing', 'nav-publishing'],
  ['/analytics', 'nav-analytics'],
  ['/automations', 'nav-automations'],
  ['/notes', 'nav-notes'],
  ['/members', 'nav-members'],
  ['/permissions', 'nav-members'],
  ['/settings', 'nav-settings'],
  ['/settings/brand', 'nav-settings'],
  ['/settings/approvals', 'nav-settings'],
  ['/settings/publishing', 'nav-settings'],
  ['/settings/ai', 'nav-settings'],
  ['/settings/notifications', 'nav-settings'],
  ['/settings/security', 'nav-settings'],
  ['/settings/data', 'nav-settings'],
  ['/integrations', 'nav-settings'],
  ['/activity', 'nav-settings'],
  ['/billing', 'nav-settings'],
  ['/plan', 'nav-settings'],
];

test.describe('round 4 · the rail marks every page', () => {
  test.skip(({ isMobile }) => isMobile, 'the phone layout is post-launch (D-468 (b))');
  test.use({ viewport: { width: 1440, height: 720 } });

  test('one current item, the right one, in view, under the pill', async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page);
    const problems: string[] = [];
    for (const [route, testId] of EXPECTED) {
      await page.goto(`${DASHBOARD_BASE_URL}/en${route}`);
      const current = page.getByTestId('sidebar').locator('[aria-current="page"]');
      await expect(current, route).toHaveCount(1);
      await expect(current, route).toHaveAttribute('data-testid', testId);
      // The pill settles after the item is scrolled into view.
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const sb = document.querySelector('[data-testid="sidebar"]')!;
              const nav = sb.querySelector('nav')!.getBoundingClientRect();
              const item = sb.querySelector('[aria-current="page"]')!.getBoundingClientRect();
              const pill = sb.querySelector('.bsp-nav-ind')?.getBoundingClientRect();
              const inView = item.top >= nav.top - 1 && item.bottom <= nav.bottom + 1;
              const pillOn = pill ? Math.abs(pill.top - item.top) < 2 : false;
              return inView && pillOn;
            }),
          { message: `${route}: the current item is in view under the pill` },
        )
        .toBe(true)
        .catch(() => problems.push(route));
    }
    expect(problems).toEqual([]);
  });

  test('clicking through the rail: the pill glides once, without jumping, to an item in view', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await signIn(page);
    // From the top of the rail to its foot and back, by the rail itself.
    for (const testId of ['nav-notes', 'nav-settings', 'nav-overview', 'nav-members']) {
      // Record, on every frame of the move, the pill's offset in the rail and
      // any frame where the current item paints its own fill while the pill
      // is in charge (`data-ind`): that fill on the destination, with the pill
      // still on its way, is the flash the owner saw (Gate 2b review).
      await page.evaluate(() => {
        const w = window as unknown as {
          __pillYs: number[];
          __ownFill: string[];
          __pillStop: boolean;
        };
        w.__pillYs = [];
        w.__ownFill = [];
        w.__pillStop = false;
        const sample = () => {
          const nav = document.querySelector<HTMLElement>('[data-testid="sidebar"] nav');
          const pill = nav?.querySelector<HTMLElement>('.bsp-nav-ind');
          if (pill) w.__pillYs.push(new DOMMatrixReadOnly(getComputedStyle(pill).transform).f);
          const item = nav?.querySelector<HTMLElement>('[aria-current="page"]');
          if (nav?.hasAttribute('data-ind') && item) {
            const fill = getComputedStyle(item).backgroundColor;
            if (fill !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(fill)) {
              w.__ownFill.push(`${item.dataset['testid']} ${fill}`);
            }
          }
          if (!w.__pillStop) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      await page.getByTestId('sidebar').getByTestId(testId).click();
      const current = page.getByTestId('sidebar').locator('[aria-current="page"]');
      await expect(current).toHaveAttribute('data-testid', testId);
      // The glide starts when the new page is first drawn, which on a busy
      // machine comes well after its DOM exists: the move is judged once the
      // pill's own animation has ended, not after a fixed time.
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document
                .querySelector<HTMLElement>('[data-testid="sidebar"] .bsp-nav-ind')
                ?.getAnimations().length ?? -1,
          ),
        )
        .toBe(0);
      const { ys, ownFill } = await page.evaluate(() => {
        const w = window as unknown as {
          __pillYs?: number[];
          __ownFill?: string[];
          __pillStop: boolean;
        };
        w.__pillStop = true;
        return { ys: w.__pillYs ?? [], ownFill: w.__ownFill ?? [] };
      });
      expect(ownFill, `${testId}: the item painted its own fill under a moving pill`).toEqual([]);
      // A new document after navigation starts a fresh record; what matters
      // is the move it shows: one direction, never back.
      const moves = ys.slice(1).map((y, i) => y - ys[i]!);
      const up = moves.some((d) => d < -1);
      const down = moves.some((d) => d > 1);
      expect(up && down, `${testId}: the pill reversed (${ys.join(', ')})`).toBe(false);
      const inView = await page.evaluate(() => {
        const sb = document.querySelector('[data-testid="sidebar"]')!;
        const nav = sb.querySelector('nav')!.getBoundingClientRect();
        const item = sb.querySelector('[aria-current="page"]')!.getBoundingClientRect();
        const pill = sb.querySelector('.bsp-nav-ind')!.getBoundingClientRect();
        return (
          item.top >= nav.top - 1 &&
          item.bottom <= nav.bottom + 1 &&
          Math.abs(pill.top - item.top) < 2
        );
      });
      expect(inView, `${testId}: in view, under the pill`).toBe(true);
    }
  });

  test('collapsed: the same current item, in view, at the foot of the rail', async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);
    await page.locator('.bsp-sb button[aria-pressed="false"]').first().click();
    await expect(page.locator('.bsp-sb.bsp-min')).toBeVisible();
    for (const [route, testId] of [
      ['/billing', 'nav-settings'],
      ['/notes', 'nav-notes'],
      ['/permissions', 'nav-members'],
    ] as const) {
      await page.goto(`${DASHBOARD_BASE_URL}/en${route}`);
      await expect(page.locator('.bsp-sb.bsp-min'), route).toBeVisible();
      const current = page.getByTestId('sidebar').locator('[aria-current="page"]');
      await expect(current, route).toHaveAttribute('data-testid', testId);
      await expect
        .poll(() =>
          page.evaluate(() => {
            const sb = document.querySelector('[data-testid="sidebar"]')!;
            const nav = sb.querySelector('nav')!.getBoundingClientRect();
            const item = sb.querySelector('[aria-current="page"]')!.getBoundingClientRect();
            return item.top >= nav.top - 1 && item.bottom <= nav.bottom + 1;
          }),
        )
        .toBe(true);
    }
    // The label is there on hover, for a collapsed square that shows none.
    await page.getByTestId('sidebar').getByTestId('nav-notes').hover();
    await expect(page.getByTestId('sidebar').getByRole('tooltip', { name: 'Notes' })).toBeVisible();
    await page.locator('.bsp-sb button[aria-pressed="true"]').first().click();
  });
});
