/**
 * The social preview's TYPES and its platform/aspect table.
 *
 * In a neutral module rather than beside the component, for the same reason as
 * `menu-style.ts`: everything exported from a `'use client'` module becomes a
 * client reference, so a server component cannot read this table. Data and
 * types belong on the shared side of the boundary.
 */

export type SocialPlatform = 'instagram' | 'facebook' | 'linkedin' | 'x' | 'tiktok';
export type PostAspect = '1:1' | '4:5' | '16:9' | '9:16';
export type PostStatus = 'DRAFT' | 'SCHEDULED' | 'PUBLISHED' | 'FAILED';
export type PreviewSurface = 'mobile' | 'desktop';

export interface SocialAccountIdentity {
  readonly displayName: string;
  readonly handle: string;
  /** Initials shown in the avatar. No image is fetched by this component. */
  readonly initials: string;
}

export interface SocialPostPreviewContent {
  readonly platform: SocialPlatform;
  readonly aspect: PostAspect;
  readonly status: PostStatus;
  readonly account: SocialAccountIdentity;
  readonly caption: string;
  /** Direction of the CAPTION, independent of the interface locale. */
  readonly captionDirection?: 'rtl' | 'ltr';
  readonly scheduledLabel?: string | undefined;
  readonly media?:
    | { readonly kind: 'image'; readonly alt: string }
    | { readonly kind: 'video'; readonly alt: string; readonly durationLabel?: string | undefined }
    | { readonly kind: 'loading' }
    | { readonly kind: 'missing' };
}

export interface SocialPostPreviewLabels {
  readonly statusLabels: Record<PostStatus, string>;
  readonly platformNames: Record<SocialPlatform, string>;
  readonly showMore: string;
  readonly showLess: string;
  readonly missingMedia: string;
  readonly loadingMedia: string;
  readonly videoBadge: string;
  readonly previewNotice: string;
  readonly aspectLabel: (aspect: PostAspect) => string;
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
