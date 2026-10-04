'use client';

import Link from 'next/link';
import { useCallback, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import {
  SegmentPill,
  useDismissOnOutsidePointer,
  useOverlayBehaviour,
  usePresence,
} from '@brandspace/ui';
import type { FeedItem, FeedKind } from '../app/[locale]/notifications/feed';
import { markAllNotificationsReadAction } from '../app/[locale]/notifications/actions';
import { MoreDisclosure } from './more-disclosure';

/**
 * THE BELL OPENS A FEED, NOT A PAGE (Phase 6 final, D-277 §40, D-297) — in the
 * prototype's popover (`Main.dc.html` line 162, D-468): a 340px glass card under
 * the bell, its title and Dismiss, one row per notification (a dot, what
 * happened, where and when), and "See all" across the foot.
 *
 * PROGRESSIVE, like the Copilot's control: the top bar's bell is still the LINK
 * to the full Notifications screen. With script, a plain click opens this
 * popover over the current screen and reads the feed then — not on every page
 * render. A modified click, or no script, follows the link.
 *
 * Three tabs (D-297), because volume justifies them: All, Mentions (the Notes
 * that name you), Approvals (reviews waiting on you and outcomes of yours). Each
 * row's title is the link to the exact place, and the whole row answers it.
 * Unread is a word and the purple dot, never colour alone.
 */
type Tab = 'all' | 'mention' | 'approval';

export function NotificationsBell({
  locale,
  href,
  children,
  load,
  strings,
}: {
  readonly locale: string;
  readonly href: string;
  readonly children: ReactNode;
  readonly load: (locale: string) => Promise<{ readonly items: readonly FeedItem[] }>;
  readonly strings: {
    readonly title: string;
    readonly close: string;
    /** Review of #67 — the prototype's footer and the "⋯" holding the filters. */
    readonly markAll: string;
    readonly more: string;
    readonly all: string;
    readonly mentions: string;
    readonly approvals: string;
    readonly seeAll: string;
    readonly open: string;
    readonly unread: string;
    readonly loading: string;
    readonly emptyTitle: string;
    readonly emptyBody: string;
    readonly error: string;
  };
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('all');
  const [items, setItems] = useState<readonly FeedItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);

  // Escape, focus in and back out, and the one overlay stack (C8).
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

  const shown = (items ?? []).filter((item) => tab === 'all' || item.kind === (tab as FeedKind));
  const tabs: readonly { key: Tab; label: string }[] = [
    { key: 'all', label: strings.all },
    { key: 'mention', label: strings.mentions },
    { key: 'approval', label: strings.approvals },
  ];

  return (
    <span className="bsp-ntf-wrap" ref={wrapRef}>
      <span
        onClickCapture={intercept}
        data-testid="notifications-bell-trigger"
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
          data-testid="notifications-feed"
          {...leavingProps}
        >
          {/*
            Review of #67 — the prototype's head: the title and "Dismiss". The
            product's kind filters and "See all", which it does not draw, are
            under the "⋯" between them.
          */}
          <div className="bsp-ntf-head">
            <span>{strings.title}</span>
            <span className="bsp-ntf-headacts">
              <MoreDisclosure
                label={strings.more}
                testId="notifications-more"
                align="end"
                closeOnPick
              >
                <div className="bsp-seg bsp-ntf-tabs" role="tablist" aria-label={strings.title}>
                  {/* MO4: the chosen tab's pill slides between tabs. */}
                  <SegmentPill selector='[aria-selected="true"]' />
                  {tabs.map((entry) => (
                    <button
                      key={entry.key}
                      type="button"
                      role="tab"
                      className="bsp-seg-item"
                      aria-selected={tab === entry.key}
                      data-testid={`notifications-tab-${entry.key}`}
                      onClick={() => setTab(entry.key)}
                    >
                      {entry.label}
                    </button>
                  ))}
                </div>
                <Link
                  href={href}
                  className="bsp-ntf-seeall"
                  data-testid="notifications-see-all"
                  onClick={close}
                >
                  {strings.seeAll}
                </Link>
              </MoreDisclosure>
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
          ) : shown.length === 0 ? (
            <div className="bsp-ntf-empty">
              <b>{strings.emptyTitle}</b>
              <span>{strings.emptyBody}</span>
            </div>
          ) : (
            <ul className="bsp-ntf-list" data-testid="notifications-feed-list">
              {shown.map((item) => (
                <li
                  key={item.id}
                  className="bsp-ntf-row"
                  data-unread={item.unread ? 'true' : undefined}
                  data-testid={`feed-${item.id}`}
                  data-kind={item.kind}
                >
                  <span className="bsp-ntf-dot" aria-hidden="true" />
                  <span className="bsp-ntf-body">
                    {item.href ? (
                      <Link
                        href={item.href}
                        className="bsp-ntf-t bsp-ntf-link"
                        data-testid={`feed-open-${item.id}`}
                        onClick={close}
                      >
                        {item.headline}
                      </Link>
                    ) : (
                      <span className="bsp-ntf-t">{item.headline}</span>
                    )}
                    {item.excerpt ? (
                      <span dir="auto" className="bsp-ntf-x">
                        “{item.excerpt}”
                      </span>
                    ) : null}
                    {/* Review of #67 — unread is the row's dot and tint, as drawn;
                        the word stays for assistive technology. */}
                    <span className="bsp-ntf-m">
                      {item.unread ? <span className="bs-sr-only">{strings.unread} · </span> : null}
                      {[item.context, item.when].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {/* "Mark all as read" — the product's existing action, as the prototype's footer. */}
          <form action={markAllNotificationsReadAction}>
            <input type="hidden" name="locale" value={locale} />
            <button type="submit" className="bsp-ntf-all" data-testid="notifications-mark-all">
              {strings.markAll}
            </button>
          </form>
        </div>
      ) : null}
    </span>
  );
}
