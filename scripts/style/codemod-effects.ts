/**
 * S4 CODEMOD — durations, easings, z-index, backdrop blur, shadows and radius
 * become tokens, with no change to what is drawn at the default settings
 * (design-system programme, S4).
 *
 * Same rule as the S3 colour codemod: a value is replaced only by a token
 * defined once on tokens.css's generated `:root` and redefined nowhere, so it
 * computes to the same value on every element. Where no token carries the
 * value, a new one is added (`newTokens`, written into `cssRootTokens`).
 *
 *   duration   `0.15s`              → `var(--bs-dur-150)`
 *              every `--bs-dur-*`, `--bs-duration-*` and `--bs-motion-*` is
 *              `calc(<ms>ms * var(--bs-motion-scale))`, and the scale is 1, so
 *              nothing moves differently until the Look & feel page changes it.
 *   easing     `ease-out`           → `var(--bs-ease-css-out)`   (the CSS keyword)
 *              `cubic-bezier(.16,1,.3,1)` → `var(--bs-ease-out)` (already a token)
 *   z-index    `70`                 → `var(--bs-z-70)`
 *   backdrop   `blur(18px)`         → `var(--bs-fx-backdrop-18)`
 *   shadow     a literal shadow     → its `--bs-shadow-*` token, or a new
 *                                     `--bs-shadow-lit-N` (a shadow sized in
 *                                     `--bsp-*` lengths stays in place, for the
 *                                     same reason as radius below)
 *   radius     `var(--bsp-px-12)`   → `calc(var(--bsp-px-12) * var(--bs-radius-scale))`
 *              In place, not through a `:root` alias: `--bsp-px-*` is rescaled
 *              per scope (0.88 in the customer app, 0.80 on the entry screens),
 *              and an alias declared on `:root` would freeze the root value.
 *              Pills (`50%`, 999px and up) never scale.
 *
 * NEVER TOUCHED: the generated `:root` block, any `--bs-*` definition, anything
 * inside `@media (prefers-reduced-motion: reduce)` — reduced motion always wins
 * — `url(…)`, strings and comments.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss, { type Declaration } from 'postcss';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const FILES = [
  'packages/ui/src/tokens.css',
  'packages/ui/src/prototype.css',
  'packages/ui/src/entry.css',
  'packages/ui/src/content-studio.css',
  'packages/ui/src/brand-brain.css',
];

export interface NewToken {
  readonly name: string;
  readonly value: string;
}

function rootTokens(tokensCss: string): Map<string, string> {
  const start = tokensCss.indexOf(':root {\n');
  const block = tokensCss.slice(start, tokensCss.indexOf('\n}', start));
  return new Map(
    [...block.matchAll(/^ {2}(--[a-z0-9-]+):\s*([^;]+);/gm)].map((m) => [m[1]!, m[2]!.trim()]),
  );
}

function redefined(sources: Record<string, string>): Set<string> {
  const names = new Set<string>();
  for (const [file, css] of Object.entries(sources)) {
    let text = css;
    if (file.endsWith('tokens.css')) {
      const start = text.indexOf(':root {\n');
      text = text.slice(0, start) + text.slice(text.indexOf('\n}', start));
    }
    for (const m of text.matchAll(/(--[a-z0-9-]+)\s*:/g)) names.add(m[1]!);
  }
  return names;
}

const squash = (v: string) =>
  v
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .trim();

export function ms(literal: string): number {
  return literal.endsWith('ms')
    ? parseFloat(literal)
    : Math.round(parseFloat(literal) * 1000 * 1000) / 1000;
}

const durationName = (n: number) => `--bs-dur-${String(n).replace('.', '-')}`;
export const durationValue = (n: number) => `calc(${n}ms * var(--bs-motion-scale))`;

const KEYWORD_EASING: Record<string, string> = {
  ease: '--bs-ease-css',
  'ease-in': '--bs-ease-css-in',
  'ease-out': '--bs-ease-css-out',
  'ease-in-out': '--bs-ease-css-in-out',
  linear: '--bs-ease-linear',
};

function blurName(value: string): string {
  const m = /^blur\((\d+(?:\.\d+)?)px\)(?: saturate\((\d+)%\))?$/.exec(
    squash(value).replace(/\)saturate/, ') saturate'),
  );
  if (!m) return '';
  return `--bs-fx-backdrop-${m[1]!.replace('.', '-')}${m[2] ? `-sat-${m[2]}` : ''}`;
}

function zName(n: string): string {
  return `--bs-z-${n.startsWith('-') ? `neg-${n.slice(1)}` : n}`;
}

function inReducedMotion(decl: Declaration): boolean {
  for (let node = decl.parent; node; node = node.parent as typeof node) {
    if (node.type === 'atrule' && /prefers-reduced-motion/.test((node as postcss.AtRule).params))
      return true;
    if (node.type === 'root') return false;
  }
  return false;
}

function isGeneratedRoot(decl: Declaration, file: string): boolean {
  if (!file.endsWith('tokens.css')) return false;
  const parent = decl.parent;
  return parent?.type === 'rule' && parent.selector === ':root' && parent === parent.root().first;
}

/** Split into rewritable text and protected `url(…)` / string runs. */
function mapUnlocked(value: string, fn: (text: string) => string): string {
  const out: string[] = [];
  let last = 0;
  for (const m of value.matchAll(/url\([^)]*\)|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g)) {
    out.push(fn(value.slice(last, m.index)), m[0]);
    last = m.index! + m[0].length;
  }
  out.push(fn(value.slice(last)));
  return out.join('');
}

