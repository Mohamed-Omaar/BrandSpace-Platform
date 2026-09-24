'use client';

import {
  PLATFORM_FORMATS,
  SocialPostPreview,
  spacingTokens,
  type PostAspect,
  type PreviewMedia,
  type SocialPlatform,
  type SocialPostPreviewLabels,
} from '@brandspace/ui';
import { durationLabel } from '../../../../server/composer-editor';

/**
 * LIVE SOCIAL PREVIEWS, FED BY REAL CONTENT (AC-27.4).
 *
 * THE COMPONENT ALREADY EXISTED. `SocialPostPreview` is an approved, ported
 * demo component that has shipped in `packages/ui` since Phase 2C and has been
 * visible only in the design-system showcase, fed by fixtures. Phase 8 hands it
 * the variant the author is actually writing — no redesign, no second preview.
 *
 * IT IS AN APPROXIMATION AND SAYS SO. The panel carries a notice; the point is
 * to show the author that a caption WILL be clipped, that their picture is
 * portrait where the platform wants square, that TikTok takes one video and not
 * a carousel. Claiming pixel fidelity with a platform we do not control would
 * be a promise this product cannot keep.
 *
 * A PLATFORM THE PREVIEW DOES NOT KNOW RENDERS NOTHING, rather than rendering
 * as something else. The configured platform list is an operator's fact and can
 * grow (CLAUDE.md §2.2); guessing that an unknown key looks like Instagram
 * would put a made-up frame in front of real content.
 */

const KNOWN: Readonly<Record<string, SocialPlatform>> = {
  instagram: 'instagram',
  facebook: 'facebook',
  linkedin: 'linkedin',
  x: 'x',
  tiktok: 'tiktok',
};

/** The platform this preview can draw, or null when it cannot draw one. */
export function previewPlatform(platformKey: string): SocialPlatform | null {
  return KNOWN[platformKey] ?? null;
}

export interface VariantPreviewMedia {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly previewToken: string | null;
  readonly durationMs?: number | null;
}

export function VariantPreview({
  locale,
  platformKey,
  format,
  body,
  hashtags,
  media,
  cover = null,
  accountName,
  accountHandle,
  status,
  approval,
  labels,
  testId,
}: {
  readonly locale: string;
  readonly platformKey: string;
  /**
   * PHASE 6 FINAL (§22) — the composition the post is drawn in. A Reel is a
   * 9:16 frame with an action rail, not a feed post with a video in it.
   * Absent means the platform's own default.
   */
  readonly format?: 'feed' | 'story' | 'reel' | 'video';
  readonly body: string;
  readonly hashtags: readonly string[];
  /** In the author's order. The first item is the cover. */
  readonly media: readonly VariantPreviewMedia[];
  /** PHASE 6 FINAL (D-285) — a Reel's or video's chosen cover image. */
  readonly cover?: VariantPreviewMedia | null;
  readonly accountName: string;
  readonly accountHandle: string;
  readonly status: 'DRAFT' | 'SCHEDULED' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED';
  readonly approval: 'NOT_REQUIRED' | 'NEEDS_APPROVAL' | 'APPROVED' | 'CHANGES_REQUESTED';
  readonly labels: SocialPostPreviewLabels;
  readonly testId?: string;
}) {
  const platform = previewPlatform(platformKey);
  if (!platform) return null;

  /*
   * THE CAPTION'S DIRECTION IS THE CAPTION'S, not the interface's. An Arabic
   * post previewed by an English-speaking reviewer must still read right to
   * left, because that is how it will be published.
   */
  const captionDirection = /[؀-ۿ]/.test(body) ? 'rtl' : 'ltr';

  const first = media[0];
  const srcOf = (item: VariantPreviewMedia) =>
    item.previewToken ? `/${locale}/assets/file/${item.previewToken}` : undefined;
  /*
   * A VIDEO SHOWS ITS COVER where one is chosen (D-285) — the frame a viewer
   * sees before pressing play. A CAROUSEL carries every slide, in order, so the
   * preview can be paged.
   */
  const poster = cover ? srcOf(cover) : undefined;
  const previewMedia: PreviewMedia = !first
    ? { kind: 'missing' }
    : first.kind === 'VIDEO'
      ? {
          kind: 'video',
          alt: first.name,
          ...(durationLabel(first.durationMs)
            ? { durationLabel: durationLabel(first.durationMs) ?? '' }
            : {}),
          ...(poster ? { src: poster } : srcOf(first) ? { src: srcOf(first) } : {}),
        }
      : {
          kind: 'image',
          alt: first.name,
          count: media.length,
          ...(srcOf(first) ? { src: srcOf(first) } : {}),
          ...(media.length > 1
            ? {
                slides: media.map((item) => ({
                  alt: item.name,
                  ...(srcOf(item) ? { src: srcOf(item) } : {}),
                })),
              }
            : {}),
        };

  return (
    <div style={{ display: 'grid', gap: spacingTokens.sm }} data-testid={testId}>
      <SocialPostPreview
        content={{
          platform,
          ...(format ? { format: drawableFormat(platform, format) } : {}),
          // `resolveAspect` inside the component forces a story/reel to 9:16 and
          // falls back to the platform's first allowed ratio, so a square
          // request on TikTok cannot render as a square.
          aspect: '1:1' as PostAspect,
          status,
          approval,
          account: {
            displayName: accountName,
            handle: accountHandle,
            initials: initialsOf(accountName),
          },
          caption: body,
          captionDirection,
          hashtags,
          media: previewMedia,
        }}
        labels={labels}
      />
    </div>
  );
}

