/** Locale and text direction. Arabic is RTL and first-class — CLAUDE.md §4. */
export const SUPPORTED_LOCALES = ['ar', 'en'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = 'ar';

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
