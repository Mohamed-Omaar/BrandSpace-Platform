// @ts-check
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { builtinRules } from 'eslint/use-at-your-own-risk';

/**
 * The hard-coded style values the ESLint `style/no-restricted-syntax` rule
 * reports, and the ratchet counts (scripts/style/measure.ts).
 *
 * WHY A SECOND NAME FOR `no-restricted-syntax`. ESLint gives a rule one
 * severity per file. The core `no-restricted-syntax` already ERRORS on
 * `new Date()` everywhere; adding these selectors to it as warnings would
 * downgrade that error. Registering the same core rule under a plugin name lets
 * the style selectors keep their own severity while the Date rule stays an
 * error everywhere.
 *
 * Every message starts with `[category]`, which is how the ratchet groups them.
 */
const coreRule = builtinRules.get('no-restricted-syntax');
if (!coreRule) throw new Error('ESLint no longer ships no-restricted-syntax');

export const styleSyntaxPlugin = { rules: { 'no-restricted-syntax': coreRule } };

const COLOUR = String.raw`/^\s*(#[0-9a-fA-F]{3,8}|(rgba?|hsla?)\()/`;
const LENGTH = String.raw`/^-?\d*\.?\d+(px|rem|em|ch|vw|vh)$/`;
const NUMERIC_STYLE = '/^(zIndex|fontSize|borderRadius|letterSpacing|lineHeight)$/';
// Since S2, colorTokens, shadowTokens and motionTokens return var(--bs-…), so
// they follow tokens.css (since S4 every colour, the three D-55 ones included).
// What is still baked: the z-index and font objects.
const BAKED = '/^(zIndexTokens|fontTokens)$/';

export const STYLE_SYNTAX_SELECTORS = [
  {
    selector: `Literal[value=${COLOUR}]`,
    message: '[colour] A colour literal. Use a design token (var(--bs-…)).',
  },
  {
    selector: `TemplateElement[value.raw=${COLOUR}]`,
    message: '[colour] A colour literal. Use a design token (var(--bs-…)).',
  },
  {
    selector: `Property[key.name=${NUMERIC_STYLE}] > Literal[raw=/^-?\\d/]`,
    message: '[numeric-style] A hard-coded z-index, font size, radius or spacing. Use a token.',
  },
  {
    selector: `Property > Literal[value=${LENGTH}]`,
    message: '[length] A hard-coded length in a style value. Use a size token.',
  },
  {
    selector: "JSXAttribute[name.name='style']",
    message: '[inline-style] An inline style. Prefer a class from the shared component set.',
  },
  {
    selector: `MemberExpression[object.name=${BAKED}]`,
    message: '[baked-token] This token object holds literal values that do not follow tokens.css.',
  },
];

/**
 * STRICT (design-system programme, S6). The rule is an ERROR in every file,
 * new files included, except the files the ratchet still holds — those listed
 * in scripts/style/baseline.json, where it stays a warning and the ratchet
 * stops their counts rising. When a file's counts reach zero,
 * `pnpm style:ratchet --write` drops it from the baseline, and from then on it
 * has zero tolerance.
 */
export const STYLE_SYNTAX_RULE = ['error', ...STYLE_SYNTAX_SELECTORS];
export const STYLE_SYNTAX_RATCHETED = ['warn', ...STYLE_SYNTAX_SELECTORS];

/**
 * The files the ratchet still holds, by kind (`ts` or `css`), as repo-relative
 * glob patterns. A route segment such as `[locale]` is escaped, or the glob
 * would read it as a character class and miss the file.
 * @param {'ts' | 'css'} kind
 * @returns {string[]}
 */
export function ratchetedFiles(kind) {
  const baseline = JSON.parse(readFileSync(new URL('./baseline.json', import.meta.url), 'utf8'));
  return Object.keys(baseline[kind])
    .sort()
    .map((file) => file.replace(/[[\]()*?{}!]/g, '\\$&'));
}
