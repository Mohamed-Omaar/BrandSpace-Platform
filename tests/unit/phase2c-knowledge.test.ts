import { describe, expect, it } from 'vitest';
import { defaultPayload, parseConfigPayload } from '@brandspace/config';
import {
  brandBrainPolicyFrom,
  calendarDate,
  confidenceExplanation,
  confidenceLabel,
  isExpired,
  knowledgeAsOf,
  localDateIn,
  parseValidUntil,
  usableKnowledgeWhere,
} from '@brandspace/brand-brain';

/**
 * PHASE 2C, ITEM 2 — the pure rules behind "valid until" (D6), the review
 * inbox's confidence (D4) and the key-questions configuration (Q19).
 */

describe('D6 — "valid until" is a WORKSPACE-LOCAL calendar day', () => {
  it('is valid through the whole of its last day and expired from the next local midnight', () => {
    const lastDay = calendarDate('2026-10-30');
    // Riyadh (UTC+3): 23:59 local on the 30th is 20:59Z; 00:00 local on the 31st is 21:00Z on the 30th.
    const lastMinute = knowledgeAsOf('Asia/Riyadh', new Date('2026-10-30T20:59:00Z'));
    const nextMidnight = knowledgeAsOf('Asia/Riyadh', new Date('2026-10-30T21:00:00Z'));
    expect(isExpired(lastDay, lastMinute)).toBe(false);
    expect(isExpired(lastDay, nextMidnight)).toBe(true);
  });

  it('west of UTC, the same instant can still be the last day', () => {
    const lastDay = calendarDate('2026-10-30');
    // 03:00Z on the 31st is still 23:00 on the 30th in New York (UTC-4 in October).
    const instant = new Date('2026-10-31T03:00:00Z');
    expect(localDateIn(instant, 'America/New_York')).toBe('2026-10-30');
    expect(isExpired(lastDay, knowledgeAsOf('America/New_York', instant))).toBe(false);
    expect(isExpired(lastDay, knowledgeAsOf('UTC', instant))).toBe(true);
  });

  it('follows a daylight-saving change without moving the day', () => {
    // Europe/London leaves BST on 2026-10-25 at 01:00Z.
    expect(localDateIn(new Date('2026-10-24T23:30:00Z'), 'Europe/London')).toBe('2026-10-25');
    expect(localDateIn(new Date('2026-10-25T23:30:00Z'), 'Europe/London')).toBe('2026-10-25');
  });

  it('no end date never expires', () => {
    expect(isExpired(null, calendarDate('2099-12-31'))).toBe(false);
  });

  it('accepts only real calendar days, and empty means "no end date"', () => {
    expect(parseValidUntil('')).toBeNull();
    expect(parseValidUntil('  ')).toBeNull();
    expect(parseValidUntil('2026-02-28')?.toISOString()).toBe('2026-02-28T00:00:00.000Z');
    expect(() => parseValidUntil('2026-02-31')).toThrow();
    expect(() => parseValidUntil('31/12/2026')).toThrow();
  });

  it('the usable-fact rule excludes a day before today and keeps today', () => {
    const asOf = calendarDate('2026-10-30');
    expect(usableKnowledgeWhere(asOf)).toEqual({
      status: { in: ['ACTIVE', 'STALE'] },
      OR: [{ validUntil: null }, { validUntil: { gte: asOf } }],
    });
  });
});

describe('D4 — confidence in words', () => {
  const policy = { highMilli: 850, mediumMilli: 700 };

  it('labels High ≥ 85, Medium 70–84, Low < 70 at the owner thresholds', () => {
    expect(confidenceLabel(850, policy)).toBe('high');
    expect(confidenceLabel(849, policy)).toBe('medium');
    expect(confidenceLabel(700, policy)).toBe('medium');
    expect(confidenceLabel(699, policy)).toBe('low');
  });

  it('explains from what was RECORDED, and says so when nothing was', () => {
    expect(
      confidenceExplanation({
        sourceKind: 'DOCUMENT',
        evidence: [{ quote: 'x', method: 'keyword', keywordHits: 2, aimedArea: true }],
      }),
    ).toEqual({ reason: 'keywords_aimed', keywordHits: 2 });
    expect(
      confidenceExplanation({
        sourceKind: 'DOCUMENT',
        evidence: [{ quote: 'x', method: 'keyword', keywordHits: 1, aimedArea: false }],
      }),
    ).toEqual({ reason: 'keywords', keywordHits: 1 });
    expect(
      confidenceExplanation({
        sourceKind: 'DOCUMENT',
        evidence: [{ quote: 'x', method: 'keyword', keywordHits: 0, aimedArea: true }],
      }),
    ).toEqual({ reason: 'aimed_only', keywordHits: 0 });
    expect(confidenceExplanation({ sourceKind: 'DOCUMENT', evidence: [{ quote: 'x' }] })).toEqual({
      reason: 'unrecorded',
      keywordHits: null,
    });
    expect(confidenceExplanation({ sourceKind: 'ANALYTICS', evidence: [] }).reason).toBe(
      'analytics',
    );
  });
});

describe('the configuration', () => {
  it('defaults the review thresholds to the owner values and hands them to the services', () => {
    const policy = brandBrainPolicyFrom(defaultPayload('brand-brain'));
    expect(policy.review).toEqual({ highMilli: 850, mediumMilli: 700, confidentAcceptMilli: 850 });
  });

  it('refuses Medium above High', () => {
    expect(() =>
      parseConfigPayload('brand-brain', { review: { highMilli: 700, mediumMilli: 800 } }),
    ).toThrow();
  });

  it('refuses two questions answered by the same fact in one list', () => {
    const question = (key: string) => ({
      key,
      itemKey: 'offers.what',
      prompt: { en: 'What do you sell?', ar: 'ماذا تبيع؟' },
    });
    expect(() =>
      parseConfigPayload('brand-brain', {
        questions: { areas: { OFFERS: [question('a'), question('b')] } },
      }),
    ).toThrow();
  });

  it('refuses a question without both languages', () => {
    expect(() =>
      parseConfigPayload('brand-brain', {
        questions: {
          areas: { OFFERS: [{ key: 'a', itemKey: 'offers.a', prompt: { en: 'What?', ar: '' } }] },
        },
      }),
    ).toThrow();
  });
});
