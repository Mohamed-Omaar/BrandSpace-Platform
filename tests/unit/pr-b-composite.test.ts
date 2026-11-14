import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HEADLINE_FONT_KEY,
  composeImage,
  contrastRatio,
  headlineFontFor,
  headlineLayer,
} from '../../packages/creative/src/composite';
import { bundledFont } from '@brandspace/shared';

/**
 * PR B (D-601, D-602; owner 2026-11-14) — THE LOGO AND THE HEADLINE, PUT ON A
 * MADE IMAGE. Real images, real fonts, real pixels.
 */

const SIZE = 1024;
const solid = (hex: string) =>
  sharp({ create: { width: SIZE, height: SIZE, channels: 3, background: hex } })
    .png()
    .toBuffer();
/** A logo: a filled circle in one colour on a transparent square. */
const logo = (hex: string) =>
  sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><circle cx="100" cy="100" r="90" fill="${hex}"/><rect x="210" y="40" width="180" height="120" fill="${hex}"/></svg>`,
    ),
  )
    .png()
    .toBuffer();

const DARK_LOGO = logo('#111114');
const LIGHT_LOGO = logo('#ffffff');

async function pixel(bytes: Uint8Array, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(bytes)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const at = (y * info.width + x) * info.channels;
  return [data[at]!, data[at + 1]!, data[at + 2]!];
}

const near = (a: number[], b: number[], tolerance = 18) =>
  a.every((value, index) => Math.abs(value - b[index]!) <= tolerance);

describe('PR B · the logo contrasts with the image under it', () => {
  it('on a DARK image the light (secondary) logo is used, with no plate', async () => {
    const result = await composeImage({
      image: await solid('#16161a'),
      logos: { primary: await DARK_LOGO, secondary: await LIGHT_LOGO },
      addLogo: true,
      headline: null,
      typography: null,
      output: 'jpeg',
    });
    expect(result).toMatchObject({ logo: 'secondary', logoPlate: false, mimeType: 'image/jpeg' });
    // The logo is inside the bottom-right safe margin: its circle is white.
    const margin = Math.round(SIZE * 0.05);
    const boxW = Math.round(SIZE * 0.2); // the circle sits at the logo's left
    const logoHeight = Math.round(boxW / 2);
    const cx = SIZE - margin - boxW + Math.round(boxW * 0.25);
    const cy = SIZE - margin - Math.round(logoHeight / 2);
    expect(near(await pixel(result.bytes, cx, cy), [255, 255, 255], 30)).toBe(true);
    // Outside the margin, the image is untouched.
    expect(near(await pixel(result.bytes, SIZE - 3, SIZE - 3), [22, 22, 26])).toBe(true);
  });

  it('on a LIGHT image the primary (dark) logo is used, with no plate', async () => {
    const result = await composeImage({
      image: await solid('#f4f4f2'),
      logos: { primary: await DARK_LOGO, secondary: await LIGHT_LOGO },
      addLogo: true,
      headline: null,
      typography: null,
      output: 'webp',
    });
    expect(result).toMatchObject({ logo: 'primary', logoPlate: false, mimeType: 'image/webp' });
  });

  it('when neither logo contrasts, the better one sits on a subtle backing plate', async () => {
    const result = await composeImage({
      image: await solid('#7a7a7a'),
      logos: { primary: await logo('#858585'), secondary: null },
      addLogo: true,
      headline: null,
      typography: null,
      output: 'jpeg',
    });
    expect(result).toMatchObject({ logo: 'primary', logoPlate: true });
    // The plate is light under a mid-grey logo: the corner of the plate area is
    // brighter than the image.
    const margin = Math.round(SIZE * 0.05);
    const pad = Math.round(margin * 0.4);
    const plateCorner = await pixel(
      result.bytes,
      SIZE - margin - Math.round(SIZE * 0.2) - pad + 4,
      SIZE - margin - pad + 2,
    );
    expect(plateCorner[0]!).toBeGreaterThan(180);
  });

  it('the plate threshold is WCAG’s 3:1', () => {
    expect(contrastRatio(1, 0)).toBeCloseTo(21, 0);
    expect(contrastRatio(0.2, 0.18)).toBeLessThan(3);
  });

  it('switched off, or no logo on file: nothing is placed', async () => {
    const image = await solid('#f4f4f2');
    for (const input of [
      { addLogo: false, logos: { primary: await DARK_LOGO, secondary: null } },
      { addLogo: true, logos: { primary: null, secondary: null } },
    ]) {
      const result = await composeImage({
        image,
        ...input,
        headline: null,
        typography: null,
        output: 'jpeg',
      });
      expect(result.logo).toBeNull();
      expect(near(await pixel(result.bytes, SIZE - 120, SIZE - 80), [244, 244, 242])).toBe(true);
    }
  });
});

describe('PR B · the headline: joined, right to left, in a licensed font', () => {
  const plex = bundledFont(DEFAULT_HEADLINE_FONT_KEY)!;
  const render = (text: string) =>
    headlineLayer({ width: 800, height: 400, text, font: plex, backdrop: 0 });
  const ink = async (png: Buffer) => {
    const { data, info } = await sharp(png)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data, info };
  };

  it('Arabic letters are SHAPED: the word differs from the same letters forced apart', async () => {
    const word = 'سلام';
    // ZWNJ between letters forbids joining, so each letter takes its isolated
    // form. A renderer that does not shape draws the two identically.
    const apart = [...word].join('\u200C');
    const joined = await ink(render(word));
    const isolated = await ink(render(apart));
    expect(Buffer.compare(joined.data, isolated.data)).not.toBe(0);
    // And shaping makes the joined word narrower than its isolated letters.
    const inkWidth = ({ data, info }: Awaited<ReturnType<typeof ink>>) => {
      let min = info.width;
      let max = -1;
      for (let y = 0; y < info.height; y += 1) {
        for (let x = 0; x < info.width; x += 1) {
          if (data[(y * info.width + x) * 4 + 3]! > 128) {
            min = Math.min(min, x);
            max = Math.max(max, x);
          }
        }
      }
      return max - min;
    };
    expect(inkWidth(joined)).toBeLessThan(inkWidth(isolated));
  });

  it('Arabic reads RIGHT TO LEFT: the first letter (a tall alef) is at the right end', async () => {
    // "ا" then a long run of tatweel: the alef is the only tall stroke.
    const { data, info } = await ink(render('ا ـــــــــــ'));
    // The top rows of the text (above the tatweel line) hold ink only at the
    // right end of the ink when the text runs right to left.
    let topMin = info.width;
    let allMin = info.width;
    let allMax = -1;
    let topRow = -1;
    for (let y = 0; y < info.height && topRow < 0; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        if (data[(y * info.width + x) * 4 + 3]! > 128) topRow = y;
      }
    }
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        if (data[(y * info.width + x) * 4 + 3]! <= 128) continue;
        allMin = Math.min(allMin, x);
        allMax = Math.max(allMax, x);
        if (y < topRow + 8) topMin = Math.min(topMin, x);
      }
    }
    expect(topMin).toBeGreaterThan(allMin + (allMax - allMin) / 2);
  });

  it('the composed image names the headline font and the logo in its EXIF description', async () => {
    const result = await composeImage({
      image: await solid('#16161a'),
      logos: { primary: await DARK_LOGO, secondary: await LIGHT_LOGO },
      addLogo: true,
      headline: 'خصم ٢٠٪ هذا الأسبوع',
      typography: null,
      output: 'jpeg',
    });
    expect(result.headlineFont).toBe('IBM Plex Sans Arabic');
    const { exif } = await sharp(result.bytes).metadata();
    const note = Buffer.from(exif ?? []).toString('latin1');
    expect(note).toContain('headline font: IBM Plex Sans Arabic');
    expect(note).toContain('logo: secondary');
  });
});

describe('PR B · the headline font follows the brand’s typography when it is licensed', () => {
  const v2 = (slots: Record<string, Record<string, unknown>>) => ({ version: 2, ...slots });

  it('the brand’s Arabic heading font, when bundled (Tajawal)', () => {
    const typography = v2({
      ar: { heading: { kind: 'catalogue', key: 'tajawal' }, body: null },
      en: { heading: null, body: null },
    });
    expect(headlineFontFor(typography, 'ar').family).toBe('Tajawal');
  });

  it('the brand’s English heading font for an English headline (Poppins)', () => {
    const typography = v2({
      ar: { heading: null, body: null },
      en: { heading: { kind: 'catalogue', key: 'poppins' }, body: null },
    });
    expect(headlineFontFor(typography, 'en').family).toBe('Poppins');
  });

  it('an uploaded font (licence unknown), nothing set, or an unknown name: the default', () => {
    const uploaded = v2({
      ar: { heading: { kind: 'uploaded', brandFontId: crypto.randomUUID() }, body: null },
      en: { heading: null, body: null },
    });
    expect(headlineFontFor(uploaded, 'ar').family).toBe('IBM Plex Sans Arabic');
    expect(headlineFontFor(null, 'ar').family).toBe('IBM Plex Sans Arabic');
    expect(headlineFontFor(['Comic Sans'], 'en').family).toBe('IBM Plex Sans Arabic');
  });

  it('an older record naming a bundled family by name (Cairo), for its own language only', () => {
    expect(headlineFontFor(['Cairo'], 'ar').family).toBe('Cairo');
    // A Latin font is never used for an Arabic headline.
    expect(headlineFontFor(['Poppins'], 'ar').family).toBe('IBM Plex Sans Arabic');
  });
});
