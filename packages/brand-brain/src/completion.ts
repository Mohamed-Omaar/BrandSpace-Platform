import type { BrandKnowledgeArea } from '@brandspace/database';
import { AREA_DEFINITIONS, areaDefinition } from './areas';

/**
 * Brand Brain completion — the real number behind the demo's 82%.
 *
 * THE RULES, STATED ONCE SO THEY CAN BE TESTED:
 *
 *  1. Only ACTIVE items count. A draft, a proposal awaiting review and an
 *     archived item all count as nothing. This is the rule that stops an upload
 *     from inflating the score: a document produces CANDIDATES, and a candidate
 *     is not knowledge until a human accepts it.
 *
 *  2. An area is COMPLETE when it has at least `minimumItems` active items and,
 *     where the area requires it, at least one of them carries both locales.
 *
 *  3. An area NEEDS ATTENTION when it is complete but something is wrong with
 *     it — stale items past review, an unresolved conflict, or pending
 *     candidates waiting on a human. "Needs attention" is deliberately distinct
 *     from "incomplete": one is work the customer has not done, the other is
 *     work the system is waiting on them to confirm.
 *
 *  4. Overall completion is the mean of the per-area RATIOS across the areas
 *     that count, each ratio capped at 1. Not a count of complete areas —
 *     that would jump from 0% to 12.5% on a single item and tell the customer
 *     almost nothing about progress — and not a raw item count, which would let
 *     twenty glossary terms hide an empty identity.
 *
 *  5. The result is an integer percentage, floored. A brand that has done
 *     nothing reads 0%; a brand one item short of everything must not read
 *     100%, and flooring is what guarantees it.
 *
 * Pure and synchronous. It takes counts, not a database, so every rule above is
 * a unit test rather than an integration one.
 */

export interface AreaCounts {
  readonly area: BrandKnowledgeArea;
  /** Items in ACTIVE status. Only these count toward completion. */
  readonly activeItems: number;
  /** Active items carrying non-empty text in BOTH locales. */
  readonly bilingualActiveItems: number;
  /** Items past `reviewDueAt`. */
  readonly staleItems: number;
  /** Items with an unresolved conflict. */
  readonly conflictedItems: number;
  /** Candidates in PENDING review for this area. */
  readonly pendingCandidates: number;
}

export type AreaStatus = 'EMPTY' | 'IN_PROGRESS' | 'NEEDS_ATTENTION' | 'COMPLETE';

export interface AreaCompletion {
  readonly area: BrandKnowledgeArea;
  readonly status: AreaStatus;
  /** 0–1000 per mille, so the ratio stays an integer all the way through. */
  readonly ratioMilli: number;
  readonly activeItems: number;
  readonly requiredItems: number;
  readonly pendingCandidates: number;
  readonly staleItems: number;
  readonly conflictedItems: number;
  /**
   * Stable machine codes for why this area needs attention. Translated in the
   * UI — never assembled into a sentence here, because a sentence built in a
   * package cannot be translated (CLAUDE.md §4).
   */
  readonly attention: readonly AttentionReason[];
}

export type AttentionReason =
  | 'missing_items'
  | 'missing_second_locale'
  | 'stale_items'
  | 'unresolved_conflict'
  | 'pending_review';

export interface BrandCompletion {
  /** 0–100, floored. The number the hero card shows. */
  readonly percent: number;
  readonly areas: readonly AreaCompletion[];
  /** Areas whose status is NEEDS_ATTENTION or which are incomplete with work waiting. */
  readonly areasNeedingAttention: readonly BrandKnowledgeArea[];
  readonly totalActiveItems: number;
  readonly totalPendingCandidates: number;
}

function emptyCounts(area: BrandKnowledgeArea): AreaCounts {
  return {
    area,
    activeItems: 0,
    bilingualActiveItems: 0,
    staleItems: 0,
    conflictedItems: 0,
    pendingCandidates: 0,
  };
}

export function computeAreaCompletion(counts: AreaCounts): AreaCompletion {
  const definition = areaDefinition(counts.area);
  const required = definition.minimumItems;

  const attention: AttentionReason[] = [];

  // An area with no requirement (LEARNINGS) is complete once it is not empty,
  // and never counts as incomplete — see AreaDefinition.countsTowardCompletion.
  const ratioMilli =
    required === 0 ? 1000 : Math.min(1000, Math.floor((counts.activeItems / required) * 1000));

  const meetsCount = counts.activeItems >= required;
  const meetsLocales = !definition.requiresBothLocales || counts.bilingualActiveItems >= 1;

  if (!meetsCount) attention.push('missing_items');
  if (meetsCount && !meetsLocales) attention.push('missing_second_locale');
  if (counts.staleItems > 0) attention.push('stale_items');
  if (counts.conflictedItems > 0) attention.push('unresolved_conflict');
  if (counts.pendingCandidates > 0) attention.push('pending_review');

  let status: AreaStatus;
  if (counts.activeItems === 0 && counts.pendingCandidates === 0) {
    status = 'EMPTY';
  } else if (!meetsCount || !meetsLocales) {
    status = 'IN_PROGRESS';
  } else if (attention.length > 0) {
    // Complete, but something is waiting on a human. The demo's "Needs review"
    // badge is this state, and it is NOT the same as incomplete.
    status = 'NEEDS_ATTENTION';
  } else {
    status = 'COMPLETE';
  }

  /*
   * THE SECOND LOCALE GATES THE RATIO, NOT ONLY THE BADGE.
   *
   * Without this, an area that requires both locales could report a 100% ratio
   * while being unusable for Arabic generation — the exact failure a bilingual
   * product must not paper over. It is capped at 90% rather than halved so the
   * customer still sees that the work is nearly done.
   */
  const effectiveRatio = meetsLocales ? ratioMilli : Math.min(ratioMilli, 900);

  return {
    area: counts.area,
    status,
    ratioMilli: effectiveRatio,
    activeItems: counts.activeItems,
    requiredItems: required,
    pendingCandidates: counts.pendingCandidates,
    staleItems: counts.staleItems,
    conflictedItems: counts.conflictedItems,
    attention,
  };
}

export function computeBrandCompletion(counts: readonly AreaCounts[]): BrandCompletion {
  const byArea = new Map(counts.map((c) => [c.area, c]));
  // Every area appears in the result, present in the input or not. A missing
  // area is an EMPTY area, never an absent one: the UI renders ten cards
  // whatever the database happens to hold.
  const areas = AREA_DEFINITIONS.map((definition) =>
    computeAreaCompletion(byArea.get(definition.area) ?? emptyCounts(definition.area)),
  );

  const counted = areas.filter((a) => areaDefinition(a.area).countsTowardCompletion);
  const totalMilli = counted.reduce((sum, a) => sum + a.ratioMilli, 0);
  const percent = counted.length === 0 ? 0 : Math.floor(totalMilli / counted.length / 10);

  return {
    percent,
    areas,
    areasNeedingAttention: areas
      .filter((a) => a.attention.length > 0 && a.status !== 'EMPTY')
      .map((a) => a.area),
    totalActiveItems: areas.reduce((sum, a) => sum + a.activeItems, 0),
    totalPendingCandidates: areas.reduce((sum, a) => sum + a.pendingCandidates, 0),
  };
}
