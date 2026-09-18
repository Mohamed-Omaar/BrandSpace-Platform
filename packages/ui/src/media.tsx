import type { CSSProperties, ReactNode } from 'react';
import { colorTokens, radiusTokens, spacingTokens, typographyTokens } from './tokens';

/**
 * Deterministic abstract media, drawn in CSS and SVG.
 *
 * WHY THIS EXISTS. A post preview whose media is a grey rectangle tells the
 * owner nothing about how the product will look, and a preview that fetched a
 * stock photograph would make the design system depend on a network, a licence
 * and a third party. These are gradients and shapes built from the brand
 * palette — attractive enough to judge a layout by, obviously not photographs,
 * and identical on every run so a screenshot means the same thing twice.
 *
 * NOTHING HERE IS A REAL ASSET. There is no upload, no storage, no remote
 * fetch, and no fixture pretends to be a customer's photograph.
 *
 * `seed` picks a palette deterministically, so the same post always renders the
 * same artwork and a reviewer can compare two screenshots meaningfully.
 */

export type MediaSeed = 0 | 1 | 2 | 3 | 4 | 5;

interface Palette {
  readonly from: string;
  readonly to: string;
  readonly accent: string;
  readonly ink: string;
}

/**
 * Six palettes, all derived from the approved brand colours.
 *
 * Purple leads; yellow appears as an accent shape rather than as a background,
 * which is the same rule the interface follows.
 */
const PALETTES: readonly Palette[] = [
  { from: '#7935FE', to: '#B08CFF', accent: '#FFDD15', ink: '#FFFFFF' },
  { from: '#5312C4', to: '#7935FE', accent: '#FFE86B', ink: '#FFFFFF' },
  { from: '#F0E9FF', to: '#FFFFFF', accent: '#7935FE', ink: '#2A1A5E' },
  { from: '#FFDD15', to: '#FFF3A8', accent: '#5312C4', ink: '#171528' },
  { from: '#171528', to: '#4A2A8F', accent: '#FFDD15', ink: '#FFFFFF' },
  { from: '#F8F5FF', to: '#E4D8FF', accent: '#7935FE', ink: '#2A1A5E' },
];

export function mediaPalette(seed: MediaSeed): Palette {
  return PALETTES[seed % PALETTES.length]!;
}

/**
 * An abstract artwork tile.
 *
 * `role="img"` with the caller's `alt`, because in a composer the alt text is
 * part of the content being authored — hiding it would hide a field the user is
 * responsible for.
 */
export function AbstractMedia({
  seed = 0,
  alt,
  radius = '0',
  children,
  testId,
}: {
  readonly seed?: MediaSeed;
  /**
   * The artwork's description. An EMPTY string marks it decorative: the element
   * then carries `aria-hidden` and no `img` role at all, because a `role="img"`
   * with an empty label is a control a screen reader announces as nothing
   * (axe's `role-img-alt`).
   */
  readonly alt: string;
  readonly radius?: string;
  /** Overlays: a video badge, a carousel indicator, a draft watermark. */
  readonly children?: ReactNode;
  readonly testId?: string | undefined;
}) {
  const palette = mediaPalette(seed);
  return (
    <div
      {...(alt === '' ? { 'aria-hidden': true } : { role: 'img', 'aria-label': alt })}
      data-testid={testId ?? 'abstract-media'}
      data-media-seed={seed}
      style={{
        position: 'relative',
        inlineSize: '100%',
        blockSize: '100%',
        borderRadius: radius,
        overflow: 'hidden',
        background: `linear-gradient(135deg, ${palette.from} 0%, ${palette.to} 100%)`,
      }}
    >
      {/* Two soft shapes and one accent arc: enough composition to read as
          artwork at thumbnail size, cheap enough to render a hundred times. */}
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="xMidYMid slice"
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0, inlineSize: '100%', blockSize: '100%' }}
      >
        <circle cx="78" cy="22" r="26" fill={palette.accent} opacity="0.22" />
        <circle cx="20" cy="78" r="34" fill={palette.ink} opacity="0.08" />
        <path
          d="M -10 70 Q 30 40 60 62 T 120 52"
          fill="none"
          stroke={palette.accent}
          strokeWidth="3"
          opacity="0.5"
        />
        <rect x="8" y="8" width="18" height="18" rx="6" fill={palette.ink} opacity="0.14" />
      </svg>
      {children}
    </div>
  );
}

