import type { SaveBarLabels } from '@brandspace/ui';

/**
 * The Settings save bar's words (A9 / G1, D-330), one place for every
 * draftable tab so "All changes saved" never reads two ways.
 */
export function saveBarLabels(
  t: (key: 'saveBar.saved' | 'saveBar.unsaved' | 'common.cancel' | 'common.save') => string,
): SaveBarLabels {
  return {
    saved: t('saveBar.saved'),
    unsaved: t('saveBar.unsaved'),
    cancel: t('common.cancel'),
    save: t('common.save'),
  };
}

/**
 * The seven weekdays in the reader's language, index 0 = Sunday — the
 * numbering `weekStartsOn` uses. Named by `Intl`, not by a copy table:
 * 7 January 2024 was a Sunday.
 */
export function weekdayNames(locale: string): string[] {
  const format = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', {
    weekday: 'long',
    timeZone: 'UTC',
  });
  return Array.from({ length: 7 }, (_, day) => format.format(new Date(Date.UTC(2024, 0, 7 + day))));
}
