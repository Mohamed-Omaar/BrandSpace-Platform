'use client';

import { useState, type CSSProperties, type ReactNode } from 'react';
import {
  colorTokens,
  layoutTokens,
  radiusTokens,
  shadowTokens,
  spacingTokens,
  typographyTokens,
} from './tokens';
import {
  AlertIcon,
  CalendarIcon,
  ChevronEndIcon,
  ChevronStartIcon,
  ImageIcon,
  PlayIcon,
} from './icons';
import { StatusBadge, statusTone } from './data';
import { Skeleton } from './feedback';
import {
  AbstractMedia,
  AssetMedia,
  Avatar,
  CarouselDots,
  MediaChip,
  MediaStateOverlay,
} from './media';
import {
  CAPTION_CLAMP,
  PLATFORM_ACCENT,
  PLATFORM_ASPECTS,
  PLATFORM_FORMATS,
  defaultFormat,
  resolveAspect,
  type PostAspect,
  type SocialFormat,
  type SocialPlatform,
  type SocialPostPreviewContent,
  type SocialPostPreviewLabels,
} from './social-post-types';

/**
 * `SocialPostPreview` — the visual contract for Content Studio, Calendar,
 * Social Media and the AI Copilot.
 *
 * WHAT THIS IS: a faithful sense of how a composed post will read, so an
 * operator can judge a caption length, a crop, a format and a schedule before
 * anything is published. WHAT IT IS NOT: a copy of any platform's interface,
 * and not a connection to one. No persistence, no OAuth, no platform API, no
 * publish path, and it never fetches remote media.
 *
 * SEVEN VARIANTS, BECAUSE A PLATFORM IS NOT ONE SURFACE. An Instagram feed
 * post, a Story and a Reel differ in chrome, aspect ratio and action strip;
 * modelling only "instagram" is what made the first attempt feel generic. The
 * variants are feed (Instagram / Facebook / LinkedIn / X), story, reel and
 * vertical video (TikTok).
 *
 * FAMILIAR, NOT COPIED. Each variant borrows the COMPOSITION a reader expects —
 * where the avatar sits, whether the caption is above or below the media, that
 * there is an action strip — and renders it in BrandSpace's own shapes,
 * spacing and palette. Reproducing a platform's interface pixel-for-pixel is
 * both a trademark problem and a maintenance treadmill.
 *
 * Bilingual by construction: the caption's direction follows the CONTENT, not
 * the interface, because an Arabic post previewed in an English console must
 * still read right-to-left.
 */

const ASPECT_RATIO: Record<PostAspect, string> = {
  '1:1': '1 / 1',
  '4:5': '4 / 5',
  '16:9': '16 / 9',
  '9:16': '9 / 16',
};

