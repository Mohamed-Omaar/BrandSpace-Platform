/**
 * THE STYLE RATCHET — how many hard-coded style values exist, file by file.
 *
 * WHY A RATCHET AND NOT A RULE. The full check-up (docs/FULL-CHECKUP-2026-10-28.md
 * §9) counted 2,149 literal values in the stylesheets and several thousand in
 * the TSX. Failing the build on all of them at once would block every PR until
 * the whole design-system programme is done. Instead the counts measured here
 * are committed as a baseline (`baseline.json`), and
 * `tests/unit/style-ratchet.test.ts` fails if any count goes UP. Each later PR
 * lowers them. Since S6 the baseline is exact (`stale`), and the lint rules are
 * errors in every file the baseline no longer lists.
 *
 * WHAT COUNTS AS A HARD-CODED VALUE.
 *
 *   CSS (every `*.css` under packages/ui/src and apps/*\/src): a declaration
 *   whose value states a colour, length, duration, easing, z-index, blur, font
 *   size or font family literally instead of through `var(--…)`. Custom
 *   property DEFINITIONS (`--bs-ink: #111114`) are the tokens themselves and are
 *   never counted. A reference to the S3 transitional palette (`var(--bs-lit-…)`,
 *   a token named for its own value) is counted as `lit-token`. `0`, keywords and percentages are not values a theme would
 *   change, so they are not counted either.
 *
 *   TS/TSX (apps/*\/src and packages/ui/src, tests excluded, and `tokens.ts` —
 *   the token source — excluded): colour strings, numeric `zIndex` /
 *   `fontSize` / `borderRadius` / `letterSpacing` / `lineHeight` style values,
 *   literal length strings in style objects, every inline `style=` attribute,
 *   and every reference to a token whose value is a baked literal
 *   (`zIndexTokens.*`, `fontTokens.*`, and the three D-55 colours) — those do
 *   not follow a change to tokens.css. Since S2 the other colour, shadow and
 *   motion tokens are `var(--bs-…)` and are not counted.
 *
 * The TSX categories are found with the SAME selectors the ESLint
 * `style/no-restricted-syntax` rule reports in the editor (`style-rules.mjs`),
 * so a warning in the editor and a count here are the same thing.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { STYLE_SYNTAX_SELECTORS, styleSyntaxPlugin } from './style-rules.mjs';

export type Counts = Record<string, Record<string, number>>;

export const CSS_ROOTS = [
  'packages/ui/src',
  'apps/dashboard/src',
  'apps/admin/src',
  'apps/web/src',
];
export const TS_ROOTS = [
  'packages/ui/src',
  'apps/dashboard/src',
  'apps/admin/src',
  'apps/web/src',
  'apps/api/src',
];

/** The token source itself: its literals ARE the tokens. */
const TS_EXCLUDED = new Set(['packages/ui/src/tokens.ts']);

function walk(root: string, dir: string, accept: (file: string) => boolean, out: string[]): void {
  for (const name of readdirSync(path.join(root, dir))) {
    if (name === 'node_modules' || name === '.next' || name === 'dist') continue;
    const relative = path.posix.join(dir, name);
    if (statSync(path.join(root, relative)).isDirectory()) walk(root, relative, accept, out);
    else if (accept(relative)) out.push(relative);
  }
}

export function cssFiles(root: string): string[] {
  const out: string[] = [];
  for (const dir of CSS_ROOTS) walk(root, dir, (f) => f.endsWith('.css'), out);
  return out.sort();
}

export function tsFiles(root: string): string[] {
  const out: string[] = [];
  const accept = (f: string) =>
    /\.(ts|tsx)$/.test(f) && !/\.(test|spec)\.tsx?$/.test(f) && !f.endsWith('.d.ts');
  for (const dir of TS_ROOTS) walk(root, dir, accept, out);
  return out.filter((f) => !TS_EXCLUDED.has(f)).sort();
}

// --- CSS ---------------------------------------------------------------------

