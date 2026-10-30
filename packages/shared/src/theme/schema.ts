import { z } from 'zod';

/**
 * THE LOOK & FEEL THEME DOCUMENT (LF; the `theme` configuration domain).
 *
 * Every field defaults to the ORIGINAL LOOK — the approved prototype (D-468),
 * token for token — so the empty document `{}` changes nothing on screen, and
 * "reset to the original look" is activating `{}`. A colour left `null` keeps
 * the original; only what the owner changed is ever written.
 *
 * Colours are opaque `#rrggbb` only: a theme never carries transparency, a CSS
 * function or a keyword, so nothing written into a stylesheet can be anything
 * but a colour.
 */
const colour = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'a colour is #rrggbb')
  .transform((v) => v.toLowerCase())
  .nullable()
  .default(null);

export const THEME_PRESET_KEYS = ['original', 'calm', 'modern', 'premium', 'light'] as const;
export type ThemePresetKey = (typeof THEME_PRESET_KEYS)[number];

/** The fixed list of self-hosted fonts that carry Arabic and Latin (LF). */
export const THEME_FONTS = [
  'original',
  'cairo',
  'inter',
  'ibm-plex-sans-arabic',
  'tajawal',
] as const;
export type ThemeFont = (typeof THEME_FONTS)[number];

export const colourSchemeSchema = z.enum(['light', 'dark', 'system']);
export type ColourScheme = z.infer<typeof colourSchemeSchema>;

export const themeLookSchema = z.object({
  colours: z
    .object({
      /** The one colour the owner must pick to recolour; the scale is generated. */
      primary: colour,
      secondary: colour,
      background: colour,
      /** The ambient ground's soft colour orbs. */
      backgroundGradient: z.boolean().default(true),
      surface: colour,
      text: colour,
      success: colour,
      warning: colour,
      danger: colour,
      info: colour,
    })
    .default({}),
  dark: z
    .object({
      /** What a user who has not chosen sees. Each user may override it (a cookie). */
      mode: colourSchemeSchema.default('light'),
      /** The generated dark palette, adjustable: null keeps the generated value. */
      primary: colour,
      background: colour,
      surface: colour,
      text: colour,
    })
    .default({}),
  shape: z
    .object({
      radius: z.enum(['sharp', 'medium', 'round']).default('medium'),
      shadows: z.enum(['none', 'soft', 'medium']).default('soft'),
      density: z.enum(['comfortable', 'compact']).default('comfortable'),
    })
    .default({}),
  buttons: z
    .object({
      style: z.enum(['filled', 'soft', 'outline']).default('filled'),
      size: z.enum(['small', 'medium', 'large']).default('medium'),
    })
    .default({}),
  fields: z
    .object({
      style: z.enum(['filled', 'outlined']).default('filled'),
      border: z.enum(['1', '1.5', '2']).default('1'),
    })
    .default({}),
  text: z
    .object({
      font: z.enum(THEME_FONTS).default('original'),
      size: z.enum(['small', 'normal', 'large']).default('normal'),
      /** Arabic is always at least relaxed, whatever this says. */
      lineHeight: z.enum(['normal', 'relaxed']).default('normal'),
    })
    .default({}),
  logo: z
    .object({
      /** Object-store keys of the uploaded images; null keeps the wordmark. */
      light: z.string().max(200).nullable().default(null),
      dark: z.string().max(200).nullable().default(null),
      mark: z.string().max(200).nullable().default(null),
      favicon: z.string().max(200).nullable().default(null),
    })
    .default({}),
  motion: z
    .object({
      level: z.enum(['full', 'reduced', 'off']).default('full'),
      speed: z.enum(['calm', 'normal', 'quick']).default('normal'),
    })
    .default({}),
  effects: z
    .object({
      overlayBlur: z.boolean().default(true),
      gradients: z.boolean().default(true),
      glass: z.boolean().default(true),
    })
    .default({}),
  layout: z
    .object({
      sidebarWidth: z.enum(['compact', 'default', 'wide']).default('default'),
      sidebarDefault: z.enum(['expanded', 'collapsed']).default('expanded'),
      contentWidth: z.enum(['standard', 'wide']).default('standard'),
    })
    .default({}),
});

export type ThemeLook = z.infer<typeof themeLookSchema>;

const savedPresetSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  name: z.string().trim().min(1).max(60),
  look: themeLookSchema,
});

export const themeDocumentSchema = z.object({
  /** The preset the look started from; `custom` once the owner changed it. */
  preset: z.enum([...THEME_PRESET_KEYS, 'custom', 'saved']).default('original'),
  look: themeLookSchema.default({}),
  /** "Save as my preset": the owner's own looks, to start from later. */
  savedPresets: z.array(savedPresetSchema).max(12).default([]),
  /** Safe mode: the Control Center keeps the original look unless turned off. */
  controlCenterOriginal: z.boolean().default(true),
});

export type ThemeDocument = z.infer<typeof themeDocumentSchema>;

/** The original look, as a parsed document. */
export function originalTheme(): ThemeDocument {
  return themeDocumentSchema.parse({});
}
