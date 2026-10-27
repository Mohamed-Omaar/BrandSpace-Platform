/**
 * D-573 — THE LANGUAGE LINE EVERY TEXT PROMPT CARRIES.
 *
 * One Arabic for every reader (D-474): the product writes simple, correct
 * formal Arabic, never a dialect. A model left to itself drifts into
 * colloquial forms, Gulf or Egyptian vocabulary, or Eastern Arabic digits, so
 * every task that writes text asks for the same thing in the same words. The
 * one place these words live is here; `tests/unit/d573-arabic-prompts.test.ts`
 * checks each prompt builder uses them.
 */

/** Asked of every text task whose output is Arabic. */
export const FORMAL_ARABIC_INSTRUCTION =
  'Write in correct formal Arabic (Modern Standard Arabic): correct grammar, spelling and ' +
  'punctuation, simple and clear, with no dialect or colloquial words. Write numbers with ' +
  'Latin digits (0-9). Keep the brand name exactly as written.';

/** Asked of every text task whose output is English. */
export const ENGLISH_INSTRUCTION = 'Write in clear, correct English.';

/**
 * The language line for a prompt: the output language, and for Arabic the
 * formal-Arabic instruction. Accepts either spelling of the locale the
 * packages use (`AR`/`EN` or `ar`/`en`).
 */
export function languageInstruction(locale: string | null | undefined): string {
  const arabic = typeof locale === 'string' && locale.toLowerCase() === 'ar';
  return arabic
    ? `Language: Arabic. ${FORMAL_ARABIC_INSTRUCTION}`
    : `Language: English. ${ENGLISH_INSTRUCTION}`;
}

/**
 * For a conversation (Brand Brain chat, the Copilot): answer in the language
 * the person wrote in, which is how they read; when the message does not make
 * that clear, in `fallbackLocale` — the reader's interface language or the
 * brand's own. Never fixed to English. Arabic answers are formal Arabic.
 */
export function answerLanguageInstruction(fallbackLocale: string | null | undefined): string {
  const fallback =
    typeof fallbackLocale === 'string' && fallbackLocale.toLowerCase() === 'ar'
      ? 'Arabic'
      : 'English';
  return (
    'Answer in the language the customer wrote their message in; if that is unclear, answer in ' +
    `${fallback}. When you answer in Arabic: ${FORMAL_ARABIC_INSTRUCTION} ` +
    `When you answer in English: ${ENGLISH_INSTRUCTION}`
  );
}
