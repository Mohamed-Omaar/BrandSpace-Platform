/**
 * PHASE 2C (Q19) — THE KEY QUESTIONS BRAND BRAIN SHIPS WITH, as the
 * `brand-brain.questions` configuration defaults.
 *
 * Configuration, not code: an operator replaces any of it by activating a new
 * `brand-brain` version in the Control Center, and the application reads only
 * what the schema resolved. This module holds the defaults the schema applies
 * when no version has been activated.
 */

export interface DefaultKeyQuestion {
  readonly key: string;
  readonly itemKey: string;
  readonly prompt: { readonly en: string; readonly ar: string };
}

export interface DefaultBrandBrainQuestions {
  readonly areas: Readonly<Record<string, readonly DefaultKeyQuestion[]>>;
  readonly offersSets: Readonly<Record<string, readonly DefaultKeyQuestion[]>>;
}

export const BRAND_BRAIN_QUESTIONS: DefaultBrandBrainQuestions = {
  areas: {},
  offersSets: {},
};
