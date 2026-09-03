import { describe, expect, it } from 'vitest';
import { scrollContainerStyle, visuallyHiddenStyle } from '@brandspace/ui';

/**
 * The two style helpers that stop a hidden label from scrolling the page.
 *
 * These assertions look pedantic until you know what they are pinning. A
 * screen-reader-only label is `position: absolute`, and an absolutely
 * positioned element whose containing block lies OUTSIDE a scrolling ancestor
 * escapes that ancestor's clip. Inside a wide, horizontally scrolling table the
 * label therefore sat hundreds of pixels past the viewport and extended the
 * DOCUMENT's scroll width: the whole page scrolled sideways on a phone, and the
 * only thing out there was text nobody can see. The end-to-end suite caught it
 * as "/en/members overflows by 65px".
 *
 * `position: relative` on the scroll container is what makes the label's
 * containing block the container itself, so it is clipped with everything else.
 * Losing that one declaration reintroduces the bug silently, which is exactly
 * the kind of thing a fast test should refuse.
 */
describe('visuallyHiddenStyle', () => {
  const style = visuallyHiddenStyle();

  it('takes the element out of flow and clips it to nothing', () => {
    expect(style.position).toBe('absolute');
    expect(style.inlineSize).toBe('1px');
    expect(style.blockSize).toBe('1px');
    expect(style.overflow).toBe('hidden');
  });

  it('uses clip-path, not the deprecated clip property', () => {
    expect(style.clipPath).toBe('inset(50%)');
    expect(Object.keys(style)).not.toContain('clip');
  });

  it('does not let the text reflow into a tall invisible box', () => {
    expect(style.whiteSpace).toBe('nowrap');
  });

  it('contributes no visible box of its own', () => {
    expect(style.padding).toBe(0);
    expect(style.border).toBe(0);
    expect(style.margin).toBe('-1px');
  });
});

describe('scrollContainerStyle', () => {
  const style = scrollContainerStyle();

  it('scrolls wide content inside itself rather than scrolling the page', () => {
    expect(style.overflowX).toBe('auto');
    expect(style.maxInlineSize).toBe('100%');
  });

  it('establishes a containing block, so an absolute descendant is clipped here', () => {
    // THE regression guard. Without this, a visually hidden label inside a wide
    // table pushes the document's scroll width past the viewport.
    expect(style.position).toBe('relative');
  });
});
