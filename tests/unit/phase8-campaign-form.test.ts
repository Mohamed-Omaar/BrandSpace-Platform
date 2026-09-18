import { describe, expect, it } from 'vitest';
import { AppError } from '@brandspace/shared';
import {
  CAMPAIGN_OBJECTIVES,
  CAMPAIGN_STATUSES,
  briefFrom,
  campaignFormFrom,
} from '../../apps/dashboard/src/server/campaign-form';

/**
 * PHASE 8 — THE CAMPAIGN FORM DECODER, ASSERTED DIRECTLY (AC-26.1, AC-26.2).
 *
 * WHY THESE ARE UNIT TESTS. Every rule below is about a request THE SCREEN
 * CANNOT PRODUCE: a field the markup always submits arriving absent, a date
 * that is not a date, a channel the operator has not enabled. A browser can
 * only show that the form works; these show what happens when something else
 * posts to it.
 *
 * THE RULE THEY ENFORCE IS D-184's: MISSING IS NOT EMPTY. A field that is
 * absent did not come from the screen and is refused; a field that is present
 * and blank is the author clearing it and is honoured.
 */

const PLATFORMS = ['instagram', 'linkedin'] as const;

function form(entries: Record<string, string | readonly string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    if (Array.isArray(value)) {
      for (const item of value) data.append(key, item);
    } else {
      data.set(key, value as string);
    }
  }
  return data;
}

function complete(overrides: Record<string, string | readonly string[]> = {}): FormData {
  return form({
    name: 'Ramadan launch',
    objective: 'AWARENESS',
    briefAr: '',
    briefEn: '',
    description: '',
    startDate: '',
    endDate: '',
    ...overrides,
  });
}

const options = { allowedChannels: PLATFORMS, withStatus: false };

describe('P8: the campaign decoder refuses what the screen cannot send', () => {
  it('decodes a complete submission', () => {
    const input = campaignFormFrom(
      complete({
        briefEn: 'Reach founders in the Gulf',
        briefAr: 'الوصول إلى المؤسسين',
        description: 'internal',
        startDate: '2026-03-01',
        endDate: '2026-03-30',
        channels: ['instagram', 'linkedin'],
      }),
      options,
    );
    expect(input.name).toBe('Ramadan launch');
    expect(input.objective).toBe('AWARENESS');
    expect(input.brief).toEqual({ ar: 'الوصول إلى المؤسسين', en: 'Reach founders in the Gulf' });
    expect(input.description).toBe('internal');
    expect(input.startDate?.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(input.channels).toEqual(['instagram', 'linkedin']);
    expect(input.status).toBeUndefined();
  });

  it.each(['name', 'objective', 'briefAr', 'briefEn', 'description', 'startDate', 'endDate'])(
    'refuses a submission with %s absent',
    (field) => {
      const data = complete();
      data.delete(field);
      expect(() => campaignFormFrom(data, options)).toThrow(AppError);
    },
  );

  it('treats a present-but-blank date as no date, not as the epoch', () => {
    const input = campaignFormFrom(complete({ startDate: '', endDate: '' }), options);
    expect(input.startDate).toBeNull();
    expect(input.endDate).toBeNull();
  });

  it('refuses a date that is not a date rather than storing an Invalid Date', () => {
    expect(() => campaignFormFrom(complete({ startDate: 'soon' }), options)).toThrow(AppError);
    expect(() => campaignFormFrom(complete({ startDate: '2026-13-45' }), options)).toThrow(
      AppError,
    );
  });

  it('refuses a campaign that ends before it starts', () => {
    expect(() =>
      campaignFormFrom(complete({ startDate: '2026-03-30', endDate: '2026-03-01' }), options),
    ).toThrow(AppError);
  });

  it('refuses an empty name', () => {
    expect(() => campaignFormFrom(complete({ name: '   ' }), options)).toThrow(AppError);
  });

  it('refuses an objective this product does not offer', () => {
    expect(() => campaignFormFrom(complete({ objective: 'WORLD_PEACE' }), options)).toThrow(
      AppError,
    );
  });

  /*
   * THE CHANNEL LIST IS THE OPERATOR'S FACT (CLAUDE.md §2.2). The decoder is
   * TOLD what is enabled and refuses anything else — silently dropping it would
   * tell the author their campaign covers a platform it does not.
   */
  it('refuses a channel the operator has not enabled', () => {
    expect(() =>
      campaignFormFrom(complete({ channels: ['instagram', 'myspace'] }), options),
    ).toThrow(AppError);
  });

  it('de-duplicates a repeated channel rather than listing a platform twice', () => {
    const input = campaignFormFrom(
      complete({ channels: ['instagram', 'instagram', 'linkedin'] }),
      options,
    );
    expect(input.channels).toEqual(['instagram', 'linkedin']);
  });

  it('writes both halves of the brief or neither', () => {
    expect(campaignFormFrom(complete({ briefEn: 'only english' }), options).brief).toEqual({
      ar: '',
      en: 'only english',
    });
    expect(campaignFormFrom(complete(), options).brief).toBeUndefined();
  });

  it('clears a description that arrives blank', () => {
    expect(campaignFormFrom(complete({ description: '   ' }), options).description).toBeNull();
  });
});

describe('P8: the status field exists only where the screen offers it', () => {
  const withStatus = { allowedChannels: PLATFORMS, withStatus: true };

  it('requires a status when the edit form is decoded', () => {
    expect(() => campaignFormFrom(complete(), withStatus)).toThrow(AppError);
    expect(campaignFormFrom(complete({ status: 'ACTIVE' }), withStatus).status).toBe('ACTIVE');
  });

  /*
   * ARCHIVING IS ITS OWN ACTION WITH ITS OWN AUDIT EVENT AND ITS OWN SOFT
   * DELETE. Accepting it as a dropdown value would give one state two doors
   * with two different behaviours behind them.
   */
  it('refuses ARCHIVED as a status a form may set', () => {
    expect(() => campaignFormFrom(complete({ status: 'ARCHIVED' }), withStatus)).toThrow(AppError);
    expect(CAMPAIGN_STATUSES).not.toContain('ARCHIVED');
  });

  it('refuses a status that is not a status', () => {
    expect(() => campaignFormFrom(complete({ status: 'ON_FIRE' }), withStatus)).toThrow(AppError);
  });
});

describe('P8: a stored brief is read defensively', () => {
  it('reads both locales when they are there', () => {
    expect(briefFrom({ ar: 'مرحبا', en: 'hello' })).toEqual({ ar: 'مرحبا', en: 'hello' });
  });

  /*
   * The column is `Json?`, so what comes back is whatever was written — by an
   * older shape, by a migration, by a hand-edited row. A reader that assumed
   * `{ar, en}` would throw while rendering a page.
   */
  it.each([null, undefined, 'a string', 42, [], { ar: 5 }])(
    'returns empty strings for %s rather than throwing',
    (value) => {
      expect(briefFrom(value)).toEqual({ ar: '', en: '' });
    },
  );

  it('keeps whichever half is a string', () => {
    expect(briefFrom({ en: 'hello', ar: null })).toEqual({ ar: '', en: 'hello' });
  });
});

describe('P8: the enums the screen offers are the enums the database has', () => {
  it('offers every objective the schema declares', () => {
    expect([...CAMPAIGN_OBJECTIVES]).toEqual([
      'AWARENESS',
      'ENGAGEMENT',
      'TRAFFIC',
      'LEADS',
      'RETENTION',
      'LAUNCH',
    ]);
  });
});
