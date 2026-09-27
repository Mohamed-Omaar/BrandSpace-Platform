'use client';

import { useEffect, useState, type RefObject } from 'react';
import { EASE_OUT, prefersReducedMotion } from './motion';
import { motionMs } from './tokens';

/**
 * MO5 — A SURFACE THAT LEAVES BEFORE IT UNMOUNTS.
 *
 * The CLOSE happens at once — `open` is already false, the overlay stack has
 * let it go and focus has gone back — and only its picture stays for §8's
 * 180 ms: the container fades with a 4 px lift while its rows blur to 4 px.
 * While it leaves it is `leaving`: callers mark it inert and hidden from
 * assistive technology, so nothing can be done to a surface that is gone.
 * Reduced motion, or a browser without the API, unmounts at once.
 */
export function usePresence(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
): { readonly present: boolean; readonly leaving: boolean } {
  const [present, setPresent] = useState(open);
  if (open && !present) setPresent(true);

  useEffect(() => {
    if (open || !present) return undefined;
    const element = ref.current;
    if (!element || prefersReducedMotion() || typeof element.animate !== 'function') {
      setPresent(false);
      return undefined;
    }
    const timing: KeyframeAnimationOptions = {
      duration: motionMs.menuOut,
      easing: EASE_OUT,
      fill: 'forwards',
    };
    const container = element.animate(
      [
        { opacity: 1, translate: '0 0' },
        { opacity: 0, translate: '0 -4px' },
      ],
      timing,
    );
    const rows = Array.from(element.children).map((row) =>
      row.animate([{ filter: 'blur(0)' }, { filter: 'blur(4px)' }], timing),
    );
    let cancelled = false;
    container.finished
      .then(() => {
        if (!cancelled) setPresent(false);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      container.cancel();
      for (const row of rows) row.cancel();
    };
  }, [open, present, ref]);

  return { present: open || present, leaving: !open && present };
}

/**
 * MO5 — TRUE FOR THE MOMENT A LIST OPENS. A listbox that filters as you type
 * inserts new rows on every keystroke; its rows enter in order when it OPENS,
 * not again on each letter, so its `bs-pop` class is held only this long.
 */
export function useOpening(open: boolean): boolean {
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    setOpening(true);
    const settle = motionMs.menuIn + motionMs.menuRowStep * 5 + motionMs.menuRow;
    const timer = window.setTimeout(() => setOpening(false), settle);
    return () => window.clearTimeout(timer);
  }, [open]);
  return open && opening;
}
