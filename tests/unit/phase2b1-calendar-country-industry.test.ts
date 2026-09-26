import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfigPayload } from '@brandspace/config';
import {
  calendarMarkers,
  parseContentPolicy,
  suggestedPostingTimes,
  type ContentPolicy,
} from '@brandspace/content';
import { industryKeyFor, industryLabel, offersQuestionSetFor } from '@brandspace/onboarding';
import { suggestedTimeZone, suggestedTimeZones, timeZoneOptions } from '@brandspace/shared';
import { timeZoneAfterCountryChange } from '../../apps/dashboard/src/components/time-zone-suggestion';

/**
 * G6 / Q7 (prototype v94 Phase 2B-1, D-329) — what a country and an industry
 * decide, as pure rules. Every holiday, observance, time and industry below is
 * a FIXTURE standing in for operator configuration.
 */

const root = path.resolve(__dirname, '../..');

function calendarWith(overrides: Partial<ContentPolicy['calendar']>): ContentPolicy['calendar'] {
  const base = (parseConfigPayload('content', {}) as { calendar: ContentPolicy['calendar'] })
    .calendar;
  return { ...base, ...overrides };
}

describe('Q7 · the country preselects its usual time zone, and only suggests it', () => {
  it('suggests the single zone of a single-zone country, from the runtime’s own data', () => {
    expect(suggestedTimeZone('EG')).toBe('Africa/Cairo');
    expect(suggestedTimeZone('sa')).toBe('Asia/Riyadh');
    expect(suggestedTimeZone('AE')).toBe('Asia/Dubai');
  });

  it('names the capital’s zone for a country with several, and nothing it cannot stand behind', () => {
    expect(suggestedTimeZone('US')).toBe('America/New_York');
    expect(suggestedTimeZone('AQ')).toBeNull();
    expect(suggestedTimeZone('ZZ')).toBeNull();
  });

  it('only ever suggests a zone the picker offers', () => {
    const offered = new Set(timeZoneOptions('en').map((option) => option.value));
    for (const zone of Object.values(suggestedTimeZones())) expect(offered.has(zone)).toBe(true);
  });

  it('replaces the zone only while the person has not chosen one themselves', () => {
    const suggestions = { EG: 'Africa/Cairo', SA: 'Asia/Riyadh' };
    const change = (previousCountry: string, nextCountry: string, currentZone: string) =>
      timeZoneAfterCountryChange({ previousCountry, nextCountry, currentZone, suggestions });
    expect(change('', 'EG', '')).toBe('Africa/Cairo');
    expect(change('EG', 'SA', 'Africa/Cairo')).toBe('Asia/Riyadh');
    // Chosen by hand: kept.
    expect(change('EG', 'SA', 'Europe/London')).toBe('Europe/London');
    // No suggestion for the new country: whatever was there stays.
    expect(change('EG', 'AQ', 'Africa/Cairo')).toBe('Africa/Cairo');
  });
});

