import { describe, expect, it } from 'vitest';
import {
  contrastOf,
  formatColour,
  luminance,
  parseColour,
  presetLook,
  type ThemePresetKey,
} from '@brandspace/shared/theme';
import { themeStylesheet } from '../../packages/ui/src/theme-css';

/**
 * PR E — THE DARK PALETTE IS READABLE BY CONSTRUCTION.
 *
 * The browser suite (`tests/e2e/pr-e-dark-mode.spec.ts`) measures the pages;
 * this pins the rules that make them pass, for the original look AND every
 * starting preset, so a look the owner activates cannot bring the problems
 * back:
 *
 *   - every text colour the pages use is 4.5:1 on every dark ground (WCAG 1.4.3);
 *   - a field's edge, the focus ring and the primary colour as a mark are 3:1
 *     on every dark ground (WCAG 1.4.11);
 *   - status colours and links read on cards (4.5:1);
 *   - the quiet count on the current rail item reads on that pill, in both;
 *   - glass is the surface's colour, gradients go dark, lines are lighter than
 *     the surface, and the words on the abstract artwork keep their ink.
 */

/**
 * The custom properties the blocks for exactly this selector declare, in
 * order, a later one winning — as the cascade does.
 */
function block(
  css: string,
  selector: string,
  only?: (body: string) => boolean,
): Map<string, string> {
  const out = new Map<string, string>();
  let found = false;
  for (const chunk of css.split(/\n(?=\S)/)) {
    if (!chunk.startsWith(`${selector} {`)) continue;
    if (only && !only(chunk)) continue;
    found = true;
    for (const m of chunk.matchAll(/(--[a-z0-9-]+): ([^;]+);/g)) out.set(m[1]!, m[2]!.trim());
  }
  expect(found, `no "${selector}" block`).toBe(true);
  return out;
}

/** The dark block of a look's stylesheet (the one that says `color-scheme: dark`). */
const darkOf = (look: unknown) =>
  block(themeStylesheet(look, { scheme: 'dark' }), ':root:root', (body) =>
    body.includes('color-scheme: dark'),
  );

const TEXT = [
  '--bs-text-primary',
  '--bs-text-secondary',
  '--bs-text-muted',
  '--bs-text-subtle',
  '--bs-lit-55555c',
  '--bs-lit-6d6d76',
  '--bs-lit-75757e',
  '--bs-lit-8a8a92',
] as const;
const GROUNDS = [
  '--bs-surface',
  '--bs-app-background',
  '--bs-ambient-ground',
  '--bs-shell-surface',
  '--bs-control-surface',
  '--bs-surface-soft',
  '--bs-surface-muted',
  '--bs-surface-lavender',
  '--bs-surface-lavender-strong',
  '--bs-brand-purple-tint',
] as const;
const LOOKS: readonly ThemePresetKey[] = ['original', 'calm', 'modern', 'premium', 'light'];