/**
 * A REAL asset's bytes, filling the same box `AbstractMedia` fills.
 *
 * PHASE 8. Everything above this line draws artwork in CSS because the design
 * system must not depend on a network, a licence or a third party. A CUSTOMER's
 * media is the opposite case: it is the whole point, and a preview that drew a
 * gradient instead of the picture the author chose would be a preview of
 * nothing.
 *
 * `src` IS AN OPAQUE, EXPIRING DOWNLOAD GRANT issued by the server for this
 * viewer — never a storage key, never a signed URL from a column. The route
 * that redeems it re-checks the session, the workspace and the expiry, so a
 * token that leaks stops working rather than becoming a key to the library.
 *
 * `onError` IS NOT USED, DELIBERATELY. A grant that has expired while a page
 * sat open should show the browser's own broken-image state rather than have
 * this component invent a "media is gone" story it cannot verify; the caller
 * renders `MediaStateOverlay` when it KNOWS the asset is unusable.
 */
export function AssetMedia({
  src,
  alt,
  radius = '0',
  fit = 'cover',
  children,
  testId,
}: {
  readonly src: string;
  /** Empty marks it decorative, exactly as `AbstractMedia` does. */
  readonly alt: string;
  readonly radius?: string;
  readonly fit?: 'cover' | 'contain';
  readonly children?: ReactNode;
  readonly testId?: string | undefined;
}) {
  return (
    <div
      data-testid={testId ?? 'asset-media'}
      style={{
        position: 'relative',
        inlineSize: '100%',
        blockSize: '100%',
        borderRadius: radius,
        overflow: 'hidden',
        // A neutral bed, so a `contain` fit and a transparent PNG both read as
        // deliberate rather than as a rendering fault.
        background: colorTokens.surfaceMuted,
      }}
    >
      {/*
        A PLAIN `<img>`, DELIBERATELY. This package is the design system and has
        no framework dependency; importing a Next.js image component here would
        make `@brandspace/ui` unusable outside that framework and would try to
        optimise a same-origin, short-lived, per-viewer grant — which is not a
        static asset and must not be cached by an optimiser.
      */}
      <img
        src={src}
        alt={alt}
        style={{
          inlineSize: '100%',
          blockSize: '100%',
          objectFit: fit,
          display: 'block',
        }}
      />
      {children}
    </div>
  );
}

/** A small square thumbnail of the same artwork, for lists and calendars. */
export function MediaThumb({
  seed = 0,
  alt,
  size = '2.5rem',
  testId,
}: {
  readonly seed?: MediaSeed;
  readonly alt: string;
  readonly size?: string;
  readonly testId?: string | undefined;
}) {
  return (
    <span
      style={{
        display: 'inline-block',
        inlineSize: size,
        blockSize: size,
        flexShrink: 0,
        borderRadius: radiusTokens.sm,
        overflow: 'hidden',
      }}
    >
      <AbstractMedia seed={seed} alt={alt} testId={testId} />
    </span>
  );
}

/**
 * A small square thumbnail of a REAL asset, for lists, calendars and pickers.
 *
 * The `MediaThumb` above it, with the bytes instead of the gradient.
 */
export function AssetThumb({
  src,
  alt,
  size = '2.5rem',
  testId,
}: {
  readonly src: string;
  readonly alt: string;
  readonly size?: string;
  readonly testId?: string | undefined;
}) {
  return (
    <span
      style={{
        display: 'inline-block',
        inlineSize: size,
        blockSize: size,
        flexShrink: 0,
        borderRadius: radiusTokens.sm,
        overflow: 'hidden',
      }}
    >
      <AssetMedia src={src} alt={alt} testId={testId} />
    </span>
  );
}

/**
 * An avatar.
 *
 * Initials on a deterministic brand tint — never a fetched image, for the same
 * reason as the artwork above.
 */
