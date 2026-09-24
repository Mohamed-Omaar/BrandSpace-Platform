'use client';

import { useState, type CSSProperties } from 'react';

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
}: {
  readonly src: string;
  readonly alt: string;
  readonly style: CSSProperties;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return <img src={src} alt={alt} style={style} onError={() => setFailed(true)} />;
}
