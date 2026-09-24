'use client';

import Link from 'next/link';
import { useCallback, useState, type MouseEvent, type ReactNode } from 'react';
import {
  SideSheet,
  StateMessage,
  buttonClass,
  buttonStyle,
  colorTokens,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import type { FeedItem, FeedKind } from '../app/[locale]/notifications/feed';

/**
 * THE BELL OPENS A FEED, NOT A PAGE (Phase 6 final, D-277 §40, D-297).
 *
 * PROGRESSIVE, like the Copilot's control: the top bar's bell is still the
 * LINK to the full Notifications screen. With script, a plain click opens this
 * sheet over the current screen and reads the feed then — not on every page
 * render. A modified click, or no script, follows the link.
 *
 * Three tabs, because volume justifies them: All, Mentions (the Notes that
 * name you), Approvals (reviews waiting on you and outcomes of yours). No tab
 * is added for symmetry. Each row: who, what, the object, when, and a link to
 * the exact place. Unread is a word and an edge, never colour alone.
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

  const intercept = useCallback(
    (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      setOpen(true);
      setFailed(false);
      setItems(null);
      load(locale)
        .then((feed) => setItems(feed.items))
        .catch(() => setFailed(true));
    },
    [load, locale],
  );

  const shown = (items ?? []).filter((item) => tab === 'all' || item.kind === (tab as FeedKind));
  const tabs: readonly { key: Tab; label: string }[] = [
    { key: 'all', label: strings.all },
    { key: 'mention', label: strings.mentions },
    { key: 'approval', label: strings.approvals },
  ];

  return (
    <>
      <span
        onClickCapture={intercept}
        data-testid="notifications-bell-trigger"
        style={{ display: 'contents' }}
      >
        {children}
      </span>
      <SideSheet
        open={open}
        onClose={() => setOpen(false)}
        title={strings.title}
        closeLabel={strings.close}
        testId="notifications-feed"
      >
        <div
          role="tablist"
          aria-label={strings.title}
          style={{ display: 'flex', gap: spacingTokens.xs, flexWrap: 'wrap' }}
        >
          {tabs.map((entry) => (
            <button
              key={entry.key}
              type="button"
              role="tab"
              aria-selected={tab === entry.key}
              className={buttonClass(tab === entry.key ? 'neutral' : 'ghost')}
              style={buttonStyle(tab === entry.key ? 'neutral' : 'ghost', 'sm')}
              data-testid={`notifications-tab-${entry.key}`}
              onClick={() => setTab(entry.key)}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {failed ? (
          <p role="alert" style={{ ...typographyTokens.bodySm, margin: 0 }}>
            {strings.error}
          </p>
        ) : items === null ? (
          <p role="status" style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
            {strings.loading}
          </p>
        ) : shown.length === 0 ? (
          <StateMessage kind="empty" title={strings.emptyTitle} description={strings.emptyBody} />
        ) : (
          <ul
            data-testid="notifications-feed-list"
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'grid',
              gap: spacingTokens.sm,
            }}
          >
            {shown.map((item) => (
              <li
                key={item.id}
                data-testid={`feed-${item.id}`}
                data-kind={item.kind}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '2rem minmax(0, 1fr)',
                  gap: spacingTokens.xs,
                  paddingBlock: spacingTokens.xs,
                  paddingInlineStart: item.unread ? spacingTokens.xs : 0,
                  borderInlineStart: item.unread ? `3px solid ${colorTokens.brandPurple}` : 'none',
                  borderBlockEnd: `1px solid ${colorTokens.border}`,
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    display: 'grid',
                    placeItems: 'center',
                    inlineSize: '2rem',
                    blockSize: '2rem',
                    borderRadius: '9999px',
                    background: colorTokens.surfaceMuted,
                    color: colorTokens.textPrimary,
                    ...typographyTokens.caption,
                    fontWeight: 600,
                  }}
                >
                  {(item.who ?? item.headline).slice(0, 1).toUpperCase()}
                </span>
                <div style={{ display: 'grid', gap: spacingTokens['3xs'], minInlineSize: 0 }}>
                  <strong style={{ ...typographyTokens.bodySm, color: colorTokens.textPrimary }}>
                    {item.headline}
                    {item.unread ? (
                      <span
                        style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}
                      >
                        {' '}
                        · {strings.unread}
                      </span>
                    ) : null}
                  </strong>
                  {item.excerpt ? (
                    <span
                      dir="auto"
                      style={{
                        ...typographyTokens.bodySm,
                        color: colorTokens.textSecondary,
                        overflowWrap: 'anywhere',
                      }}
                    >
                      “{item.excerpt}”
                    </span>
                  ) : null}
                  <span style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
                    {[item.context, item.when].filter(Boolean).join(' · ')}
                  </span>
                  {item.href ? (
                    <Link
                      href={item.href}
                      data-testid={`feed-open-${item.id}`}
                      style={{ ...typographyTokens.caption, justifySelf: 'start' }}
                      onClick={() => setOpen(false)}
                    >
                      {strings.open}
                    </Link>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}

        <Link
          href={href}
          className={buttonClass('ghost')}
          style={{ ...buttonStyle('ghost', 'sm'), justifySelf: 'start' }}
          data-testid="notifications-see-all"
          onClick={() => setOpen(false)}
        >
          {strings.seeAll}
        </Link>
      </SideSheet>
    </>
  );
}
