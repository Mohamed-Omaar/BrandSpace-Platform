/**
 * Writes the `:root { … }` block of packages/ui/src/tokens.css from
 * `cssRootTokens` in packages/ui/src/tokens.ts (design-system programme, S2).
 *
 * Only the `:root` block is generated. Everything after it — the base element
 * rules, the shell, the media-query restorations — stays hand-written. Hex
 * values are written in lower case, the stylesheet's convention, so the
 * TypeScript source keeps its own.
 *
 * `pnpm style:tokens` rewrites the file; tests/unit/style-tokens-css.test.ts
 * fails if the committed file differs from `render()`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cssRootTokens } from '../../packages/ui/src/tokens';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const TOKENS_CSS = 'packages/ui/src/tokens.css';

const OPEN = ':root {\n';

export function rootBlock(): string {
  const lines = cssRootTokens.map((entry) => {
    if ('blank' in entry) return '';
    if ('comment' in entry) return entry.comment;
    const value = entry.value.replace(/#[0-9a-fA-F]{3,8}\b/g, (hex) => hex.toLowerCase());
    // A value written on the following lines (a long font stack) keeps no space.
    const separator = value.startsWith('\n') ? ':' : ': ';
    return `  ${entry.name}${separator}${value};${entry.note ? ` ${entry.note}` : ''}`;
  });
  return `${OPEN}${lines.join('\n')}\n}`;
}

/** tokens.css with its `:root` block replaced by the generated one. */
export function render(current: string): string {
  const start = current.indexOf(OPEN);
  const end = current.indexOf('\n}', start) + '\n}'.length;
  if (start < 0 || end < start) throw new Error('tokens.css has no :root block');
  return current.slice(0, start) + rootBlock() + current.slice(end);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const file = path.join(ROOT, TOKENS_CSS);
  writeFileSync(file, render(readFileSync(file, 'utf8')));
  console.log(`Wrote the :root block of ${TOKENS_CSS}`);
}
