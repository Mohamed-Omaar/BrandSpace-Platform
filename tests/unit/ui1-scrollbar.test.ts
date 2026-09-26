import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { colorTokens } from '@brandspace/ui';

/**
 * UI-1 (prototype v94) — ONE GLOBAL SCROLLBAR STYLE, AND THE HIDDEN ONES STAY
 * HIDDEN.
 *
 * The style lives once, in the design system's global stylesheet, never per
 * screen. Chrome/Edge draw it with the `::-webkit-scrollbar` pseudo-elements;
 * Firefox with `scrollbar-width` / `scrollbar-color`, scoped to engines that
 * lack the pseudo-elements (setting the standard properties globally would
 * make Chromium 121+ ignore the pseudo-elements and lose the hover state).
 */

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const tokens = read('packages/ui/src/tokens.css');

/** The body of the FIRST rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  expect(match, `${selector} is defined`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('UI-1 · the global scrollbar', () => {
  it('is thin, has no arrow buttons and a transparent track (Chrome/Edge)', () => {
    expect(rule(tokens, '*::-webkit-scrollbar')).toMatch(/width:\s*8px/);
    expect(rule(tokens, '*::-webkit-scrollbar')).toMatch(/height:\s*8px/);
    expect(rule(tokens, '*::-webkit-scrollbar-button')).toMatch(/display:\s*none/);
    expect(tokens).toMatch(
      /\*::-webkit-scrollbar-track,\s*\*::-webkit-scrollbar-corner\s*\{\s*background:\s*transparent;/,
    );
  });

  it('has a subtle thumb that darkens on hover, from tokens', () => {
    expect(rule(tokens, '*::-webkit-scrollbar-thumb')).toContain('var(--bs-scrollbar-thumb)');
    expect(rule(tokens, '*::-webkit-scrollbar-thumb:hover')).toContain(
      'var(--bs-scrollbar-thumb-hover)',
    );
    expect(tokens).toMatch(/--bs-scrollbar-thumb:\s*#9a9aa2;/);
    expect(tokens).toMatch(/--bs-scrollbar-thumb-hover:\s*#6a6a72;/);
    expect(colorTokens.scrollbarThumb.toLowerCase()).toBe('#9a9aa2');
    expect(colorTokens.scrollbarThumbHover.toLowerCase()).toBe('#6a6a72');
  });

  it('uses scrollbar-width / scrollbar-color only where the pseudo-elements do not exist (Firefox)', () => {
    const block = tokens.match(/@supports not selector\(::-webkit-scrollbar\)\s*\{([\s\S]*?)\n\}/);
    expect(block, 'the Firefox block exists').not.toBeNull();
    expect(block?.[1]).toMatch(/scrollbar-width:\s*thin/);
    expect(block?.[1]).toMatch(/scrollbar-color:\s*var\(--bs-scrollbar-thumb\) transparent/);
    expect(block?.[1]).toMatch(/scrollbar-color:\s*var\(--bs-scrollbar-thumb-hover\) transparent/);
    // Never on the universal selector outside that block: Chromium would then
    // ignore every pseudo-element rule above.
    const outside = tokens.replace(block?.[0] ?? '', '');
    expect(outside).not.toMatch(/(?:^|\n)\*\s*\{[^}]*scrollbar-(?:width|color)/);
  });

  it('is defined once, in the design system, not per screen', () => {
    for (const file of ['packages/ui/src/brand-brain.css', 'packages/ui/src/content-studio.css']) {
      expect(read(file), file).not.toMatch(/\*::-webkit-scrollbar/);
    }
  });
});

describe('UI-1 · deliberately hidden scrollbars stay hidden', () => {
  it('the sidebar navigation hides its bar in every engine', () => {
    expect(rule(tokens, '.bs-nav-scroll')).toMatch(/scrollbar-width:\s*none/);
    expect(rule(tokens, '.bs-nav-scroll::-webkit-scrollbar')).toMatch(/display:\s*none/);
    const shell = read('packages/ui/src/app-shell.tsx');
    expect(shell).toContain('className="bs-nav-scroll"');
  });

  it('the Brand Brain chat suggestions keep both hiding rules', () => {
    const brain = read('packages/ui/src/brand-brain.css');
    expect(rule(brain, '.bb-chat-suggestions')).toMatch(/scrollbar-width:\s*none/);
    expect(rule(brain, '.bb-chat-suggestions::-webkit-scrollbar')).toMatch(/display:\s*none/);
  });
});
