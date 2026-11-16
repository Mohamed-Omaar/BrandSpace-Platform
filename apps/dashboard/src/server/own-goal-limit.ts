/**
 * D-496 (Auth 8) — the longest goal a person may type in setup.
 *
 * Its own module (B2) so the browser's goal field can read it without
 * importing `./setup-wizard-state.ts`, which carries both languages' words.
 */
export const OWN_GOAL_MAX = 120;
