import { describe, expect, it } from 'vitest';
import { instantForIntent } from '@brandspace/content';
import { knowledgeAsOfSafe, usableKnowledgeWhere } from '@brandspace/brand-brain';
import {
  authorableConditionFieldsFor,
  conditionFieldsFor,
  expiringFactsWhere,
  factWindowOpens,
  findTrigger,
  isAuthorablePair,
  type KnowledgeValidityPort,
  type LocalCalendarPort,
} from '@brandspace/automation';

/**
 * PHASE 2B-3 PR 3 — "A BRAND BRAIN FACT EXPIRES WITHIN 7 DAYS".
 *
 * A fact is expiring while its last valid day is today to today + 6, local
 * calendar days, and it is usable by Brand Brain's own rule (owner decision F).
 * It enters that window at local 00:00 on `validUntil − 6`.
 */

const calendar: LocalCalendarPort = {
  localMidnight: (dayKey, timezone) => instantForIntent(`${dayKey}T00:00`, timezone),
};
const knowledge: KnowledgeValidityPort = {
  asOf: knowledgeAsOfSafe,
  usableWhere: usableKnowledgeWhere,
};
const at = (iso: string) => new Date(iso);

describe('when a fact enters its last seven days', () => {
  it('local 00:00 six days before its last day', () => {
    expect(factWindowOpens({ validUntil: '2026-10-16', timezone: 'UTC', calendar })).toEqual(
      at('2026-10-10T00:00:00Z'),
    );
    expect(
      factWindowOpens({ validUntil: '2026-10-16', timezone: 'Asia/Riyadh', calendar }),
    ).toEqual(at('2026-10-09T21:00:00Z'));
  });

  it('across a month end and a daylight-saving change, by calendar days', () => {
    expect(factWindowOpens({ validUntil: '2026-11-03', timezone: 'UTC', calendar })).toEqual(
      at('2026-10-28T00:00:00Z'),
    );
    // New York: 2026-11-01 is EDT at midnight, so the window opens at 04:00Z.
    expect(
      factWindowOpens({ validUntil: '2026-11-07', timezone: 'America/New_York', calendar }),
    ).toEqual(at('2026-11-01T04:00:00Z'));
  });
});

describe('which facts are expiring', () => {
  it('Brand Brain’s own usable rule, and a last day from today to today + 6', () => {
    const asOf = knowledge.asOf('UTC', at('2026-10-10T15:00:00Z'));
    expect(expiringFactsWhere({ workspaceId: 'w', brandId: 'b', asOf, knowledge })).toEqual({
      workspaceId: 'w',
      brandId: 'b',
      AND: [
        usableKnowledgeWhere(asOf),
        { validUntil: { gte: at('2026-10-10T00:00:00Z'), lte: at('2026-10-16T00:00:00Z') } },
      ],
    });
  });

  it('today is the workspace’s day', () => {
    const asOf = knowledge.asOf('Asia/Riyadh', at('2026-10-10T22:30:00Z'));
    expect(asOf).toEqual(at('2026-10-11T00:00:00Z'));
  });
});

describe('the trigger, as approved', () => {
  it('ships with its producer: rule-addressed, the fact as reference, no conditions', () => {
    expect(findTrigger('FACT_EXPIRING')).toMatchObject({
      refType: 'BrandKnowledgeItem',
      contentItemVia: null,
      ruleAddressed: true,
      authorable: true,
    });
    expect(isAuthorablePair('FACT_EXPIRING', 'NOTIFY_PERSON')).toBe(true);
    expect(conditionFieldsFor('FACT_EXPIRING')).toEqual(['brand.id']);
    expect(authorableConditionFieldsFor('FACT_EXPIRING')).toEqual([]);
  });
});
