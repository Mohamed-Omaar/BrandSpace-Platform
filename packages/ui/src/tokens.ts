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
  /* Neutrals and supporting surfaces                                       */
  /*                                                                        */
  /* THE HIERARCHY MODEL CHANGED IN 2C-A REVISION 2 (D-54).                 */
  /*                                                                        */
  /* Before: a white card, a visible border, on a white ground — which made */
  /* the BORDER the only thing separating a section from the page. That is  */
  /* what made the product read as an outlined admin template: every card,  */
  /* input and toolbar was a stroked rectangle, and strokes were doing all  */
  /* the work that spacing, surface and type should be doing.               */
  /*                                                                        */
  /* Now: the canvas stays white, and SUPPORTING SURFACES carry the         */
  /* structure — soft lavender, warm grey and off-white fills with a very   */
  /* subtle shadow and a large radius. Borders drop to hairlines used only  */
  /* where a genuine edge is needed, and controls are filled rather than    */
  /* outlined.                                                              */
  /* ---------------------------------------------------------------------- */

  /** The canvas, and any card that must read as raised white on white. */
  surface: '#FFFFFF',
  /** Off-white card fill. The default card surface — near-white, not grey. */
  surfaceSoft: '#FBFBFC',
  /** Warm grey section surface, for grouping without drawing a box. */
  surfaceWarm: '#F7F6F4',
  /**
   * Lavender-tinted supporting surface. The brand-adjacent neutral: used for
   * the active navigation pill, selected rows, Copilot surfaces and hero
   * areas. Purple at 4% — a tint, never a colour wash.
   */
  surfaceLavender: '#F8F5FF',
  /** Deeper lavender, for hover and selected states on a lavender surface. */
  surfaceLavenderStrong: '#F0E9FF',
  /**
   * A faint neutral for insets that must read as recessed: table headers,
   * code blocks, skeletons, disabled controls.
   */
  surfaceMuted: '#F5F6F8',
  /** Slightly deeper inset, for a nested surface on an already-muted one. */
  surfaceSunken: '#EDEFF3',
  /** A dark surface, for the Design Studio canvas frame and media chrome. */
  surfaceInk: '#171528',
  /**
   * THE APPLICATION GROUND IS WHITE (D-49, reaffirmed in D-54). Structure now
   * comes from tinted surfaces, spacing and radius rather than from borders —
   * but the ground itself is still white, so the product reads as open rather
   * than as a grey utility.
   */
  appBackground: '#FFFFFF',

  /* ------------------------------------------------------------------ */
  /* Controls                                                            */
  /*                                                                     */
  /* A control is identified by its FILL, its persistent text label and  */
  /* its focus ring — not by a resting stroke (D-55). `controlBorder` is */
  /* transparent by design; `controlBorderContrast` is the 3:1 boundary  */
  /* that `tokens.css` swaps in under `prefers-contrast: more`, so a     */
  /* reader who needs edges gets real ones from their own OS setting.    */
  /* ------------------------------------------------------------------ */

  /** Resting fill for inputs, selects, textareas and search fields. */
  controlSurface: '#F4F4F7',
  /** Hover fill. Perceptible without becoming a second state to read. */
  controlSurfaceHover: '#EDEDF3',
  /** Focused fill: white, so the purple ring reads at full strength. */
  controlSurfaceFocus: '#FFFFFF',
  /** Disabled fill. Paired with `textMuted`, never with `textPrimary`. */
  controlSurfaceDisabled: '#F7F7F9',
  /** Resting control border. Transparent by design — see D-55. */
  controlBorder: 'transparent',
  /** The 3:1 boundary used under `prefers-contrast: more` and forced colours. */
  controlBorderContrast: '#818C9C',

  /**
   * Hairline. A structural edge that separates without outlining: table rows,
   * a sticky header's underside, a panel split. Deliberately below the
   * non-text threshold because it is DECORATION, not the way a component is
   * identified.
   */
  hairline: '#F0F1F4',
  /** Card border. Subtle by design; the shadow carries the rest. 1.28:1. */
  cardBorder: '#EAECF0',
  /** Default border for dividers. 1.44:1 — decorative. */
  border: '#E3E8EF',
  /**
   * A boundary that must be PERCEIVABLE — WCAG 1.4.11 wants 3:1 for a UI
   * component boundary, and `#98A2B3`, the obvious mid-grey and the first
   * value tried here, scores 2.58:1. Used for high-contrast mode, for a
   * control in an error state, and anywhere an edge is load-bearing rather
   * than decorative.
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
/**
 * Elevation.
 *
 * Restrained and LARGE-RADIUS rather than tight and dark: a soft, wide,
 * low-opacity shadow lifts a surface off white without drawing an edge, which
 * is precisely the job the borders used to be doing. `card` is almost
 * subliminal on purpose — it should be felt, not seen.
 */
export const shadowTokens = {
  /** The default card lift. Two very soft layers, no visible edge. */
  card: '0 1px 2px 0 rgba(23, 21, 40, 0.03), 0 6px 16px -8px rgba(23, 21, 40, 0.08)',
  /** Hover, and a card that must sit above its neighbours. */
  raised: '0 2px 4px -1px rgba(23, 21, 40, 0.04), 0 12px 28px -12px rgba(23, 21, 40, 0.12)',
  /** Menus, dialogs, drawers, the Copilot panel. */
  overlay: '0 8px 16px -8px rgba(23, 21, 40, 0.10), 0 24px 48px -16px rgba(23, 21, 40, 0.18)',
  /** A brand-tinted glow, for the sign-in hero and the Copilot header only. */
  brandGlow: '0 18px 48px -18px rgba(121, 53, 254, 0.35)',
  /** The focus ring, as a shadow, for controls that cannot use `outline`. */
  focus: `0 0 0 2px ${colorTokens.focusRingContrast}, 0 0 0 4px ${colorTokens.focusRing}`,
} as const;

/**
 * Corner radius.
 *
 * The scale moved up in the 2C-A revision (D-54): controls sit at 12px and
 * cards at 18–20px, because a 6px corner on a 44px control reads as a form
 * field in a database tool, and a 12px corner on a card reads as a panel. The
 * softer geometry is a large part of what separates "premium product" from
 * "admin template", and it costs nothing.
 */
export const radiusTokens = {
  xs: '0.375rem',
  sm: '0.5rem',
  /** Controls: inputs, buttons, chips. 12px. */
  md: '0.75rem',
  /** Slightly larger control, and small surfaces. 14px. */
  lg: '0.875rem',
  /** Cards and panels. 18px. */
  xl: '1.125rem',
  /** Hero surfaces, sheets and the composer's media well. 24px. */
  '2xl': '1.5rem',
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
/** Fixed layout measurements the shell and its tests both need. */
export const layoutTokens = {
  sidebarExpanded: '17rem',
  sidebarCollapsed: '4.5rem',
  headerHeight: '4rem',
  contentMaxWidth: '88rem',
  copilotPanelWidth: '26rem',
  /** WCAG 2.2 target size (2.5.8) minimum for a pointer target. */
  minTargetSize: '24px',
  /**
   * The comfortable control height. 44px — the brief's 44–48px band, and the
   * size a thumb can hit without aiming. The previous 36px was a desktop-only
   * assumption.
   */
  controlHeight: '2.75rem',
  /** A compact control, for toolbars and table rows. Still 36px. */
  controlHeightSm: '2.25rem',
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
