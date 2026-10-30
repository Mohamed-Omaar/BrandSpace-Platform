import { describe, expect, it } from 'vitest';
import {
  ORIGINAL_ROLES,
  THEME_PRESET_KEYS,
  contrastIssues,
  contrastOf,
  darkPalette,
  follow,
  formatColour,
  lightPalette,
  originalTheme,
  parseColour,
  presetLook,
  themeLookSchema,
} from '@brandspace/shared';
import { CONFIG_DOMAINS } from '@brandspace/config';
import { ambientTokens, colorValues } from '../../packages/ui/src/tokens';
import { isOriginalLook, themeStylesheet, themeVariables } from '../../packages/ui/src/theme-css';

/**
 * THE LOOK & FEEL THEME ENGINE (LF).
 *
 * The theme document's defaults are the original look, value for value; a
 * look that fails WCAG AA contrast, in light or in dark, cannot be activated;
 * and the stylesheet a theme writes is custom properties drawn from fixed
 * tables and validated colours.
 */
const look = (input: unknown) => themeLookSchema.parse(input);

describe('the original look', () => {
  it('is the empty document, and changes nothing', () => {
    expect(originalTheme()).toEqual(CONFIG_DOMAINS.theme.schema.parse({}));
    expect(isOriginalLook(originalTheme().look)).toBe(true);
    expect(themeVariables(look({}))).toEqual([]);
  });

  it("its role colours are the design tokens' (a theme default cannot drift)", () => {
    const tokens: Record<keyof typeof ORIGINAL_ROLES, string> = {
      primary: colorValues.brandPurple,
      primaryHover: colorValues.brandPurpleHover,
      primaryPressed: colorValues.brandPurplePressed,
      primaryInk: colorValues.brandPurpleInk,
      primaryTint: colorValues.brandPurpleTint,
      primaryBorder: colorValues.brandPurpleBorder,
      secondary: colorValues.brandYellow,
      secondaryInk: colorValues.brandYellowInk,
      secondaryText: colorValues.brandYellowText,
      secondaryTint: colorValues.brandYellowTint,
      background: colorValues.appBackground,
      ambientGround: ambientTokens.ground,
      surface: colorValues.surface,
      text: colorValues.textPrimary,
      textSecondary: colorValues.textSecondary,
      textMuted: colorValues.textMuted,
      success: colorValues.success,
      warning: colorValues.warning,
      danger: colorValues.danger,
      info: colorValues.info,
      focus: colorValues.focusRing,
    };
    for (const [role, value] of Object.entries(ORIGINAL_ROLES)) {
      expect(value, role).toBe(tokens[role as keyof typeof tokens].toLowerCase());
    }
  });

  it('writes only the dark palette a user may switch to, never a light override', () => {
    const css = themeStylesheet({});
    expect(css).not.toMatch(/^:root:root \{/m);
    expect(css).toContain(":root:root[data-color-scheme='dark'] {");
    expect(css).toContain('@media (prefers-color-scheme: dark)');
  });

  it('passes every contrast check, light and dark', () => {
    expect(contrastIssues(look({}))).toEqual([]);
  });
});

describe('the presets', () => {
  it.each(THEME_PRESET_KEYS)('%s passes every contrast check, light and dark', (key) => {
    expect(contrastIssues(presetLook(key))).toEqual([]);
  });

  it('"light and fast" turns every effect off', () => {
    expect(presetLook('light').effects).toEqual({
      overlayBlur: false,
      gradients: false,
      glass: false,
    });
  });
});

describe('colours', () => {
  it('the owner picks the primary; its scale and a readable text colour are generated', () => {
    const p = lightPalette(look({ colours: { primary: '#0f766e' } }));
    expect(p.primary).toBe('#0f766e');
    expect(p.focus).toBe('#0f766e');
    for (const shade of [p.primaryHover, p.primaryPressed, p.primaryTint, p.primaryBorder]) {
      expect(shade).not.toBe('#7935fe');
    }
    expect(contrastOf(p.primaryInk, p.primary)).toBeGreaterThanOrEqual(4.5);
  });

  it('a family colour keeps its relation to the anchor (the identity move changes nothing)', () => {
    const tint = parseColour('#f0e9ff')!;
    const anchor = parseColour('#7935fe')!;
    expect(formatColour(follow(tint, anchor, anchor))).toBe('#f0e9ff');
  });

  it('the dark palette is generated and adjustable', () => {
    const generated = darkPalette(look({}));
    expect(contrastOf(generated.text, generated.surface)).toBeGreaterThanOrEqual(4.5);
    // A card stays lighter than the page it sits on.
    expect(contrastOf('#000000', generated.surface)).toBeGreaterThan(
      contrastOf('#000000', generated.background) - 0.001,
    );
    expect(darkPalette(look({ dark: { surface: '#202024' } })).surface).toBe('#202024');
  });
});

describe('validation: a look that cannot be read is refused, with a plain reason', () => {
  it('a pale primary is refused in both languages', () => {
    const issues = contrastIssues(look({ colours: { primary: '#ffee00' } }));
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.en).toMatch(/hard to (read|see)/);
    expect(issues[0]!.ar).toMatch(/صعب/);
  });

  it('the configuration domain refuses it, so it can never be activated', () => {
    const result = CONFIG_DOMAINS.theme.schema.safeParse({
      look: { colours: { primary: '#ffee00' } },
    });
    expect(result.success).toBe(false);
  });

  it('a saved preset must pass too', () => {
    const result = CONFIG_DOMAINS.theme.schema.safeParse({
      savedPresets: [{ id: 'pale', name: 'Pale', look: { colours: { text: '#dddddd' } } }],
    });
    expect(result.success).toBe(false);
  });

  it('a colour is #rrggbb and nothing else, so no text reaches the stylesheet', () => {
    for (const value of ['red', '#fff', 'rgb(0,0,0)', '#000000;}body{', 'var(--x)']) {
      expect(themeLookSchema.safeParse({ colours: { primary: value } }).success, value).toBe(false);
    }
  });
});

