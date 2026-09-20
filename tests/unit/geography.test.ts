import { describe, expect, it } from 'vitest';
import { countryOptions, isIsoCountryCode, timeZoneOptions } from '@brandspace/shared';

describe('onboarding geography catalogues', () => {
  it('contains the complete ISO alpha-2 country set and localises labels', () => {
    const countries = countryOptions('en');
    expect(countries).toHaveLength(249);
    expect(countries.find((country) => country.value === 'SA')?.label).toMatch(/Saudi/i);
    expect(countries.find((country) => country.value === 'US')?.label).toMatch(/United States/i);
  });

  it('validates country codes independently of commerce configuration', () => {
    expect(isIsoCountryCode('sa')).toBe(true);
    expect(isIsoCountryCode('US')).toBe(true);
    expect(isIsoCountryCode('ZZ')).toBe(false);
  });

  it('offers searchable runtime IANA time zones and keeps canonical stored values', () => {
    const zones = timeZoneOptions('en').map((option) => option.value);
    expect(zones).toContain('Asia/Riyadh');
    expect(zones).toContain('Europe/London');
    expect(zones).toContain('UTC');
  });
});
