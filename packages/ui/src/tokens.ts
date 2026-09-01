/**
 * Design tokens — CLAUDE.md §4.
 *
 * Brand colours are tokens, never literals in components. The yellow is an accent
 * only: `#FFDD15` on white fails WCAG contrast for text, so `brandYellowInk` is the
 * paired foreground and `brandYellowText` the darkened variant for text on light ground.
 */
export const colorTokens = {
  brandBlue: '#00ADEE',
  brandBlueHover: '#0098D1',
  brandBlueInk: '#FFFFFF',
  brandYellow: '#FFDD15',
  brandYellowInk: '#1A1A1A',
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
