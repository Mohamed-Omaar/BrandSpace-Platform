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
  brandPurpleTint: '#F0E9FF',
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
  surfaceSoft: '#F9F9FA',
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
  surfaceMuted: '#F5F5F6',
  /** Slightly deeper inset, for a nested surface on an already-muted one. */
  surfaceSunken: '#EDEFF3',
  /** A dark surface, for the Design Studio canvas frame and media chrome. */
  surfaceInk: '#181620',
  /**
   * THE APPLICATION GROUND IS WHITE (D-49, reaffirmed in D-54). Structure now
   * comes from tinted surfaces, spacing and radius rather than from borders —
   * but the ground itself is still white, so the product reads as open rather
   * than as a grey utility.
   */
  appBackground: '#F2F2F2',

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
  controlSurface: '#F5F5F6',
  /** Hover fill. Perceptible without becoming a second state to read. */
  controlSurfaceHover: '#ECECEF',
  /** Focused fill: white, so the purple ring reads at full strength. */
  controlSurfaceFocus: '#FFFFFF',
  /** Disabled fill. Paired with `textMuted`, never with `textPrimary`. */
  controlSurfaceDisabled: '#F7F7F8',
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
  hairline: '#F0F0F2',
  /** Card border. Subtle by design; the shadow carries the rest. 1.28:1. */
  cardBorder: '#EEEEF0',
  /** Default border for dividers. 1.44:1 — decorative. */
  border: '#E8E8EA',
  /**
   * A boundary that must be PERCEIVABLE — WCAG 1.4.11 wants 3:1 for a UI
   * component boundary, and `#98A2B3`, the obvious mid-grey and the first
   * value tried here, scores 2.58:1. Used for high-contrast mode, for a
   * control in an error state, and anywhere an edge is load-bearing rather
   * than decorative.
   */
  borderStrong: '#818C9C',

  /** Body text. 17.9:1 on white. */
  textPrimary: '#111114',
  /** Secondary text, labels, captions. 7.55:1 on white — AA at every size. */
  textSecondary: '#5B5B62',
  /** Placeholder and disabled text. 4.61:1 on white — still AA for normal text. */
  textMuted: '#6A6A71',
  /** Foreground on a dark or saturated surface. */
  textInverse: '#FFFFFF',

  /* ------------------------------------------------------------------ */
  /* INK — the approved demo's primary action colour.                     */
  /*                                                                      */
  /* The reference has TWO primary treatments, and reproducing only one   */
  /* would lose half the direction: `.dark-button` (near-black) carries   */
  /* almost every action — the hero CTA, Schedule post, Export, Edit post */
  /* — while `.primary-button` (purple) is reserved for the single        */
  /* "+ Create" entry point. Black is the workhorse; purple is the        */
  /* accent that starts something new.                                    */
  /* ------------------------------------------------------------------ */

  /** `--ink`. Near-black, not pure black. 18.85:1 against white. */
  ink: '#111114',
  /** Hover for a filled ink surface. */
  inkHover: '#26262B',
  /** Foreground on `ink`. */
  inkInk: '#FFFFFF',

  /* The floating application shell, over the ambient page. */
  /** `rgba(255,255,255,.94)` over `#F2F2F2`, resolved. */
  shellSurface: '#FCFCFC',
  /** The sidebar's own slightly cooler plane. */
  shellSidebar: '#F9F9FA',
  /** The main panel inside the shell. */
  shellPanel: '#FDFDFD',

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
 * RETUNED TO THE APPROVED DEMO. The direction's typography is not a size
 * choice, it is a TRACKING choice: the reference sets its titles at strongly
 * negative letter-spacing (-0.045em on a page title, -0.06em on the hero
 * statement) with leading close to 1, which is what makes a large heading read
 * as a confident statement rather than as a banner. Supporting text stays
 * small, quiet and generously led, so the contrast between the two is the
 * hierarchy — no rules, no boxes, no colour needed.
 *
 * The two title steps are FLUID (`clamp`) exactly as the reference is, so a
 * heading is large on a desktop and still fits a 390px phone without wrapping
 * into four lines.
 */
