'use client';

import { useLayoutEffect, useRef, type ReactNode } from 'react';

/**
 * FIX PR 2c (owner review of #77) — THE WORKSPACE LIST NEVER SHOWS A ROW CUT
 * TO AN EMPTY BAR. The list scrolls inside the card (PR D), and its edge cut
 * whichever row it stopped on: a rounded grey sliver with no text sat above
 * the first whole row. The rows snap to the top edge (`scroll-snap`, in the
 * design system's CSS); this holds the list's height to a whole number of rows
 * when it overflows, so the last scroll position also lands on a row and not
 * part-way through one. A list that fits is left alone.
 */
export function WholeRowList({
  className,
  children,
}: {
  readonly className: string;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLUListElement | null>(null);
  useLayoutEffect(() => {
    const list = ref.current;
    if (!list) return undefined;
    const fit = () => {
      list.style.maxBlockSize = '';
      const first = list.firstElementChild;
      if (!first || list.scrollHeight <= list.clientHeight) return;
      const style = getComputedStyle(list);
      const pad = parseFloat(style.paddingBlockStart) + parseFloat(style.paddingBlockEnd);
      const gap = parseFloat(style.rowGap) || 0;
      const pitch = first.getBoundingClientRect().height + gap;
      const rows = Math.max(1, Math.floor((list.clientHeight - pad + gap) / pitch));
      list.style.maxBlockSize = `${rows * pitch - gap + pad}px`;
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  return (
    <ul ref={ref} className={className}>
      {children}
    </ul>
  );
}
