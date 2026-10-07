import { describe, expect, it } from 'vitest';
import {
  countryOptions,
  isIsoCountryCode,
  timeZoneOptions,
  utcOffsetLabel,
} from '@brandspace/shared';

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

describe('BATCH 7 (A5) — the time-zone list names each zone once', () => {
  const winter = new Date('2026-01-15T12:00:00Z');
  const summer = new Date('2026-07-15T12:00:00Z');

  it('prints the UTC offset of a zone at an instant', () => {
    expect(utcOffsetLabel('Asia/Riyadh', winter)).toBe('UTC+03:00');
    expect(utcOffsetLabel('Asia/Kolkata', winter)).toBe('UTC+05:30');
    expect(utcOffsetLabel('UTC', winter)).toBe('UTC+00:00');
    // Daylight saving moves the offset, so it is read at the instant given.
    expect(utcOffsetLabel('Europe/London', winter)).toBe('UTC+00:00');
    expect(utcOffsetLabel('Europe/London', summer)).toBe('UTC+01:00');
    expect(utcOffsetLabel('America/New_York', winter)).toBe('UTC-05:00');
  });

  it('a row is the city on one side and the offset on the other, never the zone twice', () => {
    const riyadh = timeZoneOptions('en', winter).find((option) => option.value === 'Asia/Riyadh');
    expect(riyadh).toEqual({ value: 'Asia/Riyadh', label: 'Riyadh', hint: 'UTC+03:00' });
    const newYork = timeZoneOptions('en', winter).find(
      (option) => option.value === 'America/New_York',
    );
    expect(newYork?.label).toBe('New York');
    for (const option of timeZoneOptions('en', winter)) {
      expect(option.label).not.toContain('/');
      expect(option.hint).toMatch(/^UTC[+-]\d\d:\d\d$/);
    }
  });

  it('offers every zone the runtime knows, not one', () => {
    expect(timeZoneOptions('ar', winter).length).toBeGreaterThan(300);
  });
});
