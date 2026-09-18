'use client';

import { useRef, type ReactNode } from 'react';

import {
  colorTokens,
  layoutTokens,
  radiusTokens,
  shadowTokens,
  spacingTokens,
  typographyTokens,
  zIndexTokens,
} from './tokens';
import { AbstractMedia, AssetMedia } from './media';
import { StatusBadge, statusTone } from './data';
import { IconButton } from './primitives';
import { CloseIcon } from './icons';
import { useOverlayBehaviour } from './overlays';
import type { PostCardLabels, PostRecord } from './post-card';

export interface PostDetailLabels {
  readonly title: string;
  readonly close: string;
  readonly account: string;
  readonly platforms: string;
  readonly schedule: string;
  readonly status: string;
  readonly approval: string;
}

/**
 * THE POST DETAILS PANEL (§9, D-59).
 *
 * The reference's `.post-drawer`: a floating rounded panel inset from the
 * window on all four sides, over a soft scrim, holding the artwork, the
 * caption, a definition list of the post's facts, and the two actions that
 * lead somewhere — open it in the library, or edit it in the composer.
 *
 * WHY A DRAWER AND NOT A ROUTE. In this phase a post is prototype data, not a
 * row: there is no `Post` model, so there is no `/posts/:id` to navigate to and
 * inventing one would be a URL that 404s the moment anyone shares it. A drawer
 * is the honest shape for a detail view whose subject lives only on the screen
 * that opened it, and it is also what the reference does.
 *
 * WHAT MAKES IT USABLE WITHOUT A MOUSE. `useOverlayBehaviour` — the same hook
 * the dialog and the navigation drawer use, so the three cannot drift apart:
 * focus moves in when it opens, is trapped while it is open, Escape closes it
 * from anywhere inside, and focus returns to the card that opened it. A detail
 * panel that strands the keyboard behind it is not a detail panel.
 */
export function PostDetailDrawer({
  post,
  labels,
  postLabels,
  actions,
  onClose,
  testId = 'post-detail-drawer',
}: {
  /** `null` closes it. The caller owns which post is open. */
  readonly post: PostRecord | null;
  readonly labels: PostDetailLabels;
  readonly postLabels: PostCardLabels;
  /** Where this post can be taken next. Never decorative. */
  readonly actions?: ReactNode;
  readonly onClose: () => void;
  readonly testId?: string | undefined;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  useOverlayBehaviour({ open: post !== null, onClose, containerRef: panelRef });

  if (!post) return null;

  const rows: ReadonlyArray<readonly [string, ReactNode]> = [
    [labels.account, post.accountName],
    [labels.platforms, post.platforms.map((p) => postLabels.platformNames[p]).join(' · ')],
    [labels.schedule, post.whenLabel],
    [
      labels.status,
      <StatusBadge
        key="status"
        label={postLabels.statusLabels[post.status]}
        tone={statusTone(post.status)}
        dot
      />,
    ],
    ...(post.approval === 'NOT_REQUIRED'
      ? []
      : ([[labels.approval, postLabels.approvalLabels[post.approval]]] as const)),
  ];

  return (
    <div
      data-testid={`${testId}-scrim`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: zIndexTokens.drawer,
        background: 'rgba(12, 12, 14, 0.25)',
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={labels.title}
        data-testid={testId}
        data-post-id={post.id}
        tabIndex={-1}
        style={{
          position: 'fixed',
          insetBlock: layoutTokens.shellInset,
          insetInlineEnd: layoutTokens.shellInset,
          /*
            `.side-drawer { width: min(430px, calc(100vw - 40px)); padding: 22px;
             background: rgba(255,255,255,.96); backdrop-filter: blur(24px);
             border-radius: 28px; box-shadow: 0 30px 80px rgba(0,0,0,.2) }`.
            It was 300px — the Copilot panel's width — which is a different
            component with a different job.
          */
          inlineSize: `min(${layoutTokens.drawerWidth}, calc(100vw - ${layoutTokens.shellInset} * 2))`,
          zIndex: zIndexTokens.overlay,
          padding: '1.375rem',
          overflowY: 'auto',
          background: colorTokens.drawerAlpha,
          backdropFilter: 'blur(24px)',
          borderRadius: radiusTokens['3xl'],
          boxShadow: shadowTokens.drawer,
          display: 'grid',
          gap: spacingTokens.md,
          alignContent: 'start',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: spacingTokens.sm,
          }}
        >
          <span style={{ ...typographyTokens.overline, color: colorTokens.textMuted }}>
            {labels.title}
          </span>
          <IconButton
            label={labels.close}
            icon={<CloseIcon size={18} />}
            onClick={onClose}
            variant="neutral"
            size="sm"
            data-testid={`${testId}-close`}
          />
        </div>

        <div
          style={{
            position: 'relative',
            aspectRatio: '1 / 1',
            borderRadius: radiusTokens.xl,
            overflow: 'hidden',
          }}
        >
          {/* The post's own picture when it has one; the abstract tile when it
              does not — the same rule every other post surface follows. */}
          {post.mediaSrc ? (
            <AssetMedia src={post.mediaSrc} alt={post.mediaAlt} />
          ) : (
            <AbstractMedia seed={post.mediaSeed} alt={post.mediaAlt} />
          )}
        </div>

        <p
          dir={post.captionDirection}
          style={{ margin: 0, ...typographyTokens.body, color: colorTokens.textPrimary }}
        >
          {post.caption}
        </p>

        <dl style={{ margin: 0, display: 'grid', gap: 0 }}>
          {rows.map(([term, value], index) => (
            <div
              key={term}
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: spacingTokens.sm,
                paddingBlock: spacingTokens.sm,
                // A hairline BETWEEN rows only — the one place a line is doing
                // real work rather than drawing a box (§8).
                borderBlockStart: index === 0 ? 'none' : `1px solid ${colorTokens.hairline}`,
              }}
            >
              <dt style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>{term}</dt>
              <dd
                style={{
                  margin: 0,
                  ...typographyTokens.bodySm,
                  fontWeight: 600,
                  color: colorTokens.textPrimary,
                  textAlign: 'end',
                }}
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>

        {actions ? (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: spacingTokens.sm,
            }}
          >
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}
