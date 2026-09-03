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

  /**
   * PHASE 2B PRIMARY — owner-approved application purple (D-42).
   *
   * Unlike the identity blue, this one is legible: 5.60:1 on white, so it works
   * BOTH as text on a light surface and as a filled surface carrying white
   * text. That is why it can be the primary action colour without a separate
   * darkened text variant.
   *
   * It is the primary for the CUSTOMER DASHBOARD and the CONTROL CENTER. The
   * public marketing site keeps the identity blue — this phase does not
   * redesign it.
   */
  brandPurple: '#7935FE',
  /** Hover/active. 7.16:1 on white. */
  brandPurpleHover: '#6528E0',
  /** Foreground on brandPurple. 5.60:1. */
  brandPurpleInk: '#FFFFFF',
  /** Selected-row and active-nav tint. Pairs with textPrimary and brandPurple. */
  brandPurpleTint: '#F3EDFF',

  brandYellow: '#FFDD15',
  /** Foreground on brandYellow. Yellow is an accent; it never carries text. */
  brandYellowInk: '#1A1A1A',
  /** Darkened yellow for text on a light background. 5.52:1. */
  brandYellowText: '#7A6800',

  surface: '#FFFFFF',
  surfaceMuted: '#F6F8FA',
  /** Phase 2B application background: cards sit on it, so it is not white. */
  appBackground: '#FAFAFA',
  /** Card border. Subtle by design; contrast is carried by the shadow. */
  cardBorder: '#EAECF0',
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

/** Card elevation. Restrained: one subtle shadow, not a stack of them. */
export const shadowTokens = {
  card: '0 1px 2px 0 rgba(16, 24, 40, 0.04), 0 1px 3px 0 rgba(16, 24, 40, 0.06)',
  raised: '0 4px 8px -2px rgba(16, 24, 40, 0.08), 0 2px 4px -2px rgba(16, 24, 40, 0.04)',
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
  // Cairo leads the Arabic stack (D-42), with the previous faces as fallbacks
  // so a missing webfont still renders Arabic in an Arabic-designed face.
  sansArabic:
    "'Cairo', 'IBM Plex Sans Arabic', 'Noto Sans Arabic', system-ui, 'Segoe UI', Tahoma, Arial, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
} as const;
