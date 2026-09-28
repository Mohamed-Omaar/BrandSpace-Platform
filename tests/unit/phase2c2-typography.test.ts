import { describe, expect, it } from 'vitest';
import { defaultPayload, parseConfigPayload } from '@brandspace/config';
import { assetPolicyFrom } from '@brandspace/assets';
import {
  BUNDLED_FONTS,
  BUNDLED_FONT_KEYS,
  allSlots,
  catalogueFor,
  fontFaceCss,
  fontFamilyValue,
  readStoredTypography,
  resolveTypography,
  slotForContent,
  typographyJson,
  type BrandFontCatalogue,
  type ReadableUploadedFont,
} from '@brandspace/shared';

/**
 * PHASE 2C-2, ITEM 3 — the four typography slots.
 *
 * v2 `{ en: { heading, body }, ar: { heading, body } }` with typed references;
 * v1 `{ heading, body }` names still read as the English slots; every slot
 * always resolves, falling back to the language default when its font cannot
 * be used by THIS reader.
 */

const CATALOGUE: BrandFontCatalogue = {
  catalogue: [...BUNDLED_FONT_KEYS],
  defaults: { en: 'inter', ar: 'cairo' },
};
const FONT_ID = '11111111-2222-4333-8444-555555555555';
const readable = (overrides: Partial<ReadableUploadedFont> = {}): ReadableUploadedFont => ({
  brandFontId: FONT_ID,
  language: 'ar',
  displayName: 'Our Arabic',
  url: `/en/assets/font/abc_DEF-123.456`,
  format: 'woff2',
  ...overrides,
});

describe('reading brand.typography', () => {
  it('reads v2, with typed catalogue and uploaded references', () => {
    const stored = readStoredTypography({
      en: {
        heading: { kind: 'catalogue', key: 'poppins' },
        body: { kind: 'catalogue', key: 'lora' },
      },
      ar: { heading: { kind: 'uploaded', brandFontId: FONT_ID }, body: null },
    });
    expect(stored).toEqual({
      version: 2,
      slots: {
        en: {
          heading: { kind: 'catalogue', key: 'poppins' },
          body: { kind: 'catalogue', key: 'lora' },
        },
        ar: { heading: { kind: 'uploaded', brandFontId: FONT_ID }, body: null },
      },
    });
  });

  it('reads v1 names as the English slots, without changing anything', () => {
    const value = { heading: 'Poppins', body: 'Kit Body Serif' };
    const stored = readStoredTypography(value);
    expect(stored).toEqual({ version: 1, legacy: { heading: 'Poppins', body: 'Kit Body Serif' } });
    // The stored object is untouched by reading.
    expect(value).toEqual({ heading: 'Poppins', body: 'Kit Body Serif' });

    const resolved = resolveTypography({ stored: value, catalogue: CATALOGUE, readable: [] });
    // A v1 name that IS a catalogue family is that font…
    expect(resolved.en.heading).toMatchObject({
      source: 'catalogue',
      key: 'poppins',
      fallback: null,
    });
    // …any other name renders in the English default, and says why.
    expect(resolved.en.body).toMatchObject({ key: 'inter', fallback: 'legacy_name' });
    expect(resolved.ar.heading).toMatchObject({ key: 'cairo', fallback: 'unset' });
  });

  it('refuses a malformed reference rather than trusting it', () => {
    const stored = readStoredTypography({
      en: { heading: { kind: 'uploaded', brandFontId: 'not-a-uuid' }, body: 'Inter' },
      ar: {},
    });
    expect(stored).toMatchObject({ version: 2 });
    if (stored.version !== 2) throw new Error('v2 expected');
    expect(stored.slots.en.heading).toBeNull();
    expect(stored.slots.en.body).toBeNull();
  });

  it('nothing stored is the defaults everywhere', () => {
    const resolved = resolveTypography({ stored: null, catalogue: CATALOGUE, readable: [] });
    expect(resolved.en.heading).toMatchObject({ key: 'inter', name: 'Inter' });
    expect(resolved.en.body).toMatchObject({ key: 'inter' });
    expect(resolved.ar.heading).toMatchObject({ key: 'cairo', name: 'Cairo' });
    expect(resolved.ar.body).toMatchObject({ key: 'cairo' });
  });
});

