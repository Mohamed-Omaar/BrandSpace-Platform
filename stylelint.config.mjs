// @ts-check
/**
 * Stylelint, REPORT ONLY (design-system programme, step S1).
 *
 * Every rule here is a warning: `pnpm lint:style` exits 0 while the stylesheets
 * still hold literal values. The build-failing gate is the style ratchet
 * (tests/unit/style-ratchet.test.ts), which fails only if a count goes up. Step
 * S6 turns these into errors once the counts reach zero.
 *
 * `scale-unlimited/declaration-strict-value` asks for `var(--…)` (or a
 * function) wherever a theme-able value is written. Custom-property
 * definitions — the tokens themselves — are never checked.
 */
export default {
  plugins: ['stylelint-declaration-strict-value'],
  ignoreFiles: ['**/node_modules/**', '**/.next/**', 'docs/**'],
  rules: {
    'scale-unlimited/declaration-strict-value': [
      [
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
      ],
      {
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
        severity: 'warning',
      },
    ],
  },
};
