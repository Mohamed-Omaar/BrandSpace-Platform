import {
  BUNDLED_FONTS,
  ORIGINAL_ROLES,
  contrastOf,
  darkCounterpart,
  fromOklch,
  luminance,
  toOklch,
  untilReadable,
  darkPalette,
  follow,
  formatColour,
  hueDistance,
  hueOf,
  lightPalette,
  parseColour,
  themeLookSchema,
  type Palette,
  type Role,
  type ThemeLook,
} from '@brandspace/shared/theme';
import { cssRootTokens } from './tokens';

/**
 * THE LOOK & FEEL THEME AS CSS VARIABLES (LF).
 *
 * `themeStylesheet(look)` turns a theme look into the stylesheet both apps
 * put in their `<head>`: custom properties only, never a new rule for a
 * component's look, so the design system's classes keep doing the drawing and
 * a theme can never draw something the product does not already draw. Every
 * value comes from a fixed table or from the theme's validated `#rrggbb`
 * colours, so nothing a document holds reaches the stylesheet as text.
 *
 * The original look writes nothing but the dark palette: a user may switch to
 * dark whatever the owner's default, so that part is always there.
 *
 * `scope` is where the variables land: `:root` for an app, or a preview
 * container in the Control Center, which shows a draft without applying it.
 */

/** The tokens each palette role sets. */
const ROLE_TOKENS: Record<Role, readonly string[]> = {
  primary: ['--bs-brand-purple'],
  primaryHover: ['--bs-brand-purple-hover'],
  primaryPressed: ['--bs-brand-purple-pressed'],
  primaryInk: ['--bs-brand-purple-ink'],
  primaryTint: ['--bs-brand-purple-tint', '--bs-surface-lavender-strong'],
  primaryBorder: ['--bs-brand-purple-border'],
  secondary: ['--bs-brand-yellow'],
  secondaryInk: ['--bs-brand-yellow-ink'],
  secondaryText: ['--bs-brand-yellow-text'],
  secondaryTint: ['--bs-brand-yellow-tint'],
  background: ['--bs-app-background'],
  ambientGround: ['--bs-ambient-ground'],
  surface: ['--bs-surface', '--bs-control-surface-focus'],
  text: ['--bs-text-primary', '--bs-ink'],
  textSecondary: ['--bs-text-secondary'],
  textMuted: ['--bs-text-muted'],
  success: ['--bs-success'],
  warning: ['--bs-warning'],
  danger: ['--bs-danger'],
  info: ['--bs-info'],
  focus: ['--bs-focus-ring'],
};

/** The colour families a token can belong to, each anchored on a role. */
const FAMILY_ANCHORS = ['primary', 'secondary', 'success', 'warning', 'danger', 'info'] as const;

type Entry = { readonly name: string; readonly value: string };
const ENTRIES: readonly Entry[] = cssRootTokens.filter(
  (e): e is Entry => 'name' in e && 'value' in e,
);
const COLOUR_TOKENS = ENTRIES.filter((e) => parseColour(e.value) !== null);
const valueOf = (name: string) => ENTRIES.find((e) => e.name === name)?.value;

/** Each chromatic token's family: the anchor whose hue is nearest, within 32°. */
const FAMILY: ReadonlyMap<string, (typeof FAMILY_ANCHORS)[number]> = (() => {
  const out = new Map<string, (typeof FAMILY_ANCHORS)[number]>();
  const anchors = FAMILY_ANCHORS.map((role) => ({
    role,
    hue: hueOf(parseColour(ORIGINAL_ROLES[role])!)!,
  }));
  for (const token of COLOUR_TOKENS) {
    const hue = hueOf(parseColour(token.value)!);
    if (hue === null) continue;
    const nearest = anchors
      .map((a) => ({ ...a, d: hueDistance(a.hue, hue) }))
      .sort((x, y) => x.d - y.d)[0]!;
    if (nearest.d <= 32) out.set(token.name, nearest.role);
  }
  return out;
})();

