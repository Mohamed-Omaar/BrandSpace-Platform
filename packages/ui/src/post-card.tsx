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
  testId,
}: {
  readonly post: PostRecord;
  readonly labels: PostCardLabels;
  readonly selected?: boolean;
  readonly actions?: ReactNode;
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
        borderRadius: radiusTokens.xl,
        // Selection is a purple ring, not a permanent outline on every card.
        boxShadow: selected
          ? `0 0 0 2px ${colorTokens.brandPurple}, ${shadowTokens.card}`
          : shadowTokens.card,
        overflow: 'hidden',
        display: 'grid',
        gridTemplateRows: 'auto 1fr auto',
      }}
    >
      <div style={{ position: 'relative', aspectRatio: '4 / 5' }}>
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

      <div style={{ padding: spacingTokens.md, display: 'grid', gap: spacingTokens.xs }}>
        <p
          dir={post.captionDirection}
          style={{
            margin: 0,
            ...typographyTokens.bodySm,
            color: colorTokens.textPrimary,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {post.caption}
        </p>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: spacingTokens.xs,
            ...typographyTokens.caption,
            color: colorTokens.textMuted,
          }}
        >
          <PlatformDots platforms={post.platforms} labels={labels} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {post.accountName}
          </span>
        </div>
      </div>

      <footer
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: spacingTokens.xs,
          paddingInline: spacingTokens.md,
          paddingBlockEnd: spacingTokens.md,
        }}
      >
        <StatusBadge label={labels.statusLabels[post.status]} tone={statusTone(post.status)} dot />
        {post.approval !== 'NOT_REQUIRED' ? (
          <StatusBadge
            label={labels.approvalLabels[post.approval]}
            tone={approvalTone(post.approval)}
          />
        ) : null}
        <span
          style={{
            marginInlineStart: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: spacingTokens['3xs'],
            ...typographyTokens.caption,
            color: colorTokens.textMuted,
          }}
        >
          <CalendarIcon size={13} />
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
  testId,
}: {
  readonly post: PostRecord;
  readonly labels: PostCardLabels;
  readonly selected?: boolean;
  readonly actions?: ReactNode;
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
      <MediaThumb seed={post.mediaSeed} alt={post.mediaAlt} size="1.75rem" />
      <span style={{ minInlineSize: 0, display: 'grid', gap: '1px', flex: 1, textAlign: 'start' }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: spacingTokens['3xs'],
            ...typographyTokens.caption,
            fontWeight: 700,
            color: colorTokens.textPrimary,
          }}
        >
          <PlatformDots platforms={post.platforms} labels={labels} />
          {post.whenLabel}
        </span>
        <span
          dir={post.captionDirection}
          style={{
            ...typographyTokens.caption,
            color: colorTokens.textSecondary,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {post.caption}
        </span>
      </span>
      <span
        aria-hidden="true"
        title={labels.statusLabels[post.status]}
        style={{
          inlineSize: '0.375rem',
          blockSize: '1.5rem',
          borderRadius: radiusTokens.full,
          flexShrink: 0,
          background:
            post.status === 'PUBLISHED'
              ? colorTokens.success
              : post.status === 'FAILED'
                ? colorTokens.danger
                : post.status === 'DRAFT'
                  ? colorTokens.textMuted
                  : colorTokens.brandPurple,
        }}
      />
    </>
  );

  const style = {
    display: 'flex',
    alignItems: 'center',
    gap: spacingTokens.xs,
    inlineSize: '100%',
    padding: spacingTokens.xs,
    borderRadius: radiusTokens.sm,
    background: colorTokens.surfaceSoft,
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
