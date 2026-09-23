/**
 * THE EVIDENCE BEHIND A PROPOSED LEARNING, READ SAFELY (P6-11).
 *
 * An analytics learning carries its evidence as the object the learning rules
 * wrote (`ProposedLearning.evidence` in `@brandspace/intelligence`): the metric,
 * the observed and baseline values, the deviation and the two windows. The
 * Brand Brain review queue only knew how to read a DOCUMENT candidate's evidence
 * — an array of `{ locator, quote }` — so every analytics learning reached the
 * reviewer with no evidence at all, and the queue asked a person to accept an
 * inference while hiding the numbers it was inferred from.
 *
 * PARSED, NOT CAST — by hand rather than with a schema library, because the
 * dashboard takes no direct dependency on one and the shape is ten fields. The
 * column is `Json`; a row written by an older rule
 * version or edited by hand yields null and the reviewer is shown the link to
 * the source insight instead of half an object. The values stay strings until
 * the page formats them, because they are `bigint` in the ledger of record and
 * a lossy conversion here would print a number the observation does not hold.
 *
 * PURE, AND NOT `server-only` — the unit suite imports it directly.
 */

export interface AnalyticsEvidence {
  readonly metricKey: string;
  readonly observedValue: string;
  readonly baselineValue: string;
  readonly deviationMilli: number;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly baselineStart: Date;
  readonly baselineEnd: Date;
  readonly inferenceVersion: string;
}

export function analyticsEvidence(evidence: unknown): AnalyticsEvidence | null {
  if (typeof evidence !== 'object' || evidence === null || Array.isArray(evidence)) return null;
  const record = evidence as Record<string, unknown>;
  const text = (key: string, max: number): string | null => {
    const value = record[key];
    return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
  };
  const integer = (key: string): string | null => {
    const value = record[key];
    return typeof value === 'string' && /^-?\d{1,30}$/.test(value) ? value : null;
  };
  const date = (key: string): Date | null => {
    const value = record[key];
    if (typeof value !== 'string') return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };

  const inferenceVersion = text('inferenceVersion', 60);
  const metricKey = text('metricKey', 60);
  const observedValue = integer('observedValue');
  const baselineValue = integer('baselineValue');
  const deviation = record['deviationMilli'];
  const periodStart = date('periodStart');
  const periodEnd = date('periodEnd');
  const baselineStart = date('baselineStart');
  const baselineEnd = date('baselineEnd');
  if (
    !inferenceVersion ||
    !metricKey ||
    !/^[a-z0-9_.]+$/.test(metricKey) ||
    observedValue === null ||
    baselineValue === null ||
    typeof deviation !== 'number' ||
    !Number.isInteger(deviation) ||
    !periodStart ||
    !periodEnd ||
    !baselineStart ||
    !baselineEnd
  ) {
    return null;
  }
  return {
    metricKey,
    observedValue,
    baselineValue,
    deviationMilli: deviation,
    periodStart,
    periodEnd,
    baselineStart,
    baselineEnd,
    inferenceVersion,
  };
}

/**
 * What a reviewer must be told about a conflict, before they decide.
 *
 * `conflictsWithItemId` is set at proposal time when a HUMAN or DOCUMENT item
 * outside the learnings area shares the key (`proposeLearning`). Accepting the
 * learning never changes that item — the learning can only target the
 * LEARNINGS area, and `mayOverwrite` refuses AI-inferred over human — so the
 * honest statement is "both will exist, and the human one wins", which is what
 * the page says. The title is looked up among items the page already loaded;
 * an item it did not load (or that has since been removed) is still reported
 * as a conflict, just without a name.
 */
export function conflictNote(input: {
  readonly conflictsWithItemId: string | null;
  readonly titleOf: (itemId: string) => string | null;
}): { readonly title: string | null } | null {
  if (!input.conflictsWithItemId) return null;
  return { title: input.titleOf(input.conflictsWithItemId) };
}