/** Every colour token's light value under a look (the families follow their anchor). */
function lightColours(palette: Palette): Map<string, string> {
  const out = new Map<string, string>();
  for (const token of COLOUR_TOKENS) {
    const family = FAMILY.get(token.name);
    if (!family || palette[family] === ORIGINAL_ROLES[family]) continue;
    out.set(
      token.name,
      formatColour(
        follow(
          parseColour(token.value)!,
          parseColour(ORIGINAL_ROLES[family])!,
          parseColour(palette[family])!,
        ),
      ),
    );
  }
  writeRoles(out, palette, ORIGINAL_ROLES);
  return out;
}

function writeRoles(out: Map<string, string>, palette: Palette, unless?: Palette): void {
  for (const [role, tokens] of Object.entries(ROLE_TOKENS) as [Role, readonly string[]][]) {
    if (unless && palette[role] === unless[role]) continue;
    for (const token of tokens) out.set(token, palette[role]);
  }
}

/*
 * PR E — WHAT THE GENERATED DARK PALETTE GOT WRONG, AND THE RULES THAT FIX IT.
 *
 * `darkCounterpart` inverts each colour on its own. Measured on the dark pages
 * (tests/e2e/pr-e-dark-mode.spec.ts), three kinds of token came out unreadable
 * because nothing checked them against what they sit on:
 *
 *   1. FIELD EDGES. A field's border is a light grey on white; inverted it is
 *      near-black, darker than the dark surface (1.12:1), so a field had no
 *      visible edge. In dark it is a grey at 3:1 against the lightest surface a
 *      field sits on (WCAG 1.4.11).
 *   2. MID-GREY TEXT. The secondary greys a page sets text in (`--bs-lit-55555c`,
 *      `--bs-text-subtle`, …) were inverted without a check and fell to 3.4:1.
 *      Every neutral that reads as text on white (3:1 to 9:1 against white) is
 *      raised in dark until it is 4.5:1 on the lightest surface text sits on.
 *   3. LINES. Hairlines and card borders came out darker than the surface, so
 *      card edges vanished. In dark a line is a step LIGHTER than the surface,
 *      as dark interfaces draw them.
 *
 * Pale tints (a tinted panel, a selected row) count as grounds too.
 *
 * And one token keeps its light value: the words printed on the abstract
 * artwork (`AbstractMedia`), because the artwork stands in for a picture and a
 * picture does not change with the scheme.
 */
const DARK_FIELD_EDGES = [
  '--bs-control-border',
  '--bs-control-border-customer',
  '--bs-control-border-customer-hover',
] as const;
const DARK_LINES = [
  '--bs-hairline',
  '--bs-card-border',
  '--bs-border',
  '--bs-document-rule',
] as const;
const DARK_FIXED = ['--bs-media-ink-soft'] as const;
/** The surfaces text and fields sit on in dark; the lightest one decides. */
const DARK_GROUNDS = [
  '--bs-surface',
  '--bs-app-background',
  '--bs-ambient-ground',
  '--bs-shell-surface',
  '--bs-frame-surface',
  '--bs-frame-rail',
  '--bs-control-surface',
  '--bs-control-surface-hover',
  '--bs-surface-soft',
  '--bs-surface-muted',
  '--bs-surface-lavender',
  '--bs-surface-lavender-strong',
  '--bs-brand-purple-tint',
] as const;

/** A pale tint on white (a tinted panel or row): text sits on it too. */
function isPaleTint(value: string): boolean {
  const colour = parseColour(value);
  if (!colour || colour.a < 1) return false;
  const c = toOklch(colour);
  return c.l > 0.85 && c.c >= 0.025 && c.c < 0.1;
}

