import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * PR U — ONE NODE VERSION, AND ONE THE RUNTIME DEPENDENCIES ACCEPT.
 *
 * Staging's worker ran Node 20.20.2 because the root `engines.node` said
 * `>=20.11.0`, which is all Railpack reads. pdf.js 6 needs `>=22.13.0`; on Node
 * 20 it threw `Promise.withResolvers is not a function` before reading a byte,
 * and every PDF uploaded to Brand Brain failed three times with
 * `extraction_failed`. Nothing compared the two ranges. This does.
 *
 * Every place a Node version is set is listed here and must agree on major 22:
 *   - `package.json` `engines.node` (Railpack's source for every service);
 *   - `.nvmrc` and `.node-version` (local tools; Railpack reads them too);
 *   - `.github/workflows/ci.yml` `NODE_VERSION` (CI; read, never edited here).
 * There is no Dockerfile and `.railway/railway.ts` sets no Node version.
 */
const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const rootEngines = (JSON.parse(read('package.json')) as { engines: { node: string } }).engines
  .node;

type Version = readonly [number, number, number];

function parse(text: string): Version {
  const [major = 0, minor = 0, patch = 0] = text
    .replace(/^v/, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  return [major, minor, patch];
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  return 0;
}

/**
 * A small evaluator for the `engines` forms runtime dependencies actually use:
 * `||` alternatives of space-separated `>=`, `>`, `<`, `<=`, `=`, `^` comparators.
 * An operator it does not know fails the test rather than passing silently.
 */
function satisfies(version: Version, range: string): boolean {
  return range.split('||').some((alternative) => {
    const comparators = alternative
      .trim()
      .replace(/(>=|<=|>|<|=|\^)\s+/g, '$1')
      .split(/\s+/)
      .filter(Boolean);
    return comparators.every((comparator) => {
      const match = /^(>=|<=|>|<|=|\^)?(\d[\d.]*)$/.exec(comparator);
      if (!match) throw new Error(`unknown engines comparator "${comparator}" in "${range}"`);
      const [, op = '=', raw = ''] = match;
      const target = parse(raw);
      const c = compare(version, target);
      switch (op) {
        case '>=':
          return c >= 0;
        case '>':
          return c > 0;
        case '<':
          return c < 0;
        case '<=':
          return c <= 0;
        case '^':
          return c >= 0 && version[0] === target[0];
        default:
          return raw.split('.').length < 3 ? version[0] === target[0] : c === 0;
      }
    });
  });
}

/**
 * The lowest version the root range admits (its `>=` bound) and the highest
 * minor of that major: what Railpack could install today.
 */
function probes(range: string): readonly Version[] {
  const lowest = parse(/>=\s*(\d[\d.]*)/.exec(range)?.[1] ?? '0');
  return [lowest, [lowest[0], 99, 0]];
}

function runtimeDependencyEngines(): Record<string, string> {
  const out: Record<string, string> = {};
  const dirs = [
    '.',
    ...['apps', 'packages'].flatMap((group) =>
      readdirSync(path.join(root, group)).map((name) => `${group}/${name}`),
    ),
  ];
  for (const dir of dirs) {
    const manifest = path.join(root, dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const requireFrom = createRequire(manifest);
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (dep.startsWith('@brandspace/')) continue;
      let base: string;
      try {
        base = path.dirname(requireFrom.resolve(dep));
      } catch {
        try {
          base = path.dirname(requireFrom.resolve(`${dep}/package.json`));
        } catch {
          continue; // A type-only or ESM-exports-only entry; nothing runs it.
        }
      }
      while (!existsSync(path.join(base, 'package.json')) && base !== path.dirname(base)) {
        base = path.dirname(base);
      }
      const found = JSON.parse(readFileSync(path.join(base, 'package.json'), 'utf8')) as {
        name?: string;
        engines?: { node?: string };
      };
      if (found.name === dep && found.engines?.node) out[dep] = found.engines.node;
    }
  }
  return out;
}

describe('PR U — the Node version', () => {
  it('pins major 22 at or above 22.13.0, so the build cannot pick 20 or jump a major', () => {
    expect(rootEngines).toBe('>=22.13.0 <23');
    expect(satisfies([20, 20, 2], rootEngines)).toBe(false);
    expect(satisfies([22, 12, 0], rootEngines)).toBe(false);
    expect(satisfies([22, 13, 0], rootEngines)).toBe(true);
    expect(satisfies([24, 0, 0], rootEngines)).toBe(false);
  });

  it('every runtime dependency accepts every Node the root range admits', () => {
    const engines = runtimeDependencyEngines();
    // The one that broke staging is among them.
    expect(engines['pdfjs-dist']).toBeDefined();
    const refused = Object.entries(engines).filter(
      ([, range]) => !probes(rootEngines).every((probe) => satisfies(probe, range)),
    );
    expect(refused).toEqual([]);
  });

  it('.nvmrc, .node-version and CI agree on major 22', () => {
    expect(read('.nvmrc').trim()).toBe('22');
    expect(read('.node-version').trim()).toBe('22');
    const ci = /NODE_VERSION:\s*'(\d+)/.exec(read('.github/workflows/ci.yml'));
    expect(ci?.[1]).toBe('22');
  });

  it('the evaluator refuses the old root range against pdf.js', () => {
    // What staging ran: the old range admitted 20.11, which pdf.js refuses.
    expect(satisfies([20, 11, 0], '>=22.13.0 || >=24')).toBe(false);
    expect(satisfies([22, 13, 0], '>=22.13.0 || >=24')).toBe(true);
    expect(satisfies([22, 13, 0], '^20.19 || ^22.12 || >=24.0')).toBe(true);
    expect(satisfies([22, 13, 0], '>= 10')).toBe(true);
  });
});