export const typographyTokens = {
  /** The hero statement. Measured: 57.6px / 56.45 / 700 / -3.456px at 1440. */
  display: {
    fontSize: 'clamp(2.125rem, 4vw, 3.75rem)',
    lineHeight: '0.98',
    fontWeight: 700,
    letterSpacing: '-0.06em',
  },
  /** The page title in the top bar. `clamp(24px, 2.4vw, 35px)`. */
  h1: {
    fontSize: 'clamp(1.5rem, 2.4vw, 2.1875rem)',
    // Measured: 34.56px with line-height 34.56 — exactly 1. The tight leading
    // is what lets the eyebrow sit 4px above the cap height rather than
    // floating off it, which is most of why the reference's top bar reads as
    // one block instead of two stacked lines.
    lineHeight: '1',
    fontWeight: 700,
    letterSpacing: '-0.045em',
  },
  /** A section title inside a surface. `.section-head h3`: 20px / 700 / -0.6px. */
  h2: { fontSize: '1.25rem', lineHeight: '1.5rem', fontWeight: 700, letterSpacing: '-0.03em' },
  /** A card or group title. */
  h3: { fontSize: '0.9375rem', lineHeight: '1.375rem', fontWeight: 700, letterSpacing: '-0.02em' },
  /** `.hero-copy p`: 16px / 25.6 (1.6) / 400, no tracking. */
  body: { fontSize: '1rem', lineHeight: '1.6', fontWeight: 400, letterSpacing: 'normal' },
  bodySm: { fontSize: '0.875rem', lineHeight: '1.5', fontWeight: 400, letterSpacing: '0' },
  /** `.nav-item span` and `.workspace-copy strong`: 13px, 650, no tracking. */
  label: {
    fontSize: '0.8125rem',
    lineHeight: '1.25rem',
    fontWeight: 650,
    letterSpacing: 'normal',
  },
  /** `.metric > span`: 12px / 400. The reference sets no weight on a caption. */
  caption: { fontSize: '0.75rem', lineHeight: '1.15rem', fontWeight: 400, letterSpacing: 'normal' },
  /**
   * The eyebrow/kicker above a title.
   *
   * `.eyebrow` and `.section-kicker`, measured: 10px, weight 800, tracking
   * 1.1px (0.11em), uppercase, leading 11px.
   *
   * The size was held at 11px in the first demo alignment and the fidelity pass
   * restored the reference's 10px: no accessibility rule sets a minimum font
   * size, so that exception was not carrying its weight. The exception that IS
   * necessary is kept — the reference's own `#707077` fails AA on its own
   * ground, so this sits on `textMuted` instead.
   */
  overline: {
    fontSize: '0.625rem',
    lineHeight: '0.6875rem',
    fontWeight: 800,
    letterSpacing: '0.11em',
  },
  /** `.metric strong`: 32px / 700 / -1.28px (-0.04em). */
  numeric: {
    fontSize: '2rem',
    lineHeight: '2.375rem',
    fontWeight: 700,
    letterSpacing: '-0.04em',
  },
} as const;

export type TypographyToken = keyof typeof typographyTokens;

/**
 * Elevation.
 *
 * RETUNED TO THE APPROVED DEMO. The reference lifts a surface with a shadow
 * that is WIDE, FAR and very low in opacity — `0 12px 40px rgba(0,0,0,.05)` on
 * a card — rather than with a tight dark one. That is what lets a card carry no
 * border at all and still read as a separate plane: the eye reads the gradient
 * of light under it, not an edge. A tight shadow at the same opacity is
 * invisible; a tight shadow dark enough to see reads as a cheap drop shadow.
 *
 * Nothing here is "heavy". §3 of the brief forbids excessive shadow, and the
 * largest value in the set is reserved for a drawer that genuinely floats above
 * a scrim.
 */