/** The lightest of the dark grounds: the one a light foreground must clear. */
function lightestGround(
  out: ReadonlyMap<string, string>,
  light: ReadonlyMap<string, string>,
): string {
  let best: string | null = null;
  const tints = COLOUR_TOKENS.filter((t) => isPaleTint(light.get(t.name) ?? t.value)).map(
    (t) => t.name,
  );
  for (const name of [...DARK_GROUNDS, ...tints]) {
    const value = out.get(name);
    const colour = value ? parseColour(value) : null;
    if (!colour || colour.a < 1) continue;
    if (best === null || luminance(colour) > luminance(parseColour(best)!)) {
      best = formatColour(colour);
    }
  }
  return best ?? ORIGINAL_ROLES.text;
}

/** A neutral that reads as text or an icon on white (3:1 to 9:1). */
function isMidGreyText(value: string): boolean {
  const colour = parseColour(value);
  if (!colour || colour.a < 1 || toOklch(colour).c >= 0.025) return false;
  const ratio = contrastOf(formatColour(colour), ORIGINAL_ROLES.surface);
  return ratio >= 3 && ratio <= 9;
}

/*
 * PR E — GRADIENTS FOLLOW TOO. A token whose value is a gradient with colour
 * literals in it (the Overview hero's wash) is not a colour token, so the dark
 * palette never reached it and the Control Center's hero stayed a white panel
 * under light text. Each literal in such a value is replaced by its dark
 * counterpart; a gradient written with `var(--…)` already follows. Shadows and
 * the focus ring are left alone: their colours are dark on purpose, and
 * `darkCounterpart` keeps a dark translucent colour as it is anyway.
 */
const LITERAL_COLOUR = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;
const PAINTED_VALUES = ENTRIES.filter(
  (e) =>
    parseColour(e.value) === null &&
    !/shadow|focus/.test(e.name) &&
    new RegExp(LITERAL_COLOUR.source).test(e.value),
);

function darkValue(value: string): string {
  return value.replace(LITERAL_COLOUR, (literal) => {
    const colour = parseColour(literal);
    return colour ? formatColour(darkCounterpart(colour)) : literal;
  });
}

/** Every colour token's dark value: generated, then the dark palette's roles. */
function darkColours(look: ThemeLook): Map<string, string> {
  const light = lightColours(lightPalette(look));
  const out = new Map<string, string>();
  for (const token of COLOUR_TOKENS) {
    const value = light.get(token.name) ?? token.value;
    out.set(token.name, formatColour(darkCounterpart(parseColour(value)!)));
  }
  writeRoles(out, darkPalette(look));
  for (const token of PAINTED_VALUES) out.set(token.name, darkValue(token.value.trim()));
  const ground = lightestGround(out, light);
  // 2. Mid-grey text, readable on every ground (the roles already are).
  for (const token of COLOUR_TOKENS) {
    if (isMidGreyText(light.get(token.name) ?? token.value)) {
      out.set(token.name, untilReadable(out.get(token.name)!, ground, 4.5));
    }
  }
  for (const role of ['textSecondary', 'textMuted'] as const) {
    for (const name of ROLE_TOKENS[role]) out.set(name, untilReadable(out.get(name)!, ground, 4.5));
  }
  // 1. Field edges at 3:1, starting from the hover grey so the two stay apart.
  const edge = untilReadable(out.get('--bs-control-border-customer-hover')!, ground, 3);
  for (const name of DARK_FIELD_EDGES) out.set(name, edge);
  out.set('--bs-field-edge-quiet', edge);
  out.set('--bs-control-border-customer-hover', untilReadable(edge, ground, 4.5));
  // 3. Lines: a step lighter than the surface.
  const surface = toOklch(parseColour(out.get('--bs-surface')!)!);
  for (const name of DARK_LINES) {
    out.set(name, formatColour(fromOklch({ ...surface, l: Math.min(0.5, surface.l + 0.09) })));
  }
  for (const name of DARK_FIXED) {
    const value = valueOf(name);
    if (value) out.set(name, value);
  }
  // The quiet count on the current rail item: that pill is ink in light and
  // light in dark, so its grey is measured against the pill, not the page.
  out.set(
    '--bs-nav-pill-quiet',
    untilReadable(valueOf('--bs-nav-pill-quiet')!, out.get('--bs-text-primary')!, 4.5),
  );
  // The floating Copilot button: nearly opaque in dark, so whatever passes
  // under it (a pale post picture) cannot wash out its label.
  out.set('--bs-fab-surface', formatColour({ ...parseColour(out.get('--bs-surface')!)!, a: 0.94 }));
  // Home's hero canvas and the ambient light behind the frame: soft on a dark
  // ground, soft enough that text over the brightest blob keeps 4.5:1.
  out.set('--bs-hero-blob-strength', '0.12');
  out.set('--bs-ambient-strength', '0.4');
  return out;
}

