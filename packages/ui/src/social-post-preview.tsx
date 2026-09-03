'use client';

import { useState, type CSSProperties, type ReactNode } from 'react';
import { colorTokens, radiusTokens, shadowTokens, spacingTokens, typographyTokens } from './tokens';
import { AlertIcon, CalendarIcon, ImageIcon, PlayIcon } from './icons';
import { StatusBadge, statusTone } from './data';
import {
  PLATFORM_ASPECTS,
  type PostAspect,
  type PreviewSurface,
  type SocialPlatform,
  type SocialPostPreviewContent,
  type SocialPostPreviewLabels,
} from './social-post-types';
import { Skeleton } from './feedback';

/**
 * `SocialPostPreview` — the VISUAL CONTRACT for Content Studio, Calendar,
 * Social Media and the AI Copilot.
 *
 * WHAT THIS IS: a faithful sense of how a composed post will read, so an
 * operator can judge a caption length, a crop and a schedule before anything is
 * published. WHAT IT IS NOT: a copy of any platform's interface, and not a
 * connection to one. There is no persistence, no OAuth, no API and no publish
 * button here — those arrive with the phase that owns them, and a preview that
 * implied otherwise would be exactly the "button that claims an unsupported
 * action" the brief forbids.
 *
 * The chrome is deliberately BrandSpace-shaped: a platform is identified by its
 * name and its accent, and the frame is our own. Reproducing a platform's UI
 * pixel-for-pixel is both a trademark problem and a maintenance treadmill.
 *
 * Bilingual by construction: the caption's direction follows the CONTENT, not
 * the interface, because an Arabic post previewed in an English interface must
 * still read right-to-left.
 */

/** Accent per platform, used for a 3px identity mark only — never for text. */
const PLATFORM_ACCENT: Record<SocialPlatform, string> = {
  instagram: '#C13584',
  facebook: '#1877F2',
  linkedin: '#0A66C2',
  x: '#0F172A',
  tiktok: '#111827',
};

const ASPECT_RATIO: Record<PostAspect, string> = {
  '1:1': '1 / 1',
  '4:5': '4 / 5',
  '16:9': '16 / 9',
  '9:16': '9 / 16',
};

/** Where a platform truncates a caption in its own feed, approximately. */
const CAPTION_CLAMP: Record<SocialPlatform, number> = {
  instagram: 125,
  facebook: 250,
  linkedin: 210,
  x: 240,
  tiktok: 100,
};

function MediaFrame({
  content,
  labels,
  surface,
}: {
  readonly content: SocialPostPreviewContent;
  readonly labels: SocialPostPreviewLabels;
  readonly surface: PreviewSurface;
}) {
  const media = content.media ?? { kind: 'missing' as const };
  const frame: CSSProperties = {
    position: 'relative',
    aspectRatio: ASPECT_RATIO[content.aspect],
    // A 9:16 preview must not become taller than the screen on a phone.
    maxBlockSize: surface === 'mobile' ? '26rem' : '30rem',
    inlineSize: '100%',
    background: colorTokens.surfaceSunken,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  };

  if (media.kind === 'loading') {
    return (
      <div style={frame} data-testid="preview-media-loading">
        <Skeleton width="100%" height="100%" radius="0" />
      </div>
    );
  }

  if (media.kind === 'missing') {
    return (
      <div style={frame} data-testid="preview-media-missing">
        <div
          style={{
            display: 'grid',
            justifyItems: 'center',
            gap: spacingTokens.xs,
            color: colorTokens.textSecondary,
            padding: spacingTokens.md,
            textAlign: 'center',
          }}
        >
          <ImageIcon size={28} />
          <span style={{ ...typographyTokens.caption }}>{labels.missingMedia}</span>
        </div>
      </div>
    );
  }

  // A placeholder stands in for the asset: this component NEVER fetches remote
  // media, so a showcase cannot silently depend on the network. The alt text is
  // still surfaced, because writing it is part of composing a post.
  return (
    <div style={frame} data-testid="preview-media">
      <div
        role="img"
        aria-label={media.alt}
        style={{
          inlineSize: '100%',
          blockSize: '100%',
          display: 'grid',
          placeItems: 'center',
          background: `linear-gradient(135deg, ${colorTokens.brandPurpleTint}, ${colorTokens.surfaceMuted})`,
          color: colorTokens.textSecondary,
        }}
      >
        {media.kind === 'video' ? <PlayIcon size={34} /> : <ImageIcon size={30} />}
      </div>
      {media.kind === 'video' ? (
        <span
          data-testid="preview-video-badge"
          style={{
            position: 'absolute',
            insetBlockStart: spacingTokens.sm,
            insetInlineEnd: spacingTokens.sm,
            paddingInline: spacingTokens.xs,
            paddingBlock: spacingTokens['3xs'],
            borderRadius: radiusTokens.sm,
            background: 'rgba(15, 23, 42, 0.78)',
            color: colorTokens.textInverse,
            ...typographyTokens.caption,
            fontWeight: 600,
          }}
        >
          {media.durationLabel ?? labels.videoBadge}
        </span>
      ) : null}
    </div>
  );
}

