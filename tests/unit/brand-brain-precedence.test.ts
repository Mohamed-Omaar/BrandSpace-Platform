import { describe, expect, it } from 'vitest';
import {
  comparePrecedence,
  mayOverwrite,
  memoryRank,
  originRank,
  sortByPrecedence,
  type PrecedenceSubject,
} from '@brandspace/brand-brain';

/**
 * D-64's four memories and D-65's human precedence.
 *
 * These are the rules that stop the feedback loop compounding its own errors:
 * a weak inference becoming grounding for the next generation, which becomes
 * evidence for the next inference. Every assertion below fails if the ordering
 * is weakened, and several exist specifically to fail if the two orderings are
 * ever collapsed into one.
 */

function subject(over: Partial<PrecedenceSubject> = {}): PrecedenceSubject {
  return { memory: 'CANONICAL', origin: 'HUMAN', version: 1, id: 'a', ...over };
}

describe('memory authority follows D-64 exactly', () => {
  it('orders canonical above strategy above content above learning', () => {
    expect(memoryRank('CANONICAL')).toBeLessThan(memoryRank('STRATEGY'));
    expect(memoryRank('STRATEGY')).toBeLessThan(memoryRank('CONTENT'));
    expect(memoryRank('CONTENT')).toBeLessThan(memoryRank('LEARNING'));
  });

  it('orders human above document above inferred', () => {
    expect(originRank('HUMAN')).toBeLessThan(originRank('DOCUMENT'));
    expect(originRank('DOCUMENT')).toBeLessThan(originRank('AI_INFERRED'));
  });
});

describe('comparePrecedence is a deterministic total order', () => {
  it('puts canonical knowledge ahead of a learning', () => {
    const canonical = subject({ memory: 'CANONICAL', id: 'z' });
    const learning = subject({ memory: 'LEARNING', id: 'a' });
    expect(comparePrecedence(canonical, learning)).toBeLessThan(0);
  });

  it('breaks a memory tie by origin, not by version', () => {
    // A brand-new inference must NOT outrank an older human statement in the
    // same layer. If version were consulted first, it would.
    const human = subject({ origin: 'HUMAN', version: 1, id: 'a' });
    const inferred = subject({ origin: 'AI_INFERRED', version: 99, id: 'b' });
    expect(comparePrecedence(human, inferred)).toBeLessThan(0);
  });

  it('prefers the newer version only when memory and origin match', () => {
    const older = subject({ version: 1, id: 'a' });
    const newer = subject({ version: 2, id: 'b' });
    expect(comparePrecedence(newer, older)).toBeLessThan(0);
  });

  it('falls back to the id so the order is total and reproducible', () => {
    // Reproducibility (D-65): the same inputs must produce the same context
    // window every time, or a generation cannot be replayed.
    const a = subject({ id: 'aaa' });
    const b = subject({ id: 'bbb' });
    expect(comparePrecedence(a, b)).toBeLessThan(0);
    expect(comparePrecedence(b, a)).toBeGreaterThan(0);
    expect(comparePrecedence(a, a)).toBe(0);
  });

  it('sorts a mixed corpus into the documented order', () => {
    const items = [
      subject({ memory: 'LEARNING', origin: 'AI_INFERRED', id: 'learning' }),
      subject({ memory: 'CONTENT', origin: 'DOCUMENT', id: 'content' }),
      subject({ memory: 'CANONICAL', origin: 'HUMAN', id: 'canonical' }),
      subject({ memory: 'STRATEGY', origin: 'HUMAN', id: 'strategy' }),
    ];
    expect(sortByPrecedence(items).map((i) => i.id)).toEqual([
      'canonical',
      'strategy',
      'content',
      'learning',
    ]);
  });

  it('does not mutate its input', () => {
    const items = [subject({ id: 'b' }), subject({ id: 'a' })];
    const before = items.map((i) => i.id);
    sortByPrecedence(items);
    expect(items.map((i) => i.id)).toEqual(before);
  });
});

describe('mayOverwrite enforces D-65 human precedence', () => {
  it('REFUSES an inference aimed at human knowledge', () => {
    const decision = mayOverwrite(subject({ origin: 'HUMAN' }), subject({ origin: 'AI_INFERRED' }));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('human_precedence');
  });

  it('refuses an inference aimed at document-sourced knowledge a human approved', () => {
    const decision = mayOverwrite(
      subject({ origin: 'DOCUMENT' }),
      subject({ origin: 'AI_INFERRED' }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('human_precedence');
  });

  it('refuses even when the inference claims a HIGHER memory layer', () => {
    /*
     * THE TEST THAT STOPS THE TWO ORDERINGS BEING COLLAPSED.
     *
     * An AI-inferred CANONICAL item against a human-entered LEARNING: by memory
     * alone the inference wins, and the customer's own note is overwritten by a
     * guess. Human precedence is checked FIRST precisely so that cannot happen.
     */
    const humanLearning = subject({ memory: 'LEARNING', origin: 'HUMAN' });
    const inferredCanonical = subject({ memory: 'CANONICAL', origin: 'AI_INFERRED' });
    const decision = mayOverwrite(humanLearning, inferredCanonical);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('human_precedence');
  });

  it('allows an inference to replace another inference', () => {
    const decision = mayOverwrite(
      subject({ origin: 'AI_INFERRED' }),
      subject({ origin: 'AI_INFERRED' }),
    );
    expect(decision.allowed).toBe(true);
  });

  it('allows a human to edit their own knowledge', () => {
    const decision = mayOverwrite(subject({ origin: 'HUMAN' }), subject({ origin: 'HUMAN' }));
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('same_authority');
  });

  it('allows a human to overwrite an inference', () => {
    const decision = mayOverwrite(subject({ origin: 'AI_INFERRED' }), subject({ origin: 'HUMAN' }));
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('higher_authority');
  });

  it('refuses a lower memory layer overwriting a higher one', () => {
    const decision = mayOverwrite(
      subject({ memory: 'CANONICAL', origin: 'HUMAN' }),
      subject({ memory: 'LEARNING', origin: 'HUMAN' }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('lower_memory_authority');
  });

  it('allows a higher memory layer to overwrite a lower one', () => {
    const decision = mayOverwrite(
      subject({ memory: 'LEARNING', origin: 'HUMAN' }),
      subject({ memory: 'CANONICAL', origin: 'HUMAN' }),
    );
    expect(decision.allowed).toBe(true);
  });
});
