import type { ReactNode } from 'react';
import { colorTokens, radiusTokens, shadowTokens, spacingTokens, typographyTokens } from './tokens';
import { AbstractMedia, MediaChip, MediaStateOverlay, MediaThumb } from './media';
import { StatusBadge, statusTone } from './data';
import { CalendarIcon } from './icons';
import type { ApprovalStatus, PostStatus, SocialPlatform } from './social-post-types';
import { PLATFORM_ACCENT } from './social-post-types';

/**
 * A post, as it appears in the Content Library and on the Calendar.
 *
 * A POLISHED CONTENT CARD, NOT A DATABASE ROW. The media leads, the caption is
 * an excerpt rather than a field, and the states a social team actually cares
 * about — publishing status and approval status, which are independent — are
 * both visible without opening anything.
 *
 * Performance figures are DELIBERATELY ABSENT. Analytics ingestion is a later
 * phase; a card showing "0 impressions" would be a measurement the product has
 * not taken. Where a caller wants to reserve the space, `performanceLabel`
 * renders an explicitly labelled unavailable slot instead.
 */

export interface PostCardLabels {
  readonly statusLabels: Record<PostStatus, string>;
  readonly approvalLabels: Record<ApprovalStatus, string>;
  readonly platformNames: Record<SocialPlatform, string>;
  readonly selectLabel: string;
  /**
   * "Open post details" — the accessible name of the openable region.
   *
   * Required so a card is never a nameless button: the caption is appended to
   * it, so a screen-reader user hears which post they are opening rather than
   * eight identical "Open post details" in a row.
   */
  readonly openLabel: string;
}

export interface PostRecord {
  readonly id: string;
  readonly caption: string;
  readonly captionDirection?: 'rtl' | 'ltr';
  readonly platforms: readonly SocialPlatform[];
  readonly accountName: string;
  readonly status: PostStatus;
  readonly approval: ApprovalStatus;
  readonly whenLabel: string;
  readonly mediaSeed: 0 | 1 | 2 | 3 | 4 | 5;
  readonly mediaAlt: string;
  readonly mediaCount?: number;
  readonly isVideo?: boolean;
}

/**
 * The invisible button that makes a post card openable.
 *
 * WHY NOT WRAP THE WHOLE CARD. A card carries its own controls — a select
 * button, an actions menu — and a button inside a button is invalid markup that
 * browsers repair unpredictably and screen readers announce twice. So the
 * OPENABLE REGION is the media and the caption, which is what a reader would
 * click anyway, and the footer's controls stay siblings of it.
 *
 * A real `<button>`, not a click handler on a div: it is in the tab order, it
 * responds to Enter and Space, and it takes the focus ring for free.
 */
function OpenRegion({
  onOpen,
  label,
  caption,
  testId,
  inline = false,
  children,
}: {
  readonly onOpen?: (() => void) | undefined;
  readonly label: string;
  readonly caption: string;
  readonly testId: string;
  /** A row lays its region out inline; a card stacks it. */
  readonly inline?: boolean;
  readonly children: ReactNode;
}) {
  // No destination, no button. A control that looks interactive and does
  // nothing is worse than a plain card — §20 forbids exactly that.
  if (!onOpen) return <>{children}</>;

  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onOpen}
      // The caption is part of the name, so eight cards do not all announce
      // themselves as "Open post details".
      aria-label={`${label}: ${caption}`}
      style={{
        display: inline ? 'flex' : 'grid',
        alignItems: inline ? 'center' : undefined,
        gap: inline ? spacingTokens.md : undefined,
        inlineSize: '100%',
        minInlineSize: 0,
        flex: inline ? '1 1 auto' : undefined,
        padding: 0,
        border: 0,
        background: 'transparent',
        textAlign: 'start',
        font: 'inherit',
        color: 'inherit',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

function PlatformDots({
  platforms,
  labels,
}: {
  readonly platforms: readonly SocialPlatform[];
  readonly labels: PostCardLabels;
}) {
  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: spacingTokens['3xs'] }}
      aria-label={platforms.map((p) => labels.platformNames[p]).join(', ')}
      role="img"
    >
      {platforms.map((platform) => (
        <span
          key={platform}
          aria-hidden="true"
          style={{
            inlineSize: '0.5rem',
            blockSize: '0.5rem',
            borderRadius: radiusTokens.full,
            background: PLATFORM_ACCENT[platform],
          }}
        />
      ))}
    </span>
  );
}

function approvalTone(approval: ApprovalStatus) {
  return approval === 'APPROVED'
    ? ('success' as const)
    : approval === 'CHANGES_REQUESTED'
      ? ('danger' as const)
      : ('accent' as const);
}

