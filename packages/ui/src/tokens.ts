/**
 * Design tokens — CLAUDE.md §4.
 *
 * Brand colours are tokens, never literals in components.
 *
 * ACCESSIBILITY: the two brand colours are vivid identity colours, and NEITHER is
 * legible as text on white — blue scores 2.56:1 and yellow 1.35:1 against the
 * 4.5:1 AA threshold. Each therefore has an explicit text variant
 * (`brandBlueText`, `brandYellowText`) and a surface/ink pair for filled
 * controls. Every documented pairing is asserted in tests/unit/contrast.test.ts,
 * so a future token change that breaks contrast fails the build.
 */
export const colorTokens = {
  /**
   * BRAND IDENTITY blue. Approved brand colour, used for logos, large graphics,
   * borders and accents.
   *
   * NOT FOR TEXT, and not as a background for white text: it scores 2.56:1
   * against white, which fails WCAG AA for both (4.5:1 normal, 3:1 large). Use
   * `brandBlueText` or `brandBlueSurface` instead. Enforced by
   * tests/unit/contrast.test.ts.
   */
  brandBlue: '#00ADEE',
  /** Accent hover state. Decorative only — 3.28:1, still not text-safe. */
  brandBlueHover: '#0098D1',
  /** Text on a light background. 6.50:1 against white — AA for all sizes. */
  brandBlueText: '#00658A',
  /** Filled surface for buttons and the skip link. Pairs with brandBlueInk. */
  brandBlueSurface: '#00658A',
  /** Foreground on brandBlueSurface. 6.50:1. */
  brandBlueInk: '#FFFFFF',

  brandYellow: '#FFDD15',
  /** Foreground on brandYellow. Yellow is an accent; it never carries text. */
  brandYellowInk: '#1A1A1A',
  /** Darkened yellow for text on a light background. 5.52:1. */
  brandYellowText: '#7A6800',

  surface: '#FFFFFF',
  surfaceMuted: '#F6F8FA',
  border: '#E3E8EF',
  textPrimary: '#0F172A',
  textSecondary: '#475569',

  danger: '#D92D20',
  warning: '#B54708',
  success: '#067647',
} as const;

export type ColorToken = keyof typeof colorTokens;

/** Logical spacing scale (rem). Used with logical CSS properties for RTL correctness. */
export const spacingTokens = {
  xs: '0.25rem',
  sm: '0.5rem',
  md: '1rem',
  lg: '1.5rem',
  xl: '2rem',
  '2xl': '3rem',
} as const;

export const radiusTokens = {
  sm: '0.25rem',
  md: '0.5rem',
  lg: '0.75rem',
  full: '9999px',
} as const;

/**
 * Font stacks. Arabic and Latin are paired so both scripts render at comparable
 * optical size; the Arabic face leads in the Arabic stack.
 */
export const fontTokens = {
  sansLatin:
    "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  sansArabic:
    "'IBM Plex Sans Arabic', 'Noto Sans Arabic', system-ui, 'Segoe UI', Tahoma, Arial, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
} as const;
