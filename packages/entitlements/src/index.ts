/**
 * Plans, features, flags, limits, overrides, the precedence engine and the
 * credit ledger — CLAUDE.md §3, docs/ADMIN-CONTROL-CENTER.md §5.
 *
 * Phase 2B implements the machinery. The plan catalogue itself stays
 * configuration: no plan name, price or allowance is written in code, because
 * D-06…D-12 are unanswered owner decisions (docs/DECISIONS.md §4.2).
 */
export * from './credits';
export * from './precedence';
export * from './service';
