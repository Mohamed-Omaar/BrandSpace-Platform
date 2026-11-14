import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp, { type OverlayOptions } from 'sharp';
import { createCanvas, GlobalFonts, type SKRSContext2D } from '@napi-rs/canvas';
import {
  BUNDLED_FONTS,
  brandTypography,
  bundledFont,
  readStoredTypography,
  type BrandFontLanguage,
  type BundledFont,
} from '@brandspace/shared';

/**
 * PR B (D-601, D-602; owner 2026-11-14) — THE REAL LOGO AND A HEADLINE, PUT
 * ON A MADE IMAGE ON THE SERVER.
 *
 * Runs only on an image a model just made for this brand, before it enters
 * the library through the person's own upload path (and is scanned there).
 * `sharp` and `@napi-rs/canvas` are the two libraries D-602 allows, for this
 * server-side work only.
 *
 *   - THE LOGO is the brand's own file, never redrawn. Of the brand's two
 *     logos (primary, secondary/light), the one that CONTRASTS MORE with the
 *     image under it is used; if neither reaches 3:1, it sits on a subtle
 *     backing plate. Bottom corner, inside a safe margin.
 *   - THE HEADLINE is drawn with a real font file, so Arabic letters join and
 *     read right to left (Skia shapes the text). The brand's heading font is
 *     used when it is one of the licensed fonts bundled with the product
 *     (`BUNDLED_FONTS`, each with its OFL licence in `packages/creative/fonts`);
 *     otherwise IBM Plex Sans Arabic, the owner's default.
 *   - THE FILE says what was done: the EXIF description names the logo used
 *     and the headline's font.
 */

export const DEFAULT_HEADLINE_FONT_KEY = 'ibm-plex-sans-arabic';

const FONTS_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..', 'fonts');
/** WCAG's non-text contrast: below this, the logo gets a backing plate. */
export const LOGO_MIN_CONTRAST = 3;

export type ImageOutput = 'jpeg' | 'webp';

export interface ComposeInput {
  readonly image: Uint8Array;
  readonly logos: { readonly primary: Uint8Array | null; readonly secondary: Uint8Array | null };
  readonly addLogo: boolean;
  readonly headline: string | null;
  /** The brand's stored typography (`brand.typography`), as stored. */
  readonly typography: unknown;
  readonly output: ImageOutput;
}

export interface ComposeResult {
  readonly bytes: Uint8Array;
  readonly mimeType: 'image/jpeg' | 'image/webp';
  readonly extension: 'jpg' | 'webp';
  readonly width: number;
  readonly height: number;
  /** Which logo was placed, or null when none was. */
  readonly logo: 'primary' | 'secondary' | null;
  readonly logoPlate: boolean;
  /** The headline's font family, or null when there is no headline. */
  readonly headlineFont: string | null;
}

const ARABIC = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

export function headlineLanguage(text: string): BrandFontLanguage {
  return ARABIC.test(text) ? 'ar' : 'en';
}

/**
 * THE HEADLINE'S FONT: the brand's heading (else body) font for the
 * headline's language when it is a bundled, licensed font; a font named in an
 * older record, if one of the bundled families has that name and language;
 * otherwise the default. An uploaded font is never used: its licence for
 * this use is not known.
 */
export function headlineFontFor(typography: unknown, language: BrandFontLanguage): BundledFont {
  const stored = readStoredTypography(typography);
  if (stored.version === 2) {
    for (const ref of [stored.slots[language].heading, stored.slots[language].body]) {
      if (ref?.kind !== 'catalogue') continue;
      const font = bundledFont(ref.key);
      if (font && font.language === language) return font;
    }
  } else {
    for (const name of brandTypography(typography)) {
      const font = BUNDLED_FONTS.find(
        (candidate) =>
          candidate.language === language &&
          candidate.family.toLowerCase() === name.trim().toLowerCase(),
      );
      if (font) return font;
    }
  }
  return bundledFont(DEFAULT_HEADLINE_FONT_KEY)!;
}

