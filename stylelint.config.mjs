// @ts-check
import { ratchetedFiles } from './scripts/style/style-rules.mjs';

/**
 * Stylelint, STRICT (design-system programme, S6).
 *
 * The rule is an ERROR in every stylesheet, new ones included, except the
 * stylesheets the style ratchet still holds (scripts/style/baseline.json):
 * there it is a warning, and tests/unit/style-ratchet.test.ts stops their
 * counts rising. A stylesheet the ratchet drops (its counts reached zero) has
 * zero tolerance from then on. `pnpm lint` runs this after ESLint.
 *
 * `scale-unlimited/declaration-strict-value` asks for `var(--…)` (or a
 * function) wherever a theme-able value is written. Custom-property
 * definitions — the tokens themselves — are never checked.
 */
/** The properties that must take a token. */
const STRICT_VALUES = [
  '/color$/',
  'fill',
  'stroke',
  'background',
  'box-shadow',
  'text-shadow',
  'z-index',
  'font-size',
  'font-family',
  '/radius$/',
  'transition-duration',
  'transition-timing-function',
  'animation-duration',
  'animation-timing-function',
  'backdrop-filter',
];

/** The values that never need one. */
const STRICT_OPTIONS = {
  ignoreValues: [
    'transparent',
    'currentColor',
    'currentcolor',
    'inherit',
    'initial',
    'unset',
    'revert',
    'none',
    'auto',
    '0',
    '/^\\d+%$/',
  ],
};

export default {
  plugins: ['stylelint-declaration-strict-value'],
  ignoreFiles: ['**/node_modules/**', '**/.next/**', 'docs/**'],
  rules: {
    'scale-unlimited/declaration-strict-value': [STRICT_VALUES, STRICT_OPTIONS],
  },
  overrides: [
    {
      files: ratchetedFiles('css'),
      rules: {
        'scale-unlimited/declaration-strict-value': [
          STRICT_VALUES,
          { ...STRICT_OPTIONS, severity: 'warning' },
        ],
      },
    },
  ],
};
