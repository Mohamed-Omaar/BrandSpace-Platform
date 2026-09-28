/**
 * PHASE 2C-2 (item 3) — BRAND TYPOGRAPHY: four slots, two kinds of font.
 *
 * A brand has FOUR typography slots — English heading, English body, Arabic
 * heading, Arabic body — stored on `brand.typography` in the v2 shape
 *
 *     { en: { heading, body }, ar: { heading, body } }
 *
 * where every slot is a TYPED reference, never a bare family name:
 *
 *     { kind: 'catalogue', key }        a font bundled with the application
 *     { kind: 'uploaded', brandFontId } one of the brand's uploaded fonts
 *
 * The v1 shape `{ heading, body }` (free-text font names) is still READ: its
 * values are the English slots until the brand is next saved, and reading never
 * writes anything back.
 *
 * TWO DELIVERY MODELS, NEVER MIXED. Catalogue fonts are GLOBAL application
 * files, self-hosted under `/fonts/<directory>/` (public, same-origin, never a
 * tenant asset, never charged to a workspace). Uploaded fonts are TENANT assets
 * served only through the authenticated font route, and only to a reader who
 * may read them; anyone else gets the language's default catalogue font.
 *
 * EVERY SLOT ALWAYS RESOLVES. A removed, archived, unready, unclean or
 * unreadable uploaded font — or a catalogue key the configuration no longer
 * offers — falls back to the configured default for that language at READ
 * time, so no stored reference can break a surface.
 *
 * Pure: no database, no I/O. The caller supplies the catalogue configuration and
 * the uploaded fonts THIS reader may use.
 */

export type BrandFontLanguage = 'en' | 'ar';
export type BrandFontRole = 'heading' | 'body';

export const BRAND_FONT_LANGUAGES: readonly BrandFontLanguage[] = ['en', 'ar'];
export const BRAND_FONT_ROLES: readonly BrandFontRole[] = ['heading', 'body'];

/* ------------------------------------------------------------------ bundled */

export interface BundledFontFace {
  /** The unmodified upstream file name, as shipped under `/fonts/<directory>/`. */
  readonly file: string;
  /** One weight (`'400'`) or a variable file's range (`'100 900'`). */
  readonly weight: string;
  readonly format: 'woff2' | 'truetype';
}

export interface BundledFont {
  readonly key: string;
  /** The family name people see. */
  readonly family: string;
  readonly language: BrandFontLanguage;
  readonly directory: string;
  readonly faces: readonly BundledFontFace[];
}

/**
 * THE FILES BUNDLED WITH THE APPLICATION — packaging facts, not configuration.
 * Every family is SIL OFL 1.1, shipped unmodified with its licence beside it
 * (docs/DESIGN-SYSTEM.md, "Bundled brand fonts"). Which of these a workspace is
 * OFFERED, and the per-language defaults, are configuration (`assets.brandFonts`).
 *
 * Weights: variable files where upstream publishes them; otherwise the static
 * 400 / 600 / 700 upstream has. Tajawal, Almarai and Amiri have no 600, so
 * semibold text uses their 700 by standard font matching (owner, 2026-09-28).
 */
export const BUNDLED_FONTS: readonly BundledFont[] = [
  {
    key: 'inter',
    family: 'Inter',
    language: 'en',
    directory: 'inter',
    faces: [{ file: 'InterVariable.woff2', weight: '100 900', format: 'woff2' }],
  },
  {
    key: 'poppins',
    family: 'Poppins',
    language: 'en',
    directory: 'poppins',
    faces: [
      { file: 'Poppins-Regular.ttf', weight: '400', format: 'truetype' },
      { file: 'Poppins-SemiBold.ttf', weight: '600', format: 'truetype' },
      { file: 'Poppins-Bold.ttf', weight: '700', format: 'truetype' },
    ],
  },
  {
    key: 'montserrat',
    family: 'Montserrat',
    language: 'en',
    directory: 'montserrat',
    faces: [{ file: 'Montserrat[wght].ttf', weight: '100 900', format: 'truetype' }],
  },
  {
    key: 'playfair-display',
    family: 'Playfair Display',
    language: 'en',
    directory: 'playfair-display',
    faces: [{ file: 'PlayfairDisplay[wght].ttf', weight: '400 900', format: 'truetype' }],
  },
  {
    key: 'lora',
    family: 'Lora',
    language: 'en',
    directory: 'lora',
    faces: [{ file: 'Lora[wght].ttf', weight: '400 700', format: 'truetype' }],
  },
  {
    key: 'cairo',
    family: 'Cairo',
    language: 'ar',
    directory: 'cairo',
    faces: [{ file: 'Cairo[slnt,wght].ttf', weight: '200 1000', format: 'truetype' }],
  },
  {
    key: 'tajawal',
    family: 'Tajawal',
    language: 'ar',
    directory: 'tajawal',
    faces: [
      { file: 'Tajawal-Regular.ttf', weight: '400', format: 'truetype' },
      { file: 'Tajawal-Bold.ttf', weight: '700', format: 'truetype' },
    ],
  },
  {
    key: 'ibm-plex-sans-arabic',
    family: 'IBM Plex Sans Arabic',
    language: 'ar',
    directory: 'ibm-plex-sans-arabic',
    faces: [
      { file: 'IBMPlexSansArabic-Regular.ttf', weight: '400', format: 'truetype' },
      { file: 'IBMPlexSansArabic-SemiBold.ttf', weight: '600', format: 'truetype' },
      { file: 'IBMPlexSansArabic-Bold.ttf', weight: '700', format: 'truetype' },
    ],
  },
  {
    key: 'almarai',
    family: 'Almarai',
    language: 'ar',
    directory: 'almarai',
    faces: [
      { file: 'Almarai-Regular.ttf', weight: '400', format: 'truetype' },
      { file: 'Almarai-Bold.ttf', weight: '700', format: 'truetype' },
    ],
  },
  {
    key: 'amiri',
    family: 'Amiri',
    language: 'ar',
    directory: 'amiri',
    faces: [
      { file: 'Amiri-Regular.ttf', weight: '400', format: 'truetype' },
      { file: 'Amiri-Bold.ttf', weight: '700', format: 'truetype' },
    ],
  },
];

