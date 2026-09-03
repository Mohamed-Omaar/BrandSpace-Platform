/**
 * Design tokens — CLAUDE.md §4, and the Phase 2C visual foundation.
 *
 * THIS FILE IS THE ONLY PLACE A COLOUR, SIZE, RADIUS, SHADOW, DURATION OR
 * BREAKPOINT IS DECIDED. Applications compose the components in this package;
 * they do not write literals. A visual direction that lives in twenty files is
 * not a design system, it is a coincidence.
 *
 * ACCESSIBILITY IS PART OF THE TOKEN, NOT A REVIEW STEP. Every pairing
 * documented here is asserted in `tests/unit/contrast.test.ts` against the WCAG
 * 2.2 AA thresholds (4.5:1 normal text, 3:1 large text and UI components), so a
 * future token change that breaks contrast fails a fast unit test rather than a
 * design review that may not happen.
 */

export const colorTokens = {
  /**
   * BRAND IDENTITY blue. The PUBLIC MARKETING SITE's primary — logos, large
   * graphics, borders and accents.
   *
   * NOT FOR TEXT, and not as a background for white text: 2.56:1 against white,
   * failing AA for both normal (4.5:1) and large (3:1). Use `brandBlueText` or
   * `brandBlueSurface` instead.
   */
  brandBlue: '#00ADEE',
  /** Accent hover state. Decorative only — 3.28:1, still not text-safe. */
  brandBlueHover: '#0098D1',
  /** Text on a light background. 6.50:1 against white — AA for all sizes. */
  brandBlueText: '#00658A',
  /** Filled surface for controls. Pairs with brandBlueInk. */
  brandBlueSurface: '#00658A',
  /** Foreground on brandBlueSurface. 6.50:1. */
  brandBlueInk: '#FFFFFF',

  /**
   * APPLICATION PRIMARY — owner-approved purple (D-42, reaffirmed in D-49).
   *
   * Unlike the identity blue, this one is legible: 5.60:1 on white, so it works
   * BOTH as text on a light surface and as a filled surface carrying white
   * text. That is why it is the primary action colour with no separate darkened
   * text variant.
   *
   * Primary for the CUSTOMER DASHBOARD and the CONTROL CENTER. The public
   * marketing site keeps the identity blue; this phase does not touch it.
   */
  brandPurple: '#7935FE',
  /** Hover/active. 7.16:1 on white. */
  brandPurpleHover: '#6528E0',
  /** Pressed state, and text that must clear AA on the purple tint. 9.02:1. */
  brandPurplePressed: '#5312C4',
  /** Foreground on brandPurple. 5.60:1. */
  brandPurpleInk: '#FFFFFF',
  /** Selected-row and active-nav tint. Carries textPrimary and brandPurple. */
  brandPurpleTint: '#F3EDFF',
  /** Border for a tinted selected surface — visible against white and tint. */
  brandPurpleBorder: '#D6C2FF',

  /**
   * ACCENT yellow. Highlights, badges and selected-state marks ONLY.
   *
   * 1.35:1 on white. It never carries body text, and white text is never placed
   * on it. Where a yellow surface must carry a word, `brandYellowInk` (near
   * black, 15.3:1 on yellow) is the only permitted foreground; where yellow must
   * appear AS text, `brandYellowText` is the only permitted value.
   */
  brandYellow: '#FFDD15',
  /** Foreground on brandYellow. 15.3:1. */
  brandYellowInk: '#1A1A1A',
  /** Darkened yellow, for yellow-toned text on a light background. 5.52:1. */
  brandYellowText: '#7A6800',
  /** Soft yellow wash for accent surfaces that sit under normal text. */
  brandYellowTint: '#FFF9DB',

  /* ---------------------------------------------------------------------- */
  /* Neutrals                                                               */
  /* ---------------------------------------------------------------------- */

  /** Cards, sheets, the sidebar, and the page ground itself (D-49). */
  surface: '#FFFFFF',
  /**
   * A faint neutral for insets that must read as recessed against a white
   * card: table headers, code blocks, skeletons, disabled controls.
   */
  surfaceMuted: '#F6F8FA',
  /** Slightly deeper inset, for a nested surface on an already-muted one. */
  surfaceSunken: '#EEF2F6',
  /**
   * THE APPLICATION GROUND IS WHITE (D-49). Structure comes from restrained
   * borders and one subtle shadow, not from a tinted background — which is what
   * "clean white surfaces, subtle neutral borders" asks for. Kept as its own
   * token so a future change is one edit, not a search for `#FFFFFF`.
   */
  appBackground: '#FFFFFF',

  /** Card border. Subtle by design; the shadow carries the rest. 1.28:1. */
  cardBorder: '#EAECF0',
  /** Default border for inputs and dividers. 1.44:1 — decorative. */
  border: '#E3E8EF',
  /**
   * Border for a control that must be PERCEIVABLE as a control. WCAG 1.4.11
   * requires 3:1 for a UI component boundary, and `#98A2B3` — the obvious
   * mid-grey, and the first value tried here — scores 2.58:1. Inputs and
   * buttons use this token, never the decorative `border`.
   */
  borderStrong: '#818C9C',

  /** Body text. 17.9:1 on white. */
  textPrimary: '#0F172A',
  /** Secondary text, labels, captions. 7.55:1 on white — AA at every size. */
  textSecondary: '#475569',
  /** Placeholder and disabled text. 4.61:1 on white — still AA for normal text. */
  textMuted: '#667085',
  /** Foreground on a dark or saturated surface. */
  textInverse: '#FFFFFF',

  /* ---------------------------------------------------------------------- */
  /* Semantic                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Error text. Darkened from `#D92D20`, which reached only 4.44:1 against its
   * own tint — a banner whose text was the one thing in it that failed AA.
   */
  danger: '#B42318',
  dangerTint: '#FEF3F2',
  dangerBorder: '#FDA29B',
  warning: '#B54708',
  warningTint: '#FFFAEB',
  warningBorder: '#FEC84B',
  success: '#067647',
  successTint: '#ECFDF3',
  successBorder: '#6CE9A6',
  info: '#175CD3',
  infoTint: '#EFF8FF',
  infoBorder: '#84CAFF',

  /**
   * THE FOCUS RING. Purple, matching the application primary, and never
   * removed. 5.60:1 against white and 3.7:1 against the purple tint, so it is
   * visible on every surface in this system (WCAG 2.4.11).
   */
  focusRing: '#7935FE',
  /** Ring halo, so focus reads on a purple-filled control too. */
  focusRingContrast: '#FFFFFF',
} as const;

