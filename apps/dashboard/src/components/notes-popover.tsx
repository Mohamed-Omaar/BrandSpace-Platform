'use client';

import Link from 'next/link';
import { useCallback, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useDismissOnOutsidePointer, useOverlayBehaviour, usePresence } from '@brandspace/ui';
import type { NotesPopoverItem } from '../app/[locale]/notes/popover-feed';

/**
 * D-496 (Shell 1, 2) — THE NOTES SQUARE OPENS A POPOVER, NOT A PAGE
 * (`Main.dc.html` L152–161): the prototype's 340px glass card under the
 * square — "Notes" and Close (the prototype's "Dismiss", Fix PR 2c), the two latest notes (a dot, who said what,
 * where), and "All notes" across the foot, which opens the Notes screen.
 *
 * THE BELL'S OWN PATTERN (`notifications-bell.tsx`, D-297) and classes, which
 * draw the same card: the square stays the LINK to Notes. With script, a plain
 * click opens this over the current screen and reads the two notes then; a
 * modified click, or no script, follows the link.
 */
export function NotesPopover({
  locale,
  href,
  children,
  load,
  strings,
}: {
  readonly locale: string;
  readonly href: string;
  readonly children: ReactNode;
  readonly load: (locale: string) => Promise<{ readonly items: readonly NotesPopoverItem[] }>;
  readonly strings: {
    readonly title: string;
    readonly close: string;
    readonly all: string;
    readonly unread: string;
    readonly loading: string;
    readonly empty: string;
    readonly error: string;
  };
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<readonly NotesPopoverItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);

  const overlayId = useOverlayBehaviour({ open, onClose: close, containerRef: panelRef });
  useDismissOnOutsidePointer(wrapRef, open, close, overlayId);
  const { present, leaving } = usePresence(open, panelRef);
  const leavingProps = leaving ? { 'data-leaving': '', 'aria-hidden': true, inert: true } : {};

  const intercept = useCallback(
    (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (open) {
        setOpen(false);
        return;
      }
      setOpen(true);
      setFailed(false);
      setItems(null);
      load(locale)
        .then((feed) => setItems(feed.items))
        .catch(() => setFailed(true));
    },
    [load, locale, open],
  );

  return (
    <span className="bsp-ntf-wrap" ref={wrapRef}>
      <span
        onClickCapture={intercept}
        data-testid="notes-popover-trigger"
        style={{ display: 'contents' }}
      >
        {children}
      </span>
      {present ? (
        <div
          ref={panelRef}
          role="dialog"
          aria-label={strings.title}
          tabIndex={-1}
          className="bs-pop bsp-ntf"
          data-origin="end"
          data-testid="notes-popover"
          {...leavingProps}
        >
          <div className="bsp-ntf-head">
            <span className="bsp-ntf-title">{strings.title}</span>
            <span className="bsp-ntf-headacts">
              <button type="button" className="bsp-btn bsp-sm bsp-ghost" onClick={close}>
                {strings.close}
              </button>
            </span>
          </div>
          {failed ? (
            <p role="alert" className="bsp-ntf-note">
              {strings.error}
            </p>
          ) : items === null ? (
            <p role="status" className="bsp-ntf-note">
              {strings.loading}
            </p>
          ) : items.length === 0 ? (
            <p className="bsp-ntf-note" data-testid="notes-popover-empty">
              {strings.empty}
            </p>
          ) : (
            <ul className="bsp-ntf-list" data-testid="notes-popover-list">
              {items.map((item) => (
                <li
                  key={item.id}
                  className="bsp-ntf-row"
                  data-unread={item.unread ? 'true' : undefined}
                  data-testid={`notes-pop-${item.id}`}
                >
                  <span className="bsp-ntf-dot" aria-hidden="true" />
                  <span className="bsp-ntf-body">
                    <Link
                      href={item.href}
                      className="bsp-ntf-t bsp-ntf-link"
                      dir="auto"
                      onClick={close}
                    >
                      {item.title}
                    </Link>
                    <span className="bsp-ntf-m" dir="auto">
                      {item.unread ? <span className="bs-sr-only">{strings.unread} · </span> : null}
                      {item.meta}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Link href={href} className="bsp-ntf-all" data-testid="notes-popover-all" onClick={close}>
            {strings.all}
          </Link>
        </div>
      ) : null}
    </span>
  );
}