export const BUNDLED_FONT_KEYS = [
  'inter',
  'poppins',
  'montserrat',
  'playfair-display',
  'lora',
  'cairo',
  'tajawal',
  'ibm-plex-sans-arabic',
  'almarai',
  'amiri',
] as const;
export type BundledFontKey = (typeof BUNDLED_FONT_KEYS)[number];

export function bundledFont(key: string): BundledFont | undefined {
  return BUNDLED_FONTS.find((font) => font.key === key);
}

/** The configuration this module reads (`assets.brandFonts`). */
export interface BrandFontCatalogue {
  /** Bundled keys offered to brands, in display order. */
  readonly catalogue: readonly string[];
  readonly defaults: Readonly<Record<BrandFontLanguage, string>>;
}

/** The offered catalogue fonts for one language, in configured order. */
export function catalogueFor(
  catalogue: BrandFontCatalogue,
  language: BrandFontLanguage,
): readonly BundledFont[] {
  return catalogue.catalogue
    .map((key) => bundledFont(key))
    .filter((font): font is BundledFont => font !== undefined && font.language === language);
}

/* ------------------------------------------------------------------ stored */

export type BrandFontRef =
  | { readonly kind: 'catalogue'; readonly key: string }
  | { readonly kind: 'uploaded'; readonly brandFontId: string };

export type BrandTypographySlots = Readonly<
  Record<BrandFontLanguage, Readonly<Record<BrandFontRole, BrandFontRef | null>>>
>;

export type StoredTypography =
  | { readonly version: 2; readonly slots: BrandTypographySlots }
  | {
      readonly version: 1;
      /** The v1 names, read as the English slots. Nothing writes this shape any more. */
      readonly legacy: Readonly<Record<BrandFontRole, string | null>>;
    }
  | { readonly version: 0 };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATALOGUE_KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function parseFontRef(value: unknown): BrandFontRef | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record['kind'] === 'catalogue' && typeof record['key'] === 'string') {
    return CATALOGUE_KEY.test(record['key']) ? { kind: 'catalogue', key: record['key'] } : null;
  }
  if (record['kind'] === 'uploaded' && typeof record['brandFontId'] === 'string') {
    return UUID.test(record['brandFontId'])
      ? { kind: 'uploaded', brandFontId: record['brandFontId'].toLowerCase() }
      : null;
  }
  return null;
}

const EMPTY_SLOTS: BrandTypographySlots = {
  en: { heading: null, body: null },
  ar: { heading: null, body: null },
};

/** Read `brand.typography` — v2, v1 or nothing — without changing anything. */
export function readStoredTypography(value: unknown): StoredTypography {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { version: 0 };
  const record = value as Record<string, unknown>;
  const isLanguageBlock = (block: unknown) =>
    typeof block === 'object' && block !== null && !Array.isArray(block);
  if (isLanguageBlock(record['en']) || isLanguageBlock(record['ar'])) {
    const slot = (language: BrandFontLanguage, role: BrandFontRole) =>
      parseFontRef((record[language] as Record<string, unknown> | undefined)?.[role]);
    return {
      version: 2,
      slots: {
        en: { heading: slot('en', 'heading'), body: slot('en', 'body') },
        ar: { heading: slot('ar', 'heading'), body: slot('ar', 'body') },
      },
    };
  }
  const name = (key: BrandFontRole) => {
    const raw = record[key];
    return typeof raw === 'string' && raw.trim() !== '' ? raw.trim().slice(0, 120) : null;
  };
  const legacy = { heading: name('heading'), body: name('body') };
  if (legacy.heading === null && legacy.body === null) return { version: 0 };
  return { version: 1, legacy };
}