/**
 * The hand-written root aliases outside `cssRootTokens` that colour a shared
 * component (tokens.css): the console badge set. A preview box re-declares
 * them, as above.
 */
const ROOT_ALIASES: ReadonlyArray<[string, string]> = [
  ['--bs-badge-neutral-fg', 'var(--bs-text-secondary)'],
  ['--bs-badge-success-bg', 'var(--bs-success-tint)'],
  ['--bs-badge-success-fg', 'var(--bs-success)'],
  ['--bs-badge-warning-bg', 'var(--bs-warning-tint)'],
  ['--bs-badge-warning-fg', 'var(--bs-warning)'],
  ['--bs-badge-danger-bg', 'var(--bs-danger-tint)'],
  ['--bs-badge-danger-fg', 'var(--bs-danger)'],
  ['--bs-badge-info-bg', 'var(--bs-info-tint)'],
  ['--bs-badge-info-fg', 'var(--bs-info)'],
  ['--bs-badge-accent-bg', 'var(--bs-brand-yellow-tint)'],
  ['--bs-badge-accent-fg', 'var(--bs-brand-yellow-text)'],
];

const RADIUS = { sharp: 0.4, medium: 1, round: 1.5 } as const;
const MOTION_LEVEL = { full: 1, reduced: 0.5, off: 0 } as const;
const MOTION_SPEED = { calm: 1.35, normal: 1, quick: 0.7 } as const;
const SIDEBAR = { compact: 0.88, default: 1, wide: 1.12 } as const;
const FONT_SCALE = { small: 0.92, normal: 1, large: 1.1 } as const;
const DENSITY = { comfortable: 1, compact: 0.86 } as const;
// Real pixels, never the --bsp-px table: that table is rescaled x0.88 in the
// dashboard, and Chromium draws a border under 1px as nothing at all.
const FIELD_BORDER = {
  '1': 'var(--bs-field-border-1)',
  '1.5': 'var(--bs-field-border-1-5)',
  '2': 'var(--bs-field-border-2)',
} as const;

/**
 * The customer look's button sizes (`.bsp-btn`, `.bsp-sm`, `.bsp-lg` in
 * tokens.css). "Buttons: small / medium / large" moves the DEFAULT size; a
 * button already marked small or large keeps its own.
 */
const BUTTON_SIZE = {
  small: {
    pad: ['var(--bsp-px-6)', 'var(--bsp-px-12)'],
    font: 'var(--bsp-fs-12-5)',
    height: 'var(--bsp-px-32)',
  },
  medium: {
    pad: ['var(--bsp-px-9)', 'var(--bsp-px-16)'],
    font: 'var(--bsp-fs-13-5)',
    height: 'var(--bsp-px-40)',
  },
  large: {
    pad: ['var(--bsp-px-12)', 'var(--bsp-px-20)'],
    font: 'var(--bsp-fs-14-5)',
    height: 'var(--bsp-px-48)',
  },
} as const;

/** The self-hosted faces, put in front of the original stacks. */
const FONT_FAMILY = {
  original: null,
  cairo: "'Cairo'",
  inter: "'Inter'",
  'ibm-plex-sans-arabic': "'IBM Plex Sans Arabic'",
  tajawal: "'Tajawal'",
} as const;

