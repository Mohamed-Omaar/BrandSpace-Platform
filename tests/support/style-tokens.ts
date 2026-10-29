import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Reading a colour token back as the colour it names (design-system programme,
 * S3).
 *
 * Since S3 the stylesheets write `var(--bs-brand-purple)` where they used to
 * write `#7935fe`. The fidelity tests compare a stylesheet with the pinned
 * prototype VALUE BY VALUE, so they read each colour token back as the exact
 * colour tokens.css's generated `:root` gives it — the same way they already
 * read `var(--bsp-px-14)` back as 14px. The comparison stays exact: a token
 * whose value differs from the prototype's colour still fails.
 *
 * Only `--bs-*` tokens whose `:root` value is a single colour are read back,
 * and the codemod used only tokens that are never redefined anywhere, so what
 * this returns is what every element computes.
 */
const tokensCss = readFileSync(path.resolve(__dirname, '../../packages/ui/src/tokens.css'), 'utf8');
const rootStart = tokensCss.indexOf(':root {\n');
const rootBlock = tokensCss.slice(rootStart, tokensCss.indexOf('\n}', rootStart));

const SINGLE_COLOUR = /^(#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?)\([^()]*\))$/;

export const colourTokenValues: ReadonlyMap<string, string> = new Map(
  [...rootBlock.matchAll(/^ {2}(--bs-[a-z0-9-]+):\s*([^;]+);/gm)]
    .map((m) => [m[1]!, m[2]!.trim()] as const)
    .filter(([, value]) => SINGLE_COLOUR.test(value)),
);

/** `var(--bs-brand-purple)` → `#7935fe`, for every colour token. */
export function resolveColourTokens(css: string): string {
  return css.replace(
    /var\((--bs-[a-z0-9-]+)\)/g,
    (match, name: string) => colourTokenValues.get(name) ?? match,
  );
}

/** One spelling per hex colour: lower case, `#fff` → `#ffffff`, `#ffff` → `#ffffffff`. */
export function canonicalHex(text: string): string {
  return text.replace(/#([0-9a-fA-F]{3,8})\b/g, (match, hex: string) => {
    const h = hex.toLowerCase();
    if (h.length === 3 || h.length === 4) return `#${[...h].map((c) => c + c).join('')}`;
    return h.length === 6 || h.length === 8 ? `#${h}` : match;
  });
}
