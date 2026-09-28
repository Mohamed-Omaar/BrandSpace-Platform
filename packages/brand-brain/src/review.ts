import type { ReviewPolicy } from './policy';

/**
 * THE REVIEW INBOX'S CONFIDENCE, IN WORDS (prototype v90 D4, Phase 2C).
 *
 * A candidate carries `confidenceMilli` (0–1000). The inbox shows a LABEL —
 * High at or above the configured `highMilli` (owner: 85), Medium at or above
 * `mediumMilli` (70), otherwise Low — and an EXPLANATION built only from what
 * was recorded when the candidate was made. Nothing is inferred afterwards: a
 * candidate made before its reason was recorded says so.
 */

export type ConfidenceLabel = 'high' | 'medium' | 'low';

export function confidenceLabel(
  confidenceMilli: number,
  policy: Pick<ReviewPolicy, 'highMilli' | 'mediumMilli'>,
): ConfidenceLabel {
  if (confidenceMilli >= policy.highMilli) return 'high';
  if (confidenceMilli >= policy.mediumMilli) return 'medium';
  return 'low';
}

export type ConfidenceReason =
  /** An inference from measured performance, with its own evidence. */
  | 'analytics'
  /** The sentence holds the area's keywords, and the document was aimed at this area. */
  | 'keywords_aimed'
  /** The sentence holds the area's keywords. */
  | 'keywords'
  /** No keyword matched; the document was aimed at this area, so it is a guess. */
  | 'aimed_only'
  /** Made before the reason was recorded. */
  | 'unrecorded';

export interface ConfidenceExplanation {
  readonly reason: ConfidenceReason;
  /** How many of the area's keywords the sentence holds, when recorded. */
  readonly keywordHits: number | null;
}

/** The explanation, read from the candidate's own stored evidence. */
export function confidenceExplanation(candidate: {
  readonly sourceKind: string;
  readonly evidence: unknown;
}): ConfidenceExplanation {
  if (candidate.sourceKind === 'ANALYTICS') return { reason: 'analytics', keywordHits: null };
  const first = Array.isArray(candidate.evidence) ? (candidate.evidence[0] as unknown) : null;
  if (!first || typeof first !== 'object') return { reason: 'unrecorded', keywordHits: null };
  const record = first as Record<string, unknown>;
  if (record['method'] !== 'keyword' || typeof record['keywordHits'] !== 'number') {
    return { reason: 'unrecorded', keywordHits: null };
  }
  const hits = record['keywordHits'];
  if (hits === 0) return { reason: 'aimed_only', keywordHits: 0 };
  return {
    reason: record['aimedArea'] === true ? 'keywords_aimed' : 'keywords',
    keywordHits: hits,
  };
}
