import {
  contrastOf,
  darkCounterpart,
  follow,
  formatColour,
  parseColour,
  readableOn,
  untilReadable,
} from './color';
import type { ThemeLook } from './schema';

/**
 * THE ROLE COLOURS OF A LOOK (LF).
 *
 * `ORIGINAL_ROLES` is the original look's value for each role the theme can
 * move. The values are the design tokens' (`colorValues` in packages/ui
 * tokens.ts); tests/unit/theme.test.ts fails if the two ever differ.
 */
export const ORIGINAL_ROLES = {
  primary: '#7935fe',
  primaryHover: '#6528e0',
  primaryPressed: '#5312c4',
  primaryInk: '#ffffff',
  primaryTint: '#f0e9ff',
  primaryBorder: '#d6c2ff',
  secondary: '#ffdd15',
  secondaryInk: '#1a1a1a',
  secondaryText: '#7a6800',
  secondaryTint: '#fff9db',
  background: '#f2f2f2',
  ambientGround: '#f3f3f3',
  surface: '#ffffff',
  text: '#111114',
  textSecondary: '#4d4c53',
  textMuted: '#6a6a72',
  success: '#16794b',
  warning: '#875f00',
  danger: '#b83245',
  info: '#175cd3',
  focus: '#7935fe',
} as const;

export type Role = keyof typeof ORIGINAL_ROLES;
export type Palette = Record<Role, string>;

const rgb = (hex: string) => parseColour(hex)!;
const followHex = (colour: string, from: string, to: string) =>
  formatColour(follow(rgb(colour), rgb(from), rgb(to)));
const dark = (hex: string) => formatColour(darkCounterpart(rgb(hex)));

/** The light palette of a look: what the owner chose, and what follows from it. */
export function lightPalette(look: ThemeLook): Palette {
  const o = ORIGINAL_ROLES;
  const c = look.colours;
  const p: Palette = { ...o };
  if (c.primary && c.primary !== o.primary) {
    p.primary = c.primary;
    p.primaryHover = followHex(o.primaryHover, o.primary, c.primary);
    p.primaryPressed = followHex(o.primaryPressed, o.primary, c.primary);
    p.primaryTint = followHex(o.primaryTint, o.primary, c.primary);
    p.primaryBorder = followHex(o.primaryBorder, o.primary, c.primary);
    p.primaryInk = readableOn(c.primary);
    p.focus = c.primary;
  }
  if (c.secondary && c.secondary !== o.secondary) {
    p.secondary = c.secondary;
    p.secondaryTint = followHex(o.secondaryTint, o.secondary, c.secondary);
    p.secondaryInk = readableOn(c.secondary, '#ffffff', o.secondaryInk);
  }
  if (c.background) {
    p.background = c.background;
    p.ambientGround = c.background;
  }
  if (c.surface) p.surface = c.surface;
  if (c.text) p.text = c.text;
  for (const role of ['success', 'warning', 'danger', 'info'] as const) {
    if (c[role]) p[role] = c[role]!;
  }
  // Yellow as text is always derived, and always readable on the surface.
  const secondaryText =
    p.secondary === o.secondary
      ? o.secondaryText
      : followHex(o.secondaryText, o.secondary, p.secondary);
  p.secondaryText = untilReadable(secondaryText, p.surface, 4.5);
  return p;
}

/** The generated dark palette, with the owner's adjustments on top. */
export function darkPalette(look: ThemeLook): Palette {
  const light = lightPalette(look);
  const p = Object.fromEntries(
    Object.entries(light).map(([role, value]) => [role, dark(value)]),
  ) as Palette;
  const d = look.dark;
  if (d.background) {
    p.background = d.background;
    p.ambientGround = d.background;
  }
  if (d.surface) p.surface = d.surface;
  if (d.text) p.text = d.text;
  p.primary = d.primary ?? untilReadable(p.primary, p.surface, 4.5);
  p.focus = p.primary;
  p.primaryInk = readableOn(p.primary);
  for (const role of ['textSecondary', 'textMuted', 'secondaryText'] as const) {
    p[role] = untilReadable(p[role], p.surface, 4.5);
  }
  for (const role of ['success', 'warning', 'danger', 'info'] as const) {
    p[role] = untilReadable(p[role], p.surface, 4.5);
  }
  p.secondaryInk = readableOn(p.secondary);
  return p;
}

