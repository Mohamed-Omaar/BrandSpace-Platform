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
  /**
   * THE TRANSLUCENT SURFACES, RESOLVED.
   *
   * The full demo builds nearly every plane from white at partial alpha over
   * the ambient ground, with `backdrop-filter: blur(24px)` on the shell. React
   * inline styles carry the alpha directly, so these are the RESOLVED opaque
   * equivalents, used only where a solid value is needed (contrast maths, a
   * sticky header's gradient, a browser without backdrop-filter).
   *
   * `rgba(255,255,255,.78)` over `#F3F3F3` = `#FCFCFC`; the sidebar's
   * `rgba(250,250,251,.78)` = `#F8F8F9`; a metric's `.72` and a surface card's
   * `.82` over the shell both resolve to `#FEFEFE`.
   */
  shellAlpha: 'rgba(255, 255, 255, 0.78)',
  shellSidebarAlpha: 'rgba(250, 250, 251, 0.78)',
  metricAlpha: 'rgba(255, 255, 255, 0.72)',
  surfaceCardAlpha: 'rgba(255, 255, 255, 0.82)',
  floatCardAlpha: 'rgba(255, 255, 255, 0.8)',
  drawerAlpha: 'rgba(255, 255, 255, 0.96)',
  /**
   * `.auth-card { background: rgba(255,255,255,.9) }`. Ninety per cent white on
   * the opaque auth stage resolves to about #FDFCFF, so purple link text on it
   * measures 5.5:1 — comfortably clear of AA.
   */
  authCardAlpha: 'rgba(255, 255, 255, 0.9)',
  /** `.preview-panel, .copilot-panel { background: rgba(255,255,255,.88) }`. */
  previewPanelAlpha: 'rgba(255, 255, 255, 0.88)',
  /** Off-white card fill. The default card surface — near-white, not grey. */
  surfaceSoft: '#F8F8F9',
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
  /** `.ambient { background: #f3f3f3 }` — a shade above the html ground. */
  ambientGround: '#F3F3F3',

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
  /**
   * A rule on a PRINTED page. The screen borders above are tuned for a lit
   * display over `appBackground`; on paper, at print gamma, `border` all but
   * disappears and a table stops having rows. This is the one edge weight that
   * survives a laser printer and still reads as a hairline on screen, and it is
   * used by the invoice document (Phase 10 §23) and nothing else.
   */
  documentRule: '#D8D8DE',

  /** Body text. 17.9:1 on white. */
  textPrimary: '#111114',
  /** Secondary text, labels, captions. 7.55:1 on white — AA at every size. */
  /** `.nav-item { color: #45454b }` and `.hero-copy p { color: #4d4c53 }`. */
  textSecondary: '#4D4C53',
  /**
   * `--muted`, the demo's supporting text colour.
   *
   * DOCUMENTED DEVIATION, and a small one: the demo's `#717179` is 4.44:1 on
   * its own `--soft` (`#F5F5F6`), which is where the search placeholder and the
   * draft status pill sit — just under AA, and 4.29:1 on the lavender the
   * composer's selected account chip uses (the F-32 pairing). Seven steps
   * darker clears 4.5:1 on all thirteen surfaces this system has, with 4.54:1
   * as the floor, and is not perceptibly different from the demo's value.
   */
  textMuted: '#6A6A72',
  /**
   * `--subtle`, the demo's navigation group headings.
   *
   * DOCUMENTED DEVIATION, and the largest colour one: the demo's `#A3A3AA` is
   * **2.36:1** on the sidebar, well under AA, at 9px uppercase. These are the
   * only labels telling a reader what a group of navigation items is for, so
   * they cannot be decorative. Darkened to the same value as `--muted`'s hue
   * family at 4.56:1 on the sidebar.
   */
  textSubtle: '#717178',
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
  /** `rgba(255,255,255,.78)` over the ambient ground, resolved. */
  shellSurface: '#FCFCFC',
  /** `rgba(250,250,251,.78)` — the sidebar's own plane. */
  shellSidebar: '#F8F8F9',
  /** The main panel takes the shell's own translucency; nothing extra. */
  shellPanel: 'transparent',

  /* ---------------------------------------------------------------------- */
  /* Semantic                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Error text. Darkened from `#D92D20`, which reached only 4.44:1 against its
   * own tint — a banner whose text was the one thing in it that failed AA.
   */
  danger: '#B83245',
  dangerTint: '#FDECEF',
  dangerBorder: '#FDA29B',
  warning: '#875F00',
  warningTint: '#FFF6D3',
  warningBorder: '#FEC84B',
  success: '#16794B',
  successTint: '#E8F8EF',
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
  /**
   * `.hero-copy h2` — `clamp(38px, 5vw, 68px)`, line-height .94,
   * letter-spacing -.065em, weight 700. Measured at 1440: 68px / 63.92.
   */
  display: {
    fontSize: 'clamp(2.375rem, 5vw, 4.25rem)',
    lineHeight: '0.94',
    fontWeight: 700,
    letterSpacing: '-0.065em',
  },
  /** `.topbar h1` — 24px, weight 700, -.04em. Fixed, not fluid. */
  h1: { fontSize: '1.5rem', lineHeight: '1.75rem', fontWeight: 700, letterSpacing: '-0.04em' },
  /** `.view-toolbar h2` — the in-page view title, 29px / -.035em. */
  h2: { fontSize: '1.8125rem', lineHeight: '2.125rem', fontWeight: 700, letterSpacing: '-0.035em' },
  /**
   * `.auth-card h2` — 34px / -.05em. The entry screens carry a heading a full
   * step above the in-app view title, which is what makes sign-in read as a
   * front door rather than another panel. Named for its purpose (§37) because
   * no other surface uses this size.
   */
  authHeading: {
    fontSize: '2.125rem',
    lineHeight: '2.375rem',
    fontWeight: 700,
    letterSpacing: '-0.05em',
  },
  /** `.section-head h3` — 18px / -.035em, the title inside a surface card. */
  h3: { fontSize: '1.125rem', lineHeight: '1.4rem', fontWeight: 700, letterSpacing: '-0.035em' },
  /**
   * `.feature-card h3` — 15px / 700, `margin: 22px 0 7px`. The title of a card
   * in a GRID of cards, a step under the title of a section: six of them in a
   * row at the section step reads as six sections.
   */
  cardTitle: {
    fontSize: '0.9375rem',
    lineHeight: '1.25rem',
    fontWeight: 700,
    letterSpacing: 'normal',
  },
  /** Body copy. `body { font-size: 15px }`, `.hero-copy p { line-height: 1.6 }`. */
  body: { fontSize: '0.9375rem', lineHeight: '1.6', fontWeight: 400, letterSpacing: 'normal' },
  /** `.item-copy b`, `.nav-item`, `.quick-card b` — the demo's 11px workhorse. */
  bodySm: { fontSize: '0.6875rem', lineHeight: '1rem', fontWeight: 400, letterSpacing: 'normal' },
  /** `.workspace-copy strong`, `.profile-copy strong` — 12px / 700. */
  label: { fontSize: '0.75rem', lineHeight: '0.875rem', fontWeight: 700, letterSpacing: 'normal' },
  /** `.metric span`, `.item-copy small`, `.quick-card small` — 9px / 400. */
  caption: {
    fontSize: '0.5625rem',
    lineHeight: '0.75rem',
    fontWeight: 400,
    letterSpacing: 'normal',
  },
  /**
   * The demo's 8px tier: `.social-preview header small`, `.calendar-post b`,
   * `.status`, `.weekday`, `.table-row.header`, `.toggle-row small`. Small
   * enough that it is only ever used for secondary metadata, and only against
   * a colour that clears AA — `textMuted`, never `textSubtle`.
   */
  micro: { fontSize: '0.5rem', lineHeight: '0.6875rem', fontWeight: 400, letterSpacing: 'normal' },
  /**
   * `.eyebrow`, `.section-kicker`, `.nav-group-title` — 9px, weight 800,
   * letter-spacing .08em, uppercase.
   */
  overline: {
    fontSize: '0.5625rem',
    lineHeight: '0.625rem',
    fontWeight: 800,
    letterSpacing: '0.08em',
  },
  /** `.metric strong` — 30px / 700 / -.05em. */
  numeric: {
    fontSize: '1.875rem',
    lineHeight: '2.125rem',
    fontWeight: 700,
    letterSpacing: '-0.05em',
  },
  /**
   * `.primary-button, .dark-button, .ghost-button, .soft-button` — 10px / 800.
   * The demo's buttons are small and heavy; that pairing is deliberate and is
   * what keeps a 40px control from reading as an enterprise form field.
   */
  button: {
    fontSize: '0.625rem',
    lineHeight: '0.875rem',
    fontWeight: 800,
    letterSpacing: 'normal',
  },
  /** `.nav-item` — 11px / 650. */
  navLabel: {
    fontSize: '0.6875rem',
    lineHeight: '1rem',
    fontWeight: 650,
    letterSpacing: 'normal',
  },
  /** `.brand` — 16px / 850. A wordmark, not a heading. */
  wordmark: { fontSize: '1rem', lineHeight: '1.125rem', fontWeight: 850, letterSpacing: 'normal' },
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
  /** `.auth-card` — `0 24px 70px rgba(44,25,82,.12)`. Violet-tinted, not grey. */
  authCard: '0 24px 70px rgba(44, 25, 82, 0.12)',
  /** `--shadow` — the application shell. */
  shell: '0 24px 70px rgba(20, 16, 35, 0.1)',
  /** `--soft-shadow` — the hero and every surface card. */
  card: '0 12px 35px rgba(16, 14, 28, 0.06)',
  /** `.metric` — lighter still, because four sit in a row. */
  metric: '0 8px 25px rgba(0, 0, 0, 0.035)',
  /** `.experience-current` — the rail's identity card. */
  rail: '0 7px 20px rgba(0, 0, 0, 0.035)',
  /** `.nav-item.active` — the ink pill lifts off the rail. */
  navActive: '0 8px 18px rgba(17, 17, 20, 0.15)',
  /** `.float-card` — the hero's floating cards, tinted violet. */
  float: '0 18px 45px rgba(73, 48, 112, 0.12)',
  /** `.segmented button.selected` — a selected segment on a soft track. */
  raised: '0 5px 14px rgba(0, 0, 0, 0.05)',
  /** `.experience-menu`, drawers and dialogs. */
  overlay: '0 22px 55px rgba(0, 0, 0, 0.16)',
  /** `.side-drawer` — `0 30px 80px rgba(0,0,0,.2)`. Deeper than a menu's. */
  drawer: '0 30px 80px rgba(0, 0, 0, 0.2)',
  /** `.command-dialog` — `0 35px 90px rgba(0,0,0,.24)`. The deepest in the system. */
  commandDialog: '0 35px 90px rgba(0, 0, 0, 0.24)',
  /** A brand-tinted glow. Used sparingly; the demo has no purple glow. */
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
  /** `.search-button kbd`, 5px. */
  xs: '0.3125rem',
  /** `.nav-item:hover::after` tooltip, 8px. */
  sm: '0.5rem',
  /** Controls: `.filter-row button`, `.segmented button`, 10px. */
  md: '0.625rem',
  /** `.search-field`, 11px; `.brand-mark`, 11px. */
  lg: '0.6875rem',
  /**
   * THE DEMO'S DEFAULT CONTROL RADIUS, 12px. `.icon-button`, `.nav-item`,
   * `.primary-button`, `.dark-button`, `.search-button`, `.experience-icon`,
   * `.profile-avatar` — almost everything a finger touches.
   */
  control: '0.75rem',
  /** `.segmented`, `.tabs` container, 13px; `.thumb`, 13px. */
  xl: '0.8125rem',
  /** `.experience-current`, `.profile-button`, `.quick-card`, 16px. */
  rail: '1rem',
  /** `.surface-card`, 18px. */
  '2xl': '1.125rem',
  /** `.float-card`, `.metric`, 20px. */
  card: '1.25rem',
  /** `.hero-card`, 28px. */
  '3xl': '1.75rem',
  /** `.studio { border-radius: 25px }` — the editor surface, one step under the shell. */
  studio: '1.5625rem',
  /** `.app-shell`, 34px. */
  shell: '2.125rem',
  /** `.label-pill`, `.status`, `.nav-badge`, 99px. */
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
  /* ---------------------------------------------------------------------- */
  /* MEASURED FROM THE FULL DEMO at the pinned commit, in Chromium, at        */
  /* 1440x900. Named here so no page invents an approximation (§37).          */
  /* ---------------------------------------------------------------------- */

  /** `--sidebar: 248px`. */
  sidebarExpanded: '15.5rem',
  /** `.app-shell.sidebar-collapsed { grid-template-columns: 78px … }`. */
  sidebarCollapsed: '4.875rem',
  /** `.topbar { min-height: 88px }`. */
  headerHeight: '5.5rem',
  /** `.app-shell { margin: 20px auto }`. */
  shellInset: '1.25rem',
  /** `.app-shell { width: min(1540px, calc(100% - 40px)) }`. */
  shellMaxWidth: '96.25rem',
  /** `.sidebar { padding: 18px 14px 14px }`. */
  railPadInline: '0.875rem',
  railPadBlockStart: '1.125rem',
  railPadBlockEnd: '0.875rem',
  /** `.sidebar-top { height: 54px; padding: 0 5px }`. */
  railTopHeight: '3.375rem',
  railTopPadInline: '0.3125rem',
  /** `.sidebar-collapsed .sidebar-top { height: 90px; gap: 8px }`. */
  railTopHeightCollapsed: '5.625rem',
  /** `.nav-group { margin-bottom: 17px }`. */
  navGroupGap: '1.0625rem',
  /** `.nav-group-title { padding: 0 12px 7px }`. */
  navGroupTitlePad: '0 0.75rem 0.4375rem',
  /** `.nav-item { height: 39px; padding: 0 11px; gap: 11px }`. */
  navItemHeight: '2.4375rem',
  navItemPadInline: '0.6875rem',
  navItemGap: '0.6875rem',
  /** `.nav-icon { width: 20px; font-size: 14px }`. */
  navIconSlot: '1.25rem',
  navIconGlyph: '0.875rem',
  /** `.experience-current`, `.profile-button` — 38px identity block. */
  railAvatar: '2.375rem',
  railCardPad: '0.625rem',
  railCardPadTight: '0.5rem',
  railCardGap: '0.5625rem',
  /** `.main-panel { padding: 0 28px 36px }`. */
  panelPadInline: '1.75rem',
  panelPadBlockEnd: '2.25rem' /* `.main-panel { padding: 0 28px 36px }`. */,
  /** `.topbar { gap: 16px }`, `.topbar-actions { gap: 7px }`. */
  topbarGap: '1rem',
  topbarActionGap: '0.4375rem',
  /** `.icon-button` — 38px square. */
  iconButton: '2.375rem',
  /** `.search-button { width: 230px; height: 38px }`. */
  searchWidth: '14.375rem',
  /** `.social-preview .avatar` — 34px, round. */
  previewAvatar: '2.125rem',
  /**
   * The composer's preview column — `.composer { grid-template-columns:
   * minmax(350px,1fr) 340px 300px }`. The post preview is drawn at 340px and
   * does not widen, because that is the width its composition was drawn at.
   */
  socialPreviewWidth: '21.25rem',
  /** `.studio { min-height: 660px }`. */
  studioMinHeight: '41.25rem',
  /** `.composer` middle column, the live preview panel. */
  composerPreviewColumn: '21.25rem',
  /** `.composer` trailing column, the Copilot panel. */
  composerCopilotColumn: '18.75rem',
  /** `.studio { grid-template-columns: 84px 240px 1fr 230px }`. */
  studioToolRailWidth: '5.25rem',
  studioAssetsWidth: '15rem',
  studioPropsWidth: '14.375rem',
  /** `.settings-grid { grid-template-columns: 220px 1fr }`. */
  settingsNavWidth: '13.75rem',
  /** `.side-drawer { width: min(430px, calc(100vw - 40px)) }`. */
  drawerWidth: '26.875rem',
  /** `.command-dialog { width: min(570px, calc(100% - 30px)) }`. */
  commandDialogWidth: '35.625rem',
  /** `.brand-mark { width: 34px; height: 34px; font-size: 15px }`. */
  brandMark: '2.125rem',
  brandMarkGlyph: '0.9375rem',
  /** `.brand { gap: 10px }`. */
  brandGap: '0.625rem',
  /** `.hero-card { min-height: 330px }`, `.hero-copy { padding: 48px }`. */
  heroMinHeight: '20.625rem',
  heroPad: '3rem',
  /** `.metric { padding: 20px }`, `.metric-row { gap: 10px; margin: 14px 0 }`. */
  metricPad: '1.25rem',
  metricGap: '0.625rem',
  metricRowMargin: '0.875rem',
  /** `.surface-card { padding: 22px }`, `.dashboard-grid { gap: 14px }`. */
  surfacePad: '1.375rem',
  sectionGap: '0.875rem',
  /** `.section-head { margin-bottom: 15px; gap: 15px }`. */
  sectionHeadGap: '0.9375rem',
  /** `.view-toolbar { min-height: 74px; margin-bottom: 12px }`. */
  viewToolbarHeight: '4.625rem',
  /** WCAG 2.2 target size (2.5.8) minimum for a pointer target. */
  minTargetSize: '24px',
  /**
   * `.primary-button, .dark-button, … { min-height: 40px }` and
   * `.compact { min-height: 38px }`. The demo runs TWO control heights and the
   * difference is deliberate, so both are named rather than averaged.
   */
  controlHeight: '2.5rem',
  controlHeightSm: '2.375rem',
  /** `.filter-row button, .segmented button { min-height: 36px }`. */
  controlHeightXs: '2.25rem',
  contentMaxWidth: '96.25rem',
  copilotPanelWidth: '18.75rem',
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
  /*
   * `.ambient { background: #f3f3f3 }` with three 56vw orbs at
   * `filter: blur(100px)`:
   *   `.orb-purple { left: -18vw; top: -28vw; opacity: .38 }`
   *   `.orb-yellow { right: -20vw; bottom: -29vw; opacity: .38; delay -7s }`
   *   `.orb-mix    { right: 12vw;  top: 25vh;   opacity: .22; delay -11s }`
   * drifting `translate(5vw, 4vh) scale(1.08)` over 16s.
   *
   * The third orb sits INSIDE the viewport at 25vh, not off the top corner —
   * it is what puts warm pink light behind the middle of the shell, and it is
   * only visible at all because the shell is translucent.
   */
  ground: '#F3F3F3',
  purple: colorTokens.brandPurple,
  purpleOpacity: 0.38,
  purpleInsetInline: '-18vw',
  purpleInsetBlock: '-28vw',
  yellow: colorTokens.brandYellow,
  yellowOpacity: 0.38,
  yellowInsetInline: '-20vw',
  yellowInsetBlock: '-29vw',
  blush: '#FF99B9',
  blushOpacity: 0.22,
  blushInsetInline: '12vw',
  blushInsetBlock: '25vh',
  size: '56vw',
  blur: '100px',
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
  hero:
    'radial-gradient(circle at 72% 28%, rgba(255, 153, 185, 0.55), transparent 30%),' +
    ' radial-gradient(circle at 28% 80%, rgba(255, 221, 21, 0.52), transparent 35%),' +
    ' linear-gradient(135deg, #F7F3FF, #FFF)',
  /**
   * `.auth-stage` — the entry screens' ground. An OPAQUE base under two soft
   * washes, which is the reason it exists rather than letting the ambient orbs
   * show through: a translucent stage put the "forgot password" link on a
   * yellow blend at 4.12:1 (axe `color-contrast`, serious). The demo has the
   * same opaque stage.
   */
  authStage:
    'radial-gradient(circle at 72% 25%, rgba(255, 153, 185, 0.42), transparent 27%),' +
    ' radial-gradient(circle at 25% 78%, rgba(255, 221, 21, 0.5), transparent 30%),' +
    ' linear-gradient(145deg, #F8F4FF, #FFF)',
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

