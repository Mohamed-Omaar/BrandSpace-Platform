import { describe, expect, it } from 'vitest';
import { messages } from '../../apps/dashboard/src/i18n/messages';

/**
 * Both locales carry every key.
 *
 * `MessageKey` is `keyof messages.en`, and `translator` indexes the Arabic
 * dictionary with it — so the compiler already catches an English key that
 * Arabic lacks. It does NOT catch the reverse: an Arabic-only key is simply
 * unreachable, and an English string that was never written is invisible until
 * a customer sees a blank label.
 *
 * CLAUDE.md §4 makes both locales first-class, and the Definition of Done
 * requires both for any new user-facing text. This asserts it in both
 * directions.
 */
describe('the customer dictionary', () => {
  const ar = Object.keys(messages.ar).sort();
  const en = Object.keys(messages.en).sort();

  it('has the same keys in Arabic and English', () => {
    expect(ar).toEqual(en);
  });

  it('has no empty string in either locale', () => {
    for (const [locale, dictionary] of Object.entries(messages)) {
      for (const [key, value] of Object.entries(dictionary)) {
        expect(typeof value, `${locale}.${key}`).toBe('string');
        expect((value as string).trim().length, `${locale}.${key} is empty`).toBeGreaterThan(0);
      }
    }
  });

  it('leaves no Brand Brain string untranslated into Arabic', () => {
    // A copy-paste of the English value into the Arabic block is the failure
    // this catches: it type-checks, renders, and is wrong.
    const shared = Object.keys(messages.en).filter((k) => k.startsWith('bb.'));
    expect(shared.length).toBeGreaterThan(0);
    const untranslated = shared.filter(
      (key) =>
        messages.ar[key as keyof typeof messages.ar] ===
        messages.en[key as keyof typeof messages.en],
    );
    expect(untranslated).toEqual([]);
  });
});
