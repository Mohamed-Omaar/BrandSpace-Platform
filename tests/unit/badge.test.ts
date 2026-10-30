import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ONE STATUS BADGE, TWO LOOKS (design-system programme, S5; D-579).
 *
 * `StatusBadge` is `.bs-badge` with a `data-tone`; its look is the scope's
 * variable set. In the customer frame it is exactly the prototype's pill
 * (`.bsp-pill` + `.bsp-p-*`, prototype.css); in the Control Center the token
 * palette it painted inline. This pins both, and that the customer set carries
 * the pill's own values, so the two can never drift apart again.
 */
const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const tokens = read('packages/ui/src/tokens.css');
const prototype = read('packages/ui/src/prototype.css');

function decls(css: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\n)${escaped} \\{\\n([\\s\\S]*?)\\n\\}`).exec(css);
  expect(m, selector).not.toBeNull();
  return Object.fromEntries(
    [...m![1]!.matchAll(/^\s*([a-z-]+):\s*([^;]+);/gm)].map((x) => [x[1]!, x[2]!]),
  );
}

describe('the customer look is the prototype pill', () => {
  const customer = decls(tokens, '.bsp-frame:not(.bs-gallery-console)');
  const pill = decls(prototype, '.bsp-pill');

  it('the pill geometry', () => {
    expect(customer['--bs-badge-gap']).toBe(pill['gap']);
    expect(customer['--bs-badge-pad']).toBe(pill['padding']);
    expect(customer['--bs-badge-font-size']).toBe(pill['font-size']);
    expect(customer['--bs-badge-font-weight']).toBe(pill['font-weight']);
    expect(customer['--bs-badge-line-height']).toBe(pill['line-height']);
    expect(customer['--bs-badge-radius']).toBe(pill['border-radius']);
    // The prototype pill draws no border, so the customer badge has none either.
    expect(pill['border']).toBeUndefined();
    expect(customer['--bs-badge-border']).toBe('0');
  });

  it.each([
    ['success', '.bsp-p-ok'],
    ['info', '.bsp-p-info'],
    ['warning', '.bsp-p-warn'],
    ['danger', '.bsp-p-bad'],
    ['neutral', '.bsp-p-neu'],
  ])('%s is the pill %s', (tone, cls) => {
    const p = decls(prototype, cls);
    const console = decls(tokens, ':root,\n.bs-gallery-console');
    const bg = customer[`--bs-badge-${tone}-bg`] ?? console[`--bs-badge-${tone}-bg`];
    const fg = customer[`--bs-badge-${tone}-fg`] ?? console[`--bs-badge-${tone}-fg`];
    expect(bg).toBe(p['background']);
    expect(fg).toBe(p['color']);
  });
});

describe('the console look is what StatusBadge painted inline', () => {
  it('9px at 600, the token palette', () => {
    const c = decls(tokens, ':root,\n.bs-gallery-console');
    expect(c['--bs-badge-font-size']).toBe('var(--bsp-fs-9)');
    expect(c['--bs-badge-font-weight']).toBe('600');
    expect(c['--bs-badge-pad']).toBe('var(--bsp-rem-0-1875) var(--bsp-rem-0-5)');
    expect(c['--bs-badge-success-bg']).toBe('var(--bs-success-tint)');
    expect(c['--bs-badge-neutral-bg']).toBe('var(--bs-surface-muted)');
  });
});

describe('the component', () => {
  it('StatusBadge is the class and the tone, with no inline style', () => {
    const data = read('packages/ui/src/data.tsx');
    expect(data).toContain('className="bs-badge" data-tone={tone}');
    expect(data).not.toContain('function badgePalette');
  });
});