/**
 * The format this platform's preview can DRAW. A reel on TikTok is its vertical
 * video; a vertical format a platform has no frame for falls back to that
 * platform's own vertical frame when it has one, and to its feed otherwise.
 */
function drawableFormat(
  platform: SocialPlatform,
  format: 'feed' | 'story' | 'reel' | 'video',
): 'feed' | 'story' | 'reel' | 'video' {
  const formats = PLATFORM_FORMATS[platform];
  const nearest = {
    feed: ['feed'],
    reel: ['reel', 'video', 'story'],
    video: ['video', 'reel', 'story'],
    story: ['story', 'reel', 'video'],
  } as const;
  return nearest[format].find((option) => formats.includes(option)) ?? formats[0] ?? 'feed';
}

function initialsOf(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const second = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return `${first}${second}`.toUpperCase();
}

/** The preview's labels, built from the composer's own dictionary. */
export function previewLabels(t: Record<string, string>): SocialPostPreviewLabels {
  return {
    statusLabels: {
      DRAFT: t['content.status.DRAFT'] ?? 'Draft',
      SCHEDULED: t['content.status.SCHEDULED'] ?? 'Scheduled',
      PUBLISHING: t['content.status.PUBLISHING'] ?? 'Publishing',
      PUBLISHED: t['content.status.PUBLISHED'] ?? 'Published',
      PARTIALLY_PUBLISHED: t['content.status.PARTIALLY_PUBLISHED'] ?? 'Partially published',
      FAILED: t['content.status.FAILED'] ?? 'Failed',
    },
    approvalLabels: {
      NOT_REQUIRED: t['content.status.DRAFT'] ?? '',
      NEEDS_APPROVAL: t['content.status.IN_REVIEW'] ?? '',
      APPROVED: t['content.status.APPROVED'] ?? '',
      CHANGES_REQUESTED: t['content.status.CHANGES_REQUESTED'] ?? '',
    },
    platformNames: {
      instagram: t['content.platform.instagram'] ?? 'Instagram',
      facebook: t['content.platform.facebook'] ?? 'Facebook',
      linkedin: t['content.platform.linkedin'] ?? 'LinkedIn',
      x: t['content.platform.x'] ?? 'X',
      tiktok: t['content.platform.tiktok'] ?? 'TikTok',
    },
    formatNames: {
      feed: t['content.format.feed'] ?? 'Feed',
      story: t['content.format.story'] ?? 'Story',
      reel: t['content.format.reel'] ?? 'Reel',
      video: t['content.format.video'] ?? 'Video',
    },
    showMore: t['content.preview.showMore'] ?? 'more',
    showLess: t['content.preview.showLess'] ?? 'less',
    missingMedia: t['content.preview.missingMedia'] ?? '',
    loadingMedia: t['content.preview.loadingMedia'] ?? '',
    videoBadge: t['content.media.video'] ?? '',
    carouselLabel: (count) =>
      (t['content.preview.carousel'] ?? '{count}').replace('{count}', String(count)),
    slideLabel: (index, count) =>
      (t['editor.preview.slide'] ?? '{index}/{count}')
        .replace('{index}', String(index))
        .replace('{count}', String(count)),
    previousSlide: t['editor.preview.previousSlide'] ?? '',
    nextSlide: t['editor.preview.nextSlide'] ?? '',
    previewNotice: t['content.preview.notice'] ?? '',
    aspectLabel: (aspect) =>
      (t['content.preview.aspect'] ?? '{aspect}').replace('{aspect}', aspect),
    actionsLabel: t['content.preview.actions'] ?? '',
  };
}

/**
 * The same preview for a SERVER page (the approvals review): it takes the plain
 * dictionary and builds the label functions here, on the client side of the
 * boundary, because functions cannot cross it.
 */
export function DictionaryVariantPreview({
  dictionary,
  ...props
}: Omit<Parameters<typeof VariantPreview>[0], 'labels'> & {
  readonly dictionary: Record<string, string>;
}) {
  return <VariantPreview {...props} labels={previewLabels(dictionary)} />;
}
