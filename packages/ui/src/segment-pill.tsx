'use client';

import { useLayoutEffect, useRef } from 'react';
import { prefersReducedMotion } from './motion';
import { motionMs } from './tokens';

/**
 * MO4 (Phase 2B-2b) — THE SLIDING PILL INSIDE A SEGMENTED CONTROL: the same
 * idea as the rail's pill (MO2), over 380 ms, in LinkTabs, the calendar's view
 * switcher, the notification tabs and the composer's Feed/Story switch.
 *
 * ONLY §8.0's PROPERTIES. The owner's width/height exception belongs to MO2's
 * pill alone, and the brief forbids carrying it to another component. So this
 * pill never changes size: a full-size layer is CLIPPED to the selected
 * segment with `clip-path: inset(… round r)`, and the clip is what slides.
 * Its shadow is a static `drop-shadow` on a wrapper, so the clip does not cut
 * it off.
 *
 * IT LOOKS EXACTLY LIKE THE CONTROL'S OWN SELECTED STATE, because it is
 * copied from it: before the pill is placed the selected segment still paints
 * its own background (the first paint, and without script), and on placement
 * the pill takes that segment's computed background, radius and shadow. Only
 * then does the container stop the segment painting its own
 * (`[data-seg='placed']` in tokens.css). No new colour, radius or shadow.
 *
 * Drop it in as the control's FIRST CHILD; `selector` names the selected
 * segment among its siblings.
 */
export function SegmentPill({ selector }: { readonly selector: string }) {
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const clipRef = useRef<HTMLSpanElement | null>(null);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const clip = clipRef.current;
    const box = wrap?.parentElement;
    if (!wrap || !clip || !box) return undefined;
    if (getComputedStyle(box).position === 'static') box.style.position = 'relative';

    let current: Element | null = null;
    let radius = '0px';

    const place = (mayGlide: boolean) => {
      const selected = Array.from(box.children).find(
        (child) => child !== wrap && child.matches(selector),
      ) as HTMLElement | undefined;
      if (!selected) {
        box.removeAttribute('data-seg');
        current = null;
        return;
      }
      if (!box.hasAttribute('data-seg')) {
        // The segment still paints its own selected look: copy it.
        const look = getComputedStyle(selected);
        clip.style.backgroundColor = look.backgroundColor;
        radius = look.borderRadius || '0px';
        wrap.style.filter = dropShadow(look.boxShadow);
      }
      const outer = box.getBoundingClientRect();
      const inner = selected.getBoundingClientRect();
      const top = inner.top - outer.top - box.clientTop;
      const left = inner.left - outer.left - box.clientLeft;
      const right = box.clientWidth - left - inner.width;
      const bottom = box.clientHeight - top - inner.height;
      const glide = mayGlide && current !== null && current !== selected && !prefersReducedMotion();
      clip.style.transition = glide ? `clip-path ${motionMs.seg}ms var(--bs-ease-out)` : 'none';
      clip.style.clipPath = `inset(${top}px ${right}px ${bottom}px ${left}px round ${radius})`;
      current = selected;
      box.setAttribute('data-seg', 'placed');
    };

    place(false);
    // A new selection glides; a resize (a wrap, a window) re-measures in place.
    const onSelection = new MutationObserver(() => place(true));
    onSelection.observe(box, {
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-current', 'aria-pressed', 'aria-selected'],
    });
    const onResize = new ResizeObserver(() => place(false));
    onResize.observe(box);
    return () => {
      onSelection.disconnect();
      onResize.disconnect();
    };
  }, [selector]);

  return (
    <span ref={wrapRef} aria-hidden="true" className="bs-seg-pill" data-testid="seg-pill">
      <span ref={clipRef} className="bs-seg-pill-fill" />
    </span>
  );
}

/** `box-shadow` → the same shadows as `drop-shadow()`s (a pill has no inset or spread). */
function dropShadow(boxShadow: string): string {
  if (!boxShadow || boxShadow === 'none') return 'none';
  const shadows = boxShadow.split(/,(?![^(]*\))/).map((shadow) => shadow.trim());
  const parts = shadows.flatMap((shadow) => {
    if (/\binset\b/.test(shadow)) return [];
    const colour = shadow.match(/rgba?\([^)]*\)|#[0-9a-f]{3,8}/i)?.[0] ?? '';
    const lengths = shadow.replace(colour, '').trim().split(/\s+/).slice(0, 3);
    return [`drop-shadow(${lengths.join(' ')} ${colour})`.trim()];
  });
  return parts.length > 0 ? parts.join(' ') : 'none';
}
