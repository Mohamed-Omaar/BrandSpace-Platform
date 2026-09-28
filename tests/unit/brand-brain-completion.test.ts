import { describe, expect, it } from 'vitest';
import {
  AREA_DEFINITIONS,
  areaDefinition,
  computeAreaCompletion,
  computeBrandCompletion,
  questionsForBrand,
  type AreaCounts,
  type KeyQuestion,
} from '@brandspace/brand-brain';
import type { BrandKnowledgeArea } from '@brandspace/database';

/**
 * COMPLETENESS IS KEY QUESTIONS PER AREA (Q19, Phase 2C; D-357).
 *
 * This file used to pin the Phase 5 percentage — per-area `minimumItems`
 * ratios, a second-locale cap, a floored overall percent. Q19 replaced that
 * rule with "answered n of m" per area and NO percentage and NO overall score,
 * so those assertions were replaced by the ones below (owner decision Q19,
 * recorded in D-357). What they protected still holds, in the new terms:
 *
 *   - AN UPLOAD STILL MOVES NOTHING. A pending candidate answers no question;
 *     only a usable fact does.
 *   - NOTHING IS INFERRED. A question is answered exactly when a usable fact
 *     with ITS `itemKey` exists in ITS area — not a similar text, not another
 *     area, not an expired fact.
 */

const q = (key: string, itemKey = key): KeyQuestion => ({
  key,
  itemKey,
  prompt: { en: `Question ${key}?`, ar: `سؤال ${key}؟` },
});

function counts(
  over: Partial<Omit<AreaCounts, 'answeredKeys'>> & {
    area: BrandKnowledgeArea;
    answered?: readonly string[];
  },
): AreaCounts {
  const { answered, ...rest } = over;
  return {
    usableItems: answered?.length ?? 0,
    staleItems: 0,
    expiredItems: 0,
    conflictedItems: 0,
    pendingCandidates: 0,
    answeredKeys: new Set(answered ?? []),
    ...rest,
  };
}

describe('one area', () => {
  const questions = [
    q('what', 'offers.what'),
    q('prices', 'offers.prices'),
    q('hours', 'offers.hours'),
  ];

  it('with nothing in it is EMPTY and answers nothing', () => {
    const result = computeAreaCompletion(counts({ area: 'OFFERS' }), questions);
    expect(result.status).toBe('EMPTY');
    expect([result.answered, result.total]).toEqual([0, 3]);
  });

  it('counts a question as answered only by a usable fact with its own itemKey', () => {
    const result = computeAreaCompletion(
      counts({ area: 'OFFERS', answered: ['offers.what', 'offers.something-else'] }),
      questions,
    );
    expect([result.answered, result.total]).toEqual([1, 3]);
    expect(result.questions.map((question) => question.answered)).toEqual([true, false, false]);
    expect(result.status).toBe('IN_PROGRESS');
    expect(result.attention).toContain('unanswered_questions');
  });

  it('a pending candidate answers nothing — an upload moves no count', () => {
    const result = computeAreaCompletion(
      counts({ area: 'OFFERS', pendingCandidates: 20 }),
      questions,
    );
    expect(result.answered).toBe(0);
    expect(result.status).toBe('IN_PROGRESS');
    expect(result.attention).toContain('pending_review');
  });

  it('every question answered and nothing waiting is COMPLETE', () => {
    const result = computeAreaCompletion(
      counts({ area: 'OFFERS', answered: ['offers.what', 'offers.prices', 'offers.hours'] }),
      questions,
    );
    expect(result.status).toBe('COMPLETE');
    expect(result.attention).toEqual([]);
  });

  it('every question answered but something waiting on a person NEEDS ATTENTION', () => {
    for (const waiting of [
      { staleItems: 1, reason: 'stale_items' },
      { expiredItems: 1, reason: 'expired_items' },
      { conflictedItems: 1, reason: 'unresolved_conflict' },
      { pendingCandidates: 1, reason: 'pending_review' },
    ] as const) {
      const { reason, ...extra } = waiting;
      const result = computeAreaCompletion(
        counts({
          area: 'OFFERS',
          answered: ['offers.what', 'offers.prices', 'offers.hours'],
          ...extra,
        }),
        questions,
      );
      expect(result.status, reason).toBe('NEEDS_ATTENTION');
      expect(result.attention).toContain(reason);
    }
  });

  it('an area with no configured questions is COMPLETE once it holds a usable fact', () => {
    expect(computeAreaCompletion(counts({ area: 'LEARNINGS' }), []).status).toBe('EMPTY');
    const result = computeAreaCompletion(counts({ area: 'LEARNINGS', answered: ['x'] }), []);
    expect([result.answered, result.total, result.status]).toEqual([0, 0, 'COMPLETE']);
  });

  it('reports no percentage and no ratio of any kind', () => {
    const result = computeAreaCompletion(
      counts({ area: 'OFFERS', answered: ['offers.what'] }),
      questions,
    );
    expect(Object.keys(result)).not.toContain('ratioMilli');
    expect(Object.keys(result)).not.toContain('percent');
  });
});

