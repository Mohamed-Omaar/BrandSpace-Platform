import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { messages } from '../../apps/dashboard/src/i18n/messages';
import {
  GAP_WEEKS,
  MIN_SLOTS,
  emptyWeekdays,
  gapWindow,
  weekdayName,
} from '../../apps/dashboard/src/server/calendar-gaps';

/**
 * PHASE 6 FINAL · D-277 §32, D-290 — THE CALENDAR.
 */

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

/** Every day of the window except the given weekdays, once per week. */
function everyDayBut(window: { start: string; end: string }, skip: readonly number[]): string[] {
  const keys: string[] = [];
  for (let ms = Date.parse(`${window.start}T00:00:00Z`); ; ms += 86_400_000) {
    const key = new Date(ms).toISOString().slice(0, 10);
    if (key >= window.end) break;
    if (!skip.includes(new Date(ms).getUTCDay())) keys.push(key);
  }
  return keys;
}

describe('D-290 · the window is whole weeks before the current one', () => {
  it('ends where this week starts, and spans GAP_WEEKS weeks', () => {
    // 2030-01-09 is a Wednesday; a Monday-start week began on 2030-01-07.
    const window = gapWindow('2030-01-09', 1);
    expect(window.end).toBe('2030-01-07');
    expect(window.start).toBe('2029-12-03');
    expect((Date.parse(window.end) - Date.parse(window.start)) / 86_400_000).toBe(GAP_WEEKS * 7);
  });

  it('on the first day of the week the whole current week is excluded', () => {
    expect(gapWindow('2030-01-06', 0).end).toBe('2030-01-06');
  });
});

describe('D-290 · a gap is said only when it means something', () => {
  const window = gapWindow('2030-01-09', 1);

  it('names the one weekday nothing went on', () => {
    expect(emptyWeekdays(everyDayBut(window, [2]), window)).toEqual([2]);
  });

  it('says nothing about a calendar that is too quiet', () => {
    const few = everyDayBut(window, [2]).slice(0, MIN_SLOTS - 1);
    expect(emptyWeekdays(few, window)).toEqual([]);
  });

  it('says nothing about a brand that simply does not post daily', () => {
    expect(emptyWeekdays(everyDayBut(window, [0, 2, 4]), window)).toEqual([]);
  });

  it('says nothing when every weekday was used, and ignores slots outside the window', () => {
    expect(emptyWeekdays(everyDayBut(window, []), window)).toEqual([]);
    const outside = ['2030-01-07', '2030-01-08', '2029-11-01'];
    expect(emptyWeekdays([...everyDayBut(window, [2]), ...outside], window)).toEqual([2]);
  });

  it('weekday names are the locale’s, Sunday first', () => {
    expect(weekdayName(2, 'en')).toBe('Tuesday');
    expect(weekdayName(0, 'en')).toBe('Sunday');
    expect(weekdayName(2, 'ar')).toBe('الثلاثاء');
  });
});

describe('D-290 · the screen', () => {
  const page = read('apps/dashboard/src/app/[locale]/calendar/page.tsx');
  const view = read('apps/dashboard/src/app/[locale]/calendar/calendar-view.tsx');
  const grid = read('packages/ui/src/calendar.tsx');

  it('the tray offers only posts without a live slot', () => {
    expect(page).toContain('unscheduledOnly: true');
    expect(page).toContain("statuses: ['DRAFT', 'APPROVED']");
    expect(read('packages/content/src/library.ts')).toMatch(
      /none: \{ status: \{ notIn: \['CANCELLED', 'PUBLISHED', 'FAILED'\] \} \}/,
    );
  });

  it('drag is never the only way: every tray row has a Schedule button', () => {
    expect(view).toContain('calendar-tray-schedule-');
    expect(grid).toContain('onDropDay');
  });

  it('the post opens in a side sheet with a real preview', () => {
    expect(view).toContain('SideSheet');
    expect(view).toContain('calendar-drawer-preview');
  });

  /*
   * G6 (prototype v94 Phase 2B-1, D-329) CHANGED THIS RULE, deliberately and on
   * the owner's instruction. It used to be "no best-time recommendation at all,
   * because nothing is measured". Now the country's CONFIGURED posting times are
   * offered — but never called a "best time", and a MEASURED best time, when
   * one exists, takes precedence over them. The precedence itself is pinned in
   * tests/unit/phase2b1-calendar-country-industry.test.ts.
   */
  it('offers configured times only as "Suggested time", never as a best time', () => {
    const wording = Object.entries({ ...messages.en, ...messages.ar })
      .filter(([key]) => key.startsWith('calendar.'))
      .map(([, value]) => String(value));
    for (const value of wording) expect(value).not.toMatch(/best[ -]?time|أفضل وقت/i);
    expect(messages.en['calendar.suggestedTime']).toBe('Suggested time');
    expect(messages.ar['calendar.suggestedTime']).toBe('وقت مقترح');
    expect(view).toContain("t['calendar.suggestedTime']");
    // The page asks for measured times FIRST; configured ones only fill in.
    expect(page).toContain('suggestedPostingTimes(calendarPolicy, { measured: [], country })');
  });

  it('the fix for an unreachable post is Publishing › Accounts, not a technical page', () => {
    expect(page).toContain('/publishing?tab=accounts');
  });

  it('every new calendar string exists in both languages', () => {
    for (const key of [
      'calendar.tray.title',
      'calendar.tray.empty',
      'calendar.tray.hint',
      'calendar.filter.brand',
      'calendar.filter.apply',
      'calendar.drawer.notes',
      'calendar.drawer.requestApproval',
      'calendar.gap.title',
      'calendar.gap.empty',
      'calendar.gap.ask',
    ] as const) {
      expect(messages.en[key], key).toBeTruthy();
      expect(messages.ar[key], key).toBeTruthy();
    }
  });
});
