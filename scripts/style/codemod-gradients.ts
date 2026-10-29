/**
 * S4 — decorative gradients become tokens, so the Look & feel page can switch
 * gradients off (design-system programme, S4). No change to what is drawn.
 *
 * ONLY A SAFE GRADIENT IS TOKENISED: a single `linear-gradient(…)` or
 * `radial-gradient(…)` layer, in `background` or `background-image`, whose
 * colours are all opaque `--bs-*` tokens. Everything else stays where it is:
 *   - fades, masks and shimmer (anything with `transparent` or a translucent
 *     `--bs-lit-…-a…` stop) — flattening one would cover what it fades;
 *   - layered backgrounds (a top-level comma);
 *   - a gradient using a `--bsp-*` length or a non-`--bs-` variable (`--bb-*`,
 *     `--cs-*`): those are scoped, and a `:root` token would freeze or lose them.
 *
 * Each token is `--bs-gradient-lit-N`. `gradientOffValues()` gives its "off"
 * value — the same gradient flattened to its first colour, so a surface keeps
 * its colour and its text keeps its contrast.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const FILES = [
  'packages/ui/src/tokens.css',
  'packages/ui/src/prototype.css',
  'packages/ui/src/entry.css',
  'packages/ui/src/content-studio.css',
  'packages/ui/src/brand-brain.css',
];

const squash = (v: string) =>
  v
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .trim();

/** Is this value a single, opaque, root-safe gradient? */
export function isSafeGradient(value: string): boolean {
  const v = squash(value);
  const m = /^(linear|radial)-gradient\((.*)\)$/.exec(v);
  if (!m) return false;
  // one layer only: no comma outside the gradient's own parentheses
  let depth = 0;
  for (const ch of v) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) return false;
  }
  if (/transparent|-a\d/.test(v)) return false;
  const vars = [...v.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((x) => x[1]!);
  return (
    vars.length > 0 && vars.every((name) => name.startsWith('--bs-') && !name.startsWith('--bsp-'))
  );
}

/** The gradient flattened to its first colour stop. */
export function flatten(value: string): string {
  const first = /var\(--bs-[a-z0-9-]+\)/.exec(value)?.[0];
  return first ? `linear-gradient(${first}, ${first})` : 'none';
}

export function rewrite(sources: Record<string, string>): {
  output: Record<string, string>;
  tokens: { name: string; value: string }[];
} {
  const byValue = new Map<string, string>();
  const tokens: { name: string; value: string }[] = [];
  const output: Record<string, string> = {};
  for (const file of FILES) {
    const tree = postcss.parse(sources[file]!);
    tree.walkDecls((decl) => {
      if (decl.prop.startsWith('--')) return;
      if (decl.prop !== 'background' && decl.prop !== 'background-image') return;
      if (!isSafeGradient(decl.value)) return;
      const key = squash(decl.value);
      let name = byValue.get(key);
      if (!name) {
        name = `--bs-gradient-lit-${byValue.size + 1}`;
        byValue.set(key, name);
        tokens.push({
          name,
          value: decl.value.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')'),
        });
      }
      decl.value = `var(${name})`;
    });
    output[file] = tree.toString();
  }
  return { output, tokens };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const sources = Object.fromEntries(
    FILES.map((f) => [f, readFileSync(path.join(ROOT, f), 'utf8')]),
  );
  const { output, tokens } = rewrite(sources);
  for (const f of FILES) writeFileSync(path.join(ROOT, f), output[f]!);
  console.log(JSON.stringify(tokens, null, 2));
}