describe('the one v2 writer', () => {
  it('always writes all four slots in the v2 shape', () => {
    expect(
      typographyJson({
        en: { heading: { kind: 'catalogue', key: 'inter' }, body: null },
        ar: { heading: null, body: { kind: 'uploaded', brandFontId: FONT_ID } },
      }),
    ).toEqual({
      en: { heading: { kind: 'catalogue', key: 'inter' }, body: null },
      ar: { heading: null, body: { kind: 'uploaded', brandFontId: FONT_ID } },
    });
  });
});

describe('fallback — a slot never breaks', () => {
  const stored = {
    en: {
      heading: { kind: 'catalogue', key: 'montserrat' },
      body: { kind: 'catalogue', key: 'cairo' },
    },
    ar: {
      heading: { kind: 'uploaded', brandFontId: FONT_ID },
      body: { kind: 'uploaded', brandFontId: FONT_ID },
    },
  };

  it('an uploaded font this reader may use is used', () => {
    const resolved = resolveTypography({ stored, catalogue: CATALOGUE, readable: [readable()] });
    expect(resolved.ar.heading).toMatchObject({ source: 'uploaded', name: 'Our Arabic' });
  });

  it('removed, not ready, not clean or unreadable — all mean "not in the readable list" — fall back', () => {
    // The service lists only ACTIVE fonts whose file is READY + CLEAN, and only
    // for a reader with assets.read + brand.read in scope; everything else is
    // absent here, and absent is the default.
    const resolved = resolveTypography({ stored, catalogue: CATALOGUE, readable: [] });
    expect(resolved.ar.heading).toMatchObject({
      source: 'catalogue',
      key: 'cairo',
      fallback: 'unavailable',
    });
    expect(resolved.ar.body).toMatchObject({ key: 'cairo', fallback: 'unavailable' });
  });

  it('an uploaded font of the other language is not used in this one', () => {
    const resolved = resolveTypography({
      stored,
      catalogue: CATALOGUE,
      readable: [readable({ language: 'en' })],
    });
    expect(resolved.ar.heading).toMatchObject({ fallback: 'unavailable' });
  });

  it('a catalogue font of the wrong language, or no longer offered, falls back', () => {
    const resolved = resolveTypography({
      stored,
      catalogue: { catalogue: ['inter', 'cairo'], defaults: { en: 'inter', ar: 'cairo' } },
      readable: [],
    });
    expect(resolved.en.heading).toMatchObject({ key: 'inter', fallback: 'not_offered' });
    expect(resolved.en.body).toMatchObject({ key: 'inter', fallback: 'not_offered' });
  });
});

describe('the content language picks the slot — never the interface language', () => {
  const resolved = resolveTypography({
    stored: {
      en: {
        heading: { kind: 'catalogue', key: 'playfair-display' },
        body: { kind: 'catalogue', key: 'lora' },
      },
      ar: {
        heading: { kind: 'catalogue', key: 'amiri' },
        body: { kind: 'catalogue', key: 'tajawal' },
      },
    },
    catalogue: CATALOGUE,
    readable: [],
  });

  it('maps EN and AR content to their own heading and body', () => {
    expect(slotForContent(resolved, 'EN', 'heading').name).toBe('Playfair Display');
    expect(slotForContent(resolved, 'EN', 'body').name).toBe('Lora');
    expect(slotForContent(resolved, 'AR', 'heading').name).toBe('Amiri');
    expect(slotForContent(resolved, 'ar', 'body').name).toBe('Tajawal');
  });

  it('uses a scoped family name, so the interface font is never replaced', () => {
    const slot = slotForContent(resolved, 'AR', 'heading');
    expect(slot.cssFamily).toBe('bsf-amiri');
    expect(fontFamilyValue(slot, 'ar')).toMatch(/^'bsf-amiri', system-ui/);
    expect(slot.cssFamily).not.toBe('Amiri');
  });
});

