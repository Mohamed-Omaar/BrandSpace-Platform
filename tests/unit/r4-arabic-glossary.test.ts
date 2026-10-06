import { describe, expect, it } from 'vitest';
import { messages } from '../../apps/dashboard/src/i18n/messages';

/**
 * ROUND 4, STEP 6 — ONE FORMAL ARABIC, ONE TERM PER CONCEPT (D-474,
 * `docs/ARABIC-GLOSSARY.md`).
 *
 * The customer dashboard's Arabic is simple formal Arabic for every country:
 * no Egyptian words, no retired alternates for a glossary term, the wordmark in
 * Latin, and Latin digits.
 */

const values = Object.entries(messages.ar as Record<string, string>);
const word = (pattern: string) =>
  new RegExp(`(?<![\\u0600-\\u06FF])(${pattern})(?![\\u0600-\\u06FF])`);

describe('the Arabic interface is formal Arabic (Step 6.3)', () => {
  const EGYPTIAN =
    'مش|إيه|دلوقتي|عشان|علشان|بتاع|بتاعك|كده|لسه|إزاي|ازاي|فين|عايز|عاوز|خلّي|يلا|اللي|إمتى|ليه|حاجة|مفيش|زرار|مستني|شوف|معاك|برضه|ماشي';
  it('no value carries an Egyptian word', () => {
    const offenders = values
      .filter(([, value]) => word(EGYPTIAN).test(value))
      .map(([key, value]) => `${key}: ${value}`);
    expect(offenders).toEqual([]);
  });
});

describe('one term per concept (Step 6.4)', () => {
  const RETIRED: readonly [string, RegExp][] = [
    ['draft is مسودة, never مسودّة', /مسودّ/],
    ['media is الوسائط, never الأصول', /الأصول/],
    ['Copilot is المساعد in Arabic', /Copilot/],
    ['Brand Brain is عقل العلامة in Arabic', /Brand Brain/],
  ];
  for (const [rule, pattern] of RETIRED) {
    it(rule, () => {
      expect(values.filter(([, value]) => pattern.test(value)).map(([key]) => key)).toEqual([]);
    });
  }
});

describe('the wordmark and the digits (Steps 6.5, 6.6)', () => {
  it('the wordmark is BrandSpace, never transliterated', () => {
    expect(values.filter(([, value]) => /براندسبيس/.test(value)).map(([key]) => key)).toEqual([]);
    expect(messages.ar['app.title']).toBe('BrandSpace');
  });

  it('no Arabic value writes an Arabic-Indic digit', () => {
    expect(values.filter(([, value]) => /[٠-٩۰-۹]/.test(value)).map(([key]) => key)).toEqual([]);
  });
});
