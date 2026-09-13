import { describe, expect, it } from 'vitest';
import {
  AREA_DEFINITIONS,
  areaDefinition,
  computeAreaCompletion,
  computeBrandCompletion,
  type AreaCounts,
} from '@brandspace/brand-brain';

/**
 * Completion — the number that replaces the demo's hard-coded 82%.
 *
 * A percentage a customer reads as progress has to be defensible, so every rule
 * in `completion.ts` gets an assertion that fails if the rule is weakened. The
 * two that matter most:
 *
 *   - AN UPLOAD MUST NOT MOVE THE NUMBER. Only ACTIVE items count, so a
 *     document that produced twenty candidates scores zero until a human
 *     accepts them. Otherwise "82%" would mean "we read some files".
 *   - ONE ITEM SHORT MUST NOT READ 100%. Flooring is what guarantees it.
 */

function counts(over: Partial<AreaCounts> & { area: AreaCounts['area'] }): AreaCounts {
  return {
    activeItems: 0,
    bilingualActiveItems: 0,
    staleItems: 0,
    conflictedItems: 0,
    pendingCandidates: 0,
    ...over,
  };
}

describe('an area with nothing in it', () => {
  it('is EMPTY and contributes zero', () => {
    const result = computeAreaCompletion(counts({ area: 'IDENTITY' }));
    expect(result.status).toBe('EMPTY');
    expect(result.ratioMilli).toBe(0);
  });
});

describe('pending candidates are not knowledge', () => {
  it('an area with only pending candidates is IN_PROGRESS, not complete', () => {
    const result = computeAreaCompletion(counts({ area: 'IDENTITY', pendingCandidates: 20 }));
    expect(result.status).toBe('IN_PROGRESS');
    expect(result.ratioMilli).toBe(0);
    expect(result.attention).toContain('pending_review');
  });

  it('AN UPLOAD ALONE NEVER MOVES OVERALL COMPLETION', () => {
    // The rule the brief calls out by name: completion must follow approved
    // knowledge, not the fact that a file was processed.
    const withCandidates = computeBrandCompletion(
      AREA_DEFINITIONS.map((d) => counts({ area: d.area, pendingCandidates: 10 })),
    );
    expect(withCandidates.percent).toBe(0);
    expect(withCandidates.totalPendingCandidates).toBe(AREA_DEFINITIONS.length * 10);
  });
});

describe('an area meeting its requirement', () => {
  it('is COMPLETE at exactly the minimum', () => {
    const required = areaDefinition('OFFERS').minimumItems;
    const result = computeAreaCompletion(counts({ area: 'OFFERS', activeItems: required }));
    expect(result.status).toBe('COMPLETE');
    expect(result.ratioMilli).toBe(1000);
  });

  it('is IN_PROGRESS one item short', () => {
    const required = areaDefinition('IDENTITY').minimumItems;
    const result = computeAreaCompletion(counts({ area: 'IDENTITY', activeItems: required - 1 }));
    expect(result.status).toBe('IN_PROGRESS');
    expect(result.attention).toContain('missing_items');
    expect(result.ratioMilli).toBeLessThan(1000);
  });

  it('caps the ratio at 1 — extra items do not earn more than complete', () => {
    const required = areaDefinition('OFFERS').minimumItems;
    const result = computeAreaCompletion(counts({ area: 'OFFERS', activeItems: required * 50 }));
    expect(result.ratioMilli).toBe(1000);
  });
});

describe('bilingual areas', () => {
  it('TONE_OF_VOICE is not complete without both locales', () => {
    // A tone of voice recorded only in English cannot ground Arabic
    // generation, which is the failure a bilingual product must not hide.
    const required = areaDefinition('TONE_OF_VOICE').minimumItems;
    const result = computeAreaCompletion(
      counts({ area: 'TONE_OF_VOICE', activeItems: required, bilingualActiveItems: 0 }),
    );
    expect(result.status).toBe('IN_PROGRESS');
    expect(result.attention).toContain('missing_second_locale');
  });

  it('caps the RATIO too, so it cannot read 100% while unusable in Arabic', () => {
    const required = areaDefinition('TONE_OF_VOICE').minimumItems;
    const result = computeAreaCompletion(
      counts({ area: 'TONE_OF_VOICE', activeItems: required * 10, bilingualActiveItems: 0 }),
    );
    expect(result.ratioMilli).toBeLessThan(1000);
  });

  it('is COMPLETE once one item carries both locales', () => {
    const required = areaDefinition('TONE_OF_VOICE').minimumItems;
    const result = computeAreaCompletion(
      counts({ area: 'TONE_OF_VOICE', activeItems: required, bilingualActiveItems: 1 }),
    );
    expect(result.status).toBe('COMPLETE');
    expect(result.ratioMilli).toBe(1000);
  });

  it('does not require a second locale for areas that do not need one', () => {
    const required = areaDefinition('IDENTITY').minimumItems;
    const result = computeAreaCompletion(
      counts({ area: 'IDENTITY', activeItems: required, bilingualActiveItems: 0 }),
    );
    expect(result.status).toBe('COMPLETE');
  });
});

