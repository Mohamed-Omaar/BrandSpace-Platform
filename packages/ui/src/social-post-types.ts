/**
 * The social preview's TYPES and its platform tables.
 *
 * In a neutral module rather than beside the component, for the same reason as
 * `menu-style.ts`: everything exported from a `'use client'` module becomes a
 * client reference, so a server component cannot read this table. Data and
 * types belong on the shared side of the boundary (F-25).
 */

export type SocialPlatform = 'instagram' | 'facebook' | 'linkedin' | 'x' | 'tiktok';

/**
 * The FORMAT a post takes on a platform.
 *
 * A platform is not one surface: an Instagram feed post, a Story and a Reel
 * are three different compositions with different chrome, aspect ratios and
 * action strips. Modelling only the platform is what made the first preview
 * feel generic.
 */
export type SocialFormat = 'feed' | 'story' | 'reel' | 'video';

export type PostAspect = '1:1' | '4:5' | '16:9' | '9:16';

/**
 * Publishing status.
 *
 * `PUBLISHING` is a real intermediate state a calendar has to show — a post
 * handed to a platform and not yet confirmed — and omitting it would force a
 * screen to show either "scheduled" or "published" for a post that is neither.
 */
export type PostStatus = 'DRAFT' | 'SCHEDULED' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED';

/** Approval, which is independent of publishing status. */
export type ApprovalStatus = 'NOT_REQUIRED' | 'NEEDS_APPROVAL' | 'APPROVED' | 'CHANGES_REQUESTED';

export type PreviewSurface = 'mobile' | 'desktop';

export interface SocialAccountIdentity {
  readonly displayName: string;
  readonly handle: string;
  /** Initials shown in the avatar. No image is fetched by this component. */
  readonly initials: string;
  /** Selects a deterministic brand palette for the avatar. */
  readonly avatarSeed?: 0 | 1 | 2 | 3 | 4 | 5;
}

export type PreviewMedia =
  | {
      readonly kind: 'image';
      readonly alt: string;
      readonly seed?: 0 | 1 | 2 | 3 | 4 | 5;
      /** More than one image makes it a carousel. */
      readonly count?: number;
      /**
       * PHASE 8 — the REAL asset's bytes, as an opaque expiring grant.
       *
       * OPTIONAL, and the two cases are different products rather than two
       * codepaths for one. Absent means the design system's own artwork, which
       * is what the showcase and the visual tests want: deterministic, offline,
       * identical on every run. Present means a customer's actual picture,
       * which is what a composer preview must show — a gradient where the
       * author put a photograph is a preview of nothing (AC-27.4).
       */
      readonly src?: string | undefined;
    }
  | {
      readonly kind: 'video';
      readonly alt: string;
      readonly seed?: 0 | 1 | 2 | 3 | 4 | 5;
      readonly durationLabel?: string | undefined;
      /** A poster frame, when the product has one. See the note above. */
      readonly src?: string | undefined;
    }
  | { readonly kind: 'loading' }
  | { readonly kind: 'missing' };

export interface SocialPostPreviewContent {
  readonly platform: SocialPlatform;
  readonly format?: SocialFormat;
  readonly aspect: PostAspect;
  readonly status: PostStatus;
  readonly approval?: ApprovalStatus;
  readonly account: SocialAccountIdentity;
  readonly caption: string;
  /** Direction of the CAPTION, independent of the interface locale. */
  readonly captionDirection?: 'rtl' | 'ltr';
  /** Rendered as brand-coloured tokens after the caption, never inline links. */
  readonly hashtags?: readonly string[];
  readonly scheduledLabel?: string | undefined;
  readonly media?: PreviewMedia;
}

export interface SocialPostPreviewLabels {
  readonly statusLabels: Record<PostStatus, string>;
  readonly approvalLabels: Record<ApprovalStatus, string>;
  readonly platformNames: Record<SocialPlatform, string>;
  readonly formatNames: Record<SocialFormat, string>;
  readonly showMore: string;
  readonly showLess: string;
  readonly missingMedia: string;
  readonly loadingMedia: string;
  readonly videoBadge: string;
  readonly carouselLabel: (count: number) => string;
  readonly previewNotice: string;
  readonly aspectLabel: (aspect: PostAspect) => string;
  /** The action strip is decorative; these name it for a screen reader. */
  readonly actionsLabel: string;
}

/**
 * Which aspect ratios each platform actually offers.
 *
 * TikTok is vertical only. Offering it a landscape ratio would be a lie about
 * what the platform accepts, and the switcher derives its options from here so
 * the combination cannot be selected.
 */
export const PLATFORM_ASPECTS: Record<SocialPlatform, readonly PostAspect[]> = {
  instagram: ['1:1', '4:5', '9:16'],
  facebook: ['1:1', '4:5', '16:9', '9:16'],
  linkedin: ['1:1', '4:5', '16:9'],
  x: ['1:1', '16:9'],
  tiktok: ['9:16'],
};

/** Which formats each platform offers, in the order a composer should list them. */
export const PLATFORM_FORMATS: Record<SocialPlatform, readonly SocialFormat[]> = {
  instagram: ['feed', 'story', 'reel'],
  facebook: ['feed', 'story'],
  linkedin: ['feed'],
  x: ['feed'],
  tiktok: ['video'],
};

/** The aspect a format forces, where it forces one. */
export const FORMAT_ASPECT: Partial<Record<SocialFormat, PostAspect>> = {
  story: '9:16',
  reel: '9:16',
  video: '9:16',
};

/**
 * Where each platform truncates a caption in its own feed, approximately.
 *
 * Approximate on purpose: the point is to show the author that a caption WILL
 * be cut, not to promise a byte-exact boundary the platform may move.
 */
export const CAPTION_CLAMP: Record<SocialPlatform, number> = {
  instagram: 125,
  facebook: 250,
  linkedin: 210,
  x: 240,
  tiktok: 100,
};

/**
 * A platform's identity colour, used ONLY for a small badge.
 *
 * Not for a themed card: the preview is a BrandSpace surface showing what a
 * post will look like, not an imitation of the platform's own interface.
 */
export const PLATFORM_ACCENT: Record<SocialPlatform, string> = {
  instagram: '#C13584',
  facebook: '#1877F2',
  linkedin: '#0A66C2',
  x: '#0F172A',
  tiktok: '#111827',
};

/** Resolve the format a preview should use when the caller did not choose. */
export function defaultFormat(platform: SocialPlatform): SocialFormat {
  return PLATFORM_FORMATS[platform][0] ?? 'feed';
}

/** The aspect a platform/format pair should render at. */
export function resolveAspect(
  platform: SocialPlatform,
  format: SocialFormat,
  requested: PostAspect,
): PostAspect {
  const forced = FORMAT_ASPECT[format];
  if (forced) return forced;
  const allowed = PLATFORM_ASPECTS[platform];
  return allowed.includes(requested) ? requested : (allowed[0] ?? '1:1');
}