const registered = new Map<string, string>();

/** The font's boldest face, registered once, under its own alias. */
function fontAlias(font: BundledFont): string {
  const known = registered.get(font.key);
  if (known) return known;
  const face =
    [...font.faces].reverse().find((candidate) => /700|900|1000/.test(candidate.weight)) ??
    font.faces[font.faces.length - 1]!;
  // A plain path, read at run time on the server: the fonts ship with this
  // package (each with its OFL licence) and are never bundled for a browser.
  const path = join(FONTS_DIRECTORY, font.directory, face.file);
  const alias = `bs-headline-${font.key}`;
  if (!GlobalFonts.registerFromPath(path, alias)) {
    throw new Error(`The font file for "${font.family}" could not be loaded.`);
  }
  registered.set(font.key, alias);
  return alias;
}

/** Relative luminance (WCAG) of an sRGB colour, 0..1. */
function luminance(r: number, g: number, b: number): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** The mean luminance of a region of the image. */
async function regionLuminance(
  image: Buffer,
  region: { left: number; top: number; width: number; height: number },
): Promise<number> {
  const { channels } = await sharp(image).extract(region).removeAlpha().stats();
  return luminance(channels[0]!.mean, channels[1]!.mean, channels[2]!.mean);
}

/** A logo fitted to a box, and the luminance of its visible (opaque) pixels. */
async function fittedLogo(
  bytes: Uint8Array,
  box: { width: number; height: number },
): Promise<{ png: Buffer; width: number; height: number; luminance: number }> {
  const { data, info } = await sharp(bytes)
    .resize({ width: box.width, height: box.height, fit: 'inside', withoutEnlargement: false })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let weight = 0;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3]! / 255;
    if (alpha === 0) continue;
    weight += alpha;
    sum += alpha * luminance(data[i]!, data[i + 1]!, data[i + 2]!);
  }
  const png = await sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png()
    .toBuffer();
  return {
    png,
    width: info.width,
    height: info.height,
    luminance: weight === 0 ? 0 : sum / weight,
  };
}

