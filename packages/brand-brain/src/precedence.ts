import type { BrandKnowledgeOrigin, BrandMemoryLayer } from '@brandspace/database';

/**
 * Knowledge precedence — D-64's four memories and D-65's human precedence.
 *
 * TWO INDEPENDENT ORDERINGS, AND THEY ARE NOT THE SAME QUESTION.
 *
 *   MEMORY decides which KIND of knowledge outranks which: what the customer
 *   states about the brand beats an approved strategy, which beats the factual
 *   record of what was published, which beats an inference drawn from
 *   performance. That is D-64's authority column.
 *
 *   ORIGIN decides who put a given row there: a human, a document the customer
 *   supplied, or an AI inference. That is D-65's human precedence.
 *
 * Conflating them would be wrong in a way that matters. A human-entered
 * LEARNING ("we tried discount posts and they hurt us") is still human
 * knowledge, and an AI-inferred CANONICAL claim is still an inference. Ordering
 * by memory alone would let the inference win; ordering by origin alone would
 * let a human note about last month outrank the brand's own positioning. So
 * both are carried, and `comparePrecedence` applies memory first and origin as
 * the decisive tie-break WITHIN a memory — which is where the two ever actually
 * compete.
 */

/**
 * The four memories, in authority order, highest first (D-64).
 *
 * EXPORTED SINCE P6-07, because a surface that explains the model needs the
 * ORDER and the DEPTH, and re-listing them in a component is how the screen
 * comes to have its own opinion that happens to agree today. Anything rendering
 * "2 of 4" reads it from here, and `MEMORY_RANK` below is derived from it so
 * the list and the ranking cannot disagree.
 */
export const BRAND_MEMORY_LAYERS = ['CANONICAL', 'STRATEGY', 'CONTENT', 'LEARNING'] as const;

/** D-64 authority, highest first. Lower number wins. */
const MEMORY_RANK: Readonly<Record<BrandMemoryLayer, number>> = Object.fromEntries(
  BRAND_MEMORY_LAYERS.map((layer, index) => [layer, index]),
) as Readonly<Record<BrandMemoryLayer, number>>;

/**
 * D-65 human precedence, highest first. Lower number wins.
 *
 * SETUP SHARES DOCUMENT'S RANK (D-335). It marks what the setup wizard
 * recorded — facts a person accepted on its Review step, and the goal chosen
 * there — so the label can say where a fact came from. It is a starting point,
 * not a deliberate edit: a later edit in Brand Brain (HUMAN) outranks it, a
 * newer document accepted in review may refresh it exactly as it could before
 * setup had a name, and an inference never overwrites it.
 */
const ORIGIN_RANK: Readonly<Record<BrandKnowledgeOrigin, number>> = {
  HUMAN: 0,
  DOCUMENT: 1,
  SETUP: 1,
  AI_INFERRED: 2,
};

/*
 * `noUncheckedIndexedAccess` is on, so a Record lookup is `number | undefined`
 * even when the key type makes it total. These two accessors are the ONE place
 * that is reconciled — rather than a non-null assertion at each of the eight
 * comparison sites, where one could later be added without one.
 */
export function memoryRank(memory: BrandMemoryLayer): number {
  const rank = MEMORY_RANK[memory];
  if (rank === undefined) throw new Error(`Unknown memory layer "${memory}".`);
  return rank;
}

export function originRank(origin: BrandKnowledgeOrigin): number {
  const rank = ORIGIN_RANK[origin];
  if (rank === undefined) throw new Error(`Unknown knowledge origin "${origin}".`);
  return rank;
}

export interface PrecedenceSubject {
  readonly memory: BrandMemoryLayer;
  readonly origin: BrandKnowledgeOrigin;
  /** Higher is newer. Used only as the FINAL tie-break. */
  readonly version: number;
  /** Stable final discriminator so ordering is total and reproducible. */
  readonly id: string;
}

/**
 * Total order over knowledge. Negative means `a` outranks `b`.
 *
 * Deterministic by construction: memory, then origin, then a newer version,
 * then the id. Retrieval depends on this being stable — a context window that
 * reorders between two identical requests makes a generation unreproducible,
 * which is the D-65 requirement this function exists to keep.
 */
export function comparePrecedence(a: PrecedenceSubject, b: PrecedenceSubject): number {
  const byMemory = memoryRank(a.memory) - memoryRank(b.memory);
  if (byMemory !== 0) return byMemory;
  const byOrigin = originRank(a.origin) - originRank(b.origin);
  if (byOrigin !== 0) return byOrigin;
  // Newer first WITHIN the same memory and origin.
  const byVersion = b.version - a.version;
  if (byVersion !== 0) return byVersion;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Sort a copy into precedence order. Never mutates the input. */
export function sortByPrecedence<T extends PrecedenceSubject>(items: readonly T[]): T[] {
  return [...items].sort(comparePrecedence);
}

/**
 * May `incoming` overwrite `existing` without a human saying so?
 *
 * THE ANSWER IS ALMOST ALWAYS NO, AND THAT IS THE POINT (D-65). An AI-inferred
 * item may never silently replace anything a human entered or approved from a
 * document. The system SURFACES the conflict instead — which is why the caller
 * gets a reason string it can show, rather than a bare boolean it would be
 * tempted to log and drop.
 */
export interface OverwriteDecision {
  readonly allowed: boolean;
  /** A stable machine code. Never customer copy — the UI translates it. */
  readonly reason:
    'human_precedence' | 'lower_memory_authority' | 'same_authority' | 'higher_authority';
}

export function mayOverwrite(
  existing: PrecedenceSubject,
  incoming: PrecedenceSubject,
): OverwriteDecision {
  // D-65, stated first because it is absolute: an inference never overwrites a
  // human rule, whatever the memory layers say. Checked BEFORE the memory
  // comparison so an AI-inferred CANONICAL item cannot outrank a human
  // LEARNING by borrowing its layer's authority.
  if (incoming.origin === 'AI_INFERRED' && existing.origin !== 'AI_INFERRED') {
    return { allowed: false, reason: 'human_precedence' };
  }

  const byMemory = memoryRank(incoming.memory) - memoryRank(existing.memory);
  if (byMemory > 0) return { allowed: false, reason: 'lower_memory_authority' };
  if (byMemory < 0) return { allowed: true, reason: 'higher_authority' };

  const byOrigin = originRank(incoming.origin) - originRank(existing.origin);
  if (byOrigin > 0) return { allowed: false, reason: 'lower_memory_authority' };
  if (byOrigin < 0) return { allowed: true, reason: 'higher_authority' };

  // Equal authority. Allowed, because this is a human editing their own
  // knowledge — the ordinary case, and the one an edit screen performs.
  return { allowed: true, reason: 'same_authority' };
}
