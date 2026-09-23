import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BRAND_MEMORY_LAYERS,
  comparePrecedence,
  mayOverwrite,
  memoryRank,
  originRank,
} from '@brandspace/brand-brain';

/**
 * PHASE 6 · P6-07 — THE FOUR-LAYER MODEL IS NOW VISIBLE, AND IT IS THE SAME
 * MODEL THE ENGINE USES.
 *
 * THE DOMAIN WAS ALREADY RIGHT, which is the finding rather than the work. The
 * four memories, the origin precedence, `comparePrecedence`, `mayOverwrite` and
 * `computeAreaCompletion` all shipped in earlier phases and none of them moved.
 * What was missing was that the SCREEN showed `origin` — human, document,
 * AI-inferred — and never the LAYER. A reader could see that a fact was
 * inferred and not that it sat in the lowest-authority memory and therefore
 * could never overwrite anything above it. Half the model, and the half that
 * decides what happens when two facts disagree.
 *
 * WHAT THIS FILE PINS:
 *
 *   - the four layers, in authority order, from ONE exported list;
 *   - the ranking is DERIVED from that list, so the two cannot disagree;
 *   - AI inference still cannot overwrite human-approved canonical knowledge —
 *     the guarantee the whole model exists to provide;
 *   - the screen reads the engine's rank rather than restating it, so it
 *     explains the rule instead of holding an opinion that agrees today;
 *   - both languages name all four layers.
 */

describe('P6-07 · one list, and the ranking comes from it', () => {
  it('names the four memories in authority order', () => {
    expect(BRAND_MEMORY_LAYERS).toEqual(['CANONICAL', 'STRATEGY', 'CONTENT', 'LEARNING']);
  });

  it('ranks them from that list, so a reorder cannot desynchronise the two', () => {
    // Before P6-07 the list did not exist and MEMORY_RANK was written out by
    // hand. A surface needing the order would have written it a third time.
    BRAND_MEMORY_LAYERS.forEach((layer, index) => {
      expect(memoryRank(layer)).toBe(index);
    });
  });

  it('orders Canonical above Strategy above Content above Learning, always', () => {
    // "Always, and not as a tie-break" — the schema's own words. Asserted as an
    // ordering rather than as four numbers, because the numbers are an
    // implementation detail and the ordering is the promise.
    const ranks = BRAND_MEMORY_LAYERS.map((layer) => memoryRank(layer));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });
});

describe('P6-07 · AI inference never silently overwrites human knowledge', () => {
  it('refuses an AI-inferred item over a human one in the same layer', () => {
    /*
     * THE GUARANTEE THE MODEL EXISTS FOR (D-65). If a generated inference could
     * replace something a person approved, the provenance on the row would be
     * describing a rule the product does not enforce — and the failure is
     * silent, because the overwritten fact simply stops being what the brand
     * says.
     */
    // `mayOverwrite(existing, incoming)` — that order matters, and getting it
    // backwards is how this test first "found" a defect that was not there.
    const decision = mayOverwrite(
      { memory: 'CANONICAL', origin: 'HUMAN' },
      { memory: 'CANONICAL', origin: 'AI_INFERRED' },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('human_precedence');
  });

  it('refuses it even when the inference claims the highest layer', () => {
    // D-65 is checked BEFORE the memory comparison, so an AI-inferred CANONICAL
    // item cannot outrank a human LEARNING one by borrowing its layer.
    const decision = mayOverwrite(
      { memory: 'LEARNING', origin: 'HUMAN' },
      { memory: 'CANONICAL', origin: 'AI_INFERRED' },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('human_precedence');
  });

  it('refuses a lower-authority layer over a higher one', () => {
    const decision = mayOverwrite(
      { memory: 'CANONICAL', origin: 'HUMAN' },
      { memory: 'LEARNING', origin: 'HUMAN' },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('lower_memory_authority');
  });

  it('allows a person editing their own knowledge at equal authority', () => {
    // The ordinary case, and the one an edit screen performs. A model that
    // refused this would make the knowledge base read-only.
    const decision = mayOverwrite(
      { memory: 'CANONICAL', origin: 'HUMAN' },
      { memory: 'CANONICAL', origin: 'HUMAN' },
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('same_authority');
  });

  it('puts human above document above inferred', () => {
    expect(originRank('HUMAN')).toBeLessThan(originRank('DOCUMENT'));
    expect(originRank('DOCUMENT')).toBeLessThan(originRank('AI_INFERRED'));
  });

  it('sorts a conflicting pair by layer first, then by origin', () => {
    // What the screen shows when two facts disagree: the higher-authority one
    // first, and the reason it is first is the pair (layer, origin).
    const canonicalInferred = { memory: 'CANONICAL' as const, origin: 'AI_INFERRED' as const };
    const strategyHuman = { memory: 'STRATEGY' as const, origin: 'HUMAN' as const };
    expect(comparePrecedence(canonicalInferred, strategyHuman)).toBeLessThan(0);
  });
});

describe('P6-07 · the screen explains the rule rather than restating it', () => {
  const PAGE = readFileSync('apps/dashboard/src/app/[locale]/brand-brain/page.tsx', 'utf8');
  const DRAWER = readFileSync(
    'apps/dashboard/src/app/[locale]/brand-brain/area-drawer.tsx',
    'utf8',
  );
  const MESSAGES = readFileSync('apps/dashboard/src/i18n/messages.ts', 'utf8');

  it('reads the memory layer out of the database at all', () => {
    // The regression: `origin` was selected and `memory` was not, so half the
    // model could not reach the screen however it was rendered.
    expect(PAGE).toMatch(/memory: true,/);
  });

  it('takes the authority position from memoryRank, not from a list in the page', () => {
    // A page with its own ordering agrees with the engine right up until one of
    // them changes.
    expect(PAGE).toContain('memoryRank(item.memory)');
    expect(PAGE).toContain('BRAND_MEMORY_LAYERS.length');
  });

  it('renders the layer beside the origin', () => {
    expect(DRAWER).toContain('item.memoryLabel');
    expect(DRAWER).toContain('item.memoryRank');
  });

  it('names all four layers in both languages', () => {
    for (const layer of BRAND_MEMORY_LAYERS) {
      const occurrences = [...MESSAGES.matchAll(new RegExp(`'bb\\.memory\\.${layer}':`, 'g'))];
      expect(occurrences, `bb.memory.${layer} is not in both message tables`).toHaveLength(2);
    }
  });

  it('explains the authority order in both languages', () => {
    const hint = [...MESSAGES.matchAll(/'bb\.memory\.authorityHint':/g)];
    expect(hint).toHaveLength(2);
  });
});