export interface Change {
  readonly file: string;
  readonly line: number;
  readonly kind: string;
  readonly before: string;
  readonly after: string;
}

export function rewrite(sources: Record<string, string>): {
  output: Record<string, string>;
  changes: Change[];
  newTokens: NewToken[];
} {
  const root = rootTokens(sources['packages/ui/src/tokens.css']!);
  const taken = redefined(sources);
  const newTokens = new Map<string, NewToken>();
  const add = (name: string, value: string) => {
    if (!root.has(name) && !newTokens.has(name)) newTokens.set(name, { name, value });
    return name;
  };
  // Existing shadow tokens, by squashed value, that are safe to reuse.
  const shadowByValue = new Map<string, string>();
  for (const [name, value] of root)
    if (name.startsWith('--bs-shadow-') && !taken.has(name)) shadowByValue.set(squash(value), name);
  let shadowSerial = 0;
  const easeOut = squash(root.get('--bs-ease-out') ?? '');
  const easeInOut = squash(root.get('--bs-ease-in-out') ?? '');

  const output: Record<string, string> = {};
  const changes: Change[] = [];
  for (const file of FILES) {
    const tree = postcss.parse(sources[file]!);
    tree.walkDecls((decl) => {
      if (decl.prop.startsWith('--')) return; // token definitions and component variables
      if (isGeneratedRoot(decl, file) || inReducedMotion(decl)) return;
      const prop = decl.prop.toLowerCase();
      const before = decl.value;
      let kind = '';
      let value = before;

      if (/^(transition|animation)/.test(prop)) {
        value = mapUnlocked(value, (text) =>
          text
            .replace(/cubic-bezier\([^)]*\)/g, (bezier) => {
              const sq = squash(bezier);
              if (sq === easeOut) return 'var(--bs-ease-out)';
              if (sq === easeInOut) return 'var(--bs-ease-in-out)';
              const name = `--bs-ease-${sq
                .replace(/[^0-9.]+/g, '-')
                .replace(/\./g, '')
                .replace(/^-|-$/g, '')}`;
              return `var(${add(name, sq.replace(/,/g, ', '))})`;
            })
            .replace(/(?<![\w-])(ease-in-out|ease-in|ease-out|ease|linear)(?![\w(-])/g, (kw) => {
              const name = KEYWORD_EASING[kw]!;
              return `var(${add(name, kw)})`;
            })
            .replace(/(?<![\w.#-])(\d*\.?\d+)(ms|s)\b/g, (literal) => {
              const n = ms(literal);
              return `var(${add(durationName(n), durationValue(n))})`;
            }),
        );
        kind = 'motion';
      } else if (prop === 'z-index' && /^-?\d+$/.test(value.trim())) {
        const n = value.trim();
        value = `var(${add(zName(n), n)})`;
        kind = 'z-index';
      } else if (
        (prop === 'backdrop-filter' || prop === '-webkit-backdrop-filter') &&
        /blur\(\d/.test(value)
      ) {
        const name = blurName(value);
        if (name) {
          value = `var(${add(name, squash(value).replace(/\)saturate/, ') saturate'))})`;
          kind = 'backdrop';
        }
      } else if (
        (prop === 'box-shadow' || prop === 'text-shadow') &&
        /\d+(\.\d+)?px/.test(value) &&
        !/^var\([^)]*\)$/.test(value.trim()) &&
        // A shadow sized in --bsp-* lengths stays in place: those lengths are
        // rescaled per scope, and a :root token would freeze the root's scale.
        !value.includes('var(--bsp-')
      ) {
        const sq = squash(value);
        let name = shadowByValue.get(sq);
        if (!name) {
          name = `--bs-shadow-lit-${++shadowSerial}`;
          shadowByValue.set(sq, name);
          add(name, value.replace(/\s+/g, ' ').trim());
        }
        value = `var(${name})`;
        kind = 'shadow';
      } else if (/radius$/.test(prop)) {
        value = mapUnlocked(value, (text) =>
          text.replace(
            /var\(--bs-radius-[a-z0-9-]+\)|var\(--bsp-(px|rem)-([0-9-]+)\)|(?<![\w.(-])(\d*\.?\d+)px\b/g,
            (match, unit, size, px) => {
              if (match.startsWith('var(--bs-radius-'))
                return `calc(${match} * var(--bs-radius-scale))`;
              const length = px ?? parseFloat(String(size).replace('-', '.'));
              const pixels = unit === 'rem' ? Number(length) * 16 : Number(length);
              if (pixels >= 99) return match; // a pill stays a pill at any scale
              return `calc(${match} * var(--bs-radius-scale))`;
            },
          ),
        );
        kind = 'radius';
      }

      if (value !== before) {
        decl.value = value;
        changes.push({ file, line: decl.source?.start?.line ?? 0, kind, before, after: value });
      }
    });
    output[file] = tree.toString();
  }
  return { output, changes, newTokens: [...newTokens.values()] };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const sources = Object.fromEntries(
    FILES.map((f) => [f, readFileSync(path.join(ROOT, f), 'utf8')]),
  );
  const { output, changes, newTokens } = rewrite(sources);
  for (const f of FILES) writeFileSync(path.join(ROOT, f), output[f]!);
  const byKind: Record<string, number> = {};
  for (const c of changes) byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
  console.log(JSON.stringify({ declarations: changes.length, byKind, newTokens }, null, 2));
}
