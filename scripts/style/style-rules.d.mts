import type { ESLint, Linter } from 'eslint';

/** Types for style-rules.mjs, which eslint.config.mjs imports as plain JS. */
export declare const styleSyntaxPlugin: ESLint.Plugin;
export declare const STYLE_SYNTAX_SELECTORS: ReadonlyArray<{ selector: string; message: string }>;
export declare const STYLE_SYNTAX_RULE: Linter.RuleEntry;