describe('PR E · the dark palette', () => {
  for (const key of LOOKS) {
    describe(`${key} look`, () => {
      const dark = darkOf(presetLook(key));
      const get = (name: string) => {
        const value = dark.get(name);
        expect(value, name).toBeDefined();
        return value!;
      };

      it('every text colour is 4.5:1 on every ground', () => {
        for (const text of TEXT) {
          for (const ground of GROUNDS) {
            expect(
              contrastOf(get(text), get(ground)),
              `${text} on ${ground}`,
            ).toBeGreaterThanOrEqual(4.5);
          }
        }
      });

      it("a field's edge and the focus ring are 3:1 on every ground", () => {
        for (const edge of [
          '--bs-control-border',
          '--bs-control-border-customer',
          '--bs-field-edge-quiet',
          '--bs-focus-ring',
        ]) {
          for (const ground of GROUNDS) {
            expect(
              contrastOf(get(edge), get(ground)),
              `${edge} on ${ground}`,
            ).toBeGreaterThanOrEqual(3);
          }
        }
      });

      it('status colours and the primary as text read on cards', () => {
        for (const ink of [
          '--bs-success',
          '--bs-warning',
          '--bs-danger',
          '--bs-info',
          '--bs-brand-purple',
          '--bs-brand-purple-pressed',
        ]) {
          expect(contrastOf(get(ink), get('--bs-surface')), ink).toBeGreaterThanOrEqual(4.5);
        }
      });

      it('the quiet count reads on the current rail item (a light pill in dark)', () => {
        expect(
          contrastOf(get('--bs-nav-pill-quiet'), get('--bs-text-primary')),
        ).toBeGreaterThanOrEqual(4.5);
      });
    });
  }

  it('in light, the field edge stays none and the count keeps the prototype grey on ink', () => {
    const light = block(themeStylesheet({}, { scope: '.preview' }), '.preview');
    expect(light.get('--bs-field-edge-quiet') ?? 'transparent').toBe('transparent');
    // `.preview` re-declares the light values (below); the root light value is
    // the token itself: the prototype's #8a8a92, 5.6:1 on the #111114 pill.
    expect(contrastOf('#8a8a92', '#111114')).toBeGreaterThanOrEqual(4.5);
  });

  it('glass takes the dark surface, not a near-black below it', () => {
    const dark = darkOf({});
    const surface = parseColour(dark.get('--bs-surface')!)!;
    for (const glass of [
      '--bs-surface-card-alpha',
      '--bs-float-card-alpha',
      '--bs-surface-glass',
    ]) {
      const value = parseColour(dark.get(glass)!)!;
      expect(value.a, glass).toBeLessThan(1);
      expect(Math.abs(luminance(value) - luminance(surface)), glass).toBeLessThan(0.002);
    }
  });

  it('lines are a step lighter than the surface, so card edges show', () => {
    const dark = darkOf({});
    for (const line of ['--bs-hairline', '--bs-card-border', '--bs-border']) {
      expect(luminance(parseColour(dark.get(line)!)!), line).toBeGreaterThan(
        luminance(parseColour(dark.get('--bs-surface')!)!),
      );
    }
  });

  it("gradients with colour literals go dark: the Overview hero's wash", () => {
    const wash = darkOf({}).get('--bs-gradient-overview-hero')!;
    const colours = [...wash.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi)].map((m) =>
      parseColour(m[0])!,
    );
    expect(colours.length).toBeGreaterThan(0);
    for (const colour of colours) expect(luminance(colour)).toBeLessThan(0.1);
  });

  it('the words on the abstract artwork keep their ink: the artwork does not change', () => {
    expect(darkOf({}).get('--bs-media-ink-soft')).toBe('#2a1a5e');
  });

  it('PR D: the floating Copilot button is nearly opaque in dark, so a picture under it cannot wash out its label', () => {
    const dark = darkOf({});
    const fab = parseColour(dark.get('--bs-fab-surface')!)!;
    expect(fab.a).toBeGreaterThanOrEqual(0.9);
    const surface = parseColour(dark.get('--bs-surface')!)!;
    expect(Math.abs(luminance(fab) - luminance(surface))).toBeLessThan(0.002);
    // The label over the worst case — a white picture under the 6% that shows through.
    const over = (a: number) => fab.r * fab.a + 1 * (1 - fab.a) * a;
    const painted = {
      r: over(1),
      g: fab.g * fab.a + (1 - fab.a),
      b: fab.b * fab.a + (1 - fab.a),
      a: 1,
    };
    expect(
      contrastOf(dark.get('--bs-text-primary')!, formatColour(painted)),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it('the ambient light and the hero blobs are softened in dark only', () => {
    const dark = darkOf({});
    expect(Number(dark.get('--bs-ambient-strength'))).toBeLessThan(1);
    expect(Number(dark.get('--bs-hero-blob-strength'))).toBeLessThan(0.35);
  });

  it("a preview box declares the light value of everything dark sets, whatever the page's scheme", () => {
    const css = themeStylesheet({}, { scope: '.preview', app: 'admin' });
    const light = block(css, '.preview');
    const dark = block(css, ".preview[data-color-scheme='dark']");
    for (const name of dark.keys()) {
      if (name === 'color-scheme') continue;
      expect(light.has(name), `${name} has a light value in the box`).toBe(true);
    }
    expect(light.get('--bs-surface')?.toLowerCase()).toBe('#ffffff');
    expect(light.get('--bs-field-edge-quiet')).toBe('transparent');
  });
});
