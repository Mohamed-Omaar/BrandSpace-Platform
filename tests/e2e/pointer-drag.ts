import { expect, type Locator, type Page } from '@playwright/test';

/**
 * §8.2 (Phase 2B-2b item 10) — HOW THE CALENDAR DRAG IS DRIVEN IN A BROWSER.
 *
 * `mouseDrag` is a real mouse: press, travel past the 5 px threshold, travel
 * to the target in steps, release. `touchDrag` is a REAL touch sequence sent
 * through the Chrome DevTools Protocol (`Input.dispatchTouchEvent`), in a
 * touch-capable mobile context — the browser itself turns it into
 * `touchstart`/`touchmove`/`touchend` and touch pointer events, exactly as a
 * finger would. Nothing here fakes touch with a mouse.
 */

async function centre(locator: Locator): Promise<{ x: number; y: number }> {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('the element is not on screen');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** A mouse drag from `source` to `target`. `hold` runs while over the target, before release. */
export async function mouseDrag(
  page: Page,
  source: Locator,
  target: Locator,
  hold?: () => Promise<void>,
): Promise<void> {
  const from = await centre(source);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 8, from.y + 4, { steps: 4 });
  await expect(page.getByTestId('calendar-drag-copy')).toBeVisible();
  const box = await target.boundingBox();
  if (!box) throw new Error('the drop target is not on screen');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
  if (hold) await hold();
  await page.mouse.up();
}

export interface Touch {
  /** Put a finger down on `locator`; resolves once it is down. */
  start(locator: Locator): Promise<{ x: number; y: number }>;
  /** Slide the finger to a point, in steps, as a finger moves. */
  moveTo(x: number, y: number, steps?: number): Promise<void>;
  /** Slide the finger onto `locator`'s centre. */
  moveOnto(locator: Locator, steps?: number): Promise<void>;
  /** Lift the finger. */
  end(): Promise<void>;
}

/** A finger on the page, through CDP — a touch-capable context is required. */
export async function finger(page: Page): Promise<Touch> {
  const cdp = await page.context().newCDPSession(page);
  let at = { x: 0, y: 0 };
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }],
    });
  const touch: Touch = {
    async start(locator) {
      at = await centre(locator);
      await send('touchStart', at.x, at.y);
      return at;
    },
    async moveTo(x, y, steps = 10) {
      const from = at;
      for (let step = 1; step <= steps; step += 1) {
        const px = from.x + ((x - from.x) * step) / steps;
        const py = from.y + ((y - from.y) * step) / steps;
        await send('touchMove', px, py);
      }
      at = { x, y };
    },
    async moveOnto(locator, steps) {
      const box = await locator.boundingBox();
      if (!box) throw new Error('the drop target is not on screen');
      await touch.moveTo(box.x + box.width / 2, box.y + box.height / 2, steps);
    },
    async end() {
      await send('touchEnd', at.x, at.y);
    },
  };
  return touch;
}
