/**
 * PR A (item 6) — THE SIZE AN IMAGE MODEL IS ASKED FOR.
 *
 * KNOWN BUG: the Studio's formats (1080×1080, 1080×1350, 1080×1920, 1200×675)
 * were sent to the provider as they are. OpenAI's GPT image models accept
 * either a fixed list (1024×1024, 1536×1024, 1024×1536) or, for gpt-image-2,
 * custom sizes whose edges are multiples of 16 within published bounds — so
 * every Studio request was refused as INVALID_REQUEST.
 *
 * The rule (owner, 2026-11-01): request the size the model ACCEPTS with the
 * Studio's ASPECT RATIO, and do not crop. What a model accepts is
 * configuration (`ai.models[].imageSizing`), never assumed here.
 *
 * Sources: OpenAI, "Image generation" guide (sizes, the gpt-image-2 custom-size
 * rules: multiples of 16, max edge 3840, aspect at most 3:1, 655,360 to
 * 8,294,400 pixels) — https://developers.openai.com/api/docs/guides/image-generation
 * — and the Create image reference —
 * https://developers.openai.com/api/reference/resources/images/methods/generate
 */

export type ImageSizing =
  | { readonly mode: 'fixed'; readonly sizes: readonly string[] }
  | {
      readonly mode: 'custom';
      readonly multipleOf: number;
      readonly minPixels: number;
      readonly maxPixels: number;
      readonly maxEdge: number;
      readonly maxAspectRatio: number;
    };

/** What a model accepts when the catalogue says nothing: the standard GPT image sizes. */
export const DEFAULT_IMAGE_SIZING: ImageSizing = {
  mode: 'fixed',
  sizes: ['1024x1024', '1536x1024', '1024x1536'],
};

interface Dimensions {
  readonly width: number;
  readonly height: number;
}

export function parseImageSize(size: string): Dimensions | null {
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(size);
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function orientation(d: Dimensions): 'square' | 'portrait' | 'landscape' {
  if (d.width === d.height) return 'square';
  return d.width < d.height ? 'portrait' : 'landscape';
}

/**
 * The size to send for a requested one. Pure and deterministic.
 *
 * FIXED: the accepted size with the same orientation whose aspect ratio is
 * closest to the requested one (a square request gets a square).
 *
 * CUSTOM: the smallest size with EXACTLY the requested aspect ratio whose edges
 * are multiples of `multipleOf`, at least as large as the request, inside the
 * pixel and edge bounds (4:5 at 1080×1350 → 1088×1360). If no exact-aspect
 * size fits, each edge is rounded to the nearest multiple and clamped.
 */
export function resolveImageSize(requested: string, sizing: ImageSizing): string {
  const want = parseImageSize(requested);
  if (!want) return requested;

  if (sizing.mode === 'fixed') {
    const candidates = sizing.sizes
      .map((size) => ({ size, d: parseImageSize(size) }))
      .filter((c): c is { size: string; d: Dimensions } => c.d !== null);
    if (candidates.some((c) => c.size === requested)) return requested;
    const sameShape = candidates.filter((c) => orientation(c.d) === orientation(want));
    const pool = sameShape.length > 0 ? sameShape : candidates;
    const ratio = want.width / want.height;
    const best = [...pool].sort(
      (a, b) =>
        Math.abs(a.d.width / a.d.height - ratio) - Math.abs(b.d.width / b.d.height - ratio) ||
        Math.abs(a.d.width * a.d.height - want.width * want.height) -
          Math.abs(b.d.width * b.d.height - want.width * want.height),
    )[0];
    return best ? best.size : requested;
  }

  const fits = (d: Dimensions) =>
    d.width % sizing.multipleOf === 0 &&
    d.height % sizing.multipleOf === 0 &&
    d.width <= sizing.maxEdge &&
    d.height <= sizing.maxEdge &&
    d.width * d.height >= sizing.minPixels &&
    d.width * d.height <= sizing.maxPixels &&
    Math.max(d.width, d.height) / Math.min(d.width, d.height) <= sizing.maxAspectRatio;

  const divisor = gcd(want.width, want.height);
  const a = want.width / divisor;
  const b = want.height / divisor;
  for (let m = 1; a * m <= sizing.maxEdge && b * m <= sizing.maxEdge; m += 1) {
    const d = { width: a * m, height: b * m };
    if (d.width < want.width || d.height < want.height) continue;
    if (fits(d)) return `${d.width}x${d.height}`;
  }

  const round = (value: number) =>
    Math.min(
      sizing.maxEdge - (sizing.maxEdge % sizing.multipleOf),
      Math.max(sizing.multipleOf, Math.round(value / sizing.multipleOf) * sizing.multipleOf),
    );
  return `${round(want.width)}x${round(want.height)}`;
}