/**
 * The four slots a stored value MEANS. A v1 name that is a catalogue family is
 * that catalogue font; any other v1 name, and every unset slot, is null (the
 * language default at resolve time).
 */
export function slotsOf(stored: StoredTypography): BrandTypographySlots {
  if (stored.version === 2) return stored.slots;
  if (stored.version === 0) return EMPTY_SLOTS;
  const byName = (name: string | null): BrandFontRef | null => {
    if (!name) return null;
    const match = BUNDLED_FONTS.find(
      (font) => font.language === 'en' && font.family.toLowerCase() === name.toLowerCase(),
    );
    return match ? { kind: 'catalogue', key: match.key } : null;
  };
  return {
    en: { heading: byName(stored.legacy.heading), body: byName(stored.legacy.body) },
    ar: { heading: null, body: null },
  };
}

/**
 * THE ONE v2 WRITER. Every save of brand typography writes the full four-slot
 * v2 shape — never v1, never a partial object that drops a slot.
 */
export function typographyJson(slots: BrandTypographySlots): {
  en: { heading: BrandFontRef | null; body: BrandFontRef | null };
  ar: { heading: BrandFontRef | null; body: BrandFontRef | null };
} {
  const copy = (ref: BrandFontRef | null): BrandFontRef | null =>
    ref === null
      ? null
      : ref.kind === 'catalogue'
        ? { kind: 'catalogue', key: ref.key }
        : { kind: 'uploaded', brandFontId: ref.brandFontId };
  return {
    en: { heading: copy(slots.en.heading), body: copy(slots.en.body) },
    ar: { heading: copy(slots.ar.heading), body: copy(slots.ar.body) },
  };
}

/* ------------------------------------------------------------------ resolved */

/** An uploaded font THIS reader may use right now, with a live URL. */
export interface ReadableUploadedFont {
  readonly brandFontId: string;
  readonly language: BrandFontLanguage;
  readonly displayName: string;
  /** Same-origin, authenticated, short-lived. */
  readonly url: string;
  readonly format: 'woff2' | 'woff' | 'truetype' | 'opentype';
}

export type ResolvedSlot =
  | {
      readonly source: 'catalogue';
      readonly key: string;
      readonly name: string;
      readonly cssFamily: string;
      /** Why the stored choice was not used, when it was not. */
      readonly fallback: null | 'unset' | 'unavailable' | 'not_offered' | 'legacy_name';
    }
  | {
      readonly source: 'uploaded';
      readonly brandFontId: string;
      readonly name: string;
      readonly cssFamily: string;
      readonly fallback: null;
    };

export type ResolvedTypography = Readonly<
  Record<BrandFontLanguage, Readonly<Record<BrandFontRole, ResolvedSlot>>>
>;

/** The scoped @font-face name of a catalogue font — never the bare family, so
 * the application's own interface font is never replaced by a brand choice. */
export function catalogueCssFamily(key: string): string {
  return `bsf-${key}`;
}

export function uploadedCssFamily(brandFontId: string): string {
  return `bsf-u-${brandFontId.toLowerCase()}`;
}

/** The generic families behind every brand font, per script. */
const FALLBACK_STACK: Readonly<Record<BrandFontLanguage, string>> = {
  en: "system-ui, 'Segoe UI', Roboto, Arial, sans-serif",
  ar: "system-ui, 'Segoe UI', Tahoma, Arial, sans-serif",
};

/** A CSS `font-family` value for a resolved slot, with a safe fallback stack. */
export function fontFamilyValue(slot: ResolvedSlot, language: BrandFontLanguage): string {
  return `'${slot.cssFamily}', ${FALLBACK_STACK[language]}`;
}