describe('the whole brand', () => {
  const byArea = new Map<BrandKnowledgeArea, readonly KeyQuestion[]>([
    ['IDENTITY', [q('what', 'identity.what'), q('who', 'identity.who')]],
    ['OFFERS', [q('what', 'offers.what')]],
  ]);

  it('reports every area, whatever the database holds', () => {
    expect(computeBrandCompletion([], byArea).areas).toHaveLength(AREA_DEFINITIONS.length);
  });

  it('carries NO overall score', () => {
    const result = computeBrandCompletion([], byArea);
    expect(Object.keys(result)).not.toContain('percent');
  });

  it("lists what's missing in area order, then question order", () => {
    const result = computeBrandCompletion(
      [counts({ area: 'IDENTITY', answered: ['identity.who'] })],
      byArea,
    );
    expect(result.missing.map((entry) => `${entry.area}:${entry.question.itemKey}`)).toEqual([
      'IDENTITY:identity.what',
      'OFFERS:offers.what',
    ]);
  });

  it('lists the areas with work waiting on a person, never merely unanswered ones', () => {
    const result = computeBrandCompletion(
      [
        counts({ area: 'OFFERS', answered: ['offers.what'], staleItems: 1 }),
        counts({ area: 'IDENTITY' }),
      ],
      byArea,
    );
    expect(result.areasNeedingAttention).toEqual(['OFFERS']);
  });

  it('totals usable facts and pending candidates honestly, and is deterministic', () => {
    const input = [
      counts({ area: 'IDENTITY', answered: ['a', 'b'], pendingCandidates: 3 }),
      counts({ area: 'OFFERS', answered: ['c'], pendingCandidates: 2 }),
    ];
    const result = computeBrandCompletion(input, byArea);
    expect(result.totalUsableItems).toBe(3);
    expect(result.totalPendingCandidates).toBe(5);
    expect(computeBrandCompletion(input, byArea)).toEqual(result);
  });
});

describe('the questions a brand is asked', () => {
  const config = {
    areas: { OFFERS: [q('general', 'offers.general')], IDENTITY: [q('what', 'identity.what')] },
    offersSets: { food: [q('menu', 'offers.menu'), q('hours', 'offers.hours')] },
  };

  it("uses the industry's Offers set when the configuration has it", () => {
    const questions = questionsForBrand(config, 'food');
    expect(questions.get('OFFERS')?.map((question) => question.itemKey)).toEqual([
      'offers.menu',
      'offers.hours',
    ]);
    expect(questions.get('IDENTITY')?.map((question) => question.itemKey)).toEqual([
      'identity.what',
    ]);
  });

  it('falls back to the general Offers list — never an invented one — without a known set', () => {
    for (const set of [null, 'no-such-set']) {
      expect(
        questionsForBrand(config, set)
          .get('OFFERS')
          ?.map((x) => x.itemKey),
      ).toEqual(['offers.general']);
    }
  });

  it('gives every area a list, empty where nothing is configured', () => {
    const questions = questionsForBrand({ areas: {}, offersSets: {} }, null);
    expect([...questions.keys()]).toEqual(AREA_DEFINITIONS.map((d) => d.area));
    for (const list of questions.values()) expect(list).toEqual([]);
  });
});

describe('the area table itself', () => {
  it('defines every area exactly once', () => {
    const areas = AREA_DEFINITIONS.map((d) => d.area);
    expect(new Set(areas).size).toBe(areas.length);
  });

  it('gives every area a resolvable definition', () => {
    for (const definition of AREA_DEFINITIONS) {
      expect(areaDefinition(definition.area)).toBe(definition);
    }
  });

  it('throws rather than silently skipping an unknown area', () => {
    // The enum and this table are two lists that can drift. A missing
    // definition must be loud, or the area quietly stops counting.
    expect(() => areaDefinition('NOT_AN_AREA' as never)).toThrow(/AreaDefinition/);
  });
});
