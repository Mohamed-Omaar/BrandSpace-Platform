/**
 * PR C (owner, 2026-11-14) — THE BRAND'S COLOURS, SUGGESTED FROM ITS LOGO.
 *
 * Pure, so the browser can run it on the logo it already shows (a canvas's
 * pixels) and a test can run it on known pixels. The suggestion is only
 * that: the colours join the palette when the person adds them and saves.
 *
 * Opaque pixels only; near-white is skipped (a logo's background, not its
 * colour). Pixels are grouped into 4-bit-per-channel buckets, buckets closer
 * than a fixed distance are merged, and the largest few are returned, each as
 * the average of its pixels, most present first. A colour under 3% of the
 * logo's visible pixels is noise and is left out.
 */

export const LOGO_COLOURS_MAX = 4;
const MERGE_DISTANCE = 56;
const MIN_SHARE = 0.03;

interface Bucket {
  count: number;
  r: number;
  g: number;
  b: number;
}

const hex = (value: number) => Math.round(value).toString(16).padStart(2, '0').toUpperCase();

export function logoColours(
  rgba: ArrayLike<number>,
  maxColours: number = LOGO_COLOURS_MAX,
): string[] {
  const buckets = new Map<number, Bucket>();
  let visible = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const r = rgba[i]!;
    const g = rgba[i + 1]!;
    const b = rgba[i + 2]!;
    const a = rgba[i + 3]!;
    if (a < 128) continue;
    if (r > 242 && g > 242 && b > 242) continue;
    visible += 1;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bucket.count += 1;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    buckets.set(key, bucket);
  }
  if (visible === 0) return [];
  const sorted = [...buckets.values()].sort((x, y) => y.count - x.count);
  const merged: Bucket[] = [];
  for (const bucket of sorted) {
    const mean = [bucket.r / bucket.count, bucket.g / bucket.count, bucket.b / bucket.count];
    const near = merged.find((other) => {
      const o = [other.r / other.count, other.g / other.count, other.b / other.count];
      return Math.hypot(mean[0]! - o[0]!, mean[1]! - o[1]!, mean[2]! - o[2]!) < MERGE_DISTANCE;
    });
    if (near) {
      near.count += bucket.count;
      near.r += bucket.r;
      near.g += bucket.g;
      near.b += bucket.b;
    } else {
      merged.push({ ...bucket });
    }
  }
  return merged
    .sort((x, y) => y.count - x.count)
    .filter((bucket) => bucket.count / visible >= MIN_SHARE)
    .slice(0, maxColours)
    .map(
      (bucket) =>
        `#${hex(bucket.r / bucket.count)}${hex(bucket.g / bucket.count)}${hex(bucket.b / bucket.count)}`,
    );
}
