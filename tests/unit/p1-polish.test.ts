import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { nextColourScheme, resolveColourScheme } from '@brandspace/shared/theme';
import { cssRootTokens, elapsedText, themeStylesheet } from '@brandspace/ui';

/**
 * P1 — the style polish before the performance PR. What can be pinned without
 * a browser: the one colour-scheme rule, the stylesheet that follows the page's
 * attribute, the elapsed-time text, the one frame both apps draw, and the
 * Copilot button's lane being gone. The browser half is
 * tests/e2e/p1-polish.spec.ts.
 */
describe('one rule for light, dark and device', () => {
  it("the person's stored choice wins over the cookie and the default", () => {
    expect(resolveColourScheme({ stored: 'dark', cookie: 'light', fallback: 'light' })).toBe(
      'dark',
    );
  });
  it('the cookie carries the choice when nothing is stored (and before sign-in)', () => {
    expect(resolveColourScheme({ stored: null, cookie: 'system', fallback: 'light' })).toBe(
      'system',
    );
  });
  it('with no choice, the Look & feel default — including "follow the device"', () => {
    expect(resolveColourScheme({ fallback: 'dark' })).toBe('dark');
    expect(resolveColourScheme({ cookie: 'nonsense', fallback: 'system' })).toBe('system');
  });
  it('a value that is not a scheme is never taken', () => {
    expect(resolveColourScheme({ stored: 'auto', cookie: 'DARK', fallback: 'light' })).toBe(
      'light',
    );
  });
  it('the account menu cycles light → dark → device → light', () => {
    expect(nextColourScheme('light')).toBe('dark');
    expect(nextColourScheme('dark')).toBe('system');
    expect(nextColourScheme('system')).toBe('light');
  });
});

describe('the stylesheet follows the page, not the request', () => {
  const css = themeStylesheet({}, { scheme: 'attribute' });
  it('draws the dark palette for data-color-scheme="dark"', () => {
    expect(css).toContain(":root:root[data-color-scheme='dark'] {");
  });
  it('follows the device live for data-color-scheme="system"', () => {
    expect(css).toMatch(
      /@media \(prefers-color-scheme: dark\) \{\s+:root:root\[data-color-scheme='system'\] \{/,
    );
  });
  it('draws nothing for light: the original look stays the stylesheets', () => {
    expect(css).not.toMatch(/data-color-scheme='light'/);
  });
});

describe('elapsed time on work whose length is unknown', () => {
  it('reads minutes and seconds', () => {
    expect(elapsedText(0, 0)).toBe('0:00');
    expect(elapsedText(0, 7_400)).toBe('0:07');
    expect(elapsedText(0, 75_000)).toBe('1:15');
  });
  it('never runs backwards', () => {
    expect(elapsedText(5_000, 0)).toBe('0:00');
  });
});

describe('one frame for both apps', () => {
  const token = (name: string) => cssRootTokens.find((entry) => entry.name === name)?.value;
  it('both surfaces are solid', () => {
    expect(token('--bs-frame-surface')).toBe('var(--bs-surface)');
    expect(token('--bs-frame-rail')).toBe('#fafafb');
  });
  it('the edge is the shared hairline', () => {
    expect(token('--bs-frame-edge')).toBe('1px solid var(--bs-frame-hairline)');
    expect(token('--bs-frame-hairline')).toBe('var(--bs-hairline)');
  });
  it('the customer frame and the Control Center frame read the same tokens', () => {
    const prototype = readFileSync('packages/ui/src/prototype.css', 'utf8');
    const tokens = readFileSync('packages/ui/src/tokens.css', 'utf8');
    for (const sheet of [prototype, tokens]) {
      expect(sheet).toContain('border-radius: var(--bs-frame-radius);');
      expect(sheet).toContain('background: var(--bs-frame-surface);');
      expect(sheet).toContain('box-shadow: var(--bs-frame-shadow);');
    }
    expect(prototype).toContain('border-inline-end: var(--bs-frame-edge);');
    expect(readFileSync('packages/ui/src/app-shell.tsx', 'utf8')).toContain(
      "borderInlineEnd: 'var(--bs-frame-edge)'",
    );
  });
});

describe('the Copilot button floats with no strip behind it', () => {
  it('no rule stops the scroll area short of the frame', () => {
    const prototype = readFileSync('packages/ui/src/prototype.css', 'utf8');
    expect(prototype).not.toMatch(/\.bsp-main\[data-fab\] > \.bsp-scroll \{[^}]*margin-block-end/);
  });
});
