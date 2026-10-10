import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * D-484 — THE CUSTOMER APP IS THE PROTOTYPE AT 0.88.
 *
 * `prototype.css` (customer app only) holds every size token at the
 * prototype's value × 0.88, rounded to the nearest 0.5px, type never under
 * 11px; `tokens.css` holds the same names at the prototype's own value for the
 * Control Center and the public site. These checks keep the two tables in step
 * and keep every icon size the customer code uses covered by a scaled rule.
 */
const ROOT = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');
const SCALE = 0.88;
const round05 = (px: number) => Math.round(px * SCALE * 2) / 2;

const SIZE = /^\s*(--(?:bsp-(?:px|rem|fs)-[0-9-]+)):\s*([^;]+);/gm;
function table(css: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [, name, value] of css.matchAll(SIZE)) {
    if (!out.has(name!)) out.set(name!, value!.trim());
  }
  return out;
}
const tokenValue = (name: string) =>
  Number(name.replace(/^--bsp-(px|rem|fs)-/, '').replace('-', '.'));

const identity = table(read('packages/ui/src/tokens.css'));
const scaled = table(read('packages/ui/src/prototype.css'));

describe('D-484 · the size tables', () => {
  it('every scaled token has its unscaled twin, at its own value', () => {
    expect(scaled.size).toBeGreaterThan(200);
    for (const name of scaled.keys()) {
      expect(identity.get(name), name).toBeDefined();
      const unit = name.startsWith('--bsp-rem-') ? 'rem' : 'px';
      expect(identity.get(name), name).toBe(`${tokenValue(name)}${unit}`);
    }
  });

  it('each scaled value is the prototype’s × 0.88 to the nearest 0.5px; type never under 11px', () => {
    for (const [name, value] of scaled) {
      const own = tokenValue(name) * (name.startsWith('--bsp-rem-') ? 16 : 1);
      // A hairline stays a hairline (1px, and 0.0625rem).
      const expected = own <= 1 ? own : round05(own);
      const floor = name.startsWith('--bsp-fs-') ? Math.max(11, expected) : expected;
      expect(value, name).toBe(`${floor}px`);
    }
  });
});

describe('D-484 amended · the entry screens are the prototype at 0.80', () => {
  const css = read('packages/ui/src/prototype.css');
  const start = css.indexOf('\n.bsp-auth {\n');
  const entry = table(css.slice(start, css.indexOf('\n}\n', start)));
  const ENTRY = 0.8;

  it('redefines every scaled token, and only on `.bsp-auth`', () => {
    expect(start).toBeGreaterThan(0);
    expect([...entry.keys()].sort()).toEqual([...scaled.keys()].sort());
  });

  it('each value is the prototype’s × 0.80 to the nearest 0.5px; type never under 11px', () => {
    for (const [name, value] of entry) {
      const own = tokenValue(name) * (name.startsWith('--bsp-rem-') ? 16 : 1);
      const expected = own <= 1 ? own : Math.round(own * ENTRY * 2) / 2;
      const floor = name.startsWith('--bsp-fs-') ? Math.max(11, expected) : expected;
      expect(value, name).toBe(`${floor}px`);
    }
  });
});

describe('D-484 · icons are drawn at 0.88 too', () => {
  const css = read('packages/ui/src/prototype.css');
  const files = execFileSync('git', ['ls-files', 'apps/dashboard/src', 'packages/ui/src'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((file) => file.endsWith('.tsx') && !file.includes('/design-system/'));

  /** Every numeric icon size: an SVG's width/height, a `size` prop, a default. */
  const sizes = new Set<number>();
  for (const file of files) {
    const source = read(file);
    for (const [tag] of source.matchAll(/<svg\b[^>]*?>/gs)) {
      for (const [, quoted, braced] of tag.matchAll(
        /\b(?:width|height)=(?:"([0-9.]+)"|\{([0-9.]+)\})/g,
      )) {
        sizes.add(Number(quoted ?? braced));
      }
    }
    for (const [, expression] of source.matchAll(/\bsize=\{([^}]*)\}/g)) {
      for (const [number] of expression!.matchAll(/\b\d+(?:\.\d+)?\b/g)) sizes.add(Number(number));
    }
    for (const [, number] of source.matchAll(/\bsize = (\d+(?:\.\d+)?)\b/g))
      sizes.add(Number(number));
  }

  it('finds the sizes the customer code uses', () => {
    expect([...sizes]).toEqual(expect.arrayContaining([12, 14, 16, 18, 20]));
  });

  it('each size has a zero-specificity rule and a scaled token', () => {
    const missing: string[] = [];
    for (const size of [...sizes].sort((a, b) => a - b)) {
      // `size={2}` (a stroke or a step count) is not an icon edge.
      if (size < 6) continue;
      const token = `--bsp-px-${String(size).replace('.', '-')}`;
      if (!scaled.has(token)) missing.push(`${size}: no ${token}`);
      for (const [attribute, property] of [
        ['width', 'inline-size'],
        ['height', 'block-size'],
      ] as const) {
        const rule = `:where(svg[${attribute}='${size}']) {\n  ${property}: var(${token});\n}`;
        if (!css.includes(rule)) missing.push(`${size}: no ${attribute} rule`);
      }
    }
    expect(missing).toEqual([]);
  });
});
