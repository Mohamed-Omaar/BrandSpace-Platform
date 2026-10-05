'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * "⋯" — WHERE A PRODUCT CONTROL THE PROTOTYPE DOES NOT DRAW IS KEPT (review of
 * #67, rule 2): the Studio's language, template, goal and other formats, its
 * other AI edits and "Compare previews", Media's "New folder". One floating
 * panel, the glass every "Filters" uses; nothing it holds is lost, and nothing
 * the prototype draws moves for it.
 *
 * A native disclosure (opens without script and from the keyboard); with
 * script it closes on a press outside, on Escape, and when a link or button
 * inside it is followed with `closeOnPick`.
 */
export function MoreDisclosure({
  label,
  chosen = null,
  testId = 'content-more',
  align = 'start',
  closeOnPick = false,
  summary,
  summaryClassName = 'bsp-chip bsp-fdis-chip',
  up = false,
  children,
}: {
  readonly label: string;
  readonly chosen?: string | null;
  readonly testId?: string;
  /** Which side the panel opens from: under the chip's start, or its end. */
  readonly align?: 'start' | 'end';
  readonly closeOnPick?: boolean;
  /**
   * A face other than "⋯" — the prototype's own button for what the panel
   * holds (Team's "+ Invite", Billing's "Change plan"), styled as it draws it.
   */
  readonly summary?: ReactNode;
  readonly summaryClassName?: string;
  /** The panel opens above the face — for a control in a bar at the bottom. */
  readonly up?: boolean;
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
    <details
      ref={ref}
      className="bsp-fdis"
      onClick={(event) => {
        if (!closeOnPick || !ref.current) return;
        const picked = (event.target as HTMLElement).closest('a, button');
        if (picked && !picked.matches('summary, summary *')) ref.current.open = false;
      }}
    >
      {summary !== undefined ? (
        <summary className={summaryClassName} data-testid={testId}>
          {summary}
        </summary>
      ) : (
        <summary className={summaryClassName} aria-label={label} title={label} data-testid={testId}>
          {chosen ? <span>{chosen}</span> : null}
          <span aria-hidden="true">⋯</span>
        </summary>
      )}
      <div
        className={`bsp-fdis-panel${align === 'start' ? ' bsp-fdis-start' : ''}${up ? ' bsp-fdis-up' : ''}`}
      >
        <div className="bsp-fdis-form">{children}</div>
      </div>
    </details>
  );
}