const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const COLOUR_FN = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/g;
const NAMED_COLOUR =
  /(?<![-\w])(?:white|black|red|green|blue|gray|grey|silver|orange|yellow|purple)(?![-\w(])/gi;
const LENGTH = /(?<![-\w.#])-?\d*\.?\d+(?:px|rem|em|ch|vw|vh|vmin|vmax)\b/g;
const DURATION = /(?<![-\w.#])\d*\.?\d+m?s\b/g;
const EASING =
  /\bcubic-bezier\(|\bsteps\(|(?<![-\w])(?:ease|ease-in|ease-out|ease-in-out|linear)(?![-\w])/g;
const BLUR = /\bblur\(\s*-?\d*\.?\d+(?:px|rem|em)/g;
const FAMILY = /^(?!\s*(?:inherit|initial|unset|revert)\s*$)/;

/** Strip `var(...)` (including nested fallbacks) so a token reference never counts. */
function withoutVars(value: string): string {
  let out = value;
  for (;;) {
    const next = out.replace(/var\([^()]*(?:\([^()]*\)[^()]*)*\)/g, '');
    if (next === out) return out;
    out = next;
  }
}

function count(re: RegExp, value: string): number {
  return (value.match(re) ?? []).length;
}

function bump(into: Record<string, number>, key: string, by: number): void {
  if (by > 0) into[key] = (into[key] ?? 0) + by;
}

export function measureCss(source: string): Record<string, number> {
  const out: Record<string, number> = {};
  const rootNode = postcss.parse(source);
  rootNode.walkDecls((decl) => {
    if (decl.prop.startsWith('--')) return; // a token definition
    const prop = decl.prop.toLowerCase();
    // The S3 transitional palette is named for its literal value: using it is
    // still a literal, so it is counted and may only go down.
    bump(out, 'lit-token', count(/var\(--bs-lit-/g, decl.value));
    const value = withoutVars(decl.value);
    // Inside a `@keyframes` step a colour or length is still a literal.
    bump(out, 'colour', count(HEX, value) + count(COLOUR_FN, value) + count(NAMED_COLOUR, value));
    if (prop === 'z-index') {
      if (/-?\d+/.test(value)) bump(out, 'z-index', 1);
      return;
    }
    if (/^(transition|animation)/.test(prop)) {
      bump(out, 'duration', count(DURATION, value));
      bump(out, 'easing', count(EASING, value));
      return;
    }
    if (prop === 'filter' || prop === 'backdrop-filter' || prop === '-webkit-backdrop-filter') {
      bump(out, 'blur', count(BLUR, value));
      return;
    }
    if (prop === 'font-family') {
      if (FAMILY.test(value) && value.trim() !== '') bump(out, 'font-family', 1);
      return;
    }
    if (prop === 'font' || prop === 'font-size') {
      bump(out, 'font-size', count(LENGTH, value));
      return;
    }
    const lengths = count(LENGTH, value);
    if (lengths === 0) return;
    if (/shadow$/.test(prop)) bump(out, 'shadow', 1);
    else if (/radius$/.test(prop)) bump(out, 'radius', lengths);
    else if (/^border(-|$)|^outline(-|$)/.test(prop)) bump(out, 'border-width', lengths);
    else if (/^(margin|padding|gap|row-gap|column-gap)/.test(prop)) bump(out, 'spacing', lengths);
    else if (prop === 'letter-spacing') bump(out, 'letter-spacing', lengths);
    else bump(out, 'size', lengths);
  });
  return out;
}

// --- TS / TSX ------------------------------------------------------------------

let eslintInstance: ESLint | undefined;

function styleEslint(root: string): ESLint {
  eslintInstance ??= new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.{ts,tsx}'],
        languageOptions: {
          parser: tseslint.parser as Linter.Parser,
          parserOptions: { ecmaFeatures: { jsx: true }, projectService: false },
        },
        // An `eslint-disable` comment must not be able to hide a value from the count.
        linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'off' },
        plugins: { style: styleSyntaxPlugin },
        rules: { 'style/no-restricted-syntax': ['warn', ...STYLE_SYNTAX_SELECTORS] },
      },
    ],
  });
  return eslintInstance;
}

/** The category is the `[category]` prefix every selector message carries. */
function categoryOf(message: string): string {
  return /^\[([a-z-]+)\]/.exec(message)?.[1] ?? 'other';
}

export async function measureTs(root: string, files: string[]): Promise<Counts> {
  const results = await styleEslint(root).lintFiles(files);
  const out: Counts = {};
  for (const result of results) {
    const file = path.relative(root, result.filePath).split(path.sep).join('/');
    for (const message of result.messages) {
      // A parse error would silently report zero; refuse to measure instead.
      if (message.fatal) throw new Error(`${file}:${message.line} ${message.message}`);
      if (message.ruleId !== 'style/no-restricted-syntax') continue;
      out[file] ??= {};
      bump(out[file]!, categoryOf(message.message), 1);
    }
  }
  return out;
}

export async function measure(root: string): Promise<{ css: Counts; ts: Counts }> {
  const css: Counts = {};
  for (const file of cssFiles(root)) {
    const counts = measureCss(readFileSync(path.join(root, file), 'utf8'));
    if (Object.keys(counts).length > 0) css[file] = counts;
  }
  const ts = await measureTs(root, tsFiles(root));
  return { css, ts };
}

export function totals(counts: Counts): Record<string, number> {
  const out: Record<string, number> = {};
  for (const perFile of Object.values(counts))
    for (const [category, n] of Object.entries(perFile)) bump(out, category, n);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** Every (file, category) whose count is above the baseline. */
/**
 * S6: the baseline is EXACT. Every (file, category) the baseline records above
 * the current count — a count that went down, or a file that reached zero —
 * is stale until `pnpm style:ratchet --write` records it, so an improvement is
 * locked in by the PR that makes it.
 */
export function stale(current: Counts, baseline: Counts): string[] {
  const out: string[] = [];
  for (const [file, perFile] of Object.entries(baseline)) {
    for (const [category, allowed] of Object.entries(perFile)) {
      const n = current[file]?.[category] ?? 0;
      if (n < allowed) out.push(`${file} ${category}: ${allowed} -> ${n}`);
    }
  }
  return out.sort();
}

export function regressions(current: Counts, baseline: Counts): string[] {
  const out: string[] = [];
  for (const [file, perFile] of Object.entries(current)) {
    for (const [category, n] of Object.entries(perFile)) {
      const allowed = baseline[file]?.[category] ?? 0;
      if (n > allowed) out.push(`${file} ${category}: ${allowed} -> ${n}`);
    }
  }
  return out.sort();
}