/** The shadows a theme may soften or remove. The focus ring is never one of them. */
const ELEVATION = ENTRIES.filter(
  (e) =>
    e.name.startsWith('--bs-shadow-') &&
    !e.name.includes('focus') &&
    e.name !== '--bs-shadow-lit-3',
);

/**
 * The type size tables, rebuilt at a scale. The customer application's root
 * is the prototype × 0.88 (prototype.css's `:root` table, D-484); the
 * Control Center's root, which does not load prototype.css, is the
 * prototype's own sizes; the entry screens are × 0.80 in both. Each value is
 * rounded to 0.5px and never under 11px — the rule
 * tests/unit/b7-scale.test.ts pins.
 */
function typeTables(scale: number, app: ThemeApp): Array<[string, Record<string, string>]> {
  const fs = ENTRIES.filter((e) => e.name.startsWith('--bsp-fs-'));
  const half = (v: number) => Math.round(v * 2) / 2;
  const table = (factor: number, floor: number) =>
    Object.fromEntries(
      fs.map((e) => {
        const own = parseFloat(e.value);
        const base = factor === 1 ? own : Math.max(floor, half(own * factor));
        return [e.name, `${half(base * scale)}px`];
      }),
    );
  return [
    ['', app === 'dashboard' ? table(0.88, 11) : table(1, 0)],
    ['.bsp-auth', table(0.8, 11)],
  ];
}

const gradientFallback = (value: string) => /var\(--[a-z0-9-]+\)/.exec(value)?.[0] ?? 'transparent';

/** The custom properties a look sets on its scope (light), as an ordered list. */
export function themeVariables(look: ThemeLook): Array<[string, string]> {
  const vars = new Map<string, string>(lightColours(lightPalette(look)));
  const { shape, motion, effects, layout, text, colours } = look;

  if (shape.radius !== 'medium') {
    const k = RADIUS[shape.radius];
    vars.set('--bs-radius-scale', String(k));
    for (const e of ENTRIES.filter((e) => /^--bs-radius-(?!scale|full)/.test(e.name))) {
      vars.set(e.name, `calc(${e.value} * ${k})`);
    }
  }
  if (shape.shadows === 'none') for (const e of ELEVATION) vars.set(e.name, 'none');
  if (shape.shadows === 'medium')
    for (const e of ELEVATION) vars.set(e.name, `${e.value}, ${e.value}`);

  if (motion.level !== 'full') vars.set('--bs-motion-level', String(MOTION_LEVEL[motion.level]));
  if (motion.speed !== 'normal') vars.set('--bs-motion-speed', String(MOTION_SPEED[motion.speed]));

  if (!effects.overlayBlur || !effects.glass) {
    for (const e of ENTRIES.filter((e) => e.name.startsWith('--bs-fx-backdrop-'))) {
      vars.set(e.name, 'none');
    }
  }
  if (!effects.glass) vars.set('--bs-surface-glass', 'var(--bs-surface)');
  if (!effects.gradients) {
    for (const e of ENTRIES.filter((e) => e.name.startsWith('--bs-gradient-'))) {
      vars.set(e.name, gradientFallback(e.value));
    }
  }
  if (!effects.gradients || !colours.backgroundGradient) vars.set('--bs-ambient-size', '0px');

  if (layout.sidebarWidth !== 'default') {
    const k = SIDEBAR[layout.sidebarWidth];
    for (const name of ['--bs-sidebar-expanded', '--bsp-sidebar-expanded']) {
      const value = valueOf(name);
      if (value) vars.set(name, `calc(${value} * ${k})`);
    }
  }
  if (layout.contentWidth === 'wide') vars.set('--bs-shell-max-width', 'none');
  if (layout.sidebarDefault === 'collapsed') vars.set('--bs-sidebar-default', 'collapsed');

  const face = FONT_FAMILY[text.font];
  if (face) {
    for (const name of ['--bs-font-latin', '--bs-font-arabic']) {
      vars.set(name, `${face}, ${(valueOf(name) ?? '').trim()}`);
    }
  }
  if (text.lineHeight === 'relaxed') vars.set('--bs-line-body', 'var(--bs-line-relaxed)');
  if (look.fields.border !== '1')
    vars.set('--bs-control-border-width', FIELD_BORDER[look.fields.border]);
  if (look.fields.style === 'outlined') {
    vars.set('--bs-control-surface', 'var(--bs-surface)');
    vars.set('--bs-control-border', 'var(--bs-control-border-contrast)');
    vars.set('--bs-control-border-customer', 'var(--bs-control-border-contrast)');
  }
  return [...vars];
}

