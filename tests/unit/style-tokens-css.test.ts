import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOKENS_CSS, render, rootBlock } from '../../scripts/style/tokens-css';
import { colorValues, colorTokens, shadowTokens, motionTokens } from '../../packages/ui/src/tokens';

/**
 * tokens.css `:root` is GENERATED from tokens.ts (design-system programme, S2).
 * Edit `cssRootTokens` or the token objects in tokens.ts, then run
 * `pnpm style:tokens`; a hand edit to the block fails here.
 */
describe('tokens.css :root is generated from tokens.ts', () => {
  const committed = readFileSync(path.resolve(__dirname, '../..', TOKENS_CSS), 'utf8');

  it('the committed stylesheet is byte-identical to the generator output', () => {
    expect(committed).toBe(render(committed));
  });

  it('the generated block is the first :root block of the file', () => {
    expect(committed.indexOf(rootBlock())).toBeGreaterThan(0);
    expect(committed.indexOf(':root {')).toBe(committed.indexOf(rootBlock()));
  });

  it('a TypeScript value change reaches the stylesheet through the generator', () => {
    expect(rootBlock()).toContain(`--bs-brand-purple: ${colorValues.brandPurple.toLowerCase()};`);
  });
});

describe('the token objects name CSS variables', () => {
  it('every colour token is var(--bs-…), the three D-55 restorations included since S4', () => {
    const literal = Object.entries(colorTokens).filter(([, v]) => !v.startsWith('var(--bs-'));
    expect(literal.map(([k]) => k).sort()).toEqual([]);
  });

  it('every shadow and motion token is var(--bs-…)', () => {
    expect(Object.values(shadowTokens).every((v) => v.startsWith('var(--bs-shadow-'))).toBe(true);
    expect(Object.values(motionTokens).every((v) => v.startsWith('var(--bs-'))).toBe(true);
  });

  it('every variable a token object names is defined in the generated :root block', () => {
    const block = rootBlock();
    const missing = [
      ...Object.values(colorTokens),
      ...Object.values(shadowTokens),
      ...Object.values(motionTokens),
    ]
      .map((v) => /^var\((--[a-z0-9-]+)\)$/.exec(v)?.[1])
      .filter((name): name is string => name !== undefined)
      .filter((name) => !block.includes(`  ${name}:`));
    expect(missing).toEqual([]);
  });
});