/**
 * Brand Brain orb tokens — the approved demo's own values, not approximations.
 *
 * The orb is drawn on a canvas, so its colours cannot come from a stylesheet;
 * they have to be strings in the drawing code. The design system forbids hex
 * literals in application source, and that rule is right — but satisfying it by
 * reaching for the nearest existing token is the trap
 * `docs/UI-FIDELITY-CONTRACT.md` §2 names: a token that is *close* silently
 * repaints a design that was approved at a specific value.
 *
 * So these are NAMED tokens carrying the EXACT values from
 * `demo/brand-brain-native.js` at commit b01d9473. They are spelled exactly as
 * the demo spells them, lowercase included, so that a reviewer diffing this
 * block against the vendored snapshot sees character-for-character equality.
 * `tests/unit/ui-fidelity-manifest.test.ts` asserts that equality.
 *
 * `brandPurple` and `brandYellow` already hold the same two colours in upper
 * case. These exist ALONGSIDE them rather than instead of them because the orb's
 * values must never drift when a brand token is retuned: this is a transcription
 * of an approved drawing, and the contract's rule 9 governs changing it.
 */
export const brandBrainTokens = {
  /** `outer` particles and the links between them. */
  orbOuter: '#7935fe',
  /** `inner` particles and the straight links between them. */
  orbInner: '#ffdd15',
  /** Every third particle, and the orb's ink text. */
  orbInk: '#111114',
  /** A particle at full energy flares to white before decaying. */
  orbFlare: '#ffffff',
} as const;
