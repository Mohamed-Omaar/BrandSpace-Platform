'use client';

import {
  SocialPostPreview,
  spacingTokens,
  type PostAspect,
  type PreviewMedia,
  type SocialPlatform,
  type SocialPostPreviewLabels,
} from '@brandspace/ui';

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
}

export function VariantPreview({
  locale,
  platformKey,
  body,
  hashtags,
  media,
  accountName,
  accountHandle,
  status,
  approval,
  labels,
  testId,
}: {
  readonly locale: string;
  readonly platformKey: string;
  readonly body: string;
  readonly hashtags: readonly string[];
  /** In the author's order. The first item is the cover. */
  readonly media: readonly VariantPreviewMedia[];
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
  const previewMedia: PreviewMedia = !first
    ? { kind: 'missing' }
    : first.kind === 'VIDEO'
      ? {
          kind: 'video',
          alt: first.name,
          ...(first.previewToken ? { src: `/${locale}/assets/file/${first.previewToken}` } : {}),
        }
      : {
          kind: 'image',
          alt: first.name,
          count: media.length,
          ...(first.previewToken ? { src: `/${locale}/assets/file/${first.previewToken}` } : {}),
        };

  return (
    <div style={{ display: 'grid', gap: spacingTokens.sm }} data-testid={testId}>
      <SocialPostPreview
        content={{
          platform,
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
    previewNotice: t['content.preview.notice'] ?? '',
    aspectLabel: (aspect) =>
      (t['content.preview.aspect'] ?? '{aspect}').replace('{aspect}', aspect),
    actionsLabel: t['content.preview.actions'] ?? '',
  };
}