/** One contrast check a theme must pass (WCAG 2.2 AA). */
export interface ContrastIssue {
  readonly scheme: 'light' | 'dark';
  readonly check: string;
  readonly ratio: number;
  readonly needed: number;
  /** A plain reason, in both product languages. */
  readonly en: string;
  readonly ar: string;
}

const CHECKS: ReadonlyArray<{
  readonly check: string;
  readonly fg: Role;
  readonly bg: Role;
  readonly needed: number;
  readonly en: string;
  readonly ar: string;
}> = [
  {
    check: 'text-on-background',
    fg: 'text',
    bg: 'background',
    needed: 4.5,
    en: 'Text is hard to read on the background',
    ar: 'النص صعب القراءة على الخلفية',
  },
  {
    check: 'text-on-surface',
    fg: 'text',
    bg: 'surface',
    needed: 4.5,
    en: 'Text is hard to read on cards and panels',
    ar: 'النص صعب القراءة على البطاقات واللوحات',
  },
  {
    check: 'secondary-text-on-surface',
    fg: 'textSecondary',
    bg: 'surface',
    needed: 4.5,
    en: 'Secondary text is hard to read on cards',
    ar: 'النص الثانوي صعب القراءة على البطاقات',
  },
  {
    check: 'button-text',
    fg: 'primaryInk',
    bg: 'primary',
    needed: 4.5,
    en: 'Button text is hard to read on the primary colour',
    ar: 'نص الأزرار صعب القراءة على اللون الأساسي',
  },
  {
    check: 'primary-as-text',
    fg: 'primary',
    bg: 'surface',
    needed: 4.5,
    en: 'Links in the primary colour are hard to read on cards',
    ar: 'الروابط باللون الأساسي صعبة القراءة على البطاقات',
  },
  {
    check: 'focus-on-background',
    fg: 'focus',
    bg: 'background',
    needed: 3,
    en: 'The focus ring is hard to see on the background',
    ar: 'إطار التركيز صعب الرؤية على الخلفية',
  },
  {
    check: 'focus-on-surface',
    fg: 'focus',
    bg: 'surface',
    needed: 3,
    en: 'The focus ring is hard to see on cards',
    ar: 'إطار التركيز صعب الرؤية على البطاقات',
  },
  {
    check: 'secondary-button-text',
    fg: 'secondaryInk',
    bg: 'secondary',
    needed: 4.5,
    en: 'Text is hard to read on the secondary colour',
    ar: 'النص صعب القراءة على اللون الثانوي',
  },
  {
    check: 'success-text',
    fg: 'success',
    bg: 'surface',
    needed: 4.5,
    en: 'The success colour is hard to read on cards',
    ar: 'لون النجاح صعب القراءة على البطاقات',
  },
  {
    check: 'warning-text',
    fg: 'warning',
    bg: 'surface',
    needed: 4.5,
    en: 'The warning colour is hard to read on cards',
    ar: 'لون التحذير صعب القراءة على البطاقات',
  },
  {
    check: 'danger-text',
    fg: 'danger',
    bg: 'surface',
    needed: 4.5,
    en: 'The error colour is hard to read on cards',
    ar: 'لون الخطأ صعب القراءة على البطاقات',
  },
  {
    check: 'info-text',
    fg: 'info',
    bg: 'surface',
    needed: 4.5,
    en: 'The information colour is hard to read on cards',
    ar: 'لون المعلومات صعب القراءة على البطاقات',
  },
];

/**
 * Every WCAG AA contrast failure of a look, in light AND dark — each user may
 * switch to dark, whatever the default — with a plain reason. Empty means the
 * look may be activated.
 */
export function contrastIssues(look: ThemeLook): ContrastIssue[] {
  const out: ContrastIssue[] = [];
  for (const [scheme, palette] of [
    ['light', lightPalette(look)],
    ['dark', darkPalette(look)],
  ] as const) {
    for (const c of CHECKS) {
      const ratio = contrastOf(palette[c.fg], palette[c.bg]);
      if (ratio + 1e-9 < c.needed) {
        const n = (x: number) => (Math.round(x * 100) / 100).toString();
        out.push({
          scheme,
          check: c.check,
          ratio,
          needed: c.needed,
          en: `${c.en} in ${scheme} mode (${n(ratio)}:1, needs ${c.needed}:1).`,
          ar: `${c.ar} في الوضع ${scheme === 'light' ? 'الفاتح' : 'الداكن'} (${n(ratio)}:1، والمطلوب ${c.needed}:1).`,
        });
      }
    }
  }
  return out;
}
