import { describe, expect, it } from 'vitest';
import { instantForIntent } from '@brandspace/content';
import {
  BOUNDARY_CAMPAIGN_STATUSES,
  campaignBoundary,
  conditionFieldsFor,
  authorableConditionFieldsFor,
  CONDITION_FIELD_CONTRACTS,
  findTrigger,
  isAuthorablePair,
  type LocalCalendarPort,
} from '@brandspace/automation';

/**
 * PHASE 2B-3 PR 3 — WHEN A CAMPAIGN STARTS AND ENDS.
 *
 * A campaign's dates are calendar days. It starts at local 00:00 of its start
 * date and ends at local 00:00 of the day AFTER its end date (the end date is
 * its last day, inclusive), in the workspace's zone, through the platform's
 * one zoned-time resolver.
 */

const calendar: LocalCalendarPort = {
  localMidnight: (dayKey, timezone) => instantForIntent(`${dayKey}T00:00`, timezone),
};
const at = (iso: string) => new Date(iso);

describe('the boundary instant', () => {
  it('starts at local midnight of the start date', () => {
    expect(
      campaignBoundary({
        kind: 'CAMPAIGN_STARTED',
        dayKey: '2026-10-10',
        timezone: 'UTC',
        calendar,
      }),
    ).toEqual(at('2026-10-10T00:00:00Z'));
    expect(
      campaignBoundary({
        kind: 'CAMPAIGN_STARTED',
        dayKey: '2026-10-10',
        timezone: 'Asia/Riyadh',
        calendar,
      }),
    ).toEqual(at('2026-10-09T21:00:00Z'));
  });

  it('ends at local midnight of the day after the end date, across a month and a year', () => {
    expect(
      campaignBoundary({ kind: 'CAMPAIGN_ENDED', dayKey: '2026-10-31', timezone: 'UTC', calendar }),
    ).toEqual(at('2026-11-01T00:00:00Z'));
    expect(
      campaignBoundary({
        kind: 'CAMPAIGN_ENDED',
        dayKey: '2026-12-31',
        timezone: 'America/New_York',
        calendar,
      }),
    ).toEqual(at('2027-01-01T05:00:00Z'));
  });

  it('a midnight lost to daylight saving is the first instant of that day', () => {
    // America/Santiago springs forward at 00:00 on 2026-09-06: 00:00 → 01:00.
    const boundary = campaignBoundary({
      kind: 'CAMPAIGN_STARTED',
      dayKey: '2026-09-06',
      timezone: 'America/Santiago',
      calendar,
    });
    expect(boundary).toEqual(at('2026-09-06T04:00:00Z'));
  });

  it('either side of a daylight-saving change the offset is that day’s own', () => {
    // New York: EDT (−4) on 2026-11-01 at 00:00, EST (−5) from 02:00.
    expect(
      campaignBoundary({
        kind: 'CAMPAIGN_STARTED',
        dayKey: '2026-11-01',
        timezone: 'America/New_York',
        calendar,
      }),
    ).toEqual(at('2026-11-01T04:00:00Z'));
    expect(
      campaignBoundary({
        kind: 'CAMPAIGN_STARTED',
        dayKey: '2026-11-02',
        timezone: 'America/New_York',
        calendar,
      }),
    ).toEqual(at('2026-11-02T05:00:00Z'));
  });
});

describe('what the triggers are, as the owner decided (E)', () => {
  it('eligible statuses: planned, active, paused, completed', () => {
    expect(BOUNDARY_CAMPAIGN_STATUSES).toEqual(['PLANNED', 'ACTIVE', 'PAUSED', 'COMPLETED']);
  });

  it('both ship with their producer: rule-addressed, the campaign as reference, authorable', () => {
    for (const type of ['CAMPAIGN_STARTED', 'CAMPAIGN_ENDED'] as const) {
      expect(findTrigger(type)).toMatchObject({
        refType: 'Campaign',
        contentItemVia: null,
        ruleAddressed: true,
        authorable: true,
      });
      expect(isAuthorablePair(type, 'NOTIFY_PERSON')).toBe(true);
      expect(conditionFieldsFor(type)).toEqual(['brand.id', 'campaign.id']);
      expect(authorableConditionFieldsFor(type)).toEqual(['campaign.id']);
    }
  });

  it('campaign.id is chosen from the brand’s campaigns', () => {
    expect(CONDITION_FIELD_CONTRACTS['campaign.id']).toMatchObject({
      kind: 'string',
      options: null,
      catalogue: 'campaigns',
    });
  });
});