describe('the stylesheet', () => {
  it('sets custom properties only, plus the colour scheme', () => {
    const css = themeStylesheet(presetLook('premium'));
    const declarations = [...css.matchAll(/^\s+([a-z-]+):/gm)].map((m) => m[1]);
    for (const name of declarations) {
      expect(name === 'color-scheme' || name!.startsWith('--'), name).toBe(true);
    }
  });

  it('text size rebuilds the type tables at the same rule (×0.88 customer root, ×0.80 entry)', () => {
    const css = themeStylesheet({ text: { size: 'large' } });
    expect(css).toMatch(/:root:root \{[^}]*--bsp-fs-14: 14px;/);
    expect(css).toMatch(/:root \.bsp-auth \{[^}]*--bsp-fs-14: 12px;/);
    // The Control Center's root is the prototype's own sizes.
    const admin = themeStylesheet({ text: { size: 'large' } }, { app: 'admin' });
    expect(admin).toMatch(/:root:root \{[^}]*--bsp-fs-14: 15\.5px;/);
  });

  it('removing shadows never removes the focus ring', () => {
    const vars = new Map(themeVariables(look({ shape: { shadows: 'none' } })));
    expect(vars.get('--bs-shadow-card')).toBe('none');
    expect(vars.has('--bs-shadow-focus')).toBe(false);
  });

  it('motion level and speed, effects and layout are switches', () => {
    const vars = new Map(
      themeVariables(
        look({
          motion: { level: 'off', speed: 'quick' },
          effects: { overlayBlur: false },
          layout: { sidebarWidth: 'wide', contentWidth: 'wide' },
        }),
      ),
    );
    expect(vars.get('--bs-motion-level')).toBe('0');
    expect(vars.get('--bs-motion-speed')).toBe('0.7');
    expect(vars.get('--bs-fx-backdrop-24')).toBe('none');
    expect(vars.get('--bs-sidebar-expanded')).toBe('calc(15.5rem * 1.12)');
    expect(vars.get('--bs-shell-max-width')).toBe('none');
  });

  it('a preview is scoped to its box and never touches the page', () => {
    const css = themeStylesheet(presetLook('calm'), { scope: '.bs-theme-preview' });
    expect(css).not.toContain(':root');
    expect(css).toContain('.bs-theme-preview {');
  });
});
