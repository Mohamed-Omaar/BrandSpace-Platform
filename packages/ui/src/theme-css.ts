import {
  ORIGINAL_ROLES,
  darkCounterpart,
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
} from '@brandspace/shared';
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

/** Every colour token's dark value: generated, then the dark palette's roles. */
function darkColours(look: ThemeLook): Map<string, string> {
  const light = lightColours(lightPalette(look));
  const out = new Map<string, string>();
  for (const token of COLOUR_TOKENS) {
    const value = light.get(token.name) ?? token.value;
    out.set(token.name, formatColour(darkCounterpart(parseColour(value)!)));
  }
  writeRoles(out, darkPalette(look));
  return out;
}

const RADIUS = { sharp: 0.4, medium: 1, round: 1.5 } as const;
const MOTION_LEVEL = { full: 1, reduced: 0.5, off: 0 } as const;
const MOTION_SPEED = { calm: 1.35, normal: 1, quick: 0.7 } as const;
const SIDEBAR = { compact: 0.88, default: 1, wide: 1.12 } as const;
const FONT_SCALE = { small: 0.92, normal: 1, large: 1.1 } as const;
const DENSITY = { comfortable: 1, compact: 0.86 } as const;
const FIELD_BORDER = {
  '1': 'var(--bsp-px-1)',
  '1.5': 'var(--bsp-px-1-5)',
  '2': 'var(--bsp-px-2)',
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
 * The type size tables, rebuilt at a scale: `:root` holds the prototype's
 * sizes, the customer frame its × 0.88 table and the entry screens their
 * × 0.80 table, each rounded to 0.5px and never under 11px (D-484). The rule
 * is the one tests/unit/b7-scale.test.ts pins.
 */
function typeTables(scale: number): Array<[string, Record<string, string>]> {
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
    ['', table(1, 0)],
    ['.bsp-frame', table(0.88, 11)],
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
function scopedRules(look: ThemeLook, scope: string): string[] {
  const rules: string[] = [];
  const at = (selector: string) =>
    scope === ':root' ? `:root ${selector}`.trim() : `${scope} ${selector}`.trim();
  const block = (selector: string, decls: Record<string, string>) =>
    `${selector} {\n${Object.entries(decls)
      .map(([k, v]) => `  ${k}: ${v};`)
      .join('\n')}\n}`;

  if (look.text.size !== 'normal') {
    for (const [selector, table] of typeTables(FONT_SCALE[look.text.size])) {
      rules.push(block(selector ? at(selector) : scope === ':root' ? ':root:root' : scope, table));
    }
  }
  // Arabic reads at least relaxed under a theme; Latin follows the owner's choice.
  rules.push(
    block(`${scope === ':root' ? ':root:root' : scope}[dir='rtl'], ${at("[dir='rtl']")}`, {
      '--bs-line-body': 'var(--bs-line-relaxed)',
    }),
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

export interface ThemeStylesheetOptions {
  /** `:root` for an app; a selector for the Control Center's preview box. */
  readonly scope?: string;
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
  if (!isOriginalLook(look)) {
    const light = themeVariables(look);
    if (light.length > 0) out.push(`${root} {\n${declarations(light)}\n}`);
    out.push(...scopedRules(look, scope));
  }

  const dark = declarations(darkColours(look));
  const darkScope =
    scope === ':root'
      ? ":root:root[data-color-scheme='dark']"
      : `${scope}[data-color-scheme='dark']`;
  const systemScope =
    scope === ':root'
      ? ":root:root[data-color-scheme='system']"
      : `${scope}[data-color-scheme='system']`;
  out.push(`${darkScope} {\n  color-scheme: dark;\n${dark}\n}`);
  out.push(
    `@media (prefers-color-scheme: dark) {\n  ${systemScope} {\n    color-scheme: dark;\n${dark
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n')}\n  }\n}`,
  );
  return out.join('\n');
}