function roundedRect(width: number, height: number, radius: number, fill: string): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="${fill}"/></svg>`,
  );
}

/** Lines of at most `maxWidth`, words kept whole. */
function wrap(ctx: SKRSContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter((word) => word !== '');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line === '' ? word : `${line} ${word}`;
    if (line !== '' && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

/**
 * The headline as a transparent layer the size of the image: centred near
 * the top, at most two lines, in the colour that contrasts with what is under
 * it, with a soft shadow.
 */
export function headlineLayer(input: {
  readonly width: number;
  readonly height: number;
  readonly text: string;
  readonly font: BundledFont;
  /** The luminance of the area the headline sits on. */
  readonly backdrop: number;
}): Buffer {
  const { width, height, text } = input;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const alias = fontAlias(input.font);
  const rtl = headlineLanguage(text) === 'ar';
  const maxWidth = width * 0.84;
  let size = Math.round(width * 0.068);
  const minimum = Math.round(width * 0.04);
  let lines: string[] = [];
  for (;;) {
    ctx.font = `bold ${size}px "${alias}"`;
    lines = wrap(ctx, text, maxWidth);
    const widest = Math.max(...lines.map((line) => ctx.measureText(line).width));
    if ((lines.length <= 2 && widest <= maxWidth) || size <= minimum) break;
    size = Math.max(minimum, Math.round(size * 0.9));
  }
  lines = lines.slice(0, 2);
  ctx.direction = rtl ? 'rtl' : 'ltr';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const light = contrastRatio(1, input.backdrop) >= contrastRatio(0.0063, input.backdrop);
  ctx.fillStyle = light ? '#ffffff' : '#111114';
  ctx.shadowColor = light ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.45)';
  ctx.shadowBlur = Math.round(size * 0.25);
  const top = Math.round(height * 0.07);
  lines.forEach((line, index) => {
    ctx.fillText(line, width / 2, top + index * Math.round(size * 1.3));
  });
  return canvas.toBuffer('image/png');
}

/** The made image, with the logo and the headline the person asked for. */
export async function composeImage(input: ComposeInput): Promise<ComposeResult> {
  const base = await sharp(input.image).rotate().png().toBuffer();
  const meta = await sharp(base).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const layers: OverlayOptions[] = [];
  const margin = Math.round(Math.min(width, height) * 0.05);

  let headlineFont: string | null = null;
  const headline = input.headline?.trim() ?? '';
  if (headline !== '') {
    const font = headlineFontFor(input.typography, headlineLanguage(headline));
    const band = {
      left: 0,
      top: Math.round(height * 0.04),
      width,
      height: Math.max(1, Math.round(height * 0.22)),
    };
    layers.push({
      input: headlineLayer({
        width,
        height,
        text: headline,
        font,
        backdrop: await regionLuminance(base, band),
      }),
      left: 0,
      top: 0,
    });
    headlineFont = font.family;
  }

  let logo: ComposeResult['logo'] = null;
  let logoPlate = false;
  const candidates = (
    [
      ['primary', input.logos.primary],
      ['secondary', input.logos.secondary],
    ] as const
  ).filter((entry): entry is readonly ['primary' | 'secondary', Uint8Array] => entry[1] !== null);
  if (input.addLogo && candidates.length > 0) {
    const box = {
      width: Math.max(1, Math.round(width * 0.2)),
      height: Math.max(1, Math.round(height * 0.1)),
    };
    let best: {
      variant: 'primary' | 'secondary';
      fitted: Awaited<ReturnType<typeof fittedLogo>>;
      ratio: number;
      left: number;
      top: number;
      under: number;
    } | null = null;
    for (const [variant, bytes] of candidates) {
      const fitted = await fittedLogo(bytes, box);
      const left = width - margin - fitted.width;
      const top = height - margin - fitted.height;
      const under = await regionLuminance(base, {
        left,
        top,
        width: fitted.width,
        height: fitted.height,
      });
      const ratio = contrastRatio(fitted.luminance, under);
      if (!best || ratio > best.ratio) best = { variant, fitted, ratio, left, top, under };
    }
    if (best) {
      logo = best.variant;
      if (best.ratio < LOGO_MIN_CONTRAST) {
        // A SUBTLE PLATE: light under a dark logo, ink under a light one.
        logoPlate = true;
        const pad = Math.round(margin * 0.4);
        const fill = best.fitted.luminance < 0.5 ? 'rgba(255,255,255,0.86)' : 'rgba(17,17,20,0.78)';
        layers.push({
          input: roundedRect(
            best.fitted.width + pad * 2,
            best.fitted.height + pad * 2,
            Math.round(pad * 0.9),
            fill,
          ),
          left: best.left - pad,
          top: best.top - pad,
        });
      }
      layers.push({ input: best.fitted.png, left: best.left, top: best.top });
    }
  }

  const note = [
    'BrandSpace composition',
    `logo: ${logo ? `${logo}${logoPlate ? ' on a plate' : ''}` : 'none'}`,
    `headline font: ${headlineFont ?? 'none'}`,
  ].join('; ');
  const composed = sharp(base)
    .composite(layers)
    .withExif({ IFD0: { ImageDescription: note } });
  const bytes =
    input.output === 'webp'
      ? await composed.webp({ quality: 86 }).toBuffer()
      : await composed.jpeg({ quality: 88, mozjpeg: true }).toBuffer();
  return {
    bytes: new Uint8Array(bytes),
    mimeType: input.output === 'webp' ? 'image/webp' : 'image/jpeg',
    extension: input.output === 'webp' ? 'webp' : 'jpg',
    width,
    height,
    logo,
    logoPlate,
    headlineFont,
  };
}
