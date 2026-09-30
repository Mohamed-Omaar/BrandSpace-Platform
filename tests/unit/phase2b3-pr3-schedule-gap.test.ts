import { describe, expect, it } from 'vitest';
import { instantForIntent } from '@brandspace/content';
import {
  SCHEDULE_GAP_SLOT_STATUSES,
  authorableConditionFieldsFor,
  conditionFieldsFor,
  findTrigger,
  isAuthorablePair,
  scheduleGapWindow,
  type LocalCalendarPort,
} from '@brandspace/automation';

/**
 * PHASE 2B-3 PR 3 — "NOTHING IS SCHEDULED FOR THE NEXT 3 DAYS".
 *
 * The window is the next three LOCAL days, starting tomorrow: local 00:00
 * tomorrow up to local 00:00 three days later, in the workspace's zone, through
 * the one zoned-time resolver — real local days, not 72 hours.
 */

const calendar: LocalCalendarPort = {
  localMidnight: (dayKey, timezone) => instantForIntent(`${dayKey}T00:00`, timezone),
};
const at = (iso: string) => new Date(iso);

describe('the window', () => {
  it('in UTC: tomorrow 00:00 up to three days later', () => {
    expect(
      scheduleGapWindow({ now: at('2026-10-10T15:00:00Z'), timezone: 'UTC', calendar }),
    ).toEqual({ from: at('2026-10-11T00:00:00Z'), to: at('2026-10-14T00:00:00Z') });
  });

  it('tomorrow is the workspace’s tomorrow, not UTC’s', () => {
    // 22:30 UTC on the 10th is already 01:30 on the 11th in Riyadh.
    expect(
      scheduleGapWindow({ now: at('2026-10-10T22:30:00Z'), timezone: 'Asia/Riyadh', calendar }),
    ).toEqual({ from: at('2026-10-11T21:00:00Z'), to: at('2026-10-14T21:00:00Z') });
  });

  it('three real local days across a daylight-saving change: 71 hours in spring, 73 in autumn', () => {
    const spring = scheduleGapWindow({
      now: at('2026-03-07T15:00:00Z'),
      timezone: 'America/New_York',
      calendar,
    })!;
    expect(spring.from).toEqual(at('2026-03-08T05:00:00Z'));
    expect((spring.to.getTime() - spring.from.getTime()) / 3_600_000).toBe(71);

    const autumn = scheduleGapWindow({
      now: at('2026-10-31T15:00:00Z'),
      timezone: 'America/New_York',
      calendar,
    })!;
    expect(autumn.from).toEqual(at('2026-11-01T04:00:00Z'));
    expect((autumn.to.getTime() - autumn.from.getTime()) / 3_600_000).toBe(73);
  });

  it('a calendar that cannot answer yields no window, so nothing is decided', () => {
    expect(
      scheduleGapWindow({
        now: at('2026-10-10T15:00:00Z'),
        timezone: 'UTC',
        calendar: { localMidnight: () => null },
      }),
    ).toBeNull();
  });
});

describe('the trigger, as approved', () => {
  it('counts planned and scheduled slots only', () => {
    expect(SCHEDULE_GAP_SLOT_STATUSES).toEqual(['PLANNED', 'SCHEDULED']);
  });

  it('ships with its producer: rule-addressed, no reference, no conditions, NOTIFY_PERSON', () => {
    expect(findTrigger('SCHEDULE_GAP')).toMatchObject({
      refType: null,
      contentItemVia: null,
      ruleAddressed: true,
      authorable: true,
    });
    expect(isAuthorablePair('SCHEDULE_GAP', 'NOTIFY_PERSON')).toBe(true);
    expect(conditionFieldsFor('SCHEDULE_GAP')).toEqual(['brand.id']);
    expect(authorableConditionFieldsFor('SCHEDULE_GAP')).toEqual([]);
  });
});
