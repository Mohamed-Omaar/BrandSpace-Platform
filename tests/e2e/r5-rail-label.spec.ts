import { expect, test } from '@playwright/test';
import { signIn } from './own-workspace';

/**
 * ROUND 5 (F4) — THE RAIL'S LABELS STAY READABLE THROUGH THE GLIDE.
 *
 * The owner saw the item left behind turn ink on the still-dark pill, and the
 * new one turn white on the light rail, for the 440 ms the pill takes to
 * arrive. On every frame of a move across the rail: a label the pill covers
 * more than half of is white, and every other label is ink. Labels the pill's
 * edge is crossing (a quarter to three quarters covered) are not judged: any
 * colour is half on dark there. A white label never sits on the row's own
 * hover fill (the pressed item is still under the pointer when the pill
 * arrives).
 *
 * Each frame is read after the frame's own callbacks ran (a task queued from
 * `requestAnimationFrame`), which is the state the browser paints.
 */

for (const locale of ['en', 'ar'] as const) {
  test(`the labels the pill passes stay readable (${locale})`, async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'the phone layout is post-launch (D-468 (b))');
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, locale);
    for (const testId of ['nav-settings', 'nav-overview', 'nav-calendar', 'nav-brand-brain']) {
      await page.evaluate(() => {
        const w = window as unknown as { __wrong: string[]; __frames: number; __stop: boolean };
        w.__wrong = [];
        w.__frames = 0;
        w.__stop = false;
        const lum = (value: string) => {
          const [r = 0, g = 0, b = 0] = (value.match(/[\d.]+/g) ?? []).map(Number);
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const check = () => {
          const nav = document.querySelector<HTMLElement>('[data-testid="sidebar"] nav');
          const pill = nav?.querySelector<HTMLElement>('.bsp-nav-ind');
          if (!nav?.hasAttribute('data-ind') || !pill) return;
          w.__frames += 1;
          const box = pill.getBoundingClientRect();
          for (const row of Array.from(nav.querySelectorAll<HTMLElement>('.bsp-nav'))) {
            const r = row.getBoundingClientRect();
            if (r.height === 0) continue;
            const overlapX = Math.min(r.right, box.right) > Math.max(r.left, box.left);
            const covered = overlapX
              ? Math.max(0, Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top)) / r.height
              : 0;
            if (covered > 0.25 && covered < 0.75) continue;
            const light = lum(getComputedStyle(row).color) > 128;
            if (light !== covered >= 0.75) {
              w.__wrong.push(
                `${row.dataset['testid']} ${light ? 'white' : 'ink'} ${Math.round(covered * 100)}%`,
              );
            }
            // A white label sits on the pill, never on the row's own (hover) fill.
            const fill = getComputedStyle(row).backgroundColor;
            if (light && fill !== 'transparent' && !/,\s*0\)$/.test(fill)) {
              w.__wrong.push(`${row.dataset['testid']} white on its own fill ${fill}`);
            }
          }
        };
        const frame = () => {
          setTimeout(check, 0);
          if (!w.__stop) requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
      await page.getByTestId('sidebar').getByTestId(testId).click();
      const current = page.getByTestId('sidebar').locator('[aria-current="page"]');
      await expect(current).toHaveAttribute('data-testid', testId);
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
      await page.waitForTimeout(100);
      const { wrong, frames } = await page.evaluate(() => {
        const w = window as unknown as { __wrong?: string[]; __frames?: number; __stop: boolean };
        w.__stop = true;
        return { wrong: w.__wrong ?? [], frames: w.__frames ?? 0 };
      });
      expect(frames, `${testId}: frames were read`).toBeGreaterThan(5);
      expect(wrong, `${testId}: a label was unreadable during the glide`).toEqual([]);
      // At rest, the current item is the one white label.
      await expect(current).toHaveCSS('color', 'rgb(255, 255, 255)');
    }
  });
}