/** The grid view: media-led, the shape a content team scans. */
export function PostGridCard({
  post,
  labels,
  selected = false,
  actions,
  onOpen,
  testId,
}: {
  readonly post: PostRecord;
  readonly labels: PostCardLabels;
  readonly selected?: boolean;
  readonly actions?: ReactNode;
  /** Opens the post's details. Supplied wherever the post has a destination. */
  readonly onOpen?: (() => void) | undefined;
  readonly testId?: string | undefined;
}) {
  return (
    <article
      data-testid={testId ?? `post-card-${post.id}`}
      data-post-status={post.status}
      aria-selected={selected || undefined}
      className="bs-liftable"
      style={{
        background: colorTokens.surface,
        /* `.post-card { border-radius: 19px }`. */
        borderRadius: radiusTokens['2xl'],
        // Selection is a purple ring, not a permanent outline on every card.
        boxShadow: selected
          ? `0 0 0 2px ${colorTokens.brandPurple}, ${shadowTokens.card}`
          : shadowTokens.card,
        overflow: 'hidden',
        display: 'grid',
        gridTemplateRows: 'auto 1fr auto',
      }}
    >
      <OpenRegion
        onOpen={onOpen}
        label={labels.openLabel}
        caption={post.caption}
        testId={`open-post-${post.id}`}
      >
        {/* `.post-art { aspect-ratio: 1 }` — SQUARE. A 4:5 frame made a row of
            four cards a third taller than the demo's and changed the page's
            whole rhythm. */}
        <div style={{ position: 'relative', aspectRatio: '1 / 1' }}>
          <AbstractMedia seed={post.mediaSeed} alt={post.mediaAlt} />
          {post.isVideo ? <MediaChip placement="start-end">▶</MediaChip> : null}
          {post.mediaCount && post.mediaCount > 1 ? (
            <MediaChip placement="start-end">{`1/${post.mediaCount}`}</MediaChip>
          ) : null}
          {post.status === 'DRAFT' ? <MediaStateOverlay label={labels.statusLabels.DRAFT} /> : null}
          {post.status === 'FAILED' ? (
            <MediaStateOverlay label={labels.statusLabels.FAILED} tone="danger" />
          ) : null}
        </div>

        {/*
          `.post-info { padding: 13px }` with `b { font-size: 10px }` over
          `small { font-size: 8px; color: var(--muted); margin-top: 4px }` —
          one line of title, one line of channel and date. Two clamped lines of
          11px caption made every card a different height.
        */}
        <div style={{ padding: '0.8125rem', display: 'grid', gap: spacingTokens['3xs'] }}>
          <p
            dir={post.captionDirection}
            style={{
              margin: 0,
              ...typographyTokens.button,
              fontWeight: 700,
              color: colorTokens.textPrimary,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {post.caption}
          </p>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: spacingTokens['3xs'],
              ...typographyTokens.micro,
              color: colorTokens.textMuted,
              overflow: 'hidden',
              whiteSpace: 'nowrap',
            }}
          >
            <PlatformDots platforms={post.platforms} labels={labels} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{post.accountName}</span>
          </div>
        </div>
      </OpenRegion>

      <footer
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: spacingTokens['3xs'],
          paddingInline: '0.8125rem',
          paddingBlockEnd: '0.8125rem',
        }}
      >
        {/*
          `.post-info .status { display: inline-block; margin-top: 10px }` — the
          demo's card carries ONE pill. The approval pill and the date joined it
          here and wrapped the footer onto a second row on every other card.
          Both are real state, so they move to where they read better: the
          date onto the meta line's tooltip-free `title`, and approval onto the
          list row and the detail drawer, which have room for it.
        */}
        <StatusBadge label={labels.statusLabels[post.status]} tone={statusTone(post.status)} dot />
        <span
          style={{
            marginInlineStart: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: spacingTokens['3xs'],
            ...typographyTokens.micro,
            color: colorTokens.textMuted,
          }}
        >
          <CalendarIcon size={11} />
          {post.whenLabel}
        </span>
        {actions}
      </footer>
    </article>
  );
}

