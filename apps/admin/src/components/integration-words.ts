import type { ConnectionState } from '@brandspace/integrations';

/**
 * EVERY STATE VALUE AN INTEGRATION SCREEN SHOWS, IN BOTH LANGUAGES (#81).
 *
 * The detail page printed `never_tested`, `OK` and `STAGING` as stored. A
 * value the service can return and this file does not name is a type error,
 * not a raw word on screen: each map is total over its type. The hub and the
 * detail page read the same words, so a state never has two names.
 */

type Tone = 'ok' | 'warn' | 'off' | 'bad';
type Word = { readonly ar: string; readonly en: string; readonly tone: Tone };

export const CONNECTION_WORDS: Readonly<Record<ConnectionState, Word>> = {
  ok: { ar: 'يعمل', en: 'Working', tone: 'ok' },
  failed: { ar: 'فشل', en: 'Failed', tone: 'bad' },
  never_tested: { ar: 'لم يُختبر', en: 'Never tested', tone: 'off' },
  not_configured: { ar: 'غير مُهيّأ', en: 'Not configured', tone: 'warn' },
  refused: { ar: 'مرفوض', en: 'Refused', tone: 'warn' },
};

/** What one recorded check concluded (`IntegrationCheckOutcome`). */
export const CHECK_OUTCOMES = ['OK', 'FAILED', 'NOT_CONFIGURED', 'REFUSED'] as const;
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];

export const CHECK_OUTCOME_WORDS: Readonly<Record<CheckOutcome, Word>> = {
  OK: { ar: 'نجح', en: 'Passed', tone: 'ok' },
  FAILED: { ar: 'فشل', en: 'Failed', tone: 'bad' },
  NOT_CONFIGURED: { ar: 'غير مُهيّأ', en: 'Not configured', tone: 'warn' },
  REFUSED: { ar: 'مرفوض', en: 'Refused', tone: 'warn' },
};

export const ENVIRONMENT_WORDS: Readonly<
  Record<'DEVELOPMENT' | 'STAGING' | 'PRODUCTION', { ar: string; en: string }>
> = {
  DEVELOPMENT: { ar: 'التطوير', en: 'Development' },
  STAGING: { ar: 'ما قبل الإنتاج', en: 'Staging' },
  PRODUCTION: { ar: 'الإنتاج', en: 'Production' },
};

export function connectionWord(state: ConnectionState, isArabic: boolean): string {
  const word = CONNECTION_WORDS[state];
  return isArabic ? word.ar : word.en;
}

/**
 * The history column is typed `string` by the service (it is read back from
 * the database). An unknown value — a future outcome this build does not know
 * — is shown as a neutral dash rather than as the stored token.
 */
export function checkOutcomeWord(outcome: string, isArabic: boolean): string {
  const word = (CHECK_OUTCOME_WORDS as Record<string, Word | undefined>)[outcome];
  if (!word) return '—';
  return isArabic ? word.ar : word.en;
}

export function environmentWord(environment: string, isArabic: boolean): string {
  const word = (ENVIRONMENT_WORDS as Record<string, { ar: string; en: string } | undefined>)[
    environment
  ];
  if (!word) return '—';
  return isArabic ? word.ar : word.en;
}