export const shadowTokens = {
  /** The application shell itself, floating over the ambient ground. */
  shell: '0 24px 70px rgba(20, 16, 35, 0.1)',
  /** The default surface lift. Felt, not seen. */
  card: '0 12px 40px rgba(0, 0, 0, 0.05)',
  /** A small statistic surface — lighter still, because there are four in a row. */
  metric: '0 8px 30px rgba(0, 0, 0, 0.045)',
  /** Hover, and a surface that must sit above its neighbours. */
  raised: '0 18px 42px rgba(0, 0, 0, 0.1)',
  /** Drawers and dialogs, which float above a scrim. */
  overlay: '0 30px 80px rgba(0, 0, 0, 0.2)',
  /** The purple glow under the single accent call to action. */
  brandGlow: '0 10px 24px rgba(121, 53, 254, 0.2)',
  /** The focus ring, as a shadow, for controls that cannot use `outline`. */
  focus: `0 0 0 2px ${colorTokens.focusRingContrast}, 0 0 0 4px ${colorTokens.focusRing}`,
} as const;

/**
 * Corner radius.
 *
 * RETUNED TO THE APPROVED DEMO, which is markedly softer than the previous
 * scale: a 13px control, an 18px statistic, a 22px post card, a 28px surface
 * and a 32px application shell. The reference's `--radius-lg: 28px` and
 * `--radius-md: 18px` are the two anchors; the rest fall between them.
 *
 * This is not decoration. A 6px corner on a 44px control reads as a database
 * form field, and it was a large part of why the first draft read as an admin
 * template. Geometry carries as much of the "premium, soft, modern" direction
 * as colour does, and it costs nothing.
 */
