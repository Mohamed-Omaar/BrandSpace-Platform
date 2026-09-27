'use client';

import { useLayoutEffect, useRef } from 'react';
import { easeOutCubic, formatCount, parseCount } from './count-up-format';
import { prefersReducedMotion } from './motion';
import { motionMs } from './tokens';

/**
 * MO12 (Phase 2B-2b) — A KPI COUNTS UP FROM 0 ONCE, ON PAGE ENTRY (650 ms,
 * ease-out cubic), in its own format, and ENDS ON THE EXACT SERVER VALUE.
 *
 * The element's text never changes: it is the server's string throughout, so
 * assistive technology, the layout's width and anything reading the page get
 * the real figure. The counting copy is drawn over it (`::after` from
 * `data-display`, tokens.css) and removed when it reaches the end. Reduced
 * motion, text with no number, zero and zero-padded labels do not count.
 */
export function CountUp({ value }: { readonly value: string }) {
  const ref = useRef<HTMLSpanElement | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    const format = parseCount(value);
    if (!element || !format || prefersReducedMotion()) return undefined;
    const stop = () => {
      element.removeAttribute('data-counting');
      element.removeAttribute('data-display');
    };
    const started = performance.now();
    element.setAttribute('data-display', formatCount(format, 0));
    element.setAttribute('data-counting', '');
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - started) / motionMs.count);
      if (progress >= 1) {
        stop();
        return;
      }
      element.setAttribute(
        'data-display',
        formatCount(format, format.target * easeOutCubic(progress)),
      );
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      stop();
    };
  }, [value]);

  return (
    <span ref={ref} className="bs-count" data-testid="count-up">
      <span className="bs-count-final">{value}</span>
    </span>
  );
}
