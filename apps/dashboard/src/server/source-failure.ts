import type { MessageKey } from '../i18n/messages';

/*
 * A Brand Brain source's stored failure reason, in the reader's language —
 * shared by the Brand Brain's Sources and the setup wizard's Teach step
 * (batch 7, A4), so a file that could not be read says why in both places.
 */

/** English sentences older releases stored in `failureMessage`, and their keys. */
const LEGACY_FAILURE_SENTENCES: Readonly<Record<string, string>> = {
  'The uploaded file could not be read.': 'object_missing',
  'Processing took too long and was stopped.': 'stuck_timeout',
};

/**
 * A stored failure reason, in the reader's language.
 *
 * An unrecognised key falls back to the general message rather than printing
 * the key itself: a reason added on the server before a translation exists must
 * not surface as `archive_unsafe_entry` on a customer's screen.
 */
export function sourceFailureText(reason: string | null, t: (key: MessageKey) => string): string {
  if (!reason) return t('bb.failure.extraction_failed');
  /*
   * PHASE 2C-4 — TWO OLDER ROWS STORED ENGLISH SENTENCES, not keys: a missing
   * object and the stuck-job sweep. Both now store their key; a row written
   * before that is mapped to the same key here, derived from what it already
   * holds, so an Arabic reader never sees the English sentence.
   */
  const legacy = LEGACY_FAILURE_SENTENCES[reason];
  const key = `bb.failure.${legacy ?? reason}` as MessageKey;
  // `translator` returns undefined for a key the catalogue does not have. The
  // cast above is what makes that possible, so the check is not defensive
  // noise — it is the guard the cast removed.
  const translated = t(key) as string | undefined;
  return translated ?? t('bb.failure.extraction_failed');
}