/** A tiny platform mark. A badge, never a theme. */
function PlatformBadge({
  platform,
  labels,
}: {
  readonly platform: SocialPlatform;
  readonly labels: SocialPostPreviewLabels;
}) {
  return (
    <span
      data-testid={`platform-badge-${platform}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: spacingTokens['3xs'],
        paddingInline: spacingTokens.xs,
        paddingBlock: spacingTokens['3xs'],
        borderRadius: radiusTokens.full,
        background: colorTokens.surfaceMuted,
        ...typographyTokens.caption,
        fontWeight: 600,
        color: colorTokens.textSecondary,
        whiteSpace: 'nowrap',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          inlineSize: '0.5rem',
          blockSize: '0.5rem',
          borderRadius: radiusTokens.full,
          background: PLATFORM_ACCENT[platform],
        }}
      />
      {labels.platformNames[platform]}
    </span>
  );
}

/** The decorative action strip every social surface has. */
function ActionStrip({
  variant,
  labels,
}: {
  readonly variant: 'feed' | 'vertical';
  readonly labels: SocialPostPreviewLabels;
}) {
  /*
   * `.social-actions { display:flex; gap:14px; padding:11px; font-size:17px }`
   * with `span:last-child { margin-left:auto }` — four monochrome glyphs, the
   * last one pushed to the trailing edge. The emoji that stood here before
   * rendered in full colour and broke the strip's line, which is the kind of
   * substitution §0 rules out.
   */
  const glyphs = variant === 'feed' ? ['♡', '○', '⌁', '⌑'] : ['♡', '○', '⌁', '⋯'];
  return (
    <div
      aria-label={labels.actionsLabel}
      role="group"
      data-testid="preview-actions"
      style={{
        display: 'flex',
        gap: variant === 'feed' ? '0.875rem' : spacingTokens.sm,
        flexDirection: variant === 'feed' ? 'row' : 'column',
        alignItems: 'center',
        color: variant === 'feed' ? colorTokens.textSecondary : colorTokens.textInverse,
        fontSize: variant === 'feed' ? '1.0625rem' : '1rem',
        lineHeight: 1,
      }}
    >
      {glyphs.map((glyph, index) => (
        <span
          key={glyph}
          aria-hidden="true"
          style={
            variant === 'feed' && index === glyphs.length - 1
              ? { opacity: 0.85, marginInlineStart: 'auto' }
              : { opacity: 0.85 }
          }
        >
          {glyph}
        </span>
      ))}
    </div>
  );
}

function MediaFrame({
  content,
  labels,
  aspect,
  radius = '0',
  children,
}: {
  readonly content: SocialPostPreviewContent;
  readonly labels: SocialPostPreviewLabels;
  readonly aspect: PostAspect;
  readonly radius?: string;
  readonly children?: ReactNode;
}) {
  const media = content.media ?? { kind: 'missing' as const };
  /*
   * PHASE 6 FINAL (D-285) — A CAROUSEL YOU CAN PAGE. The slide being shown is
   * the preview's own state; it resets when the slide list shrinks under it.
   */
  const slides = media.kind === 'image' ? (media.slides ?? []) : [];
  const [slideIndex, setSlideIndex] = useState(0);
  const paged =
    slides.length > 1 &&
    labels.slideLabel !== undefined &&
    labels.previousSlide !== undefined &&
    labels.nextSlide !== undefined;
  const slide = paged ? Math.min(slideIndex, slides.length - 1) : 0;
  const current = paged ? slides[slide] : undefined;
  const frame: CSSProperties = {
    position: 'relative',
    aspectRatio: ASPECT_RATIO[aspect],
    inlineSize: '100%',
    borderRadius: radius,
    overflow: 'hidden',
    background: colorTokens.surfaceSunken,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
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
      <div
        style={{ ...frame, background: colorTokens.surfaceLavender }}
        data-testid="preview-media-missing"
      >
        <div
          style={{
            display: 'grid',
            justifyItems: 'center',
            gap: spacingTokens.xs,
            color: colorTokens.brandPurplePressed,
            padding: spacingTokens.md,
            textAlign: 'center',
          }}
        >
          <ImageIcon size={28} />
          <span style={{ ...typographyTokens.caption, fontWeight: 600 }}>
            {labels.missingMedia}
          </span>
        </div>
        {children}
      </div>
    );
  }

  const carouselCount = media.kind === 'image' ? Math.max(media.count ?? 1, slides.length || 1) : 1;
  const shownSrc = current ? current.src : media.src;
  const shownAlt = current ? current.alt : media.alt;
  const arrow = (side: 'start' | 'end'): CSSProperties => ({
    position: 'absolute',
    insetBlockStart: '50%',
    ...(side === 'start'
      ? { insetInlineStart: spacingTokens.xs }
      : { insetInlineEnd: spacingTokens.xs }),
    transform: 'translateY(-50%)',
    zIndex: 1,
    inlineSize: '1.75rem',
    blockSize: '1.75rem',
    borderRadius: radiusTokens.full,
    border: 'none',
    background: 'rgba(255, 255, 255, 0.9)',
    color: colorTokens.surfaceInk,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  });

  return (
    <div style={frame} data-testid="preview-media">
      {/*
        THE CUSTOMER'S OWN PICTURE WHERE THERE IS ONE, and the design system's
        artwork where there is not. Same frame, same aspect, same overlays.
      */}
      {shownSrc ? (
        <AssetMedia src={shownSrc} alt={shownAlt} testId="preview-media-asset" />
      ) : (
        <AbstractMedia seed={media.seed ?? 0} alt={shownAlt} />
      )}
      {media.kind === 'video' ? (
        <>
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              inlineSize: '3rem',
              blockSize: '3rem',
              borderRadius: radiusTokens.full,
              background: 'rgba(255, 255, 255, 0.9)',
              color: colorTokens.surfaceInk,
            }}
          >
            <PlayIcon size={26} />
          </span>
          <MediaChip placement="start-end" testId="preview-video-badge">
            {media.durationLabel ?? labels.videoBadge}
          </MediaChip>
        </>
      ) : null}
      {carouselCount > 1 ? (
        <>
          <MediaChip placement="start-end" testId="preview-carousel-badge">
            {paged && labels.slideLabel
              ? labels.slideLabel(slide + 1, slides.length)
              : labels.carouselLabel(carouselCount)}
          </MediaChip>
          <CarouselDots count={carouselCount} active={slide} />
        </>
      ) : null}
      {content.status === 'DRAFT' ? (
        <MediaStateOverlay label={labels.statusLabels.DRAFT} testId="preview-draft-overlay" />
      ) : null}
      {content.status === 'FAILED' ? (
        <MediaStateOverlay
          label={labels.statusLabels.FAILED}
          tone="danger"
          testId="preview-failed-overlay"
        />
      ) : null}
      {/* The arrows sit ABOVE the state overlays, so a draft can still be paged. */}
      {paged ? (
        <>
          {/*
            Logical sides: in Arabic the "previous" arrow sits on the right,
            where a right-to-left reader expects the slide before.
          */}
          <button
            type="button"
            aria-label={labels.previousSlide}
            disabled={slide === 0}
            data-testid="preview-slide-previous"
            onClick={() => setSlideIndex(Math.max(0, slide - 1))}
            style={{ ...arrow('start'), opacity: slide === 0 ? 0.4 : 1 }}
          >
            <ChevronStartIcon size={16} />
          </button>
          <button
            type="button"
            aria-label={labels.nextSlide}
            disabled={slide === slides.length - 1}
            data-testid="preview-slide-next"
            onClick={() => setSlideIndex(Math.min(slides.length - 1, slide + 1))}
            style={{ ...arrow('end'), opacity: slide === slides.length - 1 ? 0.4 : 1 }}
          >
            <ChevronEndIcon size={16} />
          </button>
        </>
      ) : null}
      {children}
    </div>
  );
}

function Caption({
  content,
  labels,
  expanded,
  onToggle,
  tone = 'light',
}: {
  readonly content: SocialPostPreviewContent;
  readonly labels: SocialPostPreviewLabels;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly tone?: 'light' | 'onMedia';
}) {
  const clamp = CAPTION_CLAMP[content.platform];
  const isLong = content.caption.length > clamp;
  const shown =
    expanded || !isLong ? content.caption : `${content.caption.slice(0, clamp).trimEnd()}…`;
  const textColor = tone === 'onMedia' ? colorTokens.textInverse : colorTokens.textPrimary;

  return (
    <div style={{ display: 'grid', gap: spacingTokens.xs, minInlineSize: 0 }}>
      <p
        data-testid="preview-caption"
        // The caption's direction follows the CONTENT. An Arabic caption in an
        // English interface still reads right-to-left, and vice versa —
        // otherwise the preview misrepresents what will be published.
        dir={content.captionDirection}
        style={{
          margin: 0,
          /* `.social-caption { font-size: 9px; line-height: 1.5 }`. */
          ...typographyTokens.caption,
          lineHeight: 1.5,
          color: textColor,
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
        }}
      >
        <strong style={{ fontWeight: 700 }}>{content.account.handle}</strong> {shown}
      </p>
      {content.hashtags && content.hashtags.length > 0 ? (
        <p
          data-testid="preview-hashtags"
          dir={content.captionDirection}
          style={{
            margin: 0,
            ...typographyTokens.caption,
            lineHeight: 1.5,
            color: tone === 'onMedia' ? colorTokens.textInverse : colorTokens.brandPurple,
            opacity: tone === 'onMedia' ? 0.9 : 1,
            overflowWrap: 'anywhere',
          }}
        >
          {content.hashtags.map((tag) => `#${tag}`).join(' ')}
        </p>
      ) : null}
      {isLong ? (
        <button
          type="button"
          data-testid="preview-caption-toggle"
          aria-expanded={expanded}
          onClick={onToggle}
          style={{
            justifySelf: 'start',
            background: 'transparent',
            border: 0,
            padding: 0,
            minBlockSize: '24px',
            color: tone === 'onMedia' ? colorTokens.textInverse : colorTokens.brandPurple,
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
  );
}

function StatusRow({
  content,
  labels,
}: {
  readonly content: SocialPostPreviewContent;
  readonly labels: SocialPostPreviewLabels;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: spacingTokens.xs,
        paddingBlock: spacingTokens.xs,
        paddingInline: spacingTokens['3xs'],
        ...typographyTokens.caption,
        color: colorTokens.textSecondary,
      }}
    >
      {/*
        The platform mark moved out of the post's header and into this strip
        (§22). It still names what is being previewed — which a workspace with
        several connected accounts needs — without putting a badge inside a
        composition that has none.
      */}
      <PlatformBadge platform={content.platform} labels={labels} />
      <StatusBadge
        label={labels.statusLabels[content.status]}
        tone={statusTone(content.status)}
        dot
        testId={`preview-status-${content.status}`}
      />
      {content.approval && content.approval !== 'NOT_REQUIRED' ? (
        <StatusBadge
          label={labels.approvalLabels[content.approval]}
          tone={
            content.approval === 'APPROVED'
              ? 'success'
              : content.approval === 'CHANGES_REQUESTED'
                ? 'danger'
                : 'accent'
          }
          testId={`preview-approval-${content.approval}`}
        />
      ) : null}
      {content.scheduledLabel ? (
        <span
          data-testid="preview-schedule"
          style={{ display: 'inline-flex', alignItems: 'center', gap: spacingTokens['3xs'] }}
        >
          <CalendarIcon size={14} />
          {content.scheduledLabel}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The FEED variant: Instagram, Facebook, LinkedIn and X.
 *
 * Header, media, action strip, caption. The three differ in how much text sits
 * above the media — X and LinkedIn lead with it, Instagram follows it — which
 * is the one composition difference a reviewer actually notices.
 */
function FeedPreview({
  content,
  labels,
  aspect,
  expanded,
  onToggle,
}: {
  readonly content: SocialPostPreviewContent;
  readonly labels: SocialPostPreviewLabels;
  readonly aspect: PostAspect;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  const captionLeads = content.platform === 'x' || content.platform === 'linkedin';
  /* `.social-caption { padding: 0 11px 15px }`. */
  const caption = (
    <div
      style={{
        paddingInline: '0.6875rem',
        paddingBlockEnd: captionLeads ? '0.6875rem' : '0.9375rem',
      }}
    >
      <Caption content={content} labels={labels} expanded={expanded} onToggle={onToggle} />
    </div>
  );

  return (
    <>
      {/*
        `.social-preview header { padding:12px; display:grid;
         grid-template-columns:34px 1fr auto; gap:8px; align-items:center }`
        with a 34px round `.avatar`, a 9px name over an 8px handle, and a `•••`
        in the trailing slot. The platform badge that used to sit there is gone
        (§22): the panel around the preview already says which platform is
        selected, and a badge inside the post is not part of the composition.
      */}
      <header
        style={{
          display: 'grid',
          gridTemplateColumns: `${layoutTokens.previewAvatar} minmax(0, 1fr) auto`,
          alignItems: 'center',
          gap: spacingTokens.sm,
          padding: spacingTokens.md,
        }}
      >
        <Avatar
          initials={content.account.initials}
          seed={content.account.avatarSeed ?? 0}
          size={layoutTokens.previewAvatar}
        />
        <span style={{ display: 'grid', minInlineSize: 0 }}>
          <span
            style={{
              ...typographyTokens.caption,
              fontWeight: 700,
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
              ...typographyTokens.micro,
              color: colorTokens.textMuted,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {content.account.handle}
          </span>
        </span>
        <span
          aria-hidden="true"
          style={{ color: colorTokens.textMuted, fontStyle: 'normal', lineHeight: 1 }}
        >
          •••
        </span>
      </header>

      {captionLeads ? caption : null}
      <MediaFrame content={content} labels={labels} aspect={aspect} />
      {/* `.social-actions { padding: 11px }` — the strip's own padding, not a wrapper's. */}
      <div style={{ padding: '0.6875rem' }}>
        <ActionStrip variant="feed" labels={labels} />
      </div>
      {captionLeads ? null : caption}
    </>
  );
}

/**
 * The VERTICAL variant: Story, Reel and TikTok.
 *
 * Full-bleed media with the identity and caption laid OVER it and the actions
 * down the trailing edge — the composition every vertical surface uses, and the
 * one a feed card cannot express.
 */
function VerticalPreview({
  content,
  labels,
  format,
  labelsForFormat,
  expanded,
  onToggle,
}: {
  readonly content: SocialPostPreviewContent;
  readonly labels: SocialPostPreviewLabels;
  readonly format: SocialFormat;
  readonly labelsForFormat: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <div style={{ position: 'relative' }}>
      <MediaFrame content={content} labels={labels} aspect="9:16" radius={radiusTokens.xl}>
        {/* A story's progress bar: the one piece of chrome that says "story"
            rather than "tall post". */}
        {format === 'story' ? (
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              insetBlockStart: spacingTokens.sm,
              insetInline: spacingTokens.sm,
              display: 'flex',
              gap: spacingTokens['3xs'],
            }}
          >
            {[0, 1, 2].map((index) => (
              <span
                key={index}
                style={{
                  flex: 1,
                  blockSize: '2px',
                  borderRadius: radiusTokens.full,
                  background: colorTokens.textInverse,
                  opacity: index === 0 ? 1 : 0.4,
                }}
              />
            ))}
          </span>
        ) : null}

        <div
          style={{
            position: 'absolute',
            insetBlockStart: format === 'story' ? '1.75rem' : spacingTokens.sm,
            insetInline: spacingTokens.sm,
            display: 'flex',
            alignItems: 'center',
            gap: spacingTokens.sm,
          }}
        >
          <Avatar
            initials={content.account.initials}
            seed={content.account.avatarSeed ?? 0}
            size="1.75rem"
          />
          <span
            style={{
              ...typographyTokens.caption,
              fontWeight: 700,
              color: colorTokens.textInverse,
              textShadow: '0 1px 3px rgba(0,0,0,0.45)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {content.account.displayName}
          </span>
          <span
            style={{
              marginInlineStart: 'auto',
              paddingInline: spacingTokens.xs,
              paddingBlock: spacingTokens['3xs'],
              borderRadius: radiusTokens.full,
              background: 'rgba(23, 21, 40, 0.55)',
              color: colorTokens.textInverse,
              ...typographyTokens.caption,
              fontWeight: 600,
            }}
          >
            {labelsForFormat}
          </span>
        </div>

        <div
          style={{
            position: 'absolute',
            insetInlineEnd: spacingTokens.sm,
            insetBlockEnd: '25%',
            textShadow: '0 1px 3px rgba(0,0,0,0.45)',
          }}
        >
          <ActionStrip variant="vertical" labels={labels} />
        </div>

        <div
          style={{
            position: 'absolute',
            insetInline: spacingTokens.sm,
            insetBlockEnd: spacingTokens.sm,
            paddingInlineEnd: '2.5rem',
            // A scrim so the caption stays legible over any artwork.
            background:
              'linear-gradient(to top, rgba(23, 21, 40, 0.78) 0%, rgba(23, 21, 40, 0) 100%)',
            borderRadius: radiusTokens.md,
            padding: spacingTokens.sm,
          }}
        >
          <Caption
            content={content}
            labels={labels}
            expanded={expanded}
            onToggle={onToggle}
            tone="onMedia"
          />
        </div>
      </MediaFrame>
    </div>
  );
}

export function SocialPostPreview({
  content,
  labels,
  head,
  testId,
}: {
  readonly content: SocialPostPreviewContent;
  readonly labels: SocialPostPreviewLabels;
  /**
   * `.preview-head` — the panel's own strip above the post, which in the demo
   * carries the panel's name on one side and a Feed/Story segmented control on
   * the other. Optional: a preview shown on its own has no panel chrome.
   */
  readonly head?: ReactNode;
  readonly testId?: string | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const format = content.format ?? defaultFormat(content.platform);
  const aspect = resolveAspect(content.platform, format, content.aspect);
  const vertical = format === 'story' || format === 'reel' || format === 'video';

  return (
    /*
      THE PANEL, then the post. `.preview-panel { background:
      rgba(255,255,255,.88); border-radius: 22px; overflow: hidden }` around a
      bare `article.social-preview` that carries no chrome of its own.
      340px is the width of the demo's preview column and the width the
      composition was drawn at, so it does not widen on a desktop surface.

      The status, approval and schedule sit BELOW the article rather than
      inside it (§22). They are real workspace state and are not dropped — but
      the demo's post has no status row in it, and a badge inside the post
      misrepresents what will be published.
    */
    <div
      style={{
        display: 'grid',
        gap: spacingTokens.sm,
        justifyItems: 'stretch',
        inlineSize: '100%',
        maxInlineSize: vertical ? '17rem' : layoutTokens.socialPreviewWidth,
      }}
    >
      <div
        style={{
          background: colorTokens.previewPanelAlpha,
          borderRadius: radiusTokens['2xl'],
          boxShadow: shadowTokens.card,
          overflow: 'hidden',
        }}
      >
        {/* `.preview-head { padding: 14px; font-size: 10px; font-weight: 800 }`. */}
        {head ? (
          <div
            data-testid="preview-head"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: spacingTokens.sm,
              padding: '0.875rem',
              ...typographyTokens.button,
              color: colorTokens.textPrimary,
            }}
          >
            {head}
          </div>
        ) : null}
        <article
          data-testid={testId ?? 'social-post-preview'}
          data-platform={content.platform}
          data-format={format}
          data-aspect={aspect}
          data-status={content.status}
        >
          {vertical ? (
            <VerticalPreview
              content={content}
              labels={labels}
              format={format}
              labelsForFormat={labels.formatNames[format]}
              expanded={expanded}
              onToggle={() => setExpanded((value) => !value)}
            />
          ) : (
            <FeedPreview
              content={content}
              labels={labels}
              aspect={aspect}
              expanded={expanded}
              onToggle={() => setExpanded((value) => !value)}
            />
          )}
        </article>
      </div>
      <StatusRow content={content} labels={labels} />
    </div>
  );
}

/**
 * A preview with platform, format and aspect switchers around it.
 *
 * The option lists are derived from the platform tables, so choosing TikTok
 * cannot leave a landscape ratio selected and choosing "Story" cannot leave a
 * square one — the control never offers a combination the platform will not
 * accept.
 */
export function SocialPostPreviewer({
  content,
  labels,
  platforms,
  notice,
}: {
  readonly content: SocialPostPreviewContent;
  readonly labels: SocialPostPreviewLabels;
  readonly platforms: readonly SocialPlatform[];
  readonly notice?: ReactNode;
}) {
  const [platform, setPlatform] = useState<SocialPlatform>(content.platform);
  const [format, setFormat] = useState<SocialFormat>(
    content.format ?? defaultFormat(content.platform),
  );
  const [aspect, setAspect] = useState<PostAspect>(content.aspect);

  function choosePlatform(next: SocialPlatform) {
    setPlatform(next);
    const formats = PLATFORM_FORMATS[next];
    const nextFormat = formats.includes(format) ? format : (formats[0] ?? 'feed');
    setFormat(nextFormat);
    setAspect(resolveAspect(next, nextFormat, aspect));
  }

  function chooseFormat(next: SocialFormat) {
    setFormat(next);
    setAspect(resolveAspect(platform, next, aspect));
  }

  const aspectsForFormat =
    format === 'feed' ? PLATFORM_ASPECTS[platform] : [resolveAspect(platform, format, aspect)];

  const chipStyle = (selected: boolean): CSSProperties => ({
    minBlockSize: '2.25rem',
    paddingInline: spacingTokens.md,
    borderRadius: radiusTokens.full,
    cursor: 'pointer',
    fontFamily: 'inherit',
    ...typographyTokens.caption,
    fontWeight: 600,
    // Filled chips, no outlines (D-54).
    background: selected ? colorTokens.brandPurple : colorTokens.controlSurface,
    color: selected ? colorTokens.brandPurpleInk : colorTokens.textSecondary,
    border: '1px solid transparent',
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
            className="bs-pressable"
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
        {PLATFORM_FORMATS[platform].map((option) => (
          <button
            key={option}
            type="button"
            className="bs-pressable"
            data-testid={`preview-format-${option}`}
            aria-pressed={option === format}
            onClick={() => chooseFormat(option)}
            style={chipStyle(option === format)}
          >
            {labels.formatNames[option]}
          </button>
        ))}
        {aspectsForFormat.map((option) => (
          <button
            key={option}
            type="button"
            className="bs-pressable"
            data-testid={`preview-aspect-${option}`}
            aria-pressed={option === aspect}
            onClick={() => setAspect(option)}
            disabled={format !== 'feed'}
            style={{
              ...chipStyle(option === aspect),
              ...(format !== 'feed' ? { opacity: 0.6, cursor: 'not-allowed' } : {}),
            }}
          >
            {labels.aspectLabel(option)}
          </button>
        ))}
      </div>

      <SocialPostPreview content={{ ...content, platform, format, aspect }} labels={labels} />

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
