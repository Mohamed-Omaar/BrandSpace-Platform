import type { BrandKnowledgeArea } from '@brandspace/database';
import { AREA_DEFINITIONS } from './areas';
import { indexVector, score, tokenize } from './retrieval';
import type { LocalizedText } from './schemas';

/**
 * Brand Brain completeness — KEY QUESTIONS PER AREA (Q19, prototype v90 D3).
 *
 * THE RULES, STATED ONCE SO THEY CAN BE TESTED:
 *
 *  1. Each area has a short list of KEY QUESTIONS, from configuration
 *     (`brand-brain.questions`, owned in the Control Center). Offers questions
 *     depend on the brand's industry: an industry names its Offers question
 *     set (D-329), and that set replaces the general Offers list.
 *
 *  2. ONE QUESTION ↔ ONE FACT. A question names the `itemKey` of the fact that
 *     answers it, and it is ANSWERED exactly when a USABLE fact — approved and
 *     not expired — exists in that area with that key. Nothing is inferred from
 *     text: an unapproved candidate answers nothing, and an expired fact makes
 *     its question unanswered again (owner, 2026-09-28).
 *
 *  3. An area shows "answered n of m". THERE IS NO PERCENTAGE AND NO OVERALL
 *     SCORE — for an area or for the brand (Q19). This replaces the Phase 5
 *     `minimumItems` ratio and its floored percentage; it is the only
 *     completeness calculation.
 *
 *  4. An area's STATUS: EMPTY when it holds nothing at all; IN PROGRESS while a
 *     question is unanswered; NEEDS ATTENTION when every question is answered
 *     but something waits on a person (stale or expired facts, a conflict,
 *     candidates to review); otherwise COMPLETE. An area with no configured
 *     questions is COMPLETE once it holds a usable fact.
 *
 *  5. "What's missing" is every unanswered question, in the areas' own order
 *     and each area's question order — the screen shows the first few.
 *
 * Pure and synchronous. It takes counts and answered keys, not a database, so
 * every rule above is a unit test.
 */

export interface KeyQuestion {
  /** Stable id of the question inside its list. */
  readonly key: string;
  /** The key of the one fact that answers it, in its area. */
  readonly itemKey: string;
  readonly prompt: LocalizedText;
}

/** The questions each area asks, already resolved for one brand's industry. */
export type AreaQuestions = ReadonlyMap<BrandKnowledgeArea, readonly KeyQuestion[]>;

export interface AreaCounts {
  readonly area: BrandKnowledgeArea;
  /** Usable facts: approved (ACTIVE or STALE) and not expired. */
  readonly usableItems: number;
  /** Approved facts past their review date (still usable). */
  readonly staleItems: number;
  /** Approved facts past their "valid until" day (never used in writing). */
  readonly expiredItems: number;
  /** Facts with an unresolved conflict. */
  readonly conflictedItems: number;
  /** Candidates in PENDING review for this area. */
  readonly pendingCandidates: number;
  /** The `itemKey`s of this area's USABLE facts. */
  readonly answeredKeys: ReadonlySet<string>;
}

export type AreaStatus = 'EMPTY' | 'IN_PROGRESS' | 'NEEDS_ATTENTION' | 'COMPLETE';

export type AttentionReason =
  | 'unanswered_questions'
  | 'stale_items'
  | 'expired_items'
  | 'unresolved_conflict'
  | 'pending_review';

export interface AreaCompletion {
  readonly area: BrandKnowledgeArea;
  readonly status: AreaStatus;
  /** "answered n of m": n. */
  readonly answered: number;
  /** "answered n of m": m. */
  readonly total: number;
  readonly questions: readonly (KeyQuestion & { readonly answered: boolean })[];
  readonly usableItems: number;
  readonly pendingCandidates: number;
  readonly staleItems: number;
  readonly expiredItems: number;
  readonly conflictedItems: number;
  /** Stable machine codes, translated in the UI — never a sentence built here. */
  readonly attention: readonly AttentionReason[];
}

export interface MissingQuestion {
  readonly area: BrandKnowledgeArea;
  readonly question: KeyQuestion;
}

export interface BrandCompletion {
  readonly areas: readonly AreaCompletion[];
  /** Every unanswered question, in area order then question order. */
  readonly missing: readonly MissingQuestion[];
  readonly areasNeedingAttention: readonly BrandKnowledgeArea[];
  readonly totalUsableItems: number;
  readonly totalPendingCandidates: number;
}

function emptyCounts(area: BrandKnowledgeArea): AreaCounts {
  return {
    area,
    usableItems: 0,
    staleItems: 0,
    expiredItems: 0,
    conflictedItems: 0,
    pendingCandidates: 0,
    answeredKeys: new Set(),
  };
}

