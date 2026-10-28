import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  colorValues,
  directionForLocale,
  htmlLangForLocale,
  isSupportedLocale,
} from '@brandspace/ui';

describe('bilingual direction', () => {
  it('supports Arabic and English', () => {
    expect([...SUPPORTED_LOCALES].sort()).toEqual(['ar', 'en']);
  });

  it('maps Arabic to RTL and English to LTR', () => {
    expect(directionForLocale('ar')).toBe('rtl');
    expect(directionForLocale('en')).toBe('ltr');
  });

  it('emits a correct html lang for each locale', () => {
    expect(htmlLangForLocale('ar')).toBe('ar-SA');
    expect(htmlLangForLocale('en')).toBe('en');
  });

  it('the PUBLIC SITE and Control Center default to Arabic (D-03); the customer app is English (D-277)', () => {
    expect(DEFAULT_LOCALE).toBe('ar');
  });

  it('rejects an unsupported locale', () => {
    expect(isSupportedLocale('fr')).toBe(false);
    expect(isSupportedLocale('ar')).toBe(true);
  });
});

describe('brand tokens', () => {
  it('carries the approved brand colours', () => {
    expect(colorValues.brandBlue).toBe('#00ADEE');
    expect(colorValues.brandYellow).toBe('#FFDD15');
  });

  it('pairs the yellow with a dark ink, because yellow-on-white fails contrast', () => {
    expect(colorValues.brandYellowInk).toBe('#1A1A1A');
    expect(colorValues.brandYellowText).not.toBe(colorValues.brandYellow);
  });
});
