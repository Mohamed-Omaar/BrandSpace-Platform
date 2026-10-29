import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buttonClass } from '../../packages/ui/src/primitives';
import { colorValues } from '../../packages/ui/src/tokens';

/**
 * THE ONE BUTTON, TWO LOOKS (design-system programme, S5).
 *
 * `.bsp-btn` lives in tokens.css, which both apps load. Every property is a
 * `--bs-btn-*` variable: the customer look is the prototype's `.btn` (the
 * values prototype.css carried until S5), and the console look — the Control
 * Center's own button, an owner decision — is the set the retired inline
 * `buttonStyle()` painted, now with a hover (L-37). This pins both sets, so a
 * later edit to one look cannot silently change the other.
 */
const css = readFileSync(path.resolve(__dirname, '../../packages/ui/src/tokens.css'), 'utf8');
const read = (file: string) => readFileSync(path.resolve(__dirname, '../..', file), 'utf8');

function rule(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped} \\{\\n([\\s\\S]*?)\\n\\}`).exec(css);
  expect(match, selector).not.toBeNull();
  return Object.fromEntries(
    [...match![1]!.matchAll(/^\s*(--bs-btn-[a-z-]+):\s*([^;]+);/gm)].map((m) => [m[1]!, m[2]!]),
  );
}

const CONSOLE = ':is(.bs-console, .bs-gallery-console) .bsp-btn';

describe('the customer look: the prototype .btn, unchanged', () => {
  it('base: 40px, 13.5px at 700, radius 12, ink with a #2a2a30 hover', () => {
    expect(rule('.bsp-btn')).toEqual({
      '--bs-btn-gap': 'var(--bsp-px-8)',
      '--bs-btn-radius': 'var(--bsp-px-12)',
      '--bs-btn-pad': 'var(--bsp-px-9) var(--bsp-px-16)',
      '--bs-btn-font-size': 'var(--bsp-fs-13-5)',
      '--bs-btn-font-weight': '700',
      '--bs-btn-line-height': 'normal',
      '--bs-btn-height': 'var(--bsp-px-40)',
      '--bs-btn-border': '0',
      '--bs-btn-bg': 'var(--bs-text-primary)',
      '--bs-btn-fg': 'var(--bs-surface)',
      '--bs-btn-bg-hover': 'var(--bs-lit-2a2a30)',
    });
  });

  it('sizes and fills', () => {
    expect(rule('.bsp-btn.bsp-sm')).toEqual({
      '--bs-btn-pad': 'var(--bsp-px-6) var(--bsp-px-12)',
      '--bs-btn-font-size': 'var(--bsp-fs-12-5)',
      '--bs-btn-height': 'var(--bsp-px-32)',
      '--bs-btn-radius': 'var(--bsp-px-10)',
    });
    expect(rule('.bsp-btn.bsp-lg')).toEqual({
      '--bs-btn-pad': 'var(--bsp-px-12) var(--bsp-px-20)',
      '--bs-btn-font-size': 'var(--bsp-fs-14-5)',
      '--bs-btn-height': 'var(--bsp-px-48)',
    });
    expect(rule('.bsp-btn.bsp-pur')).toEqual({
      '--bs-btn-bg': 'var(--bs-brand-purple)',
      '--bs-btn-bg-hover': 'var(--bs-brand-purple-hover)',
    });
    expect(rule('.bsp-btn.bsp-sec')).toEqual({
      '--bs-btn-bg': 'var(--bs-lit-f2f2f4)',
      '--bs-btn-fg': 'var(--bs-text-primary)',
      '--bs-btn-bg-hover': 'var(--bs-lit-e6e6ea)',
    });
    expect(rule('.bsp-btn.bsp-ghost')).toEqual({
      '--bs-btn-bg': 'transparent',
      '--bs-btn-fg': 'var(--bs-text-primary)',
      '--bs-btn-bg-hover': 'var(--bs-lit-f2f2f4)',
    });
    expect(rule('.bsp-btn.bsp-danger')).toEqual({ '--bs-btn-fg': 'var(--bs-danger)' });
  });

  it('prototype.css no longer defines the button, so one rule set serves both apps', () => {
    // Screen-specific modifiers (`.bsp-btn.bsp-apr-start`) stay with their screens.
    expect(read('packages/ui/src/prototype.css')).not.toMatch(
      /^\.bsp-btn(\.bsp-(pur|sec|ghost|sm|lg|danger))?(:hover)? \{/m,
    );
  });
});

describe('the console look: what buttonStyle() painted inline, as variables', () => {
  it('base: 40px, 10px at 800, radius .75rem, a transparent 1px border, ink', () => {
    expect(rule(CONSOLE)).toEqual({
      '--bs-btn-gap': 'var(--bsp-rem-0-5)',
      '--bs-btn-radius': 'var(--bsp-rem-0-75)',
      '--bs-btn-pad': '0 var(--bsp-rem-0-9375)',
      '--bs-btn-font-size': 'var(--bsp-fs-10)',
      '--bs-btn-font-weight': '800',
      '--bs-btn-line-height': 'var(--bsp-rem-0-875)',
      '--bs-btn-height': 'var(--bsp-rem-2-5)',
      '--bs-btn-border': '1px solid transparent',
      '--bs-btn-bg': 'var(--bs-ink)',
      '--bs-btn-fg': 'var(--bs-ink-ink)',
      '--bs-btn-bg-hover': 'var(--bs-ink-hover)',
    });
  });

  it('the small console button is the legacy 36px, 9px at 750', () => {
    expect(rule(`${CONSOLE}.bsp-sm`)).toEqual({
      '--bs-btn-pad': '0 var(--bsp-rem-0-6875)',
      '--bs-btn-font-size': 'var(--bsp-rem-0-5625)',
      '--bs-btn-font-weight': '750',
      '--bs-btn-height': 'var(--bsp-rem-2-25)',
      '--bs-btn-radius': 'var(--bsp-rem-0-625)',
    });
    expect(rule(`${CONSOLE}.bsp-lg`)).toEqual({ '--bs-btn-height': 'var(--bsp-rem-3)' });
  });

  it("each fill is the inline style's, and each has a hover", () => {
    expect(rule(`${CONSOLE}.bsp-pur`)['--bs-btn-bg']).toBe('var(--bs-brand-purple)');
    expect(rule(`${CONSOLE}.bsp-sec`)['--bs-btn-bg']).toBe('var(--bs-surface-muted)');
    expect(rule(`${CONSOLE}.bsp-ghost`)['--bs-btn-fg']).toBe('var(--bs-text-secondary)');
    expect(rule(`${CONSOLE}.bsp-accent`)['--bs-btn-bg']).toBe('var(--bs-brand-yellow)');
    expect(rule(`${CONSOLE}.bsp-danger`)).toMatchObject({
      '--bs-btn-bg': 'var(--bs-danger-tint)',
      '--bs-btn-fg': 'var(--bs-danger)',
    });
    for (const variant of ['', '.bsp-pur', '.bsp-sec', '.bsp-ghost', '.bsp-danger']) {
      const set = rule(`${CONSOLE}${variant}`);
      expect(set['--bs-btn-bg-hover'], variant || 'primary').toBeDefined();
      expect(set['--bs-btn-bg-hover'], variant || 'primary').not.toBe(set['--bs-btn-bg']);
    }
    // The hover tokens exist and are distinct colours from their fills.
    expect(colorValues.inkHover).not.toBe(colorValues.ink);
    expect(colorValues.controlSurfaceHover).not.toBe(colorValues.surfaceMuted);
  });

  it('the Control Center shell is the console scope', () => {
    expect(read('packages/ui/src/app-shell.tsx')).toContain(
      'className="bs-ambient-host bs-console"',
    );
  });
});

describe('buttonClass', () => {
  it('accent carries `bsp-accent`, so the console can draw it yellow while the customer look keeps `.sec`', () => {
    expect(buttonClass('accent')).toBe('bsp-btn bsp-sec bsp-accent');
    expect(css).not.toMatch(/^\.bsp-btn\.bsp-accent \{/m);
  });

  it('the other variants are unchanged', () => {
    expect(buttonClass('primary')).toBe('bsp-btn');
    expect(buttonClass('brand', 'sm')).toBe('bsp-btn bsp-pur bsp-sm');
    expect(buttonClass('neutral', 'lg')).toBe('bsp-btn bsp-sec bsp-lg');
    expect(buttonClass('ghost')).toBe('bsp-btn bsp-ghost');
    expect(buttonClass('danger')).toBe('bsp-btn bsp-sec bsp-danger');
  });
});