export function computeAreaCompletion(
  counts: AreaCounts,
  questions: readonly KeyQuestion[],
): AreaCompletion {
  const marked = questions.map((question) => ({
    ...question,
    answered: counts.answeredKeys.has(question.itemKey),
  }));
  const answered = marked.filter((question) => question.answered).length;
  const total = marked.length;

  const attention: AttentionReason[] = [];
  if (answered < total) attention.push('unanswered_questions');
  if (counts.staleItems > 0) attention.push('stale_items');
  if (counts.expiredItems > 0) attention.push('expired_items');
  if (counts.conflictedItems > 0) attention.push('unresolved_conflict');
  if (counts.pendingCandidates > 0) attention.push('pending_review');

  const holdsNothing =
    counts.usableItems === 0 && counts.expiredItems === 0 && counts.pendingCandidates === 0;
  let status: AreaStatus;
  if (holdsNothing) status = 'EMPTY';
  else if (answered < total) status = 'IN_PROGRESS';
  else if (total === 0 && counts.usableItems === 0) status = 'IN_PROGRESS';
  else if (attention.length > 0) status = 'NEEDS_ATTENTION';
  else status = 'COMPLETE';

  return {
    area: counts.area,
    status,
    answered,
    total,
    questions: marked,
    usableItems: counts.usableItems,
    pendingCandidates: counts.pendingCandidates,
    staleItems: counts.staleItems,
    expiredItems: counts.expiredItems,
    conflictedItems: counts.conflictedItems,
    attention,
  };
}

export function computeBrandCompletion(
  counts: readonly AreaCounts[],
  questions: AreaQuestions,
): BrandCompletion {
  const byArea = new Map(counts.map((c) => [c.area, c]));
  // Every area appears in the result, present in the input or not: the UI
  // renders ten cards whatever the database happens to hold.
  const areas = AREA_DEFINITIONS.map((definition) =>
    computeAreaCompletion(
      byArea.get(definition.area) ?? emptyCounts(definition.area),
      questions.get(definition.area) ?? [],
    ),
  );

  return {
    areas,
    missing: areas.flatMap((area) =>
      area.questions
        .filter((question) => !question.answered)
        .map(({ answered: _answered, ...question }) => ({ area: area.area, question })),
    ),
    // Work waiting on a person — review, conflicts, stale or expired facts —
    // not merely an unanswered question, which "What's missing" lists.
    areasNeedingAttention: areas
      .filter((a) => a.attention.some((reason) => reason !== 'unanswered_questions'))
      .map((a) => a.area),
    totalUsableItems: areas.reduce((sum, a) => sum + a.usableItems, 0),
    totalPendingCandidates: areas.reduce((sum, a) => sum + a.pendingCandidates, 0),
  };
}

/**
 * The questions one brand is asked: each area's configured list, with the
 * Offers list replaced by the brand's industry set when the configuration has
 * one (D-329). A set key that names nothing falls back to the general list,
 * never to an invented one.
 */
export function questionsForBrand(
  config: {
    readonly areas: Readonly<Partial<Record<BrandKnowledgeArea, readonly KeyQuestion[]>>>;
    readonly offersSets: Readonly<Record<string, readonly KeyQuestion[]>>;
  },
  offersQuestionSet: string | null,
): AreaQuestions {
  const out = new Map<BrandKnowledgeArea, readonly KeyQuestion[]>();
  for (const definition of AREA_DEFINITIONS) {
    out.set(definition.area, config.areas[definition.area] ?? []);
  }
  const industrySet = offersQuestionSet ? config.offersSets[offersQuestionSet] : undefined;
  if (industrySet && industrySet.length > 0) out.set('OFFERS', industrySet);
  return out;
}

/**
 * THE KEY QUESTION A REQUEST IS CLOSEST TO (Phase 2C-3, D7/D8) — so a question
 * Brand Brain cannot answer can say WHAT is missing and in which area, and link
 * to it. Every configured list is considered (each area's, and every industry
 * set of Offers), narrowed to one area when the chat was opened on one. The
 * retriever's own local lexical `score`: no model, no credits. Null when no
 * question shares a word with the request.
 */
export function closestKeyQuestion(
  request: string,
  config: {
    readonly areas: Readonly<Partial<Record<BrandKnowledgeArea, readonly KeyQuestion[]>>>;
    readonly offersSets: Readonly<Record<string, readonly KeyQuestion[]>>;
  },
  area?: BrandKnowledgeArea,
): MissingQuestion | null {
  const vector = indexVector(request);
  const tokens = new Set(tokenize(request));
  const pool: MissingQuestion[] = [
    ...AREA_DEFINITIONS.flatMap((definition) =>
      (config.areas[definition.area] ?? []).map((question) => ({
        area: definition.area,
        question,
      })),
    ),
    ...Object.values(config.offersSets).flatMap((set) =>
      set.map((question) => ({ area: 'OFFERS' as BrandKnowledgeArea, question })),
    ),
  ].filter((entry) => area === undefined || entry.area === area);
  let best: { entry: MissingQuestion; relevance: number } | null = null;
  for (const entry of pool) {
    const text = [
      entry.question.prompt.en,
      entry.question.prompt.ar,
      entry.question.itemKey.replace(/[._-]/g, ' '),
    ]
      .filter(Boolean)
      .join(' ');
    const relevance = score(text, vector, tokens);
    if (relevance > 0 && (best === null || relevance > best.relevance)) {
      best = { entry, relevance };
    }
  }
  return best?.entry ?? null;
}
