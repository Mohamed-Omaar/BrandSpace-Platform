/**
 * These helpers are typed STRUCTURALLY rather than as React `CSSProperties`.
 *
 * `packages/ui` is deliberately framework-free — it holds tokens and rules, not
 * components — so it must not take a dependency on React's types to describe a
 * style object. The literal types below are assignable to `CSSProperties` at
 * every call site, which is what matters, and the package stays portable.
 */
export interface VisuallyHiddenStyle {
  readonly position: 'absolute';
  readonly inlineSize: '1px';
  readonly blockSize: '1px';
  readonly margin: '-1px';
  readonly padding: 0;
  readonly border: 0;
  readonly overflow: 'hidden';
  readonly clipPath: 'inset(50%)';
  readonly whiteSpace: 'nowrap';
}

export interface ScrollContainerStyle {
  readonly overflowX: 'auto';
  readonly maxInlineSize: '100%';
  readonly position: 'relative';
}

/**
 * A label that screen readers announce and sighted users never see.
 *
 * WHY THIS IS A SHARED HELPER AND NOT FOUR COPIES. The obvious spelling —
 * `position: absolute` plus a 1x1 clipped box — has a defect that is invisible
 * until it is measured: an absolutely-positioned element whose containing block
 * is OUTSIDE a scrolling ancestor escapes that ancestor's clip. Inside a wide,
 * horizontally-scrolling table the hidden label therefore sat at the table's
 * true x-position — hundreds of pixels beyond the viewport — and extended the
 * DOCUMENT's scroll width. The page scrolled sideways on a phone, and the only
 * thing out there was a label nobody can see.
 *
 * Two things fix it, and both are needed:
 *
 *   1. this style, used everywhere instead of a hand-rolled copy;
 *   2. `scrollContainerStyle()` on the scrolling wrapper, which establishes a
 *      containing block so an absolutely-positioned descendant is clipped with
 *      everything else.
 *
 * `clip-path: inset(50%)` rather than the deprecated `clip`, and
 * `white-space: nowrap` so the text cannot reflow into a tall invisible box.
 */
export function visuallyHiddenStyle(): VisuallyHiddenStyle {
  return {
    position: 'absolute',
    inlineSize: '1px',
    blockSize: '1px',
    margin: '-1px',
    padding: 0,
    border: 0,
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
  };
}

/**
 * The wrapper that lets wide content (a table, a diagram, a code block) scroll
 * inside itself instead of scrolling the page.
 *
 * `position: relative` is not decoration: it makes this element the containing
 * block for absolutely-positioned descendants, so they are clipped here rather
 * than extending the document. See `visuallyHiddenStyle()`.
 */
export function scrollContainerStyle(): ScrollContainerStyle {
  return { overflowX: 'auto', maxInlineSize: '100%', position: 'relative' };
}
