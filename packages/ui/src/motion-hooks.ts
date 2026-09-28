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
/** How a surface leaves: the animations to run on it; unmount follows the first. */
export type ExitMotion = (element: HTMLElement) => Animation[];

/** MO5: the container fades with a 4 px lift while its rows blur to 4 px (180 ms). */
function menuExit(element: HTMLElement): Animation[] {
  const timing: KeyframeAnimationOptions = {
    duration: motionMs.menuOut,
    easing: EASE_OUT,
    fill: 'forwards',
  };
  return [
    element.animate(
      [
        { opacity: 1, translate: '0 0' },
        { opacity: 0, translate: '0 -4px' },
      ],
      timing,
    ),
    ...Array.from(element.children).map((row) =>
      row.animate([{ filter: 'blur(0)' }, { filter: 'blur(4px)' }], timing),
    ),
  ];
}

export function usePresence(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  exit: ExitMotion = menuExit,
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
    const animations = exit(element);
    const container = animations[0];
    if (!container) {
      setPresent(false);
      return undefined;
    }
    let cancelled = false;
    container.finished
      .then(() => {
        if (!cancelled) setPresent(false);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      for (const animation of animations) animation.cancel();
    };
  }, [open, present, ref, exit]);

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
