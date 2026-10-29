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

export const colorValues = {
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

  /**
   * UI-1 (prototype v94): the ONE scrollbar thumb, everywhere. The resting
   * value is the grey the dropdown panel already used for its "quiet
   * scrollbar", so no new grey entered the system; hover darkens it to
   * `textMuted`. A design-system extension (UI-FIDELITY-CONTRACT §6), not a
   * demo port: the demo styles only the sidebar's hidden scroller.
   */
  scrollbarThumb: '#9A9AA2',
  scrollbarThumbHover: '#6A6A72',

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

export type ColorToken = keyof typeof colorValues;

/**
 * Spacing scale (rem), applied through LOGICAL properties so Arabic mirrors
 * without a second stylesheet.
 *
 * The `2xl`/`3xl` steps exist for the generous page-level whitespace the
 * approved direction asks for; component padding stays in `sm`…`lg`.
 */
export const spacingTokens = {
  '3xs': 'var(--bsp-rem-0-125)',
  '2xs': 'var(--bsp-rem-0-1875)',
  xs: 'var(--bsp-rem-0-25)',
  sm: 'var(--bsp-rem-0-5)',
  md: 'var(--bsp-rem-1)',
  lg: 'var(--bsp-rem-1-5)',
  xl: 'var(--bsp-rem-2)',
  '2xl': 'var(--bsp-rem-3)',
  '3xl': 'var(--bsp-rem-4)',
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
  h1: {
    fontSize: 'var(--bsp-fs-24)',
    lineHeight: 'var(--bsp-rem-1-75)',
    fontWeight: 700,
    letterSpacing: '-0.04em',
  },
  /** `.view-toolbar h2` — the in-page view title, 29px / -.035em. */
  h2: {
    fontSize: 'var(--bsp-fs-29)',
    lineHeight: 'var(--bsp-rem-2-125)',
    fontWeight: 700,
    letterSpacing: '-0.035em',
  },
  /**
   * `.auth-card h2` — 34px / -.05em. The entry screens carry a heading a full
   * step above the in-app view title, which is what makes sign-in read as a
   * front door rather than another panel. Named for its purpose (§37) because
   * no other surface uses this size.
   */
  authHeading: {
    fontSize: 'var(--bsp-fs-34)',
    lineHeight: 'var(--bsp-rem-2-375)',
    fontWeight: 700,
    letterSpacing: '-0.05em',
  },
  /** `.section-head h3` — 18px / -.035em, the title inside a surface card. */
  h3: {
    fontSize: 'var(--bsp-fs-18)',
    lineHeight: 'var(--bsp-rem-1-4)',
    fontWeight: 700,
    letterSpacing: '-0.035em',
  },
  /**
   * `.feature-card h3` — 15px / 700, `margin: 22px 0 7px`. The title of a card
   * in a GRID of cards, a step under the title of a section: six of them in a
   * row at the section step reads as six sections.
   */
  cardTitle: {
    fontSize: 'var(--bsp-fs-15)',
    lineHeight: 'var(--bsp-rem-1-25)',
    fontWeight: 700,
    letterSpacing: 'normal',
  },
  /** Body copy. `body { font-size: 15px }`, `.hero-copy p { line-height: 1.6 }`. */
  body: {
    fontSize: 'var(--bsp-fs-15)',
    lineHeight: '1.6',
    fontWeight: 400,
    letterSpacing: 'normal',
  },
  /** `.item-copy b`, `.nav-item`, `.quick-card b` — the demo's 11px workhorse. */
  bodySm: {
    fontSize: 'var(--bsp-fs-11)',
    lineHeight: 'var(--bsp-rem-1)',
    fontWeight: 400,
    letterSpacing: 'normal',
  },
  /** `.workspace-copy strong`, `.profile-copy strong` — 12px / 700. */
  label: {
    fontSize: 'var(--bsp-fs-12)',
    lineHeight: 'var(--bsp-rem-0-875)',
    fontWeight: 700,
    letterSpacing: 'normal',
  },
  /** `.metric span`, `.item-copy small`, `.quick-card small` — 9px / 400. */
  caption: {
    fontSize: 'var(--bsp-fs-9)',
    lineHeight: 'var(--bsp-rem-0-75)',
    fontWeight: 400,
    letterSpacing: 'normal',
  },
  /**
   * The demo's 8px tier: `.social-preview header small`, `.calendar-post b`,
   * `.status`, `.weekday`, `.table-row.header`, `.toggle-row small`. Small
   * enough that it is only ever used for secondary metadata, and only against
   * a colour that clears AA — `textMuted`, never `textSubtle`.
   */
  micro: {
    fontSize: 'var(--bsp-fs-8)',
    lineHeight: 'var(--bsp-rem-0-6875)',
    fontWeight: 400,
    letterSpacing: 'normal',
  },
  /**
   * `.eyebrow`, `.section-kicker`, `.nav-group-title` — 9px, weight 800,
   * letter-spacing .08em, uppercase.
   */
  overline: {
    fontSize: 'var(--bsp-fs-9)',
    lineHeight: 'var(--bsp-rem-0-625)',
    fontWeight: 800,
    letterSpacing: '0.08em',
  },
  /** `.metric strong` — 30px / 700 / -.05em. */
  numeric: {
    fontSize: 'var(--bsp-fs-30)',
    lineHeight: 'var(--bsp-rem-2-125)',
    fontWeight: 700,
    letterSpacing: '-0.05em',
  },
  /**
   * `.primary-button, .dark-button, .ghost-button, .soft-button` — 10px / 800.
   * The demo's buttons are small and heavy; that pairing is deliberate and is
   * what keeps a 40px control from reading as an enterprise form field.
   */
  button: {
    fontSize: 'var(--bsp-fs-10)',
    lineHeight: 'var(--bsp-rem-0-875)',
    fontWeight: 800,
    letterSpacing: 'normal',
  },
  /** `.nav-item` — 11px / 650. */
  navLabel: {
    fontSize: 'var(--bsp-fs-11)',
    lineHeight: 'var(--bsp-rem-1)',
    fontWeight: 650,
    letterSpacing: 'normal',
  },
  /** `.brand` — 16px / 850. A wordmark, not a heading. */
  wordmark: {
    fontSize: 'var(--bsp-fs-16)',
    lineHeight: 'var(--bsp-rem-1-125)',
    fontWeight: 850,
    letterSpacing: 'normal',
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
export const shadowValues = {
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
  focus: `0 0 0 2px ${colorValues.focusRingContrast}, 0 0 0 4px ${colorValues.focusRing}`,
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
  xs: 'var(--bsp-rem-0-3125)',
  /** `.nav-item:hover::after` tooltip, 8px. */
  sm: 'var(--bsp-rem-0-5)',
  /** Controls: `.filter-row button`, `.segmented button`, 10px. */
  md: 'var(--bsp-rem-0-625)',
  /** `.search-field`, 11px. */
  lg: 'var(--bsp-rem-0-6875)',
  /**
   * THE DEMO'S DEFAULT CONTROL RADIUS, 12px. `.icon-button`, `.nav-item`,
   * `.primary-button`, `.dark-button`, `.search-button`, `.experience-icon`,
   * `.profile-avatar` — almost everything a finger touches.
   */
  control: 'var(--bsp-rem-0-75)',
  /** `.segmented`, `.tabs` container, 13px; `.thumb`, 13px. */
  xl: 'var(--bsp-rem-0-8125)',
  /** `.experience-current`, `.profile-button`, `.quick-card`, 16px. */
  rail: 'var(--bsp-rem-1)',
  /** `.surface-card`, 18px. */
  '2xl': 'var(--bsp-rem-1-125)',
  /** `.float-card`, `.metric`, 20px. */
  card: 'var(--bsp-rem-1-25)',
  /** `.hero-card`, 28px. */
  '3xl': 'var(--bsp-rem-1-75)',
  /** `.studio { border-radius: 25px }` — the editor surface, one step under the shell. */
  studio: 'var(--bsp-rem-1-5625)',
  /** `.app-shell`, 34px. */
  shell: 'var(--bsp-rem-2-125)',
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
export const motionValues = {
  instant: '80ms',
  fast: '140ms',
  base: '200ms',
  slow: '320ms',
  easeOut: 'cubic-bezier(0.16, 1, 0.3, 1)',
  easeInOut: 'cubic-bezier(0.4, 0, 0.2, 1)',
} as const;

/**
 * DESIGN-SYSTEM PROGRAMME, S2 — the TOKEN OBJECTS NOW NAME CSS VARIABLES.
 *
 * `colorTokens.brandPurple` used to be the literal `'#7935FE'`, baked into the
 * HTML wherever an inline style used it, so a change to tokens.css never reached
 * it. It is now `'var(--bs-brand-purple)'`: every inline style follows the
 * stylesheet, and a later Look & feel setting reaches the whole platform.
 *
 * The literal values live on in `colorValues`, `shadowValues` and
 * `motionValues` for the places a browser cannot resolve a variable: contrast
 * arithmetic, a native colour input's value, e-mail. (An SVG presentation
 * attribute cannot take `var()` either, so charts set fill and stroke through
 * `style`.) `tokens.css :root` is GENERATED from them
 * (`cssRootTokens` below, `pnpm style:tokens`), so the value is decided once.
 */
function kebab(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Za-z])([0-9])/g, '$1-$2')
    .toLowerCase();
}

/** The CSS variable each TS token key is mirrored as. */
export const cssVariableName = {
  color: (key: string) => `--bs-${kebab(key)}`,
  shadow: (key: string) => `--bs-shadow-${kebab(key)}`,
  motion: (key: string) =>
    key.startsWith('ease') ? `--bs-${kebab(key)}` : `--bs-duration-${kebab(key)}`,
} as const;

function asVariables<T extends Record<string, string>>(
  values: T,
  name: (key: string) => string,
  keepLiteral: ReadonlySet<string> = new Set(),
): { readonly [K in keyof T]: string } {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      keepLiteral.has(key) ? value : `var(${name(key)})`,
    ]),
  ) as { readonly [K in keyof T]: string };
}

/**
 * Since S4 (with D-2) nothing stays literal: `controlBorder`, `hairline` and
 * `cardBorder`, which tokens.css redefines inside `prefers-contrast: more` and
 * `forced-colors` (D-55), are variables too, so the contrast restorations now
 * reach every inline style that uses them. Kept as an empty set so a future
 * exception has one documented place.
 */
