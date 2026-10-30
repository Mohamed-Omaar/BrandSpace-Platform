/**
 * COLOUR MATHS FOR THE LOOK & FEEL THEME (LF).
 *
 * Pure functions, no DOM: the Control Center validates a theme with them, and
 * both apps write the theme's CSS variables with them. Colours are sRGB; the
 * perceptual work (a hue that follows the owner's primary, a dark palette) is
 * done in OKLCH, and every result is clipped back into the sRGB gamut by
 * lowering its chroma, never by clamping a channel (which would shift the hue).
 */

/** sRGB channels in 0..1 and alpha in 0..1. */
export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** OKLCH: lightness 0..1, chroma 0..~0.4, hue in degrees, and alpha. */
export interface Oklch {
  readonly l: number;
  readonly c: number;
  readonly h: number;
  readonly a: number;
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i;

/** A `#rgb`, `#rrggbb` or `#rrggbbaa` colour, the only form a theme stores. */
export function isHexColour(value: string): boolean {
  return HEX.test(value);
}

/** Parse a hex or `rgb()`/`rgba()` colour; null for anything else. */
export function parseColour(value: string): Rgba | null {
  const text = value.trim();
  const hex = HEX.exec(text);
  if (hex) {
    let digits = hex[1]!;
    if (digits.length === 3) digits = [...digits].map((d) => d + d).join('');
    const n = (i: number) => parseInt(digits.slice(i, i + 2), 16) / 255;
    return { r: n(0), g: n(2), b: n(4), a: digits.length === 8 ? n(6) : 1 };
  }
  const rgb = RGB.exec(text);
  if (rgb) {
    const channel = (s: string) => Math.min(255, Number(s)) / 255;
    return {
      r: channel(rgb[1]!),
      g: channel(rgb[2]!),
      b: channel(rgb[3]!),
      a: rgb[4] === undefined ? 1 : Math.min(1, Number(rgb[4])),
    };
  }
  return null;
}

const byte = (v: number) =>
  Math.round(Math.min(1, Math.max(0, v)) * 255)
    .toString(16)
    .padStart(2, '0');

/** `#rrggbb` when opaque, `rgba(…)` otherwise. */
export function formatColour({ r, g, b, a }: Rgba): string {
  if (a >= 1) return `#${byte(r)}${byte(g)}${byte(b)}`;
  const c = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgba(${c(r)}, ${c(g)}, ${c(b)}, ${Math.round(a * 1000) / 1000})`;
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

export function toOklch({ r, g, b, a }: Rgba): Oklch {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const h = (Math.atan2(B, A) * 180) / Math.PI;
  return { l: L, c: Math.hypot(A, B), h: (h + 360) % 360, a };
}

function oklchToLinear({ l, c, h }: Oklch): [number, number, number] {
  const A = c * Math.cos((h * Math.PI) / 180);
  const B = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m_ = (l - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s_ = (l - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

const inGamut = (rgb: [number, number, number]) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/** Back to sRGB, lowering chroma until the colour fits the gamut. */
export function fromOklch(colour: Oklch): Rgba {
  const l = Math.min(1, Math.max(0, colour.l));
  let c = Math.max(0, colour.c);
  let lin = oklchToLinear({ ...colour, l, c });
  if (!inGamut(lin)) {
    let lo = 0;
    let hi = c;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear({ ...colour, l, c: mid }))) lo = mid;
      else hi = mid;
    }
    c = lo;
    lin = oklchToLinear({ ...colour, l, c });
  }
  const [r, g, b] = lin.map((v) => fromLinear(Math.min(1, Math.max(0, v))));
  return { r: r!, g: g!, b: b!, a: colour.a };
}

/** Composite a translucent colour over an opaque one. */
export function over(top: Rgba, under: Rgba): Rgba {
  const a = top.a;
  return {
    r: top.r * a + under.r * (1 - a),
    g: top.g * a + under.g * (1 - a),
    b: top.b * a + under.b * (1 - a),
    a: 1,
  };
}

/** WCAG 2.x relative luminance of an opaque colour. */
export function luminance({ r, g, b }: Rgba): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG 2.x contrast ratio; a translucent foreground is composited first. */
export function contrastRatio(foreground: Rgba, background: Rgba): number {
  const bg = background.a < 1 ? over(background, { r: 1, g: 1, b: 1, a: 1 }) : background;
  const fg = foreground.a < 1 ? over(foreground, bg) : foreground;
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Contrast of two colour strings; 1 when either does not parse. */
export function contrastOf(foreground: string, background: string): number {
  const fg = parseColour(foreground);
  const bg = parseColour(background);
  return fg && bg ? contrastRatio(fg, bg) : 1;
}

const hueDelta = (from: number, to: number) => ((to - from + 540) % 360) - 180;

/**
 * Move a colour that belongs to an anchor's family (a shade, a tint, a
 * translucent wash of the brand purple) so it keeps the same relation to a
 * new anchor: the hue turns by the anchors' hue difference, the chroma scales
 * by their ratio, and lightness moves by the anchors' difference, weighted by
 * how close the colour sits to the anchor — a near-white tint stays a tint.
 */
export function follow(colour: Rgba, fromAnchor: Rgba, toAnchor: Rgba): Rgba {
  const c = toOklch(colour);
  const a = toOklch(fromAnchor);
  const b = toOklch(toAnchor);
  const weight = Math.max(0, 1 - Math.abs(c.l - a.l) / 0.45);
  const chromaRatio = a.c > 1e-4 ? b.c / a.c : 1;
  return fromOklch({
    l: c.l + (b.l - a.l) * weight,
    c: c.c * chromaRatio,
    h: (c.h + hueDelta(a.h, b.h) + 360) % 360,
    a: c.a,
  });
}

/** The chromatic family a colour belongs to, by OKLCH hue; null for a neutral. */
export function hueOf(colour: Rgba): number | null {
  const c = toOklch(colour);
  return c.c < 0.025 ? null : c.h;
}

/** How far apart two hues are, 0..180 degrees. */
export function hueDistance(a: number, b: number): number {
  return Math.abs(hueDelta(a, b));
}

/**
 * The generated dark counterpart of a light-theme colour (LF dark mode).
 *   - Opaque neutrals invert their lightness: white surfaces become deep
 *     grey, ink text becomes near-white.
 *   - Translucent light neutrals (glass) become translucent dark glass;
 *     translucent dark ones (shadows, scrims) stay as they are.
 *   - Pale tints become deep tinted surfaces; deep colours become light; the
 *     saturated middle is lifted until it reads on a dark ground.
 */
export function darkCounterpart(colour: Rgba): Rgba {
  const c = toOklch(colour);
  const neutral = c.c < 0.025;
  if (colour.a < 1) {
    if (c.l < 0.5) return colour;
    return fromOklch({ ...c, l: Math.max(0.12, 1.12 - c.l), c: c.c * 0.6 });
  }
  if (neutral) {
    // The near-whites keep their order (a white card stays lighter than the
    // grey page it sits on); everything darker inverts.
    if (c.l > 0.9) return fromOklch({ ...c, l: 0.18 + (c.l - 0.9) * 0.6 });
    return fromOklch({ ...c, l: Math.min(0.96, Math.max(0.12, 1.12 - c.l)) });
  }
  if (c.l > 0.85 && c.c < 0.1) return fromOklch({ ...c, l: 0.3, c: Math.min(c.c, 0.08) });
  if (c.l < 0.35) return fromOklch({ ...c, l: 0.86, c: c.c * 0.6 });
  return fromOklch({ ...c, l: Math.max(c.l, 0.72) });
}

/** White or ink, whichever reads better on a fill. */
export function readableOn(fill: string, light = '#ffffff', dark = '#111114'): string {
  return contrastOf(light, fill) >= contrastOf(dark, fill) ? light : dark;
}

/**
 * The colour, darkened (or lightened on a dark ground) in steps until it
 * reaches `ratio` against `background`. Returns the colour unchanged when it
 * already passes; the closest it got when it cannot.
 */
export function untilReadable(colour: string, background: string, ratio: number): string {
  const fg = parseColour(colour);
  const bg = parseColour(background);
  if (!fg || !bg) return colour;
  if (contrastRatio(fg, bg) >= ratio) return colour;
  const lc = toOklch(fg);
  const darker = luminance(bg) > 0.18;
  let best = colour;
  for (let step = 1; step <= 40; step++) {
    const candidate = fromOklch({ ...lc, l: lc.l + (darker ? -0.02 : 0.02) * step });
    best = formatColour(candidate);
    if (contrastRatio(candidate, bg) >= ratio) return best;
  }
  return best;
}