export function resolveTypography(input: {
  readonly stored: unknown;
  readonly catalogue: BrandFontCatalogue;
  /** Only the uploaded fonts this reader may use; anything else falls back. */
  readonly readable: readonly ReadableUploadedFont[];
}): ResolvedTypography {
  const stored = readStoredTypography(input.stored);
  const slots = slotsOf(stored);
  const readable = new Map(input.readable.map((font) => [font.brandFontId, font]));
  const offered = new Set(input.catalogue.catalogue);

  const defaultFor = (
    language: BrandFontLanguage,
    fallback: Exclude<ResolvedSlot['fallback'], null>,
  ): ResolvedSlot => {
    const configured = bundledFont(input.catalogue.defaults[language]);
    // A default that is not bundled for this language is a configuration the
    // schema refuses; the first bundled font of the language is the backstop.
    const font =
      configured && configured.language === language
        ? configured
        : BUNDLED_FONTS.find((candidate) => candidate.language === language)!;
    return {
      source: 'catalogue',
      key: font.key,
      name: font.family,
      cssFamily: catalogueCssFamily(font.key),
      fallback,
    };
  };

  const resolve = (language: BrandFontLanguage, role: BrandFontRole): ResolvedSlot => {
    const ref = slots[language][role];
    if (ref === null) {
      const legacyName = stored.version === 1 && language === 'en' ? stored.legacy[role] : null;
      return defaultFor(language, legacyName ? 'legacy_name' : 'unset');
    }
    if (ref.kind === 'catalogue') {
      const font = bundledFont(ref.key);
      if (!font || font.language !== language || !offered.has(font.key)) {
        return defaultFor(language, 'not_offered');
      }
      return {
        source: 'catalogue',
        key: font.key,
        name: font.family,
        cssFamily: catalogueCssFamily(font.key),
        fallback: null,
      };
    }
    const font = readable.get(ref.brandFontId);
    if (!font || font.language !== language) return defaultFor(language, 'unavailable');
    return {
      source: 'uploaded',
      brandFontId: font.brandFontId,
      name: font.displayName,
      cssFamily: uploadedCssFamily(font.brandFontId),
      fallback: null,
    };
  };

  return {
    en: { heading: resolve('en', 'heading'), body: resolve('en', 'body') },
    ar: { heading: resolve('ar', 'heading'), body: resolve('ar', 'body') },
  };
}

/** The slot a piece of CONTENT uses: its own language, never the interface's. */
export function slotForContent(
  resolved: ResolvedTypography,
  contentLocale: 'EN' | 'AR' | 'en' | 'ar',
  role: BrandFontRole,
): ResolvedSlot {
  const language: BrandFontLanguage = contentLocale.toLowerCase() === 'ar' ? 'ar' : 'en';
  return resolved[language][role];
}

/* ------------------------------------------------------------------ @font-face */

const SAFE_URL = /^\/[A-Za-z0-9._~%\-/[\],]+$/;

/**
 * The @font-face rules for EXACTLY the fonts in use — the catalogue families
 * the resolved slots name and the uploaded fonts among them — and nothing else.
 * Every URL is same-origin; a URL with a character outside a safe path is
 * dropped rather than escaped, so no stored value can inject CSS.
 */
export function fontFaceCss(input: {
  readonly used: readonly ResolvedSlot[];
  readonly readable: readonly ReadableUploadedFont[];
}): string {
  const rules: string[] = [];
  const seen = new Set<string>();
  for (const slot of input.used) {
    if (seen.has(slot.cssFamily)) continue;
    seen.add(slot.cssFamily);
    if (slot.source === 'catalogue') {
      const font = bundledFont(slot.key);
      if (!font) continue;
      for (const face of font.faces) {
        const url = `/fonts/${font.directory}/${encodeURIComponent(face.file)}`;
        if (!SAFE_URL.test(url)) continue;
        rules.push(
          `@font-face{font-family:'${slot.cssFamily}';src:url('${url}') format('${face.format}');font-weight:${face.weight};font-style:normal;font-display:swap;}`,
        );
      }
    } else {
      const font = input.readable.find((candidate) => candidate.brandFontId === slot.brandFontId);
      if (!font || !SAFE_URL.test(font.url)) continue;
      rules.push(
        `@font-face{font-family:'${slot.cssFamily}';src:url('${font.url}') format('${font.format}');font-style:normal;font-display:swap;}`,
      );
    }
  }
  return rules.join('\n');
}

/** Every slot of a resolved typography, for `fontFaceCss({ used })`. */
export function allSlots(resolved: ResolvedTypography): readonly ResolvedSlot[] {
  return BRAND_FONT_LANGUAGES.flatMap((language) =>
    BRAND_FONT_ROLES.map((role) => resolved[language][role]),
  );
}

/** The @font-face `format()` for an uploaded font's stored media type. */
export function fontFormatFor(mimeType: string): 'woff2' | 'woff' | 'truetype' | 'opentype' | null {
  switch (mimeType) {
    case 'font/woff2':
      return 'woff2';
    case 'font/woff':
      return 'woff';
    case 'font/ttf':
      return 'truetype';
    case 'font/otf':
      return 'opentype';
    default:
      return null;
  }
}
