import { expect, type Page } from '@playwright/test';

/**
 * HORIZONTAL OVERFLOW, measured properly. (F-26)
 *
 * THE OLD ASSERTION, and why it had to go. Every suite here used to compare
 * `document.documentElement.scrollWidth` against `clientWidth`. That number is
 * a proxy for "something sticks out", and it is wrong in both directions:
 *
 *   - FALSE POSITIVES. It counts content parked at negative offsets. Next.js
 *     puts its route announcer at `left: -10px` and the skip link at `-2px`,
 *     so it reports a 10px "overflow" on a page with nothing overflowing —
 *     which is why the tolerance kept creeping up until the assertion stopped
 *     being able to fail for a real reason.
 *   - FALSE NEGATIVES. It sees nothing at all in the direction that matters in
 *     Arabic: content pushed past the LEFT edge in an RTL document produces a
 *     negative offset, not a larger scroll width. The RTL regression this
 *     assertion exists to catch was precisely the one it could not see.
 *
 * WHAT THIS DOES INSTEAD. It walks the rendered DOM and finds the element that
 * extends furthest past the viewport's INLINE-END edge — the right edge in an
 * LTR document, the left edge in an RTL one — skipping two things that are not
 * defects:
 *
 *   - elements with no rendered area (off-screen affordances, the announcer);
 *   - elements clipped by a scrolling ancestor that itself fits, because a wide
 *     table SCROLLING INSIDE ITS OWN BOX is the required behaviour, not a bug.
 *
 * And it returns the offending element alongside the number, so a failure says
 * which component is too wide instead of leaving a bare pixel count to chase.
 */
export interface Overhang {
  readonly px: number;
  readonly offender: string;
}

export async function inlineEndOverhang(page: Page): Promise<Overhang> {
  return page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    const rtl = getComputedStyle(document.documentElement).direction === 'rtl';
    let worst = 0;
    let offender = 'none';

    for (const element of Array.from(document.querySelectorAll('*'))) {
      const box = element.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) continue;

      const overhang = rtl ? -box.left : box.right - viewport;
      if (overhang <= 1 || overhang <= worst) continue;

      // Clipped by a scrolling ancestor that itself fits? Then it is scrolling
      // inside its own box, which is the intended behaviour.
      let ancestor = element.parentElement;
      let clipped = false;
      while (ancestor) {
        // `html` and `body` are NOT legitimate clipping ancestors. A
        // page-level `overflow-x: hidden` hides overflow from the reader
        // instead of fixing it, and treating it as intentional made this
        // measurement return 0 for a planted 900px element — the assertion
        // could no longer fail for the reason it exists.
        if (ancestor === document.body || ancestor === document.documentElement) break;
        const style = getComputedStyle(ancestor);
        if (style.overflowX !== 'visible') {
          const ancestorBox = ancestor.getBoundingClientRect();
          const ancestorOverhang = rtl ? -ancestorBox.left : ancestorBox.right - viewport;
          if (ancestorOverhang <= 1) {
            clipped = true;
            break;
          }
        }
        ancestor = ancestor.parentElement;
      }
      if (clipped) continue;

      worst = overhang;
      const testId = (element as HTMLElement).dataset['testid'] ?? '';
      offender = `${element.tagName}${testId ? `[${testId}]` : ''} w=${Math.round(box.width)}`;
    }

    return { px: Math.round(worst), offender };
  });
}

/** Assert that nothing a reader is meant to see sits past the inline-end edge. */
export async function expectNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const overhang = await inlineEndOverhang(page);
  expect(
    overhang.px,
    `${label}: ${overhang.offender} extends ${overhang.px}px past the inline-end edge`,
  ).toBeLessThanOrEqual(1);
}

/**
 * CLIPPED-AWAY CONTENT, which the measurement above cannot see. (fidelity pass §29)
 *
 * The demo's shell owns its rounded corners with `.app-shell { overflow: hidden }`,
 * and the panel inside it scrolls (`.main-panel { overflow: auto }`). Reproducing
 * that geometry — which §0 requires — hands the page two ancestors that fit the
 * viewport and clip their own content, and `inlineEndOverhang` is defined to
 * treat exactly that as intended behaviour. A component 200px too wide would
 * therefore be silently cut instead of reported.
 *
 * So measure the other half directly: for a container that clips or scrolls its
 * inline axis, `scrollWidth - clientWidth` is the amount of content the reader
 * cannot reach without a scrollbar the layout never promised. Zero is the
 * contract for the shell and the page's main region; a wide table with its OWN
 * scroll container is not covered here, because that one is deliberate.
 */
export async function clippedInlineOverflow(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const element = document.querySelector(sel);
    if (!element) return -1;
    return Math.round(element.scrollWidth - element.clientWidth);
  }, selector);
}

/** Assert that a clipping or scrolling container is not hiding page content. */
export async function expectNothingClippedAway(
  page: Page,
  selector: string,
  label: string,
): Promise<void> {
  const px = await clippedInlineOverflow(page, selector);
  expect(px, `${label}: "${selector}" was not found on the page`).toBeGreaterThanOrEqual(0);
  expect(
    px,
    `${label}: ${selector} hides ${px}px of content past its inline-end edge`,
  ).toBeLessThanOrEqual(1);
}