export function SocialPostPreview({
  content,
  labels,
  surface = 'mobile',
  testId,
}: {
  readonly content: SocialPostPreviewContent;
  readonly labels: SocialPostPreviewLabels;
  readonly surface?: PreviewSurface;
  readonly testId?: string | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const clamp = CAPTION_CLAMP[content.platform];
  const isLong = content.caption.length > clamp;
  const shown =
    expanded || !isLong ? content.caption : `${content.caption.slice(0, clamp).trimEnd()}…`;

  return (
    <article
      data-testid={testId ?? 'social-post-preview'}
      data-platform={content.platform}
      data-aspect={content.aspect}
      data-status={content.status}
      style={{
        inlineSize: '100%',
        maxInlineSize: surface === 'mobile' ? '20rem' : '30rem',
        background: colorTokens.surface,
        border: `1px solid ${colorTokens.cardBorder}`,
        borderRadius: radiusTokens.lg,
        boxShadow: shadowTokens.card,
        overflow: 'hidden',
        display: 'grid',
        gridTemplateRows: 'auto auto 1fr auto',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: spacingTokens.sm,
          padding: spacingTokens.sm,
          paddingInline: spacingTokens.md,
          borderBlockEnd: `1px solid ${colorTokens.cardBorder}`,
          // The platform identity is a 3px mark, not a themed card.
          borderInlineStart: `3px solid ${PLATFORM_ACCENT[content.platform]}`,
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            inlineSize: '2rem',
            blockSize: '2rem',
            flexShrink: 0,
            borderRadius: radiusTokens.full,
            background: colorTokens.brandPurpleTint,
            color: colorTokens.brandPurplePressed,
            ...typographyTokens.caption,
            fontWeight: 700,
          }}
        >
          {content.account.initials}
        </span>
        <span style={{ display: 'grid', minInlineSize: 0 }}>
          <span
            style={{
              ...typographyTokens.label,
              color: colorTokens.textPrimary,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {content.account.displayName}
          </span>
          <span
            style={{
              ...typographyTokens.caption,
              color: colorTokens.textSecondary,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {content.account.handle} · {labels.platformNames[content.platform]}
          </span>
        </span>
        <span style={{ marginInlineStart: 'auto', flexShrink: 0 }}>
          <StatusBadge
            label={labels.statusLabels[content.status]}
            tone={statusTone(content.status)}
            testId={`preview-status-${content.status}`}
          />
        </span>
      </header>

      <MediaFrame content={content} labels={labels} surface={surface} />

      <div style={{ padding: spacingTokens.md, display: 'grid', gap: spacingTokens.sm }}>
        <p
          data-testid="preview-caption"
          // The caption's direction follows the CONTENT. An Arabic caption in an
          // English interface still reads right-to-left, and vice versa —
          // otherwise the preview misrepresents what will be published.
          dir={content.captionDirection}
          style={{
            margin: 0,
            ...typographyTokens.bodySm,
            color: colorTokens.textPrimary,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
          }}
        >
          {shown}
        </p>
        {isLong ? (
          <button
            type="button"
            data-testid="preview-caption-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            style={{
              justifySelf: 'start',
              background: 'transparent',
              border: 0,
              padding: 0,
              minBlockSize: '24px',
              color: colorTokens.brandPurple,
              cursor: 'pointer',
              fontFamily: 'inherit',
              ...typographyTokens.caption,
              fontWeight: 600,
            }}
          >
            {expanded ? labels.showLess : labels.showMore}
          </button>
        ) : null}
      </div>

      <footer
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: spacingTokens.sm,
          padding: spacingTokens.sm,
          paddingInline: spacingTokens.md,
          borderBlockStart: `1px solid ${colorTokens.cardBorder}`,
          background: colorTokens.surfaceMuted,
          ...typographyTokens.caption,
          color: colorTokens.textSecondary,
        }}
      >
        {content.scheduledLabel ? (
          <span
            data-testid="preview-schedule"
            style={{ display: 'inline-flex', alignItems: 'center', gap: spacingTokens.xs }}
          >
            <CalendarIcon size={14} />
            {content.scheduledLabel}
          </span>
        ) : null}
        <span style={{ marginInlineStart: 'auto' }}>{labels.aspectLabel(content.aspect)}</span>
      </footer>
    </article>
  );
}

/**
 * A preview with a platform and aspect switcher around it.
 *
 * The aspect list is derived from `PLATFORM_ASPECTS`, so choosing TikTok cannot
 * leave a landscape ratio selected — the control never offers a combination the
 * platform will not accept.
 */
export function SocialPostPreviewer({
  content,
  labels,
  platforms,
  surface = 'mobile',
  notice,
}: {
  readonly content: SocialPostPreviewContent;
  readonly labels: SocialPostPreviewLabels;
  readonly platforms: readonly SocialPlatform[];
  readonly surface?: PreviewSurface;
  readonly notice?: ReactNode;
}) {
  const [platform, setPlatform] = useState<SocialPlatform>(content.platform);
  const allowed = PLATFORM_ASPECTS[platform];
  const [aspect, setAspect] = useState<PostAspect>(
    allowed.includes(content.aspect) ? content.aspect : allowed[0]!,
  );

  function choosePlatform(next: SocialPlatform) {
    setPlatform(next);
    const options = PLATFORM_ASPECTS[next];
    if (!options.includes(aspect)) setAspect(options[0]!);
  }

  const chipStyle = (selected: boolean): CSSProperties => ({
    minBlockSize: '2rem',
    paddingInline: spacingTokens.sm,
    borderRadius: radiusTokens.full,
    cursor: 'pointer',
    fontFamily: 'inherit',
    ...typographyTokens.caption,
    fontWeight: 600,
    background: selected ? colorTokens.brandPurpleTint : colorTokens.surface,
    color: selected ? colorTokens.brandPurplePressed : colorTokens.textSecondary,
    border: `1px solid ${selected ? colorTokens.brandPurpleBorder : colorTokens.borderStrong}`,
  });

  return (
    <div style={{ display: 'grid', gap: spacingTokens.md, justifyItems: 'start' }}>
      <div
        role="group"
        aria-label={labels.previewNotice}
        style={{ display: 'flex', flexWrap: 'wrap', gap: spacingTokens.xs }}
      >
        {platforms.map((option) => (
          <button
            key={option}
            type="button"
            data-testid={`preview-platform-${option}`}
            aria-pressed={option === platform}
            onClick={() => choosePlatform(option)}
            style={chipStyle(option === platform)}
          >
            {labels.platformNames[option]}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: spacingTokens.xs }}>
        {allowed.map((option) => (
          <button
            key={option}
            type="button"
            data-testid={`preview-aspect-${option}`}
            aria-pressed={option === aspect}
            onClick={() => setAspect(option)}
            style={chipStyle(option === aspect)}
          >
            {labels.aspectLabel(option)}
          </button>
        ))}
      </div>

      <SocialPostPreview
        content={{ ...content, platform, aspect }}
        labels={labels}
        surface={surface}
      />

      {notice ?? (
        <p
          style={{
            margin: 0,
            display: 'flex',
            alignItems: 'center',
            gap: spacingTokens.xs,
            ...typographyTokens.caption,
            color: colorTokens.textSecondary,
          }}
        >
          <AlertIcon size={14} />
          {labels.previewNotice}
        </p>
      )}
    </div>
  );
}
