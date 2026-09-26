import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EGYPT_CITY_CODES, isEgyptCityCode } from '@brandspace/shared';
import { generalSettingsFrom } from '../../apps/dashboard/src/server/general-settings';
import { weekdayNames } from '../../apps/dashboard/src/server/save-bar-labels';
import { optionalMessage } from '../../apps/dashboard/src/i18n/messages';

/**
 * A9 / G1 (prototype v94 Phase 2B-1, D-330) — Settings → General and the save
 * bar, as rules. The database half is `tests/isolation/phase2b1-general-settings`;
 * the bar's clean/dirty behaviour in a browser is the Phase 2B-1 E2E spec.
 */

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const VALID = {
  name: 'Cairo Bakery',
  defaultLocale: 'EN',
  country: 'eg',
  timezone: 'Africa/Cairo',
  city: 'EG-ALX',
  weekStartsOn: '6',
};

describe('A9 · what General accepts', () => {
  it('reads a valid form, upper-casing the country', () => {
    expect(generalSettingsFrom(form(VALID))).toEqual({
      name: 'Cairo Bakery',
      defaultLocale: 'EN',
      country: 'EG',
      timezone: 'Africa/Cairo',
      city: 'EG-ALX',
      weekStartsOn: 6,
      brand: null,
    });
  });

  it('refuses a time zone the runtime does not know, and a country that is not one', () => {
    expect(() => generalSettingsFrom(form({ ...VALID, timezone: 'Mars/Olympus' }))).toThrow();
    expect(() => generalSettingsFrom(form({ ...VALID, timezone: '' }))).toThrow();
    expect(() => generalSettingsFrom(form({ ...VALID, country: 'XX' }))).toThrow();
  });

  it('keeps a city for Egypt only, and refuses one that is not a governorate', () => {
    expect(
      generalSettingsFrom(form({ ...VALID, country: 'AE', timezone: 'Asia/Dubai' })).city,
    ).toBeNull();
    expect(generalSettingsFrom(form({ ...VALID, city: '' })).city).toBeNull();
    expect(() => generalSettingsFrom(form({ ...VALID, city: 'Cairo' }))).toThrow();
  });

  it('accepts a weekday 0–6 and nothing else', () => {
    for (const bad of ['7', '-1', '1.5', 'monday']) {
      expect(() => generalSettingsFrom(form({ ...VALID, weekStartsOn: bad }))).toThrow();
    }
    expect(generalSettingsFrom(form({ ...VALID, weekStartsOn: '0' })).weekStartsOn).toBe(0);
  });

  it('refuses a missing field rather than guessing it', () => {
    const { timezone: _dropped, ...rest } = VALID;
    expect(() => generalSettingsFrom(form(rest))).toThrow();
  });

  it("carries the brand's industry and an http(s) website only when the form did", () => {
    const withBrand = generalSettingsFrom(
      form({ ...VALID, brandId: 'b1', industry: ' food ', websiteUrl: 'https://x.example' }),
    );
    expect(withBrand.brand).toEqual({
      brandId: 'b1',
      industry: 'food',
      websiteUrl: 'https://x.example',
    });
    expect(() =>
      generalSettingsFrom(
        form({ ...VALID, brandId: 'b1', industry: '', websiteUrl: 'javascript:alert(1)' }),
      ),
    ).toThrow();
  });
});

describe("A9 · Egypt's cities and the week's days", () => {
  it('lists the 27 governorates, each named in both languages', () => {
    expect(EGYPT_CITY_CODES).toHaveLength(27);
    expect(new Set(EGYPT_CITY_CODES).size).toBe(27);
    for (const code of EGYPT_CITY_CODES) {
      expect(code).toMatch(/^EG-[A-Z]{1,3}$/);
      expect(optionalMessage('en', `geo.city.${code}`), code).toBeTruthy();
      expect(optionalMessage('ar', `geo.city.${code}`), code).toMatch(/[؀-ۿ]/);
    }
    expect(isEgyptCityCode('EG-C')).toBe(true);
    expect(isEgyptCityCode('SA-01')).toBe(false);
  });

  it('names the weekdays from Sunday, in the reader’s language', () => {
    expect(weekdayNames('en')).toEqual([
      'Sunday',
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
    ]);
    expect(weekdayNames('ar')[0]).toMatch(/[؀-ۿ]/);
  });
});

describe('G1 · the save bar on every draftable Settings tab', () => {
  const bar = read('packages/ui/src/save-bar.tsx');

  it('clean says "All changes saved" with Save disabled; dirty offers Cancel and Save', () => {
    expect(bar).toContain('disabled={!dirty}');
    expect(bar).toMatch(/dirty \? labels\.unsaved : labels\.saved/);
    expect(bar).toMatch(/\{dirty \? \(\s*<button\s+type="button"\s+onClick=\{onCancel\}/);
    expect(optionalMessage('en', 'saveBar.saved')).toBe('All changes saved');
    expect(optionalMessage('en', 'saveBar.unsaved')).toBe('Unsaved changes');
    expect(optionalMessage('ar', 'saveBar.saved')).toMatch(/[؀-ۿ]/);
  });

  it('General and Approvals post through a DraftForm keyed on the saved values', () => {
    const general = read('apps/dashboard/src/app/[locale]/settings/page.tsx');
    expect(general).toMatch(/<DraftForm\s+key=\{JSON\.stringify\(saved\)\}/);
    expect(general).toContain('saveTestId="settings-save"');
    const approvals = read('apps/dashboard/src/app/[locale]/settings/approvals/page.tsx');
    expect(approvals).toMatch(/<DraftForm\s+key=/);
    expect(approvals).toContain('saveTestId={`policy-save-${policy.brandId}`}');
  });

  it('every General field says underneath what it changes', () => {
    const fields = read('apps/dashboard/src/app/[locale]/settings/general-fields.tsx');
    for (const hint of [
      'nameHint',
      'localeHint',
      'countryHint',
      'timezoneHint',
      'cityHint',
      'weekStartHint',
      'industryHint',
      'websiteHint',
    ]) {
      expect(fields, hint).toContain(`labels.${hint}`);
    }
  });

  it('a country typed over is judged against the last one CHOSEN, in both forms', () => {
    // Typing clears the picker's value first; comparing the new country with that
    // blank would keep the old country's zone as though somebody had chosen it.
    for (const file of [
      'apps/dashboard/src/app/[locale]/settings/general-fields.tsx',
      'apps/dashboard/src/app/[locale]/onboarding/workspace/form.tsx',
    ]) {
      const source = read(file);
      expect(source, file).toContain('previousCountry: lastCountry,');
      expect(source, file).toMatch(/setCountry\(next\);\s+if \(next === ''\) return;/);
    }
  });

  it('the calendar starts its week on the workspace’s own day, else the configured one', () => {
    const calendar = read('apps/dashboard/src/app/[locale]/calendar/page.tsx');
    expect(calendar).toContain(
      'const weekStartsOn = workspaceRow?.weekStartsOn ?? policy.calendar.weekStartsOn;',
    );
    expect(calendar).not.toMatch(/gapWindow\([^)]*policy\.calendar\.weekStartsOn/);
  });
});