export const LITERAL_UNTIL_S4: ReadonlySet<string> = new Set();

export const colorTokens = asVariables(colorValues, cssVariableName.color, LITERAL_UNTIL_S4);
export const shadowTokens = asVariables(shadowValues, cssVariableName.shadow);
export const motionTokens = asVariables(motionValues, cssVariableName.motion);

/**
 * §8 MOTION (prototype v105, Phase 2B-2b), in milliseconds, for the Web
 * Animations API — the mirror of the `--bs-motion-*` custom properties in
 * `tokens.css`, kept equal by `motion-tokens.test.ts`.
 */
export const motionMs = {
  page: 440,
  pageLate: 300,
  pageStep: 45,
  pill: 440,
  collapse: 380,
  labelOut: 110,
  labelIn: 220,
  labelInDelay: 150,
  seg: 380,
  menuIn: 200,
  menuRow: 220,
  menuRowStep: 22,
  menuOut: 180,
  dialog: 300,
  veil: 260,
  copilot: 340,
  toastIn: 420,
  toastStep: 50,
  toastCheckDelay: 160,
  toastOut: 280,
  bar: 800,
  barStep: 35,
  line: 1000,
  dot: 360,
  dotStep: 40,
  count: 650,
  loop: 1600,
  hover: 220,
  dragLift: 180,
  drop: 360,
  settle: 300,
  state: 200,
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
  sidebarExpanded: 'var(--bsp-rem-15-5)',
  /** `.app-shell.sidebar-collapsed { grid-template-columns: 78px … }`. */
  sidebarCollapsed: 'var(--bsp-rem-4-875)',
  /** `.topbar { min-height: 88px }`. */
  headerHeight: 'var(--bsp-rem-5-5)',
  /** `.app-shell { margin: 20px auto }`. */
  shellInset: 'var(--bsp-rem-1-25)',
  /** `.app-shell { width: min(1540px, calc(100% - 40px)) }`. */
  shellMaxWidth: 'var(--bsp-rem-96-25)',
  /** `.sidebar { padding: 18px 14px 14px }`. */
  railPadInline: 'var(--bsp-rem-0-875)',
  railPadBlockStart: 'var(--bsp-rem-1-125)',
  railPadBlockEnd: 'var(--bsp-rem-0-875)',
  /** `.sidebar-top { height: 54px; padding: 0 5px }`. */
  railTopHeight: 'var(--bsp-rem-3-375)',
  railTopPadInline: 'var(--bsp-rem-0-3125)',
  /** `.sidebar-collapsed .sidebar-top { height: 90px; gap: 8px }`. */
  railTopHeightCollapsed: 'var(--bsp-rem-5-625)',
  /** `.nav-group { margin-bottom: 17px }`. */
  navGroupGap: 'var(--bsp-rem-1-0625)',
  /** `.nav-group-title { padding: 0 12px 7px }`. */
  navGroupTitlePad: '0 0.75rem 0.4375rem',
  /** `.nav-item { height: 39px; padding: 0 11px; gap: 11px }`. */
  navItemHeight: 'var(--bsp-rem-2-4375)',
  navItemPadInline: 'var(--bsp-rem-0-6875)',
  navItemGap: 'var(--bsp-rem-0-6875)',
  /** `.nav-icon { width: 20px; font-size: 14px }`. */
  navIconSlot: 'var(--bsp-rem-1-25)',
  navIconGlyph: 'var(--bsp-rem-0-875)',
  /** `.experience-current`, `.profile-button` — 38px identity block. */
  railAvatar: 'var(--bsp-rem-2-375)',
  railCardPad: 'var(--bsp-rem-0-625)',
  railCardPadTight: 'var(--bsp-rem-0-5)',
  railCardGap: 'var(--bsp-rem-0-5625)',
  /** `.main-panel { padding: 0 28px 36px }`. */
  panelPadInline: 'var(--bsp-rem-1-75)',
  panelPadBlockEnd: 'var(--bsp-rem-2-25)' /* `.main-panel { padding: 0 28px 36px }`. */,
  /** `.topbar { gap: 16px }`, `.topbar-actions { gap: 7px }`. */
  topbarGap: 'var(--bsp-rem-1)',
  topbarActionGap: 'var(--bsp-rem-0-4375)',
  /** `.icon-button` — 38px square. */
  iconButton: 'var(--bsp-rem-2-375)',
  /** `.search-button { width: 230px; height: 38px }`. */
  searchWidth: 'var(--bsp-rem-14-375)',
  /** `.social-preview .avatar` — 34px, round. */
  previewAvatar: 'var(--bsp-rem-2-125)',
  /**
   * The composer's preview column — `.composer { grid-template-columns:
   * minmax(350px,1fr) 340px 300px }`. The post preview is drawn at 340px and
   * does not widen, because that is the width its composition was drawn at.
   */
  socialPreviewWidth: 'var(--bsp-rem-21-25)',
  /** `.studio { min-height: 660px }`. */
  studioMinHeight: 'var(--bsp-rem-41-25)',
  /** `.composer` middle column, the live preview panel. */
  composerPreviewColumn: 'var(--bsp-rem-21-25)',
  /** `.composer` trailing column, the Copilot panel. */
  composerCopilotColumn: 'var(--bsp-rem-18-75)',
  /** `.studio { grid-template-columns: 84px 240px 1fr 230px }`. */
  studioToolRailWidth: 'var(--bsp-rem-5-25)',
  studioAssetsWidth: 'var(--bsp-rem-15)',
  studioPropsWidth: 'var(--bsp-rem-14-375)',
  /** `.settings-grid { grid-template-columns: 220px 1fr }`. */
  settingsNavWidth: 'var(--bsp-rem-13-75)',
  /** `.side-drawer { width: min(430px, calc(100vw - 40px)) }`. */
  drawerWidth: 'var(--bsp-rem-26-875)',
  /** `.command-dialog { width: min(570px, calc(100% - 30px)) }`. */
  commandDialogWidth: 'var(--bsp-rem-35-625)',
  /**
   * `.brand-mark { width: 34px; height: 34px }` — the slot the official
   * BrandSpace logo fills.
   *
   * THE DEMO'S OTHER MARK PROPERTIES ARE GONE FROM CSS, not lost: it drew an
   * ink square with `border-radius: 11px` around a 15px/850 "B", and the
   * official artwork carries the rounded square and the letterform in its own
   * paths. A `brandMarkGlyph` font size lived here to size that letter and had
   * no consumer left, which is exactly the kind of leftover that later reads
   * as a contract somebody should restore.
   */
  brandMark: 'var(--bsp-rem-2-125)',
  /** `.brand { gap: 10px }`. */
  brandGap: 'var(--bsp-rem-0-625)',
  /** `.hero-card { min-height: 330px }`, `.hero-copy { padding: 48px }`. */
  heroMinHeight: 'var(--bsp-rem-20-625)',
  heroPad: 'var(--bsp-rem-3)',
  /** `.metric { padding: 20px }`, `.metric-row { gap: 10px; margin: 14px 0 }`. */
  metricPad: 'var(--bsp-rem-1-25)',
  metricGap: 'var(--bsp-rem-0-625)',
  metricRowMargin: 'var(--bsp-rem-0-875)',
  /** `.surface-card { padding: 22px }`, `.dashboard-grid { gap: 14px }`. */
  surfacePad: 'var(--bsp-rem-1-375)',
  sectionGap: 'var(--bsp-rem-0-875)',
  /** `.section-head { margin-bottom: 15px; gap: 15px }`. */
  sectionHeadGap: 'var(--bsp-rem-0-9375)',
  /** `.view-toolbar { min-height: 74px; margin-bottom: 12px }`. */
  viewToolbarHeight: 'var(--bsp-rem-4-625)',
  /** WCAG 2.2 target size (2.5.8) minimum for a pointer target. */
  minTargetSize: '24px',
  /**
   * `.primary-button, .dark-button, … { min-height: 40px }` and
   * `.compact { min-height: 38px }`. The demo runs TWO control heights and the
   * difference is deliberate, so both are named rather than averaged.
   */
  controlHeight: 'var(--bsp-rem-2-5)',
  controlHeightSm: 'var(--bsp-rem-2-375)',
  /** `.filter-row button, .segmented button { min-height: 36px }`. */
  controlHeightXs: 'var(--bsp-rem-2-25)',
  contentMaxWidth: 'var(--bsp-rem-96-25)',
  copilotPanelWidth: 'var(--bsp-rem-18-75)',
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

/**
 * The social platforms' OFFICIAL brand colours, for `PlatformIcon` and the
 * platform accent. Each value is the one the platform publishes in its own
 * brand resources (as recorded by Simple Icons v16.32.0): Instagram and
 * Facebook from Meta's brand resources, X from the X brand toolkit, TikTok
 * from TikTok's. LinkedIn is its published blue.
 *
 * These are identity colours for a small mark, never a theme: the interface
 * around them stays black and white.
 */
export const platformBrandTokens = {
  instagram: '#FF0069',
  facebook: '#0866FF',
  linkedin: '#0A66C2',
  x: '#000000',
  tiktok: '#000000',
} as const;

/**
 * S4: every duration is `calc(<ms>ms * var(--bs-motion-scale))`. The scale is
 * the motion LEVEL (full 1, reduced 0.5, off 0.001 — never 0, so a transitionend
 * still fires) times the SPEED (calm, normal 1, quick), both 1 by default, so
 * nothing moves differently until the Look & feel page changes them.
 * `prefers-reduced-motion` keeps its own block in tokens.css and always wins.
 */
export function scaledDuration(duration: string): string {
  return `calc(${duration} * var(--bs-motion-scale))`;
}

/**
 * THE `:root` BLOCK OF tokens.css, in order (design-system programme, S2).
 *
 * `scripts/style/tokens-css.ts` (`pnpm style:tokens`) writes tokens.css's
 * `:root { … }` from this list and `tests/unit/style-tokens-css.test.ts`
 * fails if the committed stylesheet differs from it by one byte. A value that
 * has a TypeScript twin is not repeated here: the entry points at it, so the
 * value is decided in exactly one place. Comments are carried verbatim.
 */
export type CssRootEntry =
  | { readonly name: string; readonly value: string; readonly note?: string }
  | { readonly comment: string }
  | { readonly blank: true };

export const cssRootTokens: readonly CssRootEntry[] = [
  {
    comment:
      "  /*\n   * TYPE SIZES (batch 7). Every font size the product's stylesheets use is one\n   * of these, so the size scale is changed here and nowhere else. The values\n   * are the 2026-09-27 prototype's, transcribed; a scale decision changes the\n   * values, never the stylesheets.\n   */",
  },
  { name: '--bsp-fs-7', value: '7px' },
  { name: '--bsp-fs-8', value: '8px' },
  { name: '--bsp-fs-9', value: '9px' },
  { name: '--bsp-fs-9-5', value: '9.5px' },
  { name: '--bsp-fs-10', value: '10px' },
  { name: '--bsp-fs-10-5', value: '10.5px' },
  { name: '--bsp-fs-11', value: '11px' },
  { name: '--bsp-fs-11-5', value: '11.5px' },
  { name: '--bsp-fs-12', value: '12px' },
  { name: '--bsp-fs-12-5', value: '12.5px' },
  { name: '--bsp-fs-13', value: '13px' },
  { name: '--bsp-fs-13-5', value: '13.5px' },
  { name: '--bsp-fs-14', value: '14px' },
  { name: '--bsp-fs-14-5', value: '14.5px' },
  { name: '--bsp-fs-15', value: '15px' },
  { name: '--bsp-fs-15-5', value: '15.5px' },
  { name: '--bsp-fs-16', value: '16px' },
  { name: '--bsp-fs-16-5', value: '16.5px' },
  { name: '--bsp-fs-17', value: '17px' },
  { name: '--bsp-fs-18', value: '18px' },
  { name: '--bsp-fs-19', value: '19px' },
  { name: '--bsp-fs-20', value: '20px' },
  { name: '--bsp-fs-21', value: '21px' },
  { name: '--bsp-fs-21-6', value: '21.6px' },
  { name: '--bsp-fs-22', value: '22px' },
  { name: '--bsp-fs-24', value: '24px' },
  { name: '--bsp-fs-26', value: '26px' },
  { name: '--bsp-fs-28', value: '28px' },
  { name: '--bsp-fs-29', value: '29px' },
  { name: '--bsp-fs-30', value: '30px' },
  { name: '--bsp-fs-32', value: '32px' },
  { name: '--bsp-fs-34', value: '34px' },
  { name: '--bsp-fs-40', value: '40px' },
  { name: '--bsp-fs-42', value: '42px' },
  { name: '--bsp-fs-48', value: '48px' },
  { name: '--bsp-fs-52', value: '52px' },
  { name: '--bsp-fs-56', value: '56px' },
  { name: '--bsp-fs-64', value: '64px' },
  {
    comment:
      "  /* BATCH 7 (D-484) — the design system's rem lengths, named; scaled the same way. */",
  },
  { name: '--bsp-rem-0-0625', value: '0.0625rem' },
  { name: '--bsp-rem-0-125', value: '0.125rem' },
  { name: '--bsp-rem-0-1875', value: '0.1875rem' },
  { name: '--bsp-rem-0-25', value: '0.25rem' },
  { name: '--bsp-rem-0-3125', value: '0.3125rem' },
  { name: '--bsp-rem-0-375', value: '0.375rem' },
  { name: '--bsp-rem-0-4375', value: '0.4375rem' },
  { name: '--bsp-rem-0-5', value: '0.5rem' },
  { name: '--bsp-rem-0-5625', value: '0.5625rem' },
  { name: '--bsp-rem-0-625', value: '0.625rem' },
  { name: '--bsp-rem-0-6875', value: '0.6875rem' },
  { name: '--bsp-rem-0-75', value: '0.75rem' },
  { name: '--bsp-rem-0-8125', value: '0.8125rem' },
  { name: '--bsp-rem-0-875', value: '0.875rem' },
  { name: '--bsp-rem-0-9375', value: '0.9375rem' },
  { name: '--bsp-rem-1', value: '1rem' },
  { name: '--bsp-rem-1-0625', value: '1.0625rem' },
  { name: '--bsp-rem-1-125', value: '1.125rem' },
  { name: '--bsp-rem-1-1875', value: '1.1875rem' },
  { name: '--bsp-rem-1-25', value: '1.25rem' },
  { name: '--bsp-rem-1-375', value: '1.375rem' },
  { name: '--bsp-rem-1-4', value: '1.4rem' },
  { name: '--bsp-rem-1-5', value: '1.5rem' },
  { name: '--bsp-rem-1-5625', value: '1.5625rem' },
  { name: '--bsp-rem-1-75', value: '1.75rem' },
  { name: '--bsp-rem-1-875', value: '1.875rem' },
  { name: '--bsp-rem-2', value: '2rem' },
  { name: '--bsp-rem-2-125', value: '2.125rem' },
  { name: '--bsp-rem-2-25', value: '2.25rem' },
  { name: '--bsp-rem-2-375', value: '2.375rem' },
  { name: '--bsp-rem-2-4375', value: '2.4375rem' },
  { name: '--bsp-rem-2-5', value: '2.5rem' },
  { name: '--bsp-rem-2-625', value: '2.625rem' },
  { name: '--bsp-rem-2-75', value: '2.75rem' },
  { name: '--bsp-rem-3', value: '3rem' },
  { name: '--bsp-rem-3-25', value: '3.25rem' },
  { name: '--bsp-rem-3-375', value: '3.375rem' },
  { name: '--bsp-rem-3-625', value: '3.625rem' },
  { name: '--bsp-rem-3-75', value: '3.75rem' },
  { name: '--bsp-rem-4', value: '4rem' },
  { name: '--bsp-rem-4-5', value: '4.5rem' },
  { name: '--bsp-rem-4-625', value: '4.625rem' },
  { name: '--bsp-rem-4-875', value: '4.875rem' },
  { name: '--bsp-rem-5', value: '5rem' },
  { name: '--bsp-rem-5-25', value: '5.25rem' },
  { name: '--bsp-rem-5-5', value: '5.5rem' },
  { name: '--bsp-rem-5-625', value: '5.625rem' },
  { name: '--bsp-rem-6', value: '6rem' },
  { name: '--bsp-rem-7', value: '7rem' },
  { name: '--bsp-rem-7-375', value: '7.375rem' },
  { name: '--bsp-rem-8-25', value: '8.25rem' },
  { name: '--bsp-rem-10', value: '10rem' },
  { name: '--bsp-rem-11', value: '11rem' },
  { name: '--bsp-rem-11-25', value: '11.25rem' },
  { name: '--bsp-rem-11-875', value: '11.875rem' },
  { name: '--bsp-rem-12', value: '12rem' },
  { name: '--bsp-rem-13', value: '13rem' },
  { name: '--bsp-rem-13-75', value: '13.75rem' },
  { name: '--bsp-rem-14', value: '14rem' },
  { name: '--bsp-rem-14-375', value: '14.375rem' },
  { name: '--bsp-rem-15', value: '15rem' },
  { name: '--bsp-rem-15-5', value: '15.5rem' },
  { name: '--bsp-rem-16', value: '16rem' },
  { name: '--bsp-rem-17', value: '17rem' },
  { name: '--bsp-rem-18', value: '18rem' },
  { name: '--bsp-rem-18-75', value: '18.75rem' },
  { name: '--bsp-rem-20-625', value: '20.625rem' },
  { name: '--bsp-rem-21-25', value: '21.25rem' },
  { name: '--bsp-rem-24', value: '24rem' },
  { name: '--bsp-rem-26', value: '26rem' },
  { name: '--bsp-rem-26-875', value: '26.875rem' },
  { name: '--bsp-rem-28', value: '28rem' },
  { name: '--bsp-rem-30', value: '30rem' },
  { name: '--bsp-rem-31-25', value: '31.25rem' },
  { name: '--bsp-rem-32', value: '32rem' },
  { name: '--bsp-rem-34', value: '34rem' },
  { name: '--bsp-rem-35-625', value: '35.625rem' },
  { name: '--bsp-rem-38-75', value: '38.75rem' },
  { name: '--bsp-rem-40', value: '40rem' },
  { name: '--bsp-rem-41-25', value: '41.25rem' },
  { name: '--bsp-rem-96-25', value: '96.25rem' },
  { name: '--bsp-rem-3-5', value: '3.5rem' },
  { name: '--bsp-rem-19', value: '19rem' },
  { name: '--bsp-target-min', value: '24px' },
  {
    comment:
      "  /* BATCH 7 (D-484) — the prototype's own lengths, named. Here every token is\n     its own value; the customer app (`prototype.css`) scales them by 0.88. */",
  },
  { name: '--bsp-px-1-5', value: '1.5px' },
  { name: '--bsp-px-2', value: '2px' },
  { name: '--bsp-px-3', value: '3px' },
  { name: '--bsp-px-4', value: '4px' },
  { name: '--bsp-px-5', value: '5px' },
  { name: '--bsp-px-5-5', value: '5.5px' },
  { name: '--bsp-px-6', value: '6px' },
  { name: '--bsp-px-7', value: '7px' },
  { name: '--bsp-px-8', value: '8px' },
  { name: '--bsp-px-8-5', value: '8.5px' },
  { name: '--bsp-px-9', value: '9px' },
  { name: '--bsp-px-10', value: '10px' },
  { name: '--bsp-px-11', value: '11px' },
  { name: '--bsp-px-12', value: '12px' },
  { name: '--bsp-px-13', value: '13px' },
  { name: '--bsp-px-14', value: '14px' },
  { name: '--bsp-px-15', value: '15px' },
  { name: '--bsp-px-16', value: '16px' },
  { name: '--bsp-px-17', value: '17px' },
  { name: '--bsp-px-18', value: '18px' },
  { name: '--bsp-px-19', value: '19px' },
  { name: '--bsp-px-20', value: '20px' },
  { name: '--bsp-px-21', value: '21px' },
  { name: '--bsp-px-22', value: '22px' },
  { name: '--bsp-px-24', value: '24px' },
  { name: '--bsp-px-25', value: '25px' },
  { name: '--bsp-px-26', value: '26px' },
  { name: '--bsp-px-28', value: '28px' },
  { name: '--bsp-px-30', value: '30px' },
  { name: '--bsp-px-32', value: '32px' },
  { name: '--bsp-px-34', value: '34px' },
  { name: '--bsp-px-35', value: '35px' },
  { name: '--bsp-px-36', value: '36px' },
  { name: '--bsp-px-38', value: '38px' },
  { name: '--bsp-px-40', value: '40px' },
  { name: '--bsp-px-41', value: '41px' },
  { name: '--bsp-px-42', value: '42px' },
  { name: '--bsp-px-44', value: '44px' },
  { name: '--bsp-px-46', value: '46px' },
  { name: '--bsp-px-48', value: '48px' },
  { name: '--bsp-px-50', value: '50px' },
  { name: '--bsp-px-52', value: '52px' },
  { name: '--bsp-px-55', value: '55px' },
  { name: '--bsp-px-56', value: '56px' },
  { name: '--bsp-px-58', value: '58px' },
  { name: '--bsp-px-60', value: '60px' },
  { name: '--bsp-px-64', value: '64px' },
  { name: '--bsp-px-70', value: '70px' },
  { name: '--bsp-px-72', value: '72px' },
  { name: '--bsp-px-74', value: '74px' },
  { name: '--bsp-px-76', value: '76px' },
  { name: '--bsp-px-80', value: '80px' },
  { name: '--bsp-px-84', value: '84px' },
  { name: '--bsp-px-90', value: '90px' },
  { name: '--bsp-px-92', value: '92px' },
  { name: '--bsp-px-96', value: '96px' },
  { name: '--bsp-px-99', value: '99px' },
  { name: '--bsp-px-100', value: '100px' },
  { name: '--bsp-px-104', value: '104px' },
  { name: '--bsp-px-110', value: '110px' },
  { name: '--bsp-px-112', value: '112px' },
  { name: '--bsp-px-116', value: '116px' },
  { name: '--bsp-px-120', value: '120px' },
  { name: '--bsp-px-122', value: '122px' },
  { name: '--bsp-px-125', value: '125px' },
  { name: '--bsp-px-130', value: '130px' },
  { name: '--bsp-px-140', value: '140px' },
  { name: '--bsp-px-150', value: '150px' },
  { name: '--bsp-px-160', value: '160px' },
  { name: '--bsp-px-168', value: '168px' },
  { name: '--bsp-px-170', value: '170px' },
  { name: '--bsp-px-176', value: '176px' },
  { name: '--bsp-px-180', value: '180px' },
  { name: '--bsp-px-200', value: '200px' },
  { name: '--bsp-px-210', value: '210px' },
  { name: '--bsp-px-220', value: '220px' },
  { name: '--bsp-px-230', value: '230px' },
  { name: '--bsp-px-240', value: '240px' },
  { name: '--bsp-px-250', value: '250px' },
  { name: '--bsp-px-260', value: '260px' },
  { name: '--bsp-px-270', value: '270px' },
  { name: '--bsp-px-280', value: '280px' },
  { name: '--bsp-px-290', value: '290px' },
  { name: '--bsp-px-300', value: '300px' },
  { name: '--bsp-px-320', value: '320px' },
  { name: '--bsp-px-330', value: '330px' },
  { name: '--bsp-px-340', value: '340px' },
  { name: '--bsp-px-350', value: '350px' },
  { name: '--bsp-px-360', value: '360px' },
  { name: '--bsp-px-362', value: '362px' },
  { name: '--bsp-px-380', value: '380px' },
  { name: '--bsp-px-400', value: '400px' },
  { name: '--bsp-px-420', value: '420px' },
  { name: '--bsp-px-450', value: '450px' },
  { name: '--bsp-px-470', value: '470px' },
  { name: '--bsp-px-520', value: '520px' },
  { name: '--bsp-px-540', value: '540px' },
  { name: '--bsp-px-560', value: '560px' },
  { name: '--bsp-px-570', value: '570px' },
  { name: '--bsp-px-580', value: '580px' },
  { name: '--bsp-px-600', value: '600px' },
  { name: '--bsp-px-620', value: '620px' },
  { name: '--bsp-px-640', value: '640px' },
  { name: '--bsp-px-720', value: '720px' },
  { name: '--bsp-px-760', value: '760px' },
  { name: '--bsp-px-780', value: '780px' },
  { name: '--bsp-px-836', value: '836px' },
  { name: '--bsp-px-900', value: '900px' },
  { name: '--bsp-px-999', value: '999px' },
  { name: '--bsp-px-9999', value: '9999px' },
  { name: '--bsp-px-54', value: '54px' },
  { comment: "  /* Identity blue — the marketing site's primary. NOT for text (2.56:1). */" },
  { name: '--bs-brand-blue', value: colorValues.brandBlue },
  { name: '--bs-brand-blue-hover', value: colorValues.brandBlueHover },
  { name: '--bs-brand-blue-text', value: colorValues.brandBlueText },
  { name: '--bs-brand-blue-surface', value: colorValues.brandBlueSurface },
  { name: '--bs-brand-blue-ink', value: colorValues.brandBlueInk },
  { blank: true },
  {
    comment:
      '  /* Application primary (D-42). 5.60:1 on white: safe as text AND as a filled\n     surface with white ink. */',
  },
  { name: '--bs-brand-purple', value: colorValues.brandPurple },
  { name: '--bs-brand-purple-hover', value: colorValues.brandPurpleHover },
  { name: '--bs-brand-purple-pressed', value: colorValues.brandPurplePressed },
  { name: '--bs-brand-purple-ink', value: colorValues.brandPurpleInk },
  { name: '--bs-brand-purple-tint', value: colorValues.brandPurpleTint },
  { name: '--bs-brand-purple-border', value: colorValues.brandPurpleBorder },
  { blank: true },
  { comment: '  /* Accent yellow. Never body text, never white text on it. */' },
  { name: '--bs-brand-yellow', value: colorValues.brandYellow },
  { name: '--bs-brand-yellow-ink', value: colorValues.brandYellowInk },
  { name: '--bs-brand-yellow-text', value: colorValues.brandYellowText },
  { name: '--bs-brand-yellow-tint', value: colorValues.brandYellowTint },
  { blank: true },
  { name: '--bs-surface', value: colorValues.surface },
  {
    comment:
      "  /* `drawerAlpha` in tokens.ts: the notifications sheet's glass, reused by menus (MO5). */",
  },
  { name: '--bs-surface-glass', value: 'rgba(255, 255, 255, 0.96)' },
  { name: '--bs-surface-soft', value: colorValues.surfaceSoft },
  { name: '--bs-surface-warm', value: colorValues.surfaceWarm },
  { name: '--bs-surface-lavender', value: colorValues.surfaceLavender },
  { name: '--bs-surface-lavender-strong', value: colorValues.surfaceLavenderStrong },
  { name: '--bs-surface-muted', value: colorValues.surfaceMuted },
  { name: '--bs-surface-sunken', value: colorValues.surfaceSunken },
  { name: '--bs-surface-ink', value: colorValues.surfaceInk },
  {
    comment:
      '  /* The ambient ground the shell floats on. Never white: the shell is white,\n     and it needs something to float ON (D-59). */',
  },
  { name: '--bs-app-background', value: colorValues.appBackground },
  { blank: true },
  {
    comment:
      '  /* Controls are identified by fill, label and focus ring — not by a resting\n     stroke (D-55). See the prefers-contrast block near the end of this file. */',
  },
  { name: '--bs-control-surface', value: colorValues.controlSurface },
  { name: '--bs-control-surface-hover', value: colorValues.controlSurfaceHover },
  { name: '--bs-control-surface-focus', value: colorValues.controlSurfaceFocus },
  { name: '--bs-control-surface-disabled', value: colorValues.controlSurfaceDisabled },
  { name: '--bs-control-border', value: colorValues.controlBorder },
  { name: '--bs-control-border-contrast', value: colorValues.controlBorderContrast },
  { blank: true },
  { name: '--bs-hairline', value: colorValues.hairline },
  { name: '--bs-card-border', value: colorValues.cardBorder },
  { name: '--bs-border', value: colorValues.border },
  { name: '--bs-border-strong', value: colorValues.borderStrong },
  { name: '--bs-document-rule', value: colorValues.documentRule },
  { blank: true },
  { comment: '  /* UI-1: the one scrollbar thumb, resting and hovered. */' },
  { name: '--bs-scrollbar-thumb', value: colorValues.scrollbarThumb },
  { name: '--bs-scrollbar-thumb-hover', value: colorValues.scrollbarThumbHover },
  { blank: true },
  { name: '--bs-text-primary', value: colorValues.textPrimary },
  { name: '--bs-text-secondary', value: colorValues.textSecondary },
  { name: '--bs-text-muted', value: colorValues.textMuted },
  { name: '--bs-text-subtle', value: colorValues.textSubtle },
  { name: '--bs-text-inverse', value: colorValues.textInverse },
  { blank: true },
  {
    comment:
      '  /* INK — the approved demo\'s workhorse primary. Black carries almost every\n     action; purple is reserved for the single "create" entry point. */',
  },
  { name: '--bs-ink', value: colorValues.ink },
  { name: '--bs-ink-hover', value: colorValues.inkHover },
  { name: '--bs-ink-ink', value: colorValues.inkInk },
  { blank: true },
  { comment: '  /* The floating application shell, resolved over the ambient ground. */' },
  { name: '--bs-shell-surface', value: colorValues.shellSurface },
  { name: '--bs-shell-sidebar', value: colorValues.shellSidebar },
  { name: '--bs-shell-panel', value: colorValues.shellPanel },
  { name: '--bs-ambient-ground', value: colorValues.ambientGround },
  { blank: true },
  { name: '--bs-danger', value: colorValues.danger },
  { name: '--bs-danger-tint', value: colorValues.dangerTint },
  { name: '--bs-danger-border', value: colorValues.dangerBorder },
  { name: '--bs-warning', value: colorValues.warning },
  { name: '--bs-warning-tint', value: colorValues.warningTint },
  { name: '--bs-warning-border', value: colorValues.warningBorder },
  { name: '--bs-success', value: colorValues.success },
  { name: '--bs-success-tint', value: colorValues.successTint },
  { name: '--bs-success-border', value: colorValues.successBorder },
  { name: '--bs-info', value: colorValues.info },
  { name: '--bs-info-tint', value: colorValues.infoTint },
  { name: '--bs-info-border', value: colorValues.infoBorder },
  { blank: true },
  { name: '--bs-focus-ring', value: colorValues.focusRing },
  { name: '--bs-focus-ring-contrast', value: colorValues.focusRingContrast },
  { blank: true },
  {
    comment:
      '  /* Wide, far and very low in opacity — that is what lets a surface carry no\n     border and still read as a separate plane. */',
  },
  { name: '--bs-shadow-shell', value: shadowValues.shell },
  { name: '--bs-shadow-card', value: shadowValues.card },
  { name: '--bs-shadow-metric', value: shadowValues.metric },
  { name: '--bs-shadow-rail', value: shadowValues.rail },
  { name: '--bs-shadow-nav-active', value: shadowValues.navActive },
  { name: '--bs-shadow-raised', value: shadowValues.raised },
  { name: '--bs-shadow-overlay', value: shadowValues.overlay },
  { name: '--bs-shadow-brand-glow', value: shadowValues.brandGlow },
  { blank: true },
  { name: '--bs-space-3xs', value: '0.125rem' },
  { name: '--bs-space-2xs', value: '0.1875rem' },
  { name: '--bs-space-xs', value: '0.25rem' },
  { name: '--bs-space-sm', value: '0.5rem' },
  { name: '--bs-space-md', value: '1rem' },
  { name: '--bs-space-lg', value: '1.5rem' },
  { name: '--bs-space-xl', value: '2rem' },
  { name: '--bs-space-2xl', value: '3rem' },
  { name: '--bs-space-3xl', value: '4rem' },
  { blank: true },
  { name: '--bs-radius-xs', value: '0.3125rem' },
  { name: '--bs-radius-sm', value: '0.5rem' },
  { name: '--bs-radius-md', value: '0.625rem' },
  { name: '--bs-radius-lg', value: '0.6875rem' },
  { name: '--bs-radius-control', value: '0.75rem' },
  { name: '--bs-radius-xl', value: '0.8125rem' },
  { name: '--bs-radius-rail', value: '1rem' },
  { name: '--bs-radius-2xl', value: '1.125rem' },
  { name: '--bs-radius-card', value: '1.25rem' },
  { name: '--bs-radius-3xl', value: '1.75rem' },
  { name: '--bs-radius-shell', value: '2.125rem' },
  { name: '--bs-radius-full', value: '9999px' },
  { blank: true },
  { name: '--bs-duration-instant', value: scaledDuration(motionValues.instant) },
  { name: '--bs-duration-fast', value: scaledDuration(motionValues.fast) },
  { name: '--bs-duration-base', value: scaledDuration(motionValues.base) },
  { name: '--bs-duration-slow', value: scaledDuration(motionValues.slow) },
  { name: '--bs-ease-out', value: motionValues.easeOut },
  { name: '--bs-ease-in-out', value: motionValues.easeInOut },
  { blank: true },
  {
    comment:
      '  /*\n   * §8 MOTION (prototype v105, Phase 2B-2b). Named for WHAT moves, so a\n   * component asks for "the menu\'s rows" rather than for a number, and the\n   * numbers are §8\'s exactly. `tokens.ts` mirrors them for the Web Animations\n   * API; `motion-tokens.test.ts` keeps the two equal.\n   */',
  },
  { name: '--bs-motion-page', value: scaledDuration('440ms'), note: '/* MO1 a block entering */' },
  {
    name: '--bs-motion-page-late',
    value: scaledDuration('300ms'),
    note: '/* MO1 blocks after the 7th */',
  },
  { name: '--bs-motion-page-step', value: scaledDuration('45ms'), note: '/* MO1 stagger */' },
  { name: '--bs-motion-pill', value: scaledDuration('440ms'), note: '/* MO2 the sidebar pill */' },
  {
    name: '--bs-motion-collapse',
    value: scaledDuration('380ms'),
    note: '/* MO3 the sidebar column */',
  },
  {
    name: '--bs-motion-label-out',
    value: scaledDuration('110ms'),
    note: '/* MO3 labels fade out */',
  },
  {
    name: '--bs-motion-label-in',
    value: scaledDuration('220ms'),
    note: '/* MO3 labels fade in */',
  },
  {
    name: '--bs-motion-label-in-delay',
    value: scaledDuration('150ms'),
    note: '/* MO3 … after the width */',
  },
  { name: '--bs-motion-seg', value: scaledDuration('380ms'), note: '/* MO4 the segmented pill */' },
  {
    name: '--bs-motion-menu-in',
    value: '200ms',
    note: '/* MO5 a menu, listbox, popover or sheet opens */',
  },
  { name: '--bs-motion-menu-row', value: scaledDuration('220ms'), note: '/* MO5 its rows */' },
  {
    name: '--bs-motion-menu-row-step',
    value: scaledDuration('22ms'),
    note: '/* MO5 row stagger */',
  },
  { name: '--bs-motion-menu-out', value: scaledDuration('180ms'), note: '/* MO5 it closes */' },
  { name: '--bs-motion-dialog', value: scaledDuration('300ms'), note: '/* MO6 the dialog */' },
  { name: '--bs-motion-veil', value: scaledDuration('260ms'), note: '/* MO6 its veil */' },
  {
    name: '--bs-motion-copilot',
    value: scaledDuration('340ms'),
    note: '/* MO7 the Copilot panel */',
  },
  {
    name: '--bs-motion-toast-in',
    value: '420ms',
    note: '/* MO8 a toast enters; its check draws */',
  },
  {
    name: '--bs-motion-toast-step',
    value: scaledDuration('50ms'),
    note: '/* MO8 content stagger */',
  },
  { name: '--bs-motion-toast-check-delay', value: scaledDuration('160ms'), note: '/* MO8 */' },
  {
    name: '--bs-motion-toast-out',
    value: scaledDuration('280ms'),
    note: '/* MO8 a toast leaves */',
  },
  { name: '--bs-motion-bar', value: scaledDuration('800ms'), note: '/* MO11 a bar grows */' },
  { name: '--bs-motion-bar-step', value: scaledDuration('35ms'), note: '/* MO11 bar stagger */' },
  { name: '--bs-motion-line', value: scaledDuration('1000ms'), note: '/* MO11 a line draws */' },
  {
    name: '--bs-motion-dot',
    value: scaledDuration('360ms'),
    note: '/* MO11 dots and labels pop */',
  },
  { name: '--bs-motion-dot-step', value: scaledDuration('40ms'), note: '/* MO11 dot stagger */' },
  { name: '--bs-motion-count', value: scaledDuration('650ms'), note: '/* MO12 a KPI counts up */' },
  {
    name: '--bs-motion-loop',
    value: scaledDuration('1600ms'),
    note: '/* MO13 shimmer and pulse */',
  },
  { name: '--bs-motion-hover', value: scaledDuration('220ms'), note: '/* MO14 a card lifts */' },
  {
    name: '--bs-motion-drag-lift',
    value: scaledDuration('180ms'),
    note: '/* §8.2 a post lifts */',
  },
  {
    name: '--bs-motion-drop',
    value: scaledDuration('360ms'),
    note: '/* §8.2 it flies into place */',
  },
  {
    name: '--bs-motion-settle',
    value: '300ms',
    note: '/* §8.2 others slide; a cancel glides back */',
  },
  {
    name: '--bs-motion-state',
    value: '200ms',
    note: '/* colour/background/border state feedback (≤ 200 ms) */',
  },
  { blank: true },
  { name: '--bs-z-sticky', value: '10' },
  { name: '--bs-z-drawer', value: '40' },
  { name: '--bs-z-overlay', value: '50' },
  { name: '--bs-z-dialog', value: '60' },
  { name: '--bs-z-toast', value: '70' },
  { name: '--bs-z-tooltip', value: '80' },
  { name: '--bs-z-skip-link', value: '100' },
  { blank: true },
  { name: '--bs-sidebar-expanded', value: '15.5rem' },
  { name: '--bs-sidebar-collapsed', value: '4.875rem' },
  { name: '--bs-header-height', value: '5.5rem' },
  { name: '--bs-shell-max-width', value: '96.25rem' },
  { name: '--bs-shell-inset', value: '1.25rem' },
  { name: '--bs-rail-pad-inline', value: '0.875rem' },
  { name: '--bs-rail-pad-block', value: '1.25rem' },
  { name: '--bs-panel-pad-inline', value: '1.75rem' },
  { name: '--bs-panel-pad-block-end', value: '2.25rem' },
  { name: '--bs-section-gap', value: '0.875rem' },
  { blank: true },
  {
    comment:
      '  /* The ambient orbs. Full-saturation brand colour appears ONLY here, at 24–38%\n     opacity behind a 100px blur, where it reads as light rather than as a\n     theme. Nothing sits on it: the shell above is opaque. */',
  },
  { name: '--bs-ambient-blush', value: '#ff99b9' },
  { name: '--bs-ambient-blur', value: '100px' },
  { name: '--bs-ambient-size', value: '56vw' },
  { name: '--bs-ambient-drift', value: '16s' },
  { blank: true },
  {
    name: '--bs-gradient-hero',
    value:
      'linear-gradient(\n    120deg,\n    rgba(255, 221, 21, 0.35),\n    rgba(255, 255, 255, 0.65) 42%,\n    rgba(121, 53, 254, 0.34)\n  )',
  },
  { blank: true },
  {
    name: '--bs-font-latin',
    value:
      "\n    'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  },
  {
    name: '--bs-font-arabic',
    value:
      "\n    'Cairo', 'IBM Plex Sans Arabic', 'Noto Sans Arabic', system-ui, 'Segoe UI', Tahoma, Arial,\n    sans-serif",
  },
  {
    name: '--bs-font-mono',
    value: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  { blank: true },
  { comment: '  /* S2: the translucent surfaces and shadows tokens.ts had no CSS twin for. */' },
  { name: '--bs-shell-alpha', value: colorValues.shellAlpha },
  { name: '--bs-shell-sidebar-alpha', value: colorValues.shellSidebarAlpha },
  { name: '--bs-metric-alpha', value: colorValues.metricAlpha },
  { name: '--bs-surface-card-alpha', value: colorValues.surfaceCardAlpha },
  { name: '--bs-float-card-alpha', value: colorValues.floatCardAlpha },
  { name: '--bs-drawer-alpha', value: colorValues.drawerAlpha },
  { name: '--bs-auth-card-alpha', value: colorValues.authCardAlpha },
  { name: '--bs-preview-panel-alpha', value: colorValues.previewPanelAlpha },
  { name: '--bs-shadow-auth-card', value: shadowValues.authCard },
  { name: '--bs-shadow-float', value: shadowValues.float },
  { name: '--bs-shadow-drawer', value: shadowValues.drawer },
  { name: '--bs-shadow-command-dialog', value: shadowValues.commandDialog },
  { name: '--bs-shadow-focus', value: shadowValues.focus },
  { blank: true },
  {
    comment:
      '  /*\n   * S3: the TRANSITIONAL literal palette. Every colour the stylesheets wrote\n   * literally that no token carried, as a token named for its own value. S5 folds\n   * them into semantic tokens as each component is unified; nothing new may use\n   * them (the style ratchet counts every remaining literal).\n   */',
  },
  { name: '--bs-lit-000000-a05', value: 'rgba(0, 0, 0, 0.05)' },
  { name: '--bs-lit-000000-a06', value: 'rgba(0, 0, 0, 0.06)' },
  { name: '--bs-lit-000000-a08', value: 'rgba(0, 0, 0, 0.08)' },
  { name: '--bs-lit-000000-a12', value: 'rgba(0, 0, 0, 0.12)' },
  { name: '--bs-lit-000000-a25', value: 'rgba(0, 0, 0, 0.25)' },
  { name: '--bs-lit-020203', value: '#020203' },
  { name: '--bs-lit-0a66c2', value: '#0a66c2' },
  { name: '--bs-lit-0b0b0f', value: '#0b0b0f' },
  { name: '--bs-lit-100e1c-a06', value: 'rgba(16, 14, 28, 0.06)' },
  { name: '--bs-lit-111114-a11', value: 'rgba(17, 17, 20, 0.11)' },
  { name: '--bs-lit-111114-a14', value: 'rgba(17, 17, 20, 0.14)' },
  { name: '--bs-lit-111114-a18', value: 'rgba(17, 17, 20, 0.18)' },
  { name: '--bs-lit-111114-a2', value: 'rgba(17, 17, 20, 0.2)' },
  { name: '--bs-lit-111114-a28', value: 'rgba(17, 17, 20, 0.28)' },
  { name: '--bs-lit-111114-a35', value: 'rgba(17, 17, 20, 0.35)' },
  { name: '--bs-lit-111114-a55', value: 'rgba(17, 17, 20, 0.55)' },
  { name: '--bs-lit-111114-a72', value: 'rgba(17, 17, 20, 0.72)' },
  { name: '--bs-lit-141023-a035', value: 'rgba(20, 16, 35, 0.035)' },
  { name: '--bs-lit-141023-a04', value: 'rgba(20, 16, 35, 0.04)' },
  { name: '--bs-lit-141023-a045', value: 'rgba(20, 16, 35, 0.045)' },
  { name: '--bs-lit-141023-a05', value: 'rgba(20, 16, 35, 0.05)' },
  { name: '--bs-lit-141023-a055', value: 'rgba(20, 16, 35, 0.055)' },
  { name: '--bs-lit-141023-a06', value: 'rgba(20, 16, 35, 0.06)' },
  { name: '--bs-lit-141023-a07', value: 'rgba(20, 16, 35, 0.07)' },
  { name: '--bs-lit-141023-a08', value: 'rgba(20, 16, 35, 0.08)' },
  { name: '--bs-lit-141023-a1', value: 'rgba(20, 16, 35, 0.1)' },
  { name: '--bs-lit-141023-a12', value: 'rgba(20, 16, 35, 0.12)' },
  { name: '--bs-lit-141023-a14', value: 'rgba(20, 16, 35, 0.14)' },
  { name: '--bs-lit-141023-a16', value: 'rgba(20, 16, 35, 0.16)' },
  { name: '--bs-lit-141023-a18', value: 'rgba(20, 16, 35, 0.18)' },
  { name: '--bs-lit-141023-a2', value: 'rgba(20, 16, 35, 0.2)' },
  { name: '--bs-lit-141023-a25', value: 'rgba(20, 16, 35, 0.25)' },
  { name: '--bs-lit-141023-a3', value: 'rgba(20, 16, 35, 0.3)' },
  { name: '--bs-lit-151020', value: '#151020' },
  { name: '--bs-lit-15121b', value: '#15121b' },
  { name: '--bs-lit-17171d', value: '#17171d' },
  { name: '--bs-lit-178a4c', value: '#178a4c' },
  { name: '--bs-lit-1baf7a', value: '#1baf7a' },
  { name: '--bs-lit-1d1a12', value: '#1d1a12' },
  { name: '--bs-lit-1f1635-a055', value: 'rgba(31, 22, 53, 0.055)' },
  { name: '--bs-lit-24242b', value: '#24242b' },
  { name: '--bs-lit-28145a-a14', value: 'rgba(40, 20, 90, 0.14)' },
  { name: '--bs-lit-28145a-a2', value: 'rgba(40, 20, 90, 0.2)' },
  { name: '--bs-lit-29292f', value: '#29292f' },
  { name: '--bs-lit-2a2a30', value: '#2a2a30' },
  { name: '--bs-lit-2a78d6', value: '#2a78d6' },
  { name: '--bs-lit-2b2b30', value: '#2b2b30' },
  { name: '--bs-lit-2fb36d', value: '#2fb36d' },
  { name: '--bs-lit-333333', value: '#333' },
  { name: '--bs-lit-34343d', value: '#34343d' },
  { name: '--bs-lit-36363f', value: '#36363f' },
  { name: '--bs-lit-3a2a4f', value: '#3a2a4f' },
  { name: '--bs-lit-3d2a74', value: '#3d2a74' },
  { name: '--bs-lit-40139f', value: '#40139f' },
  { name: '--bs-lit-417a59', value: '#417a59' },
  { name: '--bs-lit-4b8a64', value: '#4b8a64' },
  { name: '--bs-lit-4c8a67', value: '#4c8a67' },
  { name: '--bs-lit-5312c4-a16', value: 'rgba(83, 18, 196, 0.16)' },
  { name: '--bs-lit-5312c4-a3', value: 'rgba(83, 18, 196, 0.3)' },
  { name: '--bs-lit-5312c4-a35', value: 'rgba(83, 18, 196, 0.35)' },
  { name: '--bs-lit-55555c', value: '#55555c' },
  { name: '--bs-lit-55555e', value: '#55555e' },
  { name: '--bs-lit-5b1fd6', value: '#5b1fd6' },
  { name: '--bs-lit-5c5866', value: '#5c5866' },
  { name: '--bs-lit-5d5641', value: '#5d5641' },
  { name: '--bs-lit-5f23da', value: '#5f23da' },
  { name: '--bs-lit-696973', value: '#696973' },
  { name: '--bs-lit-6a5a9a', value: '#6a5a9a' },
  { name: '--bs-lit-6d6d76', value: '#6d6d76' },
  { name: '--bs-lit-75757e', value: '#75757e' },
  { name: '--bs-lit-7935fe-a0', value: 'rgba(121, 53, 254, 0)' },
  { name: '--bs-lit-7935fe-a07', value: 'rgba(121, 53, 254, 0.07)' },
  { name: '--bs-lit-7935fe-a08', value: 'rgba(121, 53, 254, 0.08)' },
  { name: '--bs-lit-7935fe-a12', value: 'rgba(121, 53, 254, 0.12)' },
  { name: '--bs-lit-7935fe-a18', value: 'rgba(121, 53, 254, 0.18)' },
  { name: '--bs-lit-7935fe-a22', value: 'rgba(121, 53, 254, 0.22)' },
  { name: '--bs-lit-7935fe-a26', value: 'rgba(121, 53, 254, 0.26)' },
  { name: '--bs-lit-7935fe-a3', value: 'rgba(121, 53, 254, 0.3)' },
  { name: '--bs-lit-7935fe-a35', value: 'rgba(121, 53, 254, 0.35)' },
  { name: '--bs-lit-7935fe-a45', value: 'rgba(121, 53, 254, 0.45)' },
  { name: '--bs-lit-7935fe-a8', value: 'rgba(121, 53, 254, 0.8)' },
  { name: '--bs-lit-7a5600', value: '#7a5600' },
  { name: '--bs-lit-7e7e88', value: '#7e7e88' },
  { name: '--bs-lit-8a5534', value: '#8a5534' },
  { name: '--bs-lit-8a5a00', value: '#8a5a00' },
  { name: '--bs-lit-8a6b00', value: '#8a6b00' },
  { name: '--bs-lit-8a8a92', value: '#8a8a92' },
  { name: '--bs-lit-8f5bff', value: '#8f5bff' },
  { name: '--bs-lit-92929d', value: '#92929d' },
  { name: '--bs-lit-999999', value: '#999' },
  { name: '--bs-lit-9b6bff', value: '#9b6bff' },
  { name: '--bs-lit-9c6539', value: '#9c6539' },
  { name: '--bs-lit-9c6dfe', value: '#9c6dfe' },
  { name: '--bs-lit-9d6aff', value: '#9d6aff' },
  { name: '--bs-lit-9e2a3b', value: '#9e2a3b' },
  { name: '--bs-lit-a3231f', value: '#a3231f' },
  { name: '--bs-lit-a578ff', value: '#a578ff' },
  { name: '--bs-lit-aaaaaa', value: '#aaa' },
  { name: '--bs-lit-b58cff', value: '#b58cff' },
  { name: '--bs-lit-b5b5bd', value: '#b5b5bd' },
  { name: '--bs-lit-b83245-a12', value: 'rgba(184, 50, 69, 0.12)' },
  { name: '--bs-lit-b83245-a18', value: 'rgba(184, 50, 69, 0.18)' },
  { name: '--bs-lit-b86e00', value: '#b86e00' },
  { name: '--bs-lit-b8a4ff', value: '#b8a4ff' },
  { name: '--bs-lit-b9b9c0', value: '#b9b9c0' },
  { name: '--bs-lit-bdbdc4', value: '#bdbdc4' },
  { name: '--bs-lit-c3a6ff', value: '#c3a6ff' },
  { name: '--bs-lit-c49dff', value: '#c49dff' },
  { name: '--bs-lit-c6a8ff', value: '#c6a8ff' },
  { name: '--bs-lit-c8c8cf', value: '#c8c8cf' },
  { name: '--bs-lit-c9adff', value: '#c9adff' },
  { name: '--bs-lit-c9b3ff', value: '#c9b3ff' },
  { name: '--bs-lit-c9b5ff', value: '#c9b5ff' },
  { name: '--bs-lit-c9c9cf', value: '#c9c9cf' },
  { name: '--bs-lit-c9c9d1', value: '#c9c9d1' },
  { name: '--bs-lit-cfcfd6', value: '#cfcfd6' },
  { name: '--bs-lit-d2d2d8', value: '#d2d2d8' },
  { name: '--bs-lit-d4a900', value: '#d4a900' },
  { name: '--bs-lit-d92d45', value: '#d92d45' },
  { name: '--bs-lit-d9a066', value: '#d9a066' },
  { name: '--bs-lit-d9ccff', value: '#d9ccff' },
  { name: '--bs-lit-dff6e8', value: '#dff6e8' },
  { name: '--bs-lit-e0b400', value: '#e0b400' },
  { name: '--bs-lit-e4e4e8', value: '#e4e4e8' },
  { name: '--bs-lit-e6dcff', value: '#e6dcff' },
  { name: '--bs-lit-e6e6ea', value: '#e6e6ea' },
  { name: '--bs-lit-e6f6ee', value: '#e6f6ee' },
  { name: '--bs-lit-e7ddff', value: '#e7ddff' },
  { name: '--bs-lit-e8e8ec', value: '#e8e8ec' },
  { name: '--bs-lit-eaf3ff', value: '#eaf3ff' },
  { name: '--bs-lit-eaf7ef', value: '#eaf7ef' },
  { name: '--bs-lit-eb6834', value: '#eb6834' },
  { name: '--bs-lit-ece4ff', value: '#ece4ff' },
  { name: '--bs-lit-ece6ff', value: '#ece6ff' },
  { name: '--bs-lit-eee6ff', value: '#eee6ff' },
  { name: '--bs-lit-eeeef2', value: '#eeeef2' },
  { name: '--bs-lit-eef8f2', value: '#eef8f2' },
  { name: '--bs-lit-efe4ff', value: '#efe4ff' },
  { name: '--bs-lit-efe7ff', value: '#efe7ff' },
  { name: '--bs-lit-efedf3', value: '#efedf3' },
  { name: '--bs-lit-efeff2', value: '#efeff2' },
  { name: '--bs-lit-f0e5ff', value: '#f0e5ff' },
  { name: '--bs-lit-f0f0f2', value: '#f0f0f2' },
  { name: '--bs-lit-f0f0f3', value: '#f0f0f3' },
  { name: '--bs-lit-f1eff6', value: '#f1eff6' },
  { name: '--bs-lit-f2edff', value: '#f2edff' },
  { name: '--bs-lit-f2f2f4', value: '#f2f2f4' },
  { name: '--bs-lit-f3c9d1', value: '#f3c9d1' },
  { name: '--bs-lit-f3d2d8', value: '#f3d2d8' },
  { name: '--bs-lit-f3dfa0', value: '#f3dfa0' },
  { name: '--bs-lit-f3f2f6', value: '#f3f2f6' },
  { name: '--bs-lit-f3f3f5', value: '#f3f3f5' },
  { name: '--bs-lit-f4e3c8', value: '#f4e3c8' },
  { name: '--bs-lit-f4efff', value: '#f4efff' },
  { name: '--bs-lit-f4f4f5', value: '#f4f4f5' },
  { name: '--bs-lit-f5dfb3', value: '#f5dfb3' },
  { name: '--bs-lit-f5f3ff', value: '#f5f3ff' },
  { name: '--bs-lit-f5f5f7', value: '#f5f5f7' },
  { name: '--bs-lit-f5fbf7', value: '#f5fbf7' },
  { name: '--bs-lit-f6d6dc', value: '#f6d6dc' },
  { name: '--bs-lit-f6f1ff', value: '#f6f1ff' },
  { name: '--bs-lit-f6f3ff', value: '#f6f3ff' },
  { name: '--bs-lit-f6f6f7', value: '#f6f6f7' },
  { name: '--bs-lit-f7f7f9', value: '#f7f7f9' },
  { name: '--bs-lit-f7fbf8', value: '#f7fbf8' },
  { name: '--bs-lit-f8f8f9-a7', value: 'rgba(248, 248, 249, 0.7)' },
  { name: '--bs-lit-faf7ff', value: '#faf7ff' },
  { name: '--bs-lit-faf8ff', value: '#faf8ff' },
  { name: '--bs-lit-faf9fc', value: '#faf9fc' },
  { name: '--bs-lit-fafafb', value: '#fafafb' },
  { name: '--bs-lit-fbf9ff', value: '#fbf9ff' },
  { name: '--bs-lit-fbfaff', value: '#fbfaff' },
  { name: '--bs-lit-fbfbfc', value: '#fbfbfc' },
  { name: '--bs-lit-fcfaff', value: '#fcfaff' },
  { name: '--bs-lit-fcfbff', value: '#fcfbff' },
  { name: '--bs-lit-fde8ec', value: '#fde8ec' },
  { name: '--bs-lit-ff78aa-a14', value: 'rgba(255, 120, 170, 0.14)' },
  { name: '--bs-lit-ffd60a', value: '#ffd60a' },
  { name: '--bs-lit-ffd60a-a34', value: 'rgba(255, 214, 10, 0.34)' },
  { name: '--bs-lit-ffdd15-a3', value: 'rgba(255, 221, 21, 0.3)' },
  { name: '--bs-lit-ffdd15-a7', value: 'rgba(255, 221, 21, 0.7)' },
  { name: '--bs-lit-fff1c2', value: '#fff1c2' },
  { name: '--bs-lit-fff3cc', value: '#fff3cc' },
  { name: '--bs-lit-fff4c2', value: '#fff4c2' },
  { name: '--bs-lit-fff4c7', value: '#fff4c7' },
  { name: '--bs-lit-fff5b0', value: '#fff5b0' },
  { name: '--bs-lit-fff5c8', value: '#fff5c8' },
  { name: '--bs-lit-fff6cf', value: '#fff6cf' },
  { name: '--bs-lit-fff6d6', value: '#fff6d6' },
  { name: '--bs-lit-fff7a8', value: '#fff7a8' },
  { name: '--bs-lit-fff7f8', value: '#fff7f8' },
  { name: '--bs-lit-fff8e1', value: '#fff8e1' },
  { name: '--bs-lit-fff8f9', value: '#fff8f9' },
  { name: '--bs-lit-fff9d7', value: '#fff9d7' },
  { name: '--bs-lit-fff9e6', value: '#fff9e6' },
  { name: '--bs-lit-fffbe6', value: '#fffbe6' },
  { name: '--bs-lit-fffbe8', value: '#fffbe8' },
  { name: '--bs-lit-fffbea', value: '#fffbea' },
  { name: '--bs-lit-fffbf2', value: '#fffbf2' },
  { name: '--bs-lit-fffdf4', value: '#fffdf4' },
  { name: '--bs-lit-ffffff-a0', value: 'rgba(255, 255, 255, 0)' },
  { name: '--bs-lit-ffffff-a1', value: 'rgba(255, 255, 255, 0.1)' },
  { name: '--bs-lit-ffffff-a35', value: 'rgba(255, 255, 255, 0.35)' },
  { name: '--bs-lit-ffffff-a62', value: 'rgba(255, 255, 255, 0.62)' },
  { name: '--bs-lit-ffffff-a7', value: 'rgba(255, 255, 255, 0.7)' },
  { name: '--bs-lit-ffffff-a75', value: 'rgba(255, 255, 255, 0.75)' },
  { name: '--bs-lit-ffffff-a85', value: 'rgba(255, 255, 255, 0.85)' },
  { name: '--bs-lit-ffffff-a92', value: 'rgba(255, 255, 255, 0.92)' },
  { name: '--bs-lit-ffffff-a93', value: 'rgba(255, 255, 255, 0.93)' },
  { name: '--bs-lit-ffffff-a94', value: 'rgba(255, 255, 255, 0.94)' },
  { blank: true },
  {
    comment:
      '  /*\\n   * S4: the switches the Look & feel page will set, all at their neutral value,\\n   * and the motion, z-index, backdrop and shadow values the stylesheets wrote\\n   * literally, as tokens. Value-named ones are transitional, like --bs-lit-*.\\n   */',
  },
  { name: '--bs-motion-level', value: '1' },
  { name: '--bs-motion-speed', value: '1' },
  { name: '--bs-motion-scale', value: 'calc(var(--bs-motion-level) * var(--bs-motion-speed))' },
  { name: '--bs-radius-scale', value: '1' },
  // D-2: the customer app's field border, one token (D-55 restores it to 3:1 under prefers-contrast).
  { name: '--bs-control-border-customer', value: '#e4e4e8' },
  { name: '--bs-control-border-customer-hover', value: '#c9c9d1' },
  // The customer rail's widths, and the frame's content width (none: fill the window, D-484).
  { name: '--bsp-sidebar-expanded', value: 'var(--bsp-px-250)' },
  { name: '--bsp-sidebar-collapsed', value: 'var(--bsp-px-76)' },
  { name: '--bsp-frame-max-inline', value: 'none' },
  { name: '--bs-dur-110', value: 'calc(110ms * var(--bs-motion-scale))' },
  { name: '--bs-dur-120', value: 'calc(120ms * var(--bs-motion-scale))' },
  { name: '--bs-dur-150', value: 'calc(150ms * var(--bs-motion-scale))' },
  { name: '--bs-dur-180', value: 'calc(180ms * var(--bs-motion-scale))' },
  { name: '--bs-dur-200', value: 'calc(200ms * var(--bs-motion-scale))' },
  { name: '--bs-dur-220', value: 'calc(220ms * var(--bs-motion-scale))' },
  { name: '--bs-dur-260', value: 'calc(260ms * var(--bs-motion-scale))' },
  { name: '--bs-dur-320', value: 'calc(320ms * var(--bs-motion-scale))' },
  { name: '--bs-dur-380', value: 'calc(380ms * var(--bs-motion-scale))' },
  { name: '--bs-dur-440', value: 'calc(440ms * var(--bs-motion-scale))' },
  { name: '--bs-dur-600', value: 'calc(600ms * var(--bs-motion-scale))' },
  { name: '--bs-ease-02-08-02-1', value: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
  { name: '--bs-ease-css', value: 'ease' },
  { name: '--bs-ease-css-out', value: 'ease-out' },
  { name: '--bs-ease-linear', value: 'linear' },
  { name: '--bs-fx-backdrop-18', value: 'blur(18px)' },
  { name: '--bs-fx-backdrop-18-sat-170', value: 'blur(18px) saturate(170%)' },
  { name: '--bs-fx-backdrop-22-sat-180', value: 'blur(22px) saturate(180%)' },
  { name: '--bs-fx-backdrop-24', value: 'blur(24px)' },
  { name: '--bs-fx-backdrop-3', value: 'blur(3px)' },
  { name: '--bs-fx-backdrop-30', value: 'blur(30px)' },
  { name: '--bs-fx-backdrop-8', value: 'blur(8px)' },
  { name: '--bs-shadow-lit-1', value: '0 14px 36px var(--bs-lit-111114-a14)' },
  {
    name: '--bs-shadow-lit-2',
    value: '0 22px 55px var(--bs-lit-28145a-a14), 0 0 0 1px var(--bs-lit-141023-a05)',
  },
  { name: '--bs-shadow-lit-3', value: '0 0 0 10px var(--bs-lit-7935fe-a0)' },
  { name: '--bs-shadow-lit-4', value: '0 12px 28px var(--bs-lit-141023-a18)' },
  { name: '--bs-shadow-lit-5', value: '0 8px 20px var(--bs-lit-141023-a06)' },
  { name: '--bs-z-0', value: '0' },
  { name: '--bs-z-1', value: '1' },
  { name: '--bs-z-10', value: '10' },
  { name: '--bs-z-12', value: '12' },
  { name: '--bs-z-2', value: '2' },
  { name: '--bs-z-20', value: '20' },
  { name: '--bs-z-25', value: '25' },
  { name: '--bs-z-3', value: '3' },
  { name: '--bs-z-30', value: '30' },
  { name: '--bs-z-36', value: '36' },
  { name: '--bs-z-4', value: '4' },
  { name: '--bs-z-5', value: '5' },
  { name: '--bs-z-6', value: '6' },
  { name: '--bs-z-60', value: '60' },
  { name: '--bs-z-7', value: '7' },
  { name: '--bs-z-70', value: '70' },
  { name: '--bs-z-neg-1', value: '-1' },
  // S4: the decorative gradients (scripts/style/codemod-gradients.ts), so gradients can be switched off.
  {
    name: '--bs-gradient-lit-1',
    value:
      'linear-gradient(\n    90deg,\n    var(--bs-surface-sunken) 0%,\n    var(--bs-surface-muted) 50%,\n    var(--bs-surface-sunken) 100%\n  )',
  },
  {
    name: '--bs-gradient-lit-2',
    value:
      'linear-gradient(\n    135deg,\n    var(--bs-lit-fff1c2) 0%,\n    var(--bs-lit-fde8ec) 55%,\n    var(--bs-lit-ece6ff) 100%\n  )',
  },
  {
    name: '--bs-gradient-lit-3',
    value:
      'linear-gradient(\n    135deg,\n    var(--bs-lit-9b6bff),\n    var(--bs-brand-purple-pressed)\n  )',
  },
  {
    name: '--bs-gradient-lit-4',
    value:
      'linear-gradient(\n    160deg,\n    var(--bs-lit-f4e3c8),\n    var(--bs-lit-d9a066) 60%,\n    var(--bs-lit-8a5534)\n  )',
  },
  {
    name: '--bs-gradient-lit-5',
    value: 'linear-gradient(145deg, var(--bs-lit-eee6ff), var(--bs-lit-fff9d7))',
  },
  {
    name: '--bs-gradient-lit-6',
    value: 'linear-gradient(90deg, var(--bs-brand-purple), var(--bs-lit-ffd60a))',
  },
  {
    name: '--bs-gradient-lit-7',
    value:
      'linear-gradient(\n    160deg,\n    var(--bs-lit-3a2a4f),\n    var(--bs-brand-purple) 70%,\n    var(--bs-lit-c6a8ff)\n  )',
  },
  {
    name: '--bs-gradient-lit-8',
    value: 'linear-gradient(90deg, var(--bs-brand-purple), var(--bs-lit-b58cff))',
  },
  {
    name: '--bs-gradient-lit-9',
    value: 'linear-gradient(270deg, var(--bs-brand-purple), var(--bs-lit-ffd60a))',
  },
  {
    name: '--bs-gradient-lit-10',
    value: 'linear-gradient(135deg, var(--bs-lit-efe7ff), var(--bs-lit-fff4c7))',
  },
  {
    name: '--bs-gradient-lit-11',
    value: 'linear-gradient(135deg, var(--bs-lit-faf7ff), var(--bs-lit-fffdf4))',
  },
  {
    name: '--bs-gradient-lit-12',
    value: 'linear-gradient(90deg, var(--bs-brand-purple), var(--bs-lit-9b6bff))',
  },
  {
    name: '--bs-gradient-lit-13',
    value: 'linear-gradient(135deg, var(--bs-lit-e7ddff) 0%, var(--bs-lit-c9b3ff) 100%)',
  },
  {
    name: '--bs-gradient-lit-14',
    value: 'linear-gradient(135deg, var(--bs-lit-fff4c2) 0%, var(--bs-lit-ffd60a) 100%)',
  },
  {
    name: '--bs-gradient-lit-15',
    value: 'linear-gradient(145deg, var(--bs-lit-8f5bff), var(--bs-lit-5b1fd6))',
  },
  {
    name: '--bs-gradient-lit-16',
    value:
      'linear-gradient(\n    145deg,\n    var(--bs-lit-fff5b0),\n    var(--bs-brand-yellow),\n    var(--bs-ambient-blush)\n  )',
  },
  {
    name: '--bs-gradient-lit-17',
    value:
      'radial-gradient(\n    circle at 30% 26%,\n    var(--bs-lit-55555e) 0,\n    var(--bs-text-primary) 52%,\n    var(--bs-lit-020203) 100%\n  )',
  },
  {
    name: '--bs-gradient-lit-18',
    value:
      'radial-gradient(\n    circle at 30% 26%,\n    var(--bs-lit-c49dff) 0,\n    var(--bs-brand-purple) 46%,\n    var(--bs-lit-40139f) 100%\n  )',
  },
  {
    name: '--bs-gradient-lit-19',
    value:
      'radial-gradient(\n    circle at 30% 26%,\n    var(--bs-lit-fff7a8) 0,\n    var(--bs-brand-yellow) 48%,\n    var(--bs-lit-d4a900) 100%\n  )',
  },
  {
    name: '--bs-gradient-lit-20',
    value:
      'linear-gradient(\n    155deg,\n    var(--bs-lit-17171d) 0,\n    var(--bs-lit-0b0b0f) 62%,\n    var(--bs-lit-151020) 100%\n  )',
  },
  // S4: the customer frame's glass, so glass can be switched off.
  { name: '--bsp-frame-surface', value: 'var(--bs-lit-ffffff-a93)' },
];

/**
 * THE "OFF" VALUES OF THE THREE EFFECT SWITCHES (design-system programme, S4).
 *
 * The Look & feel page applies a look by writing CSS variables only. Switching
 * an effect off is therefore a set of variable values, kept here so the page,
 * its preview and its tests use the same list:
 *
 *   blur       every overlay backdrop (`--bs-fx-backdrop-*`) becomes `none`;
 *   glass      every translucent surface becomes the same colour, opaque;
 *   gradients  every decorative gradient becomes a flat fill of its first
 *              colour, so a surface keeps its colour and its text its contrast.
 *
 * All three are ON by default: nothing here is applied until the page does it.
 */
function opaque(colour: string): string {
  const m = /^rgba\(\s*([0-9]+)\s*,\s*([0-9]+)\s*,\s*([0-9]+)\s*,\s*[0-9.]+\s*\)$/.exec(colour);
  return m ? `rgb(${m[1]}, ${m[2]}, ${m[3]})` : colour;
}

function rootValues(match: RegExp): [string, string][] {
  return cssRootTokens.flatMap((entry) =>
    'name' in entry && match.test(entry.name)
      ? [[entry.name, entry.value] as [string, string]]
      : [],
  );
}

const GLASS_TOKENS = [
  '--bs-shell-alpha',
  '--bs-shell-sidebar-alpha',
  '--bs-metric-alpha',
  '--bs-surface-card-alpha',
  '--bs-float-card-alpha',
  '--bs-drawer-alpha',
  '--bs-auth-card-alpha',
  '--bs-preview-panel-alpha',
  '--bs-surface-glass',
];

export const effectOffValues: {
  readonly blur: Readonly<Record<string, string>>;
  readonly glass: Readonly<Record<string, string>>;
  readonly gradients: Readonly<Record<string, string>>;
} = {
  blur: Object.fromEntries(rootValues(/^--bs-fx-backdrop-/).map(([name]) => [name, 'none'])),
  glass: {
    ...Object.fromEntries(
      rootValues(/^--bs-/)
        .filter(([name]) => GLASS_TOKENS.includes(name))
        .map(([name, value]) => [name, opaque(value)]),
    ),
    '--bsp-frame-surface': 'var(--bs-surface)',
  },
  gradients: Object.fromEntries(
    rootValues(/^--bs-gradient-lit-/).map(([name, value]) => {
      const first = /var\(--bs-[a-z0-9-]+\)/.exec(value)?.[0] ?? 'transparent';
      return [name, `linear-gradient(${first}, ${first})`];
    }),
  ),
};