/** The scoped rules a look needs beyond `:root` (type tables, buttons, fields). */
function scopedRules(look: ThemeLook, scope: string, app: ThemeApp): string[] {
  const rules: string[] = [];
  const at = (selector: string) =>
    scope === ':root' ? `:root ${selector}`.trim() : `${scope} ${selector}`.trim();
  const block = (selector: string, decls: Record<string, string>) =>
    `${selector} {\n${Object.entries(decls)
      .map(([k, v]) => `  ${k}: ${v};`)
      .join('\n')}\n}`;

  if (look.text.size !== 'normal') {
    for (const [selector, table] of typeTables(FONT_SCALE[look.text.size], app)) {
      rules.push(block(selector ? at(selector) : scope === ':root' ? ':root:root' : scope, table));
    }
  }
  // Arabic reads at least relaxed under a theme; Latin follows the owner's choice.
  rules.push(
    block(
      scope === ':root'
        ? `:root:root[dir='rtl'], ${at("[dir='rtl']")}`
        : `[dir='rtl'] ${scope}, ${scope}[dir='rtl'], ${at("[dir='rtl']")}`,
      { '--bs-line-body': 'var(--bs-line-relaxed)' },
    ),
  );

  const customerButton = at(
    '.bsp-btn:not(.bsp-sm):not(.bsp-lg):not(:is(.bs-console, .bs-gallery-console) *)',
  );
  const density = DENSITY[look.shape.density];
  if (look.buttons.size !== 'medium' || density !== 1) {
    const size = BUTTON_SIZE[look.buttons.size];
    const k = (v: string) => (density === 1 ? v : `calc(${v} * ${density})`);
    rules.push(
      block(customerButton, {
        '--bs-btn-pad': `${k(size.pad[0])} ${size.pad[1]}`,
        '--bs-btn-font-size': size.font,
        '--bs-btn-height': k(size.height),
      }),
    );
  }
  if (density !== 1) {
    rules.push(
      block(at('.bs-field'), {
        '--bs-control-pad-block': `calc(var(--bsp-px-9) * ${density})`,
      }),
    );
  }
  if (look.buttons.style !== 'filled') {
    const soft = look.buttons.style === 'soft';
    rules.push(
      block(at('.bsp-btn.bsp-pur'), {
        '--bs-btn-bg': soft ? 'var(--bs-brand-purple-tint)' : 'transparent',
        '--bs-btn-fg': 'var(--bs-brand-purple-pressed)',
        '--bs-btn-bg-hover': soft ? 'var(--bs-brand-purple-border)' : 'var(--bs-brand-purple-tint)',
        '--bs-btn-border': soft ? '0' : 'var(--bsp-px-1-5) solid var(--bs-brand-purple)',
      }),
    );
  }
  return rules;
}

/** True when a look changes nothing: the original look. */
export function isOriginalLook(look: ThemeLook): boolean {
  // The default colour scheme and the logo images draw nothing here.
  const drawn = (l: ThemeLook) =>
    JSON.stringify({ ...l, logo: null, dark: { ...l.dark, mode: null } });
  return drawn(look) === drawn(themeLookSchema.parse({}));
}

function declarations(vars: Iterable<[string, string]>): string {
  return [...vars].map(([k, v]) => `  ${k}: ${v};`).join('\n');
}

/** Which application the stylesheet is for: their root type tables differ. */
export type ThemeApp = 'dashboard' | 'admin';

