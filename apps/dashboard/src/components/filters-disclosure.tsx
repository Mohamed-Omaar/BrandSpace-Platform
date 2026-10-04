'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * "FILTERS" — WHERE A SCREEN'S EXTRA CONTROLS LIVE (D-468 review of #67).
 *
 * The prototype's screens carry only the controls it draws; the product has
 * more (search, brand, campaign, format, language, an exact status, the list
 * view…). None of them is deleted: they sit behind this one chip, in a panel
 * that floats over the screen, so nothing the prototype draws is pushed down.
 *
 * A native disclosure, so it opens without script and from the keyboard as it
 * is. With script it also closes on a press outside it and on Escape (focus
 * returns to the chip). `active` is how many filters are applied, shown on the
 * chip so a filtered view always says so.
 */
export function FiltersDisclosure({
  label,
  active,
  testId,
  wide = false,
  align = 'end',
  children,
}: {
  readonly label: string;
  readonly active: number;
  readonly testId: string;
  /** A panel for more than a column of fields (Media's views and facets). */
  readonly wide?: boolean;
  /** Which side of the chip the panel opens from. */
  readonly align?: 'start' | 'end';
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement | null>(null);
  useEffect(() => {
    const close = (event: Event) => {
      const panel = ref.current;
      if (!panel?.open) return;
      if (event instanceof KeyboardEvent) {
        if (event.key !== 'Escape') return;
        panel.open = false;
        panel.querySelector('summary')?.focus();
        return;
      }
      if (!panel.contains(event.target as Node)) panel.open = false;
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, []);
  return (
    <details ref={ref} className="bsp-fdis">
      <summary className="bsp-chip bsp-fdis-chip" data-testid={testId}>
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M4 6h16M7 12h10M10 18h4" />
        </svg>
        {label}
        {active > 0 ? <span className="bsp-fdis-count bsp-ltr">{active}</span> : null}
      </summary>
      <div
        className={`bsp-fdis-panel${wide ? ' bsp-fdis-wide' : ''}${align === 'start' ? ' bsp-fdis-start' : ''}`}
      >
        {children}
      </div>
    </details>
  );
}