/** The list view: denser, still a content card rather than a table row. */
export function PostListRow({
  post,
  labels,
  selected = false,
  actions,
  onOpen,
  testId,
}: {
  readonly post: PostRecord;
  readonly labels: PostCardLabels;
  readonly selected?: boolean;
  readonly actions?: ReactNode;
  readonly onOpen?: (() => void) | undefined;
  readonly testId?: string | undefined;
}) {
  return (
    <article
      data-testid={testId ?? `post-row-${post.id}`}
      data-post-status={post.status}
      aria-selected={selected || undefined}
      className="bs-row"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: spacingTokens.md,
        padding: spacingTokens.sm,
        paddingInline: spacingTokens.md,
        borderRadius: radiusTokens.lg,
        background: selected ? colorTokens.surfaceLavender : colorTokens.surface,
      }}
    >
      <OpenRegion
        onOpen={onOpen}
        label={labels.openLabel}
        caption={post.caption}
        testId={`open-post-${post.id}`}
        inline
      >
        <MediaThumb seed={post.mediaSeed} alt={post.mediaAlt} size="3rem" />
        <div style={{ minInlineSize: 0, flex: 1, display: 'grid', gap: spacingTokens['3xs'] }}>
          <p
            dir={post.captionDirection}
            style={{
              margin: 0,
              ...typographyTokens.bodySm,
              color: colorTokens.textPrimary,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {post.caption}
          </p>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: spacingTokens.xs,
              ...typographyTokens.caption,
              color: colorTokens.textMuted,
            }}
          >
            <PlatformDots platforms={post.platforms} labels={labels} />
            {post.accountName} · {post.whenLabel}
          </span>
        </div>
      </OpenRegion>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: spacingTokens.xs,
          flexShrink: 0,
          flexWrap: 'wrap',
        }}
      >
        <StatusBadge label={labels.statusLabels[post.status]} tone={statusTone(post.status)} dot />
        {post.approval !== 'NOT_REQUIRED' ? (
          <StatusBadge
            label={labels.approvalLabels[post.approval]}
            tone={approvalTone(post.approval)}
          />
        ) : null}
        {actions}
      </div>
    </article>
  );
}

/**
 * The compact card a calendar cell holds.
 *
 * Everything a planner needs at a glance and nothing more: a thumbnail, the
 * platform, the time, a caption fragment, and both states.
 */
export function CalendarPostChip({
  post,
  labels,
  onOpen,
  testId,
}: {
  readonly post: PostRecord;
  readonly labels: PostCardLabels;
  readonly onOpen?: (() => void) | undefined;
  readonly testId?: string | undefined;
}) {
  const body = (
    <>
      <MediaThumb seed={post.mediaSeed} alt={post.mediaAlt} size="1.875rem" />
      {/*
        THE TITLE LEADS. `.calendar-post b { font-size: 8px }` carries the post,
        `.calendar-post small { font-size: 7px; color: var(--muted) }` carries
        the channel and the time — in that order. It was inverted here: the
        timestamp was bold on the first line and the post itself was the quiet
        second, which made a month of chips read as a list of times.

        The trailing status bar is gone with it. The demo's chip has no such
        element, and a 6px colour bar is status expressed by colour alone
        (WCAG 1.4.1) — the status belongs in the row's text, which is where
        `whenLabel` already puts it for a draft, and on the post's own card.
      */}
      <span style={{ minInlineSize: 0, display: 'grid', gap: '1px', flex: 1, textAlign: 'start' }}>
        <span
          dir={post.captionDirection}
          style={{
            ...typographyTokens.micro,
            fontWeight: 700,
            color: colorTokens.textPrimary,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {post.caption}
        </span>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: spacingTokens['3xs'],
            ...typographyTokens.micro,
            color: colorTokens.textMuted,
            overflow: 'hidden',
            whiteSpace: 'nowrap',
          }}
        >
          <PlatformDots platforms={post.platforms} labels={labels} />
          {post.whenLabel}
        </span>
      </span>
    </>
  );

  const style = {
    /*
     * `.calendar-post { margin-top: 8px; padding: 7px; border-radius: 11px;
     *  background: var(--soft); gap: 7px }` with `.calendar-post .thumb
     *  { width: 30px; height: 30px; border-radius: 8px }`.
     */
    display: 'flex',
    alignItems: 'center',
    gap: '0.4375rem',
    inlineSize: '100%',
    marginBlockStart: spacingTokens.sm,
    padding: '0.4375rem',
    borderRadius: radiusTokens.lg,
    background: colorTokens.surfaceMuted,
    border: '1px solid transparent',
    cursor: onOpen ? 'pointer' : 'default',
    fontFamily: 'inherit',
    textAlign: 'start' as const,
  };

  // The accessible name states the post's status in words, because the coloured
  // bar beside it is decoration (WCAG 1.4.1).
  const name = `${post.whenLabel} · ${post.caption} · ${labels.statusLabels[post.status]}`;

  return onOpen ? (
    <button
      type="button"
      className="bs-row"
      data-testid={testId ?? `calendar-post-${post.id}`}
      data-post-status={post.status}
      aria-label={name}
      onClick={onOpen}
      style={style}
    >
      {body}
    </button>
  ) : (
    <div
      data-testid={testId ?? `calendar-post-${post.id}`}
      data-post-status={post.status}
      aria-label={name}
      role="group"
      style={style}
    >
      {body}
    </div>
  );
}