describe('NEEDS_ATTENTION is distinct from incomplete', () => {
  it('a complete area with stale items needs attention', () => {
    const required = areaDefinition('OFFERS').minimumItems;
    const result = computeAreaCompletion(
      counts({ area: 'OFFERS', activeItems: required, staleItems: 1 }),
    );
    expect(result.status).toBe('NEEDS_ATTENTION');
    expect(result.attention).toContain('stale_items');
  });

  it('a complete area with an unresolved conflict needs attention', () => {
    const required = areaDefinition('OFFERS').minimumItems;
    const result = computeAreaCompletion(
      counts({ area: 'OFFERS', activeItems: required, conflictedItems: 1 }),
    );
    expect(result.status).toBe('NEEDS_ATTENTION');
    expect(result.attention).toContain('unresolved_conflict');
  });

  it('stale items still COUNT toward completion — they are unconfirmed, not absent', () => {
    const required = areaDefinition('OFFERS').minimumItems;
    const result = computeAreaCompletion(
      counts({ area: 'OFFERS', activeItems: required, staleItems: required }),
    );
    expect(result.ratioMilli).toBe(1000);
  });
});

describe('overall completion', () => {
  it('is 0 for a brand with nothing', () => {
    expect(computeBrandCompletion([]).percent).toBe(0);
  });

  it('reports every area even when the input mentions none', () => {
    // Ten cards render whatever the database holds.
    const result = computeBrandCompletion([]);
    expect(result.areas).toHaveLength(AREA_DEFINITIONS.length);
  });

  it('is 100 only when every counted area is complete', () => {
    const full = AREA_DEFINITIONS.map((d) =>
      counts({
        area: d.area,
        activeItems: Math.max(d.minimumItems, 1),
        bilingualActiveItems: Math.max(d.minimumItems, 1),
      }),
    );
    expect(computeBrandCompletion(full).percent).toBe(100);
  });

  it('IS NOT 100 when a single counted area is one item short', () => {
    const full = AREA_DEFINITIONS.map((d) =>
      counts({
        area: d.area,
        activeItems: d.area === 'IDENTITY' ? d.minimumItems - 1 : Math.max(d.minimumItems, 1),
        bilingualActiveItems: Math.max(d.minimumItems, 1),
      }),
    );
    expect(computeBrandCompletion(full).percent).toBeLessThan(100);
  });

  it('EXCLUDES learnings, so a new brand can still reach 100%', () => {
    /*
     * LEARNINGS is written back by the system from performance evidence
     * (D-64). Counting it would mean a customer who did everything asked of
     * them is permanently short of 100% through no fault of their own.
     */
    expect(areaDefinition('LEARNINGS').countsTowardCompletion).toBe(false);
    const everythingButLearnings = AREA_DEFINITIONS.filter((d) => d.area !== 'LEARNINGS').map((d) =>
      counts({
        area: d.area,
        activeItems: Math.max(d.minimumItems, 1),
        bilingualActiveItems: Math.max(d.minimumItems, 1),
      }),
    );
    expect(computeBrandCompletion(everythingButLearnings).percent).toBe(100);
  });

  it('FLOORS rather than rounds, so "nearly everything" never reads 100', () => {
    const nearlyAll = AREA_DEFINITIONS.map((d) =>
      counts({
        area: d.area,
        // One area at 99% of its requirement, the rest complete.
        activeItems: d.area === 'PROOF_POINTS' ? d.minimumItems - 1 : Math.max(d.minimumItems, 1),
        bilingualActiveItems: Math.max(d.minimumItems, 1),
      }),
    );
    const percent = computeBrandCompletion(nearlyAll).percent;
    expect(percent).toBeLessThan(100);
    expect(percent).toBeGreaterThan(80);
  });

  it('lists the areas needing attention without listing empty ones', () => {
    const result = computeBrandCompletion([
      counts({ area: 'OFFERS', activeItems: 5, staleItems: 1 }),
      counts({ area: 'GLOSSARY', activeItems: 0 }),
    ]);
    expect(result.areasNeedingAttention).toContain('OFFERS');
    // An untouched area is not "needing attention" — it is simply not started,
    // and reporting it as a problem would bury the ones that are.
    expect(result.areasNeedingAttention).not.toContain('GLOSSARY');
  });

  it('is deterministic', () => {
    const input = AREA_DEFINITIONS.map((d) => counts({ area: d.area, activeItems: 2 }));
    expect(computeBrandCompletion(input)).toEqual(computeBrandCompletion(input));
  });

  it('totals active items and pending candidates honestly', () => {
    const result = computeBrandCompletion([
      counts({ area: 'IDENTITY', activeItems: 7, pendingCandidates: 3 }),
      counts({ area: 'OFFERS', activeItems: 5, pendingCandidates: 2 }),
    ]);
    expect(result.totalActiveItems).toBe(12);
    expect(result.totalPendingCandidates).toBe(5);
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
