// @ts-check
import { builtinRules } from 'eslint/use-at-your-own-risk';

/**
 * The hard-coded style values the ESLint `style/no-restricted-syntax` rule
 * reports, and the ratchet counts (scripts/style/measure.ts).
 *
 * WHY A SECOND NAME FOR `no-restricted-syntax`. ESLint gives a rule one
 * severity per file. The core `no-restricted-syntax` already ERRORS on
 * `new Date()` everywhere; adding these selectors to it as warnings would
 * downgrade that error. Registering the same core rule under a plugin name lets
 * the style selectors report as warnings (report-only, until the S6 step of the
 * design-system programme) while the Date rule stays an error.
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

/** The editor-facing rule config, used by eslint.config.mjs. */
export const STYLE_SYNTAX_RULE = ['warn', ...STYLE_SYNTAX_SELECTORS];