describe('G6 · the calendar: holidays by country, observances by industry', () => {
  const calendar = calendarWith({
    holidays: [
      {
        country: 'EG',
        date: '2026-10-06',
        name: { en: 'Armed Forces Day', ar: 'عيد القوات المسلحة' },
      },
      { country: 'SA', date: '2026-09-23', name: { en: 'Saudi National Day', ar: 'اليوم الوطني' } },
      { country: 'EG', date: '2027-01-07', name: { en: 'Coptic Christmas', ar: 'عيد الميلاد' } },
    ],
    observances: [
      { industry: 'food', date: '2026-10-16', name: { en: 'World Food Day', ar: 'يوم الأغذية' } },
      { industry: 'beauty', date: '2026-10-10', name: { en: 'Beauty day', ar: 'يوم الجمال' } },
    ],
  });

  it('shows the workspace country’s holidays in range, and nobody else’s', () => {
    const markers = calendarMarkers(calendar, {
      country: 'eg',
      industryKey: null,
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(markers).toEqual([
      {
        date: '2026-10-06',
        kind: 'holiday',
        name: { en: 'Armed Forces Day', ar: 'عيد القوات المسلحة' },
      },
    ]);
  });

  it('adds the brand industry’s observances, by catalogue key only', () => {
    const markers = calendarMarkers(calendar, {
      country: null,
      industryKey: 'food',
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(markers.map((marker) => [marker.date, marker.kind])).toEqual([
      ['2026-10-16', 'observance'],
    ]);
    expect(
      calendarMarkers(calendar, {
        country: null,
        industryKey: null,
        from: '2026-01-01',
        to: '2027-12-31',
      }),
    ).toEqual([]);
  });

  it('ships with nothing: holidays, observances, times and industries are empty until an operator enters them', () => {
    const content = parseContentPolicy(parseConfigPayload('content', {}));
    expect(content.calendar.holidays).toEqual([]);
    expect(content.calendar.observances).toEqual([]);
    expect(content.calendar.suggestedTimes).toEqual([]);
    expect((parseConfigPayload('onboarding', {}) as { industries: unknown[] }).industries).toEqual(
      [],
    );
  });

  it('the Egypt / Saudi Arabia / UAE draft is documentation only — nothing seeds or loads it', () => {
    // Names that exist ONLY in the draft. None may appear in application code,
    // a seed or a migration: the dates are unverified until the owner approves.
    for (const needle of [
      'Armed Forces Day',
      'Sinai Liberation Day',
      'Founding Day',
      'عيد الاتحاد',
    ]) {
      let hits = '';
      try {
        hits = execFileSync(
          'git',
          ['grep', '-l', needle, '--', 'apps', 'packages', 'tests/e2e', 'scripts'],
          { cwd: root, encoding: 'utf8' },
        );
      } catch {
        // `git grep` exits 1 when nothing matches — which is the point.
        hits = '';
      }
      expect(hits, needle).toBe('');
    }
  });

  it('refuses a malformed holiday or time in configuration', () => {
    expect(() =>
      parseConfigPayload('content', {
        calendar: { holidays: [{ country: 'EG', date: '6 Oct', name: { en: 'x', ar: 'س' } }] },
      }),
    ).toThrow();
    expect(() =>
      parseConfigPayload('content', {
        calendar: { suggestedTimes: [{ country: 'SA', times: ['25:00'] }] },
      }),
    ).toThrow();
  });
});

describe('G6 · suggested posting times: measured first, then the country, never "best"', () => {
  const calendar = calendarWith({
    suggestedTimes: [{ country: 'SA', times: ['21:00', '10:00', '16:00'] }],
  });

  it('a measured best time for the brand wins', () => {
    expect(suggestedPostingTimes(calendar, { measured: ['19:30'], country: 'SA' })).toEqual({
      times: ['19:30'],
      source: 'measured',
    });
  });

  it('otherwise the country’s configured times, in order', () => {
    expect(suggestedPostingTimes(calendar, { measured: [], country: 'sa' })).toEqual({
      times: ['10:00', '16:00', '21:00'],
      source: 'configured',
    });
  });

  it('otherwise nothing', () => {
    expect(suggestedPostingTimes(calendar, { measured: [], country: 'EG' })).toEqual({
      times: [],
      source: 'none',
    });
  });
});

describe('G6 · industry → Brand Brain Offers question set (read by Brand Brain v2)', () => {
  const industries = [
    {
      key: 'food',
      name: { en: 'Food & drink', ar: 'الأطعمة والمشروبات' },
      offersQuestionSet: 'food',
    },
    { key: 'salon', name: { en: 'Salons', ar: 'الصالونات' }, offersQuestionSet: 'beauty' },
  ];

  it('maps a catalogue key to its question set; free text maps to none', () => {
    expect(industryKeyFor('salon', industries)).toBe('salon');
    expect(offersQuestionSetFor('salon', industries)).toBe('beauty');
    expect(offersQuestionSetFor('Artisanal candles', industries)).toBeNull();
    expect(offersQuestionSetFor(null, industries)).toBeNull();
  });

  it('reads a key as its name in the reader’s language, and free text as written', () => {
    expect(industryLabel('food', industries, 'ar')).toBe('الأطعمة والمشروبات');
    expect(industryLabel('Artisanal candles', industries, 'en')).toBe('Artisanal candles');
  });
});