export type ColorToken = keyof typeof colorTokens;

/**
 * Spacing scale (rem), applied through LOGICAL properties so Arabic mirrors
 * without a second stylesheet.
 *
 * The `2xl`/`3xl` steps exist for the generous page-level whitespace the
 * approved direction asks for; component padding stays in `sm`…`lg`.
 */
export const spacingTokens = {
  '3xs': '0.125rem',
  '2xs': '0.1875rem',
  xs: '0.25rem',
  sm: '0.5rem',
  md: '1rem',
  lg: '1.5rem',
  xl: '2rem',
  '2xl': '3rem',
  '3xl': '4rem',
} as const;

/**
 * Type scale. One ramp for both scripts.
 *
 * Sizes were literals scattered across a dozen files before this phase
 * (`1.35rem`, `1.05rem`, `0.8125rem`, `0.6875rem`…), which is why two pages
 * that meant "section heading" rendered at different sizes. Every heading and
 * label now names a step.
 */
export const typographyTokens = {
  display: {
    fontSize: '1.875rem',
    lineHeight: '2.25rem',
    fontWeight: 700,
    letterSpacing: '-0.02em',
  },
  h1: { fontSize: '1.5rem', lineHeight: '2rem', fontWeight: 700, letterSpacing: '-0.015em' },
  h2: { fontSize: '1.125rem', lineHeight: '1.75rem', fontWeight: 650, letterSpacing: '-0.01em' },
  h3: { fontSize: '1rem', lineHeight: '1.5rem', fontWeight: 650, letterSpacing: '0' },
  body: { fontSize: '0.9375rem', lineHeight: '1.5rem', fontWeight: 400, letterSpacing: '0' },
  bodySm: { fontSize: '0.875rem', lineHeight: '1.375rem', fontWeight: 400, letterSpacing: '0' },
  label: { fontSize: '0.8125rem', lineHeight: '1.25rem', fontWeight: 600, letterSpacing: '0' },
  caption: { fontSize: '0.75rem', lineHeight: '1.125rem', fontWeight: 400, letterSpacing: '0' },
  overline: {
    fontSize: '0.6875rem',
    lineHeight: '1rem',
    fontWeight: 700,
    letterSpacing: '0.06em',
  },
  /** Tabular figures for money, credits and counts, so columns align. */
  numeric: {
    fontSize: '1.5rem',
    lineHeight: '2rem',
    fontWeight: 700,
    letterSpacing: '-0.02em',
  },
} as const;

export type TypographyToken = keyof typeof typographyTokens;

/**
 * Elevation. Restrained by direction: two steps, plus one for overlays.
 * A stack of heavy shadows is the thing this system is explicitly avoiding.
 */