export function Avatar({
  initials,
  seed = 0,
  size = '2.25rem',
  shape = 'circle',
  testId,
}: {
  readonly initials: string;
  readonly seed?: MediaSeed;
  readonly size?: string;
  /**
   * `.avatar { border-radius: 50% }` in the social preview, and
   * `.record-main .avatar { border-radius: 11px }` in a directory row — the
   * demo uses the same tile squared off in a table and round on a post.
   */
  readonly shape?: 'circle' | 'tile';
  readonly testId?: string | undefined;
}) {
  const palette = mediaPalette(seed);
  return (
    <span
      aria-hidden="true"
      data-testid={testId}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        inlineSize: size,
        blockSize: size,
        flexShrink: 0,
        borderRadius: shape === 'tile' ? radiusTokens.lg : radiusTokens.full,
        background: `linear-gradient(140deg, ${palette.from}, ${palette.to})`,
        color: palette.ink,
        ...typographyTokens.caption,
        fontWeight: 700,
        letterSpacing: '0.02em',
      }}
    >
      {initials}
    </span>
  );
}

/** A translucent chip laid over media: a duration, a carousel count, a state. */
export function MediaChip({
  children,
  placement = 'end-start',
  tone = 'ink',
  testId,
}: {
  readonly children: ReactNode;
  readonly placement?: 'start-start' | 'end-start' | 'start-end' | 'end-end';
  readonly tone?: 'ink' | 'brand';
  readonly testId?: string | undefined;
}) {
  const [block, inline] = placement.split('-') as ['start' | 'end', 'start' | 'end'];
  const position: CSSProperties = {
    position: 'absolute',
    ...(block === 'start'
      ? { insetBlockStart: spacingTokens.sm }
      : { insetBlockEnd: spacingTokens.sm }),
    ...(inline === 'start'
      ? { insetInlineStart: spacingTokens.sm }
      : { insetInlineEnd: spacingTokens.sm }),
  };
  return (
    <span
      data-testid={testId}
      style={{
        ...position,
        display: 'inline-flex',
        alignItems: 'center',
        gap: spacingTokens['3xs'],
        paddingInline: spacingTokens.sm,
        paddingBlock: spacingTokens['2xs'],
        borderRadius: radiusTokens.full,
        background: tone === 'brand' ? colorTokens.brandPurple : 'rgba(23, 21, 40, 0.72)',
        color: colorTokens.textInverse,
        ...typographyTokens.caption,
        fontWeight: 600,
        backdropFilter: 'blur(4px)',
      }}
    >
      {children}
    </span>
  );
}

/**
 * A full-bleed overlay stating that a post is not live.
 *
 * A DRAFT must be unmistakable in a grid of thumbnails, and the word is the
 * signal — the wash only makes it legible.
 */
export function MediaStateOverlay({
  label,
  tone = 'neutral',
  testId,
}: {
  readonly label: string;
  readonly tone?: 'neutral' | 'danger';
  readonly testId?: string | undefined;
}) {
  return (
    <span
      data-testid={testId ?? 'media-state-overlay'}
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: tone === 'danger' ? 'rgba(180, 35, 24, 0.55)' : 'rgba(23, 21, 40, 0.45)',
        color: colorTokens.textInverse,
        ...typographyTokens.label,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
      }}
    >
      {label}
    </span>
  );
}

/**
 * The dot strip under a carousel.
 *
 * Decoration: the count is also stated in text by the caller, because a row of
 * dots is not something a screen reader can usefully count.
 */
export function CarouselDots({
  count,
  active = 0,
}: {
  readonly count: number;
  readonly active?: number;
}) {
  return (
    <span
      aria-hidden="true"
      style={{
        position: 'absolute',
        insetBlockEnd: spacingTokens.sm,
        insetInline: 0,
        display: 'flex',
        justifyContent: 'center',
        gap: spacingTokens['3xs'],
      }}
    >
      {Array.from({ length: count }, (_, index) => (
        <span
          key={index}
          style={{
            inlineSize: '0.3125rem',
            blockSize: '0.3125rem',
            borderRadius: radiusTokens.full,
            background: colorTokens.textInverse,
            opacity: index === active ? 1 : 0.45,
          }}
        />
      ))}
    </span>
  );
}

/**
 * INITIALS FOR AN IDENTITY TILE.
 *
 * An email address is a legitimate identity in this phase — the product does
 * not collect a display name yet — so the local part before the `@` supplies
 * the letters rather than a name being invented for a decorative tile.
 *
 * Lives here, beside `Avatar`, because three call sites had grown their own
 * copy: the customer rail, the Control Center rail and the team directory.
 */
export function initialsFrom(value: string): string {
  const local = value.split('@')[0] ?? value;
  const parts = local.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : local.slice(0, 2);
  return letters.toUpperCase();
}