export interface ThemeStylesheetOptions {
  /** `dashboard` (the default) or `admin`, the Control Center. */
  readonly app?: ThemeApp;
  /** `:root` for an app; a selector for the Control Center's preview box. */
  readonly scope?: string;
  /**
   * Which palette the scope draws. `attribute` (the default) keys the dark
   * palette on `data-color-scheme` on the scope, for the preview; an app
   * resolves the user's choice on the server instead: `light` writes no dark
   * palette, `dark` writes it on the scope, `system` under
   * `prefers-color-scheme: dark`.
   */
  readonly scheme?: 'attribute' | 'light' | 'dark' | 'system';
}

/**
 * The whole theme stylesheet: the light variables, the scoped rules, and the
 * dark palette for `data-color-scheme="dark"` and, under
 * `prefers-color-scheme: dark`, for `data-color-scheme="system"`.
 */
export function themeStylesheet(input: unknown, options: ThemeStylesheetOptions = {}): string {
  const look = themeLookSchema.parse(input ?? {});
  const scope = options.scope ?? ':root';
  const root = scope === ':root' ? ':root:root' : scope;
  const out: string[] = [];
  // The original look writes nothing on top of the stylesheets but the dark
  // palette a user may switch to.
  // A PREVIEW BOX re-declares every root alias (`--x: var(--y)`). An alias is
  // resolved where it is declared, so one declared on `:root` would carry the
  // page's value into the box instead of the box's own.
  if (scope !== ':root') {
    const aliases = ENTRIES.filter((e) => e.value.includes('var(')).map(
      (e) => [e.name, e.value.trim()] as [string, string],
    );
    out.push(`${root} {\n${declarations([...aliases, ...ROOT_ALIASES])}\n}`);
    // PR E: and the LIGHT value of everything the dark palette sets, so a box
    // previewing light shows light on a Control Center page the operator has
    // switched to dark (it used to inherit the page's dark values).
    const light = lightColours(lightPalette(look));
    const reset = [...darkColours(look).keys()]
      .map((name) => [name, light.get(name) ?? valueOf(name)?.trim()] as const)
      .filter((entry): entry is [string, string] => entry[1] !== undefined);
    out.push(`${root} {\n${declarations(reset)}\n}`);
  }
  if (!isOriginalLook(look)) {
    const light = themeVariables(look);
    if (light.length > 0) out.push(`${root} {\n${declarations(light)}\n}`);
    out.push(...scopedRules(look, scope, options.app ?? 'dashboard'));
  }

  const scheme = options.scheme ?? 'attribute';
  if (scheme === 'light') return out.join('\n');
  const dark = `  color-scheme: dark;\n${declarations(darkColours(look))}`;
  const nested = (selector: string) =>
    `@media (prefers-color-scheme: dark) {\n  ${selector} {\n${dark
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n')}\n  }\n}`;
  if (scheme === 'dark') out.push(`${root} {\n${dark}\n}`);
  else if (scheme === 'system') out.push(nested(root));
  else {
    out.push(`${root}[data-color-scheme='dark'] {\n${dark}\n}`);
    out.push(nested(`${root}[data-color-scheme='system']`));
  }
  return out.join('\n');
}

/**
 * The `@font-face` rules for a look's font, from the self-hosted files both
 * apps serve under `/fonts` (the same files Brand fonts use). Empty for the
 * original look's system stacks.
 */
export function themeFontFaces(input: unknown, base = '/fonts'): string {
  const look = themeLookSchema.parse(input ?? {});
  if (look.text.font === 'original') return '';
  const font = BUNDLED_FONTS.find((f) => f.key === look.text.font);
  if (!font) return '';
  return font.faces
    .map(
      (face) =>
        `@font-face {\n  font-family: '${font.family}';\n  font-weight: ${face.weight};\n  font-display: swap;\n  src: url('${base}/${font.directory}/${encodeURIComponent(face.file)}') format('${face.format}');\n}`,
    )
    .join('\n');
}
