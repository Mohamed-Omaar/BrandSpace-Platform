'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';

/**
 * THE ONE `<img>` THE LIBRARY RENDERS (Phase 6 final acceptance, D-306).
 *
 * A grant that no longer resolves — an expired link, a file still being
 * processed, an object the store never received — must not paint the
 * browser's broken-image glyph inside a designed tile. On error the image
 * steps aside and the tile's own neutral bed shows, which reads as "no
 * preview", not as a fault. Nothing else about the image changes.
 */
export function MediaImage({
  src,
  alt,
  style,
  eager = false,
}: {
  readonly src: string;
  readonly alt: string;
  readonly style: CSSProperties;
  /**
   * B1 — an image in the first screenful is fetched at once (it may be the
   * page's largest paint); the rest wait until they near the screen.
   */
  readonly eager?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLImageElement>(null);
  // A server-rendered image can fail before hydration attaches `onError`, so
  // the error is also read from the element itself once it is on the page.
  useEffect(() => {
    const image = ref.current;
    // `decode()` rejects only for an image that cannot be shown — unlike a
    // zero `naturalWidth`, which a valid SVG without dimensions also reports.
    if (image && image.complete) image.decode().catch(() => setFailed(true));
  }, [src]);
  if (failed) return null;
  // B1 (performance): a tile below the fold is fetched when it nears the
  // screen (the first screenful is `eager`), and decoded off the main thread.
  return (
    <img
      ref={ref}
      src={src}
      alt={alt}
      style={style}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}
