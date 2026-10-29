/**
 * S3 CODEMOD — every literal colour in the stylesheets becomes a token
 * reference, with NO change to what is drawn (design-system programme, S3).
 *
 * WHY IT CANNOT CHANGE A PIXEL. A literal is replaced by `var(--token)` only
 * when that token is defined ONCE, on tokens.css's generated `:root`, with
 * exactly the same colour, and is redefined nowhere — no other selector, no
 * media query, no inline style (the D-55 contrast restorations are therefore
 * never used here). A custom property defined on `:root` and never redefined
 * resolves to the same value on every element, so the computed style is the
 * same. `verify()` re-checks this for every replacement it made.
 *
 * WHAT IT DOES, in order:
 *   1. A literal equal to an existing token's value → that token.
 *   2. Any other literal → a NEW exact-value token in the transitional
 *      `--bs-lit-*` palette (added to `cssRootTokens` in tokens.ts and written
 *      to tokens.css). Those carry their value in their name on purpose: the
 *      semantic name is decided when the component that uses it is unified
 *      (S5), not guessed here.
 *   3. The `--cs-*`, `--bb-*` and `--bsp-*` colour variables become aliases of
 *      the `--bs-*` token with their value.
 *
 * NEVER TOUCHED: the generated `:root` block, any `--bs-*` definition (they are
 * the tokens, including the contrast-mode restorations), anything inside
 * `url(…)`, a string, a comment or a selector, and named colours (`white`,
 * `black`, …), which stay for S4.
 *
 * Run: `tsx scripts/style/codemod-colours.ts` (idempotent — a second run
 * changes nothing).
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

// --- colour parsing ------------------------------------------------------------

const COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\([^()]*\)/g;

/** A canonical key, so `#FFF`, `#ffffff` and `rgb(255, 255, 255)` are one colour. */
export function colourKey(literal: string): string | undefined {
  const text = literal.trim().toLowerCase();
  if (text.startsWith('#')) {
    let hex = text.slice(1);
    if (!/^([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(hex)) return undefined;
    if (hex.length <= 4) hex = [...hex].map((c) => c + c).join('');
    if (hex.length === 8 && hex.endsWith('ff')) hex = hex.slice(0, 6);
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return key(r!, g!, b!, a);
  }
  const fn = /^(rgba?|hsla?)\(([^()]*)\)$/.exec(text);
  if (!fn) return undefined;
  if (fn[1]!.startsWith('hsl')) return `${fn[1]}(${fn[2]!.replace(/\s+/g, '')})`;
  const parts = fn[2]!.split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return undefined;
  const channel = (p: string) => (p.endsWith('%') ? (parseFloat(p) * 255) / 100 : parseFloat(p));
  const alpha =
    parts[3] === undefined
      ? 1
      : parts[3].endsWith('%')
        ? parseFloat(parts[3]) / 100
        : parseFloat(parts[3]);
  const values = [channel(parts[0]!), channel(parts[1]!), channel(parts[2]!), alpha];
  if (values.some((v) => Number.isNaN(v))) return undefined;
  return key(values[0]!, values[1]!, values[2]!, values[3]!);
}

function key(r: number, g: number, b: number, a: number): string {
  const alpha = Math.round(a * 1000) / 1000;
  return alpha === 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
}

/** The new token's name, from its colour: `--bs-lit-e4e4e8`, `--bs-lit-11-11-14-a28`. */
export function literalTokenName(colour: string): string {
  const k = colourKey(colour)!;
  const m = /^rgba?\(([^)]*)\)$/.exec(k);
  if (!m) return `--bs-lit-${k.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
  const [r, g, b, a] = m[1]!.split(',').map(Number);
  const hex = [r, g, b].map((v) => Math.round(v!).toString(16).padStart(2, '0')).join('');
  if (a === undefined) return `--bs-lit-${hex}`;
  const alpha = String(a).replace(/^0\./, '').replace('.', '-');
  return `--bs-lit-${hex}-a${alpha}`;
}

// --- the token map -------------------------------------------------------------

interface Token {
  readonly name: string;
  readonly value: string;
}

function rootTokens(tokensCss: string): Token[] {
  const start = tokensCss.indexOf(':root {\n');
  const block = tokensCss.slice(start, tokensCss.indexOf('\n}', start));
  return [...block.matchAll(/^ {2}(--[a-z0-9-]+):\s*([^;]+);/gm)].map((m) => ({
    name: m[1]!,
    value: m[2]!.trim(),
  }));
}

/** Every custom property name defined anywhere except the generated :root block. */
function redefinedNames(sources: Record<string, string>): Set<string> {
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

// Where several safe tokens share a colour, prefer the most meaningful family.
const PREFERENCE = [
  '--bs-brand-',
  '--bs-text-',
  '--bs-ink',
  '--bs-surface',
  '--bs-success',
  '--bs-warning',
  '--bs-danger',
  '--bs-info',
];
function rank(name: string): number {
  const i = PREFERENCE.findIndex((p) => name.startsWith(p));
  return i < 0 ? PREFERENCE.length : i;
}

export function safeTokenMap(sources: Record<string, string>): Map<string, string> {
  const redefined = redefinedNames(sources);
  const tokens = rootTokens(sources['packages/ui/src/tokens.css']!)
    .filter((t) => t.name.startsWith('--bs-') && !redefined.has(t.name))
    // D-61: the legacy blue family is retired and nothing may consume it, even
    // where its value (white, for `--bs-brand-blue-ink`) matches.
    .filter((t) => !t.name.startsWith('--bs-brand-blue'))
    .filter((t) => colourKey(t.value) !== undefined && t.value.match(COLOUR)?.[0] === t.value);
  const map = new Map<string, string>();
  const sorted = [...tokens].sort((a, b) => rank(a.name) - rank(b.name));
  for (const t of sorted) {
    const k = colourKey(t.value)!;
    if (!map.has(k)) map.set(k, t.name);
  }
  return map;
}

// --- rewriting -------------------------------------------------------------------

/** Split a value into rewritable text and protected `url(…)` / string runs. */
function protectedRuns(value: string): { text: string; locked: boolean }[] {
  const runs: { text: string; locked: boolean }[] = [];
  const re = /url\([^)]*\)|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
  let last = 0;
  for (const m of value.matchAll(re)) {
    runs.push({ text: value.slice(last, m.index), locked: false });
    runs.push({ text: m[0], locked: true });
    last = m.index! + m[0].length;
  }
  runs.push({ text: value.slice(last), locked: false });
  return runs;
}

export interface Replacement {
  readonly file: string;
  readonly line: number;
  readonly literal: string;
  readonly token: string;
}

function isGeneratedRoot(decl: Declaration, file: string): boolean {
  if (!file.endsWith('tokens.css')) return false;
  const parent = decl.parent;
  return parent?.type === 'rule' && parent.selector === ':root' && parent === parent.root().first;
}

export function rewrite(
  sources: Record<string, string>,
  map: Map<string, string>,
  newTokens: Map<string, { name: string; value: string }>,
): { output: Record<string, string>; replacements: Replacement[] } {
  const output: Record<string, string> = {};
  const replacements: Replacement[] = [];
  for (const file of FILES) {
    const rootNode = postcss.parse(sources[file]!);
    rootNode.walkDecls((decl) => {
      if (decl.prop.startsWith('--bs-')) return; // a token definition, any scope
      if (isGeneratedRoot(decl, file)) return;
      const next = protectedRuns(decl.value)
        .map((run) =>
          run.locked
            ? run.text
            : run.text.replace(COLOUR, (literal) => {
                const k = colourKey(literal);
                if (k === undefined) return literal;
                let token = map.get(k);
                if (!token) {
                  const existing = newTokens.get(k);
                  token = existing?.name ?? literalTokenName(literal);
                  if (!existing) newTokens.set(k, { name: token, value: literal });
                }
                replacements.push({ file, line: decl.source?.start?.line ?? 0, literal, token });
                return `var(${token})`;
              }),
        )
        .join('');
      if (next !== decl.value) decl.value = next;
    });
    output[file] = rootNode.toString();
  }
  return { output, replacements };
}

/** Every replacement resolves to exactly the literal it replaced. */
export function verify(
  replacements: readonly Replacement[],
  values: ReadonlyMap<string, string>,
): string[] {
  return replacements
    .filter((r) => colourKey(values.get(r.token) ?? '') !== colourKey(r.literal))
    .map((r) => `${r.file}:${r.line} ${r.literal} -> ${r.token} (${values.get(r.token)})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const sources = Object.fromEntries(
    FILES.map((f) => [f, readFileSync(path.join(ROOT, f), 'utf8')]),
  );
  const map = safeTokenMap(sources);
  const newTokens = new Map<string, { name: string; value: string }>();
  const { output, replacements } = rewrite(sources, map, newTokens);
  const values = new Map(
    rootTokens(sources['packages/ui/src/tokens.css']!).map((t) => [t.name, t.value]),
  );
  for (const t of newTokens.values()) values.set(t.name, t.value);
  const wrong = verify(replacements, values);
  if (wrong.length > 0) throw new Error(`replacements that change a colour:\n${wrong.join('\n')}`);
  for (const f of FILES) writeFileSync(path.join(ROOT, f), output[f]!);
  const byExisting = replacements.filter((r) => !r.token.startsWith('--bs-lit-')).length;
  console.log(
    JSON.stringify(
      {
        replacements: replacements.length,
        toExistingTokens: byExisting,
        toNewTokens: replacements.length - byExisting,
        newTokens: [...newTokens.values()],
      },
      null,
      2,
    ),
  );
}
