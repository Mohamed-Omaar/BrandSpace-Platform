import {
  AppError,
  BRAND_FONT_LANGUAGES,
  BRAND_FONT_ROLES,
  bundledFont,
  type BrandFontLanguage,
  type BrandFontRef,
  type BrandFontRole,
  type BrandTypographySlots,
} from '@brandspace/shared';

/**
 * PHASE 2C-2 — THE LOOK & VOICE DECODERS. Outside the `'use server'` file so
 * the unit suite can reach them (the Phase 7 round-5 lesson).
 */

/** `#rgb` or `#rrggbb`, and nothing else. */
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * The brand palette from a form: every `colorPalette` value, comma lists
 * allowed, trimmed, de-duplicated, each a hex colour, at most twelve. The ONE
 * palette rule — Settings → Brand and the Look & voice swatches both use it.
 */
export function paletteFromForm(formData: FormData): readonly string[] {
  const colorPalette = [
    ...new Set(
      formData
        .getAll('colorPalette')
        .flatMap((value) => String(value).split(','))
        .map((value) => value.trim())
        .filter((value) => value !== ''),
    ),
  ];
  for (const colour of colorPalette) {
    if (!HEX.test(colour)) {
      throw new AppError('VALIDATION_FAILED', `"${colour}" is not a colour.`);
    }
  }
  if (colorPalette.length > 12) {
    throw new AppError('VALIDATION_FAILED', 'A palette holds at most twelve colours.');
  }
  return colorPalette;
}

/** The form field of one slot: `font-en-heading`, … */
export function slotField(language: BrandFontLanguage, role: BrandFontRole): string {
  return `font-${language}-${role}`;
}

/** A select option's value: `catalogue:<key>` or `uploaded:<brandFontId>`. */
export function slotValue(ref: BrandFontRef): string {
  return ref.kind === 'catalogue' ? `catalogue:${ref.key}` : `uploaded:${ref.brandFontId}`;
}

/**
 * The four slots from the Look & voice form. Every slot must be present. A
 * catalogue choice must be OFFERED and of the slot's language; an uploaded
 * choice must be one of THIS brand's active fonts of that language. Anything
 * else is refused rather than stored.
 */
export function typographySlotsFromForm(
  formData: FormData,
  context: {
    readonly policy: { readonly brandFonts: { readonly catalogue: readonly string[] } };
    readonly activeFonts: readonly { readonly id: string; readonly language: string }[];
  },
): BrandTypographySlots {
  const offered = new Set(context.policy.brandFonts.catalogue);
  const fonts = new Map(context.activeFonts.map((font) => [font.id, font.language]));
  const refused = () => new AppError('VALIDATION_FAILED', 'That font cannot be used here.');

  const read = (language: BrandFontLanguage, role: BrandFontRole): BrandFontRef => {
    const raw = formData.get(slotField(language, role));
    if (raw === null) throw new AppError('VALIDATION_FAILED', 'A font slot is missing.');
    const [kind, value] = String(raw).split(':', 2);
    if (kind === 'catalogue' && value) {
      const font = bundledFont(value);
      if (!font || font.language !== language || !offered.has(font.key)) throw refused();
      return { kind: 'catalogue', key: font.key };
    }
    if (kind === 'uploaded' && value) {
      const fontLanguage = fonts.get(value);
      if (fontLanguage !== (language === 'ar' ? 'AR' : 'EN')) throw refused();
      return { kind: 'uploaded', brandFontId: value };
    }
    throw refused();
  };

  const slots = Object.fromEntries(
    BRAND_FONT_LANGUAGES.map((language) => [
      language,
      Object.fromEntries(BRAND_FONT_ROLES.map((role) => [role, read(language, role)])),
    ]),
  );
  return slots as unknown as BrandTypographySlots;
}
