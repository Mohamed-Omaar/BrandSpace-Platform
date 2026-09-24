/** Locale and text direction. Arabic is RTL and first-class — CLAUDE.md §4. */
export const SUPPORTED_LOCALES = ['ar', 'en'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/**
 * The PUBLIC WEBSITE's default (D-03, unchanged): the marketing site leads with
 * the launch market's language. The Control Center no longer uses it — see
 * `CONTROL_CENTER_DEFAULT_LOCALE`.
 */
export const DEFAULT_LOCALE: SupportedLocale = 'ar';

/**
 * The CUSTOMER DASHBOARD's default interface language (D-277): English.
 *
 * Owner decision, 2026-09-24. A locale-less customer URL, sign-up, sign-in,
 * reset, verification and first-run onboarding all start in English unless
 * `/ar` was asked for explicitly. This is the INTERFACE language only — what a
 * brand writes to its audience is decided separately (content language).
 */
export const CUSTOMER_DEFAULT_LOCALE: SupportedLocale = 'en';

/**
 * The CONTROL CENTER's default interface language (D-310): English.
 *
 * Owner decision, 2026-09-24 (Simple + Advanced mode contract §21): the owner
 * console starts in English, and Arabic is full RTL when asked for with `/ar`.
 * Interface language only — nothing here decides what a customer's content is
 * written in.
 */
export const CONTROL_CENTER_DEFAULT_LOCALE: SupportedLocale = 'en';

export type Direction = 'rtl' | 'ltr';

export function directionForLocale(locale: SupportedLocale): Direction {
  return locale === 'ar' ? 'rtl' : 'ltr';
}

export function isSupportedLocale(value: string): value is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** HTML lang attribute for a locale. */
export function htmlLangForLocale(locale: SupportedLocale): string {
  return locale === 'ar' ? 'ar-SA' : 'en';
}