describe('@font-face — only what is used, same-origin, nothing injectable', () => {
  it('declares exactly the used catalogue families, each file once, from /fonts', () => {
    const resolved = resolveTypography({
      stored: {
        en: {
          heading: { kind: 'catalogue', key: 'poppins' },
          body: { kind: 'catalogue', key: 'poppins' },
        },
        ar: { heading: null, body: null },
      },
      catalogue: CATALOGUE,
      readable: [],
    });
    const css = fontFaceCss({ used: allSlots(resolved), readable: [] });
    expect(css.match(/font-family:'bsf-poppins'/g)).toHaveLength(3);
    expect(css).toContain("url('/fonts/poppins/Poppins-SemiBold.ttf') format('truetype')");
    expect(css).toContain("font-family:'bsf-cairo'");
    expect(css).toContain("url('/fonts/cairo/Cairo%5Bslnt%2Cwght%5D.ttf')");
    // Not offered, not used: no Montserrat, no Amiri.
    expect(css).not.toContain('montserrat');
    expect(css).not.toContain('amiri');
    expect(css).not.toMatch(/https?:/);
  });

  it('an uploaded font is loaded only from its same-origin route; a hostile URL is dropped', () => {
    const stored = {
      en: { heading: null, body: null },
      ar: { heading: { kind: 'uploaded', brandFontId: FONT_ID }, body: null },
    };
    const ok = readable();
    const resolved = resolveTypography({ stored, catalogue: CATALOGUE, readable: [ok] });
    expect(fontFaceCss({ used: allSlots(resolved), readable: [ok] })).toContain(
      `url('${ok.url}') format('woff2')`,
    );
    const hostile = readable({ url: "/x');}body{background:red" });
    const resolvedHostile = resolveTypography({
      stored,
      catalogue: CATALOGUE,
      readable: [hostile],
    });
    expect(fontFaceCss({ used: allSlots(resolvedHostile), readable: [hostile] })).not.toContain(
      'red',
    );
  });
});

describe('the catalogue configuration', () => {
  const policy = assetPolicyFrom(defaultPayload('assets'));

  it('offers the ten bundled fonts and defaults to Inter and Cairo', () => {
    expect(policy.brandFonts.catalogue).toEqual([...BUNDLED_FONT_KEYS]);
    expect(policy.brandFonts.defaults).toEqual({ en: 'inter', ar: 'cairo' });
    expect(policy.brandFonts.maxUploadedPerLanguage).toBe(4);
    expect(catalogueFor(policy.brandFonts, 'en').map((font) => font.family)).toEqual([
      'Inter',
      'Poppins',
      'Montserrat',
      'Playfair Display',
      'Lora',
    ]);
    expect(catalogueFor(policy.brandFonts, 'ar').map((font) => font.family)).toEqual([
      'Cairo',
      'Tajawal',
      'IBM Plex Sans Arabic',
      'Almarai',
      'Amiri',
    ]);
  });

  it('refuses a default of the wrong language, one outside the catalogue, or a limit above four', () => {
    expect(() =>
      parseConfigPayload('assets', { brandFonts: { defaults: { en: 'cairo', ar: 'cairo' } } }),
    ).toThrow();
    expect(() =>
      parseConfigPayload('assets', { brandFonts: { catalogue: ['poppins', 'tajawal'] } }),
    ).toThrow();
    expect(() =>
      parseConfigPayload('assets', { brandFonts: { maxUploadedPerLanguage: 5 } }),
    ).toThrow();
  });

  it('can only name fonts that are bundled with their licence', () => {
    expect(() =>
      parseConfigPayload('assets', { brandFonts: { catalogue: ['inter', 'cairo', 'comic-sans'] } }),
    ).toThrow();
    for (const font of BUNDLED_FONTS) {
      expect(font.faces.length, font.key).toBeGreaterThan(0);
    }
  });
});