export const shadowTokens = {
  card: '0 1px 2px 0 rgba(16, 24, 40, 0.04), 0 1px 3px 0 rgba(16, 24, 40, 0.06)',
  raised: '0 4px 8px -2px rgba(16, 24, 40, 0.08), 0 2px 4px -2px rgba(16, 24, 40, 0.04)',
  overlay: '0 12px 24px -6px rgba(16, 24, 40, 0.12), 0 4px 8px -4px rgba(16, 24, 40, 0.06)',
  /** The focus ring, as a shadow, for controls that cannot use `outline`. */
  focus: `0 0 0 2px ${colorTokens.focusRingContrast}, 0 0 0 4px ${colorTokens.focusRing}`,
} as const;

export const radiusTokens = {
  sm: '0.25rem',
  md: '0.5rem',
  lg: '0.75rem',
  xl: '1rem',
  full: '9999px',
} as const;

/**
 * Breakpoints, as tokens rather than as numbers repeated in media queries.
 *
 * These are the widths the quality gate actually exercises: 390 (phone),
 * 768 (tablet), 1280 and 1440 (desktop). `md` is the point at which the
 * sidebar becomes a drawer.
 */
export const breakpointTokens = {
  sm: 480,
  md: 768,
  lg: 1024,
  xl: 1280,
  '2xl': 1440,
} as const;

export type BreakpointToken = keyof typeof breakpointTokens;

/** `min-width` media query for a breakpoint token. */
export function mediaAtLeast(breakpoint: BreakpointToken): string {
  return `(min-width: ${breakpointTokens[breakpoint]}px)`;
}

/** `max-width` media query, one pixel below the breakpoint. */
export function mediaBelow(breakpoint: BreakpointToken): string {
  return `(max-width: ${breakpointTokens[breakpoint] - 1}px)`;
}

/**
 * Motion. Short, purposeful, and always subject to `prefers-reduced-motion`,
 * which `tokens.css` disables globally — so nothing here needs to remember.
 */
export const motionTokens = {
  instant: '80ms',
  fast: '140ms',
  base: '200ms',
  slow: '320ms',
  easeOut: 'cubic-bezier(0.16, 1, 0.3, 1)',
  easeInOut: 'cubic-bezier(0.4, 0, 0.2, 1)',
} as const;

/**
 * Stacking order, named once. Overlapping surfaces that each invent a number
 * are how a dialog ends up behind a sticky header.
 */
export const zIndexTokens = {
  base: 0,
  sticky: 10,
  drawer: 40,
  overlay: 50,
  dialog: 60,
  toast: 70,
  tooltip: 80,
  skipLink: 100,
} as const;

/** Fixed layout measurements the shell and its tests both need. */
export const layoutTokens = {
  sidebarExpanded: '16rem',
  sidebarCollapsed: '4rem',
  headerHeight: '3.5rem',
  contentMaxWidth: '85rem',
  copilotPanelWidth: '24rem',
  /** WCAG 2.2 target size (2.5.8) minimum for a pointer target. */
  minTargetSize: '24px',
  /** The comfortable control height this system uses for buttons and inputs. */
  controlHeight: '2.25rem',
} as const;

/**
 * Font stacks. Arabic and Latin are paired so both scripts render at comparable
 * optical size; the Arabic face leads in the Arabic stack.
 *
 * The webfonts themselves are OPTIONAL AT RUNTIME and never a build dependency
 * — see `webfontHref()`. Every stack ends in system faces that ship with the
 * operating system, so an offline build, a blocked CDN or a test run with no
 * network still renders correctly in both scripts.
 */
export const fontTokens = {
  sansLatin:
    "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  sansArabic:
    "'Cairo', 'IBM Plex Sans Arabic', 'Noto Sans Arabic', system-ui, 'Segoe UI', Tahoma, Arial, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
} as const;

/**
 * Where the optional webfonts come from.
 *
 * NOT `next/font`, deliberately. `next/font/google` downloads the faces at
 * BUILD time and fails the build when it cannot reach the host — turning every
 * build, in CI and offline alike, into a dependency on a third party. F-06 was
 * exactly this shape of problem: verification that passes only under ambient
 * conditions. The link below is a runtime stylesheet the browser may or may not
 * fetch; either way the page renders in the fallback stack.
 *
 * Emitted only when the host application opts in, so tests and CI stay
 * hermetic and deterministic.
 */
export const WEBFONT_HREF =
  'https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700&family=Inter:wght@400;500;600;700&display=swap';

/**
 * The webfont stylesheet URL, or null when webfonts are disabled.
 *
 * `source` is configuration (`BRANDSPACE_WEBFONTS`), not code: `google` opts
 * in, anything else — including unset — keeps the system stack.
 */
export function webfontHref(source: string | undefined): string | null {
  return source === 'google' ? WEBFONT_HREF : null;
}