export const radiusTokens = {
  xs: '0.375rem',
  /** `.brand-mark`, 10px. */
  sm: '0.625rem',
  /** `.workspace-switcher` / `.profile-button`, 15px. */
  rail: '0.9375rem',
  /** Controls: inputs, buttons, chips, nav items. 13px in the reference. */
  md: '0.8125rem',
  /** Statistics, small surfaces, media wells. `--radius-md`, 18px. */
  lg: '1.125rem',
  /** Post cards and tiles. 22px. */
  xl: '1.375rem',
  /** Large surfaces, hero areas and drawers. `--radius-lg`, 28px. */
  '2xl': '1.75rem',
  /** The application shell itself. 32px. */
  '3xl': '2rem',
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

/**
 * Fixed layout measurements the shell and its tests both need.
 *
 * MEASURED FROM THE APPROVED DEMO: a 250px expanded sidebar, a 78px collapsed
 * rail, a 92px top bar, and a 20px inset all round because the shell FLOATS on
 * the ambient ground rather than filling the window.
 */
export const layoutTokens = {
  /** `grid-template-columns: 250px minmax(0, 1fr)` in the reference. */
  sidebarExpanded: '15.625rem',
  /** The collapsed rail. 78px — wide enough for a 44px target, centred. */
  sidebarCollapsed: '4.875rem',
  /** `min-height: 92px` on the reference top bar. Generous on purpose. */
  headerHeight: '5.75rem',
  /** The gap between the shell and the window edge, on all four sides. */
  shellInset: '1.25rem',

  /* --------------------------------------------------------------------- */
  /* MEASURED FROM THE RENDERED REFERENCE, not read off its stylesheet.     */
  /*                                                                        */
  /* The fidelity pass put the demo in a browser at 1440x900 beside the     */
  /* product and compared boxes, because a stylesheet tells you what an     */
  /* author typed and a bounding box tells you what a reader sees. These    */
  /* are the numbers that came back, named once here so no page invents an  */
  /* approximation of them (§17).                                           */
  /* --------------------------------------------------------------------- */

  /** `.sidebar { padding: 20px 14px }`. */
  railPadInline: '0.875rem',
  railPadBlock: '1.25rem',
  /** `.sidebar-top { height: 42px; margin: 0 3px 18px }`. */
  railTopHeight: '2.625rem',
  /** `.nav-list { gap: 5px; margin-top: 18px }`. */
  navGap: '0.3125rem',
  /** `.nav-item { padding: 0 12px; gap: 12px }`. */
  navItemPadInline: '0.75rem',
  navItemGap: '0.75rem',
  /** `.workspace-switcher`, `.profile-button` — 54px tall, 10px padding. */
  railCardHeight: '3.375rem',
  railCardPad: '0.625rem',
  /** The avatar column in a rail card. */
  railAvatar: '2.125rem',
  /** `.main-panel { padding: 0 28px 34px }`. */
  panelPadInline: '1.75rem',
  panelPadBlockEnd: '2.125rem',
  /** `.topbar { gap: 20px }`. */
  topbarGap: '1.25rem',
  /** `.dashboard-grid`, `.metric-row` and `.section-head` all use 18px. */
  sectionGap: '1.125rem',
  /** `.icon-button` — 40px square, 13px radius. */
  iconButton: '2.5rem',
  /** `.metric { padding: 20px }` — between the `md` and `lg` spacing steps. */
  metricPad: '1.25rem',
  contentMaxWidth: '88rem',
  copilotPanelWidth: '24.375rem',
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
 * THE AMBIENT BACKGROUND — the single most identifying element of the approved
 * direction, and the one that must not be mistaken for a colourful theme.
 *
 * The brand purple and yellow appear at full saturation exactly once in the
 * product: as three enormous, heavily blurred, low-opacity orbs drifting behind
 * a floating white shell. At 56vw across with a 100px blur they never read as
 * shapes — they read as light. That is what §3 means by "brand colour as a
 * soft, blurred, atmospheric background gradient" rather than as a UI theme,
 * and it is why the interface itself can stay almost entirely black and white.
 *
 * Nothing here ever sits behind text. The shell is opaque above it.
 */
export const ambientTokens = {
  /** The page ground the shell floats on. */
  ground: colorTokens.appBackground,
  /** Inline-start, top. The dominant one. */
  purple: colorTokens.brandPurple,
  purpleOpacity: 0.38,
  /** Inline-end, bottom. */
  yellow: colorTokens.brandYellow,
  yellowOpacity: 0.38,
  /** The smaller third orb, where the two meet. */
  blush: '#FF99B9',
  blushOpacity: 0.24,
  /** Large enough that no edge of an orb is ever visible. */
  size: '56vw',
  sizeSmall: '30vw',
  blur: '100px',
  /** A very slow drift. Neutralised entirely by `prefers-reduced-motion`. */
  driftDuration: '16s',
} as const;

/**
 * Gradients, named once.
 *
 * Two jobs: the hero wash behind the Overview's welcome area, and the
 * deterministic artwork that stands in for media (D-57). Both are built from
 * the brand pair, both are soft, and neither is ever a background for body
 * text without an opaque surface between them.
 */
export const gradientTokens = {
  /** The Overview hero. Yellow → white → purple, all under 35% opacity. */
  hero: 'linear-gradient(120deg, rgba(255, 221, 21, 0.35), rgba(255, 255, 255, 0.65) 42%, rgba(121, 53, 254, 0.34))',
  /** Artwork A — light lavender rising into purple, warmed by yellow. */
  artLight: 'linear-gradient(145deg, #F2E9FF 0%, #B686FF 38%, #7935FE 65%, #FFDD15 135%)',
  /** Artwork B — near-black into purple. Carries white text. */
  artInk: 'linear-gradient(145deg, #17111F, #7935FE 72%, #FFDD15 145%)',
  /** Artwork C — cream into pale lavender. The quietest of the four. */
  artCream: 'linear-gradient(145deg, #FFFDE9, #F7EFFF 60%, #CBAEFF)',
  /** Artwork D — ink into deep violet. Carries white text. */
  artDeep: 'linear-gradient(145deg, #111114, #3C216D 56%, #7935FE)',
} as const;

export type GradientToken = keyof typeof gradientTokens;

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
