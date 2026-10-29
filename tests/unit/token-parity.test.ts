import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  colorValues,
  fontTokens,
  motionValues,
  shadowValues,
  zIndexTokens,
} from '../../packages/ui/src/tokens';

/**
 * tokens.ts and tokens.css hold the same values (design-system programme, S1).
 *
 * The header of tokens.css has long promised this file. Until the generator in
 * step S2 writes tokens.css from tokens.ts, the two are kept in step by hand,
 * and the check that existed compared 10 of 71 colours. This one compares EVERY
 * colour, shadow, z-index, font stack and motion token that has a CSS twin, and
 * pins the exact list of tokens that do not have one yet — so a new TS token
 * without its CSS variable, or a CSS value edited on one side only, fails here.
 */
const css = readFileSync(path.resolve(__dirname, '../../packages/ui/src/tokens.css'), 'utf8');
const rootStart = css.indexOf(':root {');
const rootBlock = css.slice(rootStart, css.indexOf('\n}', rootStart));
const definitions = new Map(
  [...rootBlock.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [
    m[1]!,
    m[2]!
      .replace(/\s+/g, ' ')
      .trim()
      // S4: a duration is `calc(<ms> * var(--bs-motion-scale))`; the scale is 1,
      // so its TypeScript twin is the <ms> inside.
      .replace(/^calc\((.+) \* var\(--bs-motion-scale\)\)$/, '$1'),
  ]),
);

const kebab = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Za-z])([0-9])/g, '$1-$2')
    .toLowerCase();

const GROUPS = [
  {
    name: 'colorTokens',
    tokens: colorValues as Record<string, string>,
    variable: (k: string) => `--bs-${kebab(k)}`,
    // Since S2 every colour has a CSS twin (tokens.css :root is generated).
    withoutTwin: [],
  },
  {
    name: 'shadowTokens',
    tokens: shadowValues as Record<string, string>,
    variable: (k: string) => `--bs-shadow-${kebab(k)}`,
    withoutTwin: [],
  },
  {
    name: 'zIndexTokens',
    tokens: zIndexTokens as Record<string, number>,
    variable: (k: string) => `--bs-z-${kebab(k)}`,
    withoutTwin: ['base'],
  },
  {
    name: 'fontTokens',
    tokens: fontTokens as Record<string, string>,
    variable: (k: string) => `--bs-font-${kebab(k).replace(/^sans-/, '')}`,
    withoutTwin: [],
  },
  {
    name: 'motionTokens',
    tokens: motionValues as Record<string, string>,
    variable: (k: string) =>
      k.startsWith('ease') ? `--bs-${kebab(k)}` : `--bs-duration-${kebab(k)}`,
    withoutTwin: [],
  },
] as const;

describe.each(GROUPS)('$name: every token with a CSS twin has the same value', (group) => {
  const entries = Object.entries(group.tokens);

  it('has tokens to compare, so a pass is not vacuous', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it('every CSS twin carries exactly the TypeScript value', () => {
    const drift = entries.flatMap(([key, value]) => {
      const cssValue = definitions.get(group.variable(key));
      if (cssValue === undefined) return [];
      const tsValue = String(value).replace(/\s+/g, ' ').trim();
      return cssValue.toLowerCase() === tsValue.toLowerCase()
        ? []
        : [`${group.variable(key)}: tokens.ts=${tsValue} tokens.css=${cssValue}`];
    });
    expect(drift).toEqual([]);
  });

  it('only the known tokens are missing a CSS twin', () => {
    const missing = entries
      .map(([key]) => key)
      .filter((key) => !definitions.has(group.variable(key)));
    expect(missing).toEqual([...group.withoutTwin]);
  });
});

describe('the comparison itself', () => {
  it('reads the :root block, not a later rule', () => {
    expect(definitions.get('--bs-brand-purple')).toBe(colorValues.brandPurple.toLowerCase());
    expect(definitions.size).toBeGreaterThan(300);
  });
});
