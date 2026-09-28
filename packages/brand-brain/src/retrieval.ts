import type {
  BrandKnowledgeArea,
  BrandKnowledgeOrigin,
  BrandMemoryLayer,
  TenantScopedClient,
} from '@brandspace/database';
import { fenceUntrusted } from '@brandspace/shared';
import { sortByPrecedence } from './precedence';
import { localizedFrom } from './knowledge';

/**
 * Retrieval and context construction.
 *
 * NO EMBEDDING VENDOR. D-13 approved the provider architecture and deferred the
 * choice, so introducing an embedding API here would commit the product to a
 * vendor nobody has reviewed for privacy, no-training or retention — the exact
 * gates the Phase 4 activation checks enforce. The index is therefore LOCAL and
 * DETERMINISTIC: a hashed token vector computed in-process, reproducible, and
 * free of any network call. It is weaker than a real embedding at synonyms and
 * better than one at being explainable, and it is replaceable behind this
 * interface once a vendor is approved.
 *
 * APPROVED FACTS ONLY, AND NEVER A DOCUMENT'S RAW TEXT (Q14, Q20; Phase 2C).
 * This retriever is the GENERATIVE grounding path — Brand Brain's "Talk with
 * the brand", captions, Studio tools, Copilot, Strategy and Creative. It reads
 * `brand_knowledge_item` through `usableKnowledgeWhere()` and nothing else: no
 * candidate, no version history, and no `brand_source_chunk`. Uploaded
 * documents are SOURCES that propose pending facts through the ingestion
 * pipeline; their text never reaches a writing prompt. There is deliberately no
 * option to ask for chunks, so no caller can turn it back on.
 *
 * SCOPING IS NOT THIS FILE'S JOB, AND THAT IS THE POINT. Every query runs on
 * the tenant-scoped client inside a workspace transaction, so RLS constrains it
 * whatever this code does. The `brandId` filter narrows WITHIN the tenant; it
 * is not what keeps tenants apart.
 */

export interface RetrievedItem {
  readonly id: string;
  readonly area: BrandKnowledgeArea;
  readonly memory: BrandMemoryLayer;
  readonly origin: BrandKnowledgeOrigin;
  readonly version: number;
  readonly title: string;
  readonly body: string;
  readonly score: number;
  readonly stale: boolean;
}

/** One approved fact that grounded a request, at the exact version used. */
export interface GroundedFact {
  readonly itemId: string;
  readonly version: number;
}

export interface RetrievalContext {
  readonly items: readonly RetrievedItem[];
  /**
   * The facts in `contextText`, each at the version that was read — the set a
   * generation is grounded on, so a caller can record it rather than infer it.
   */
  readonly facts: readonly GroundedFact[];
  /** The grounding text, bounded and ordered. Safe to put in a prompt. */
  readonly contextText: string;
  /** Citations for the answer. Only ids actually retrieved appear here. */
  readonly citations: readonly Citation[];
  /**
   * True when there is not enough approved knowledge to answer honestly.
   * The chat service refuses rather than improvising when this is set.
   */
  readonly insufficient: boolean;
}

export interface Citation {
  /**
   * The retriever only ever produces `knowledge`. `document` remains in the
   * type because drafts generated before Phase 2C stored document citations in
   * `content_item.citations`, and the composer still reads those rows.
   */
  readonly kind: 'knowledge' | 'document';
  readonly id: string;
  readonly area?: BrandKnowledgeArea;
  readonly version?: number;
  readonly label: string;
  readonly locator?: string | null;
}

export interface RetrievalOptions {
  readonly maxItems: number;
  readonly maxChars: number;
  /** Narrow to one area, when the customer opened chat from a node or card. */
  readonly area?: BrandKnowledgeArea | undefined;
}

/**
 * WHICH FACTS MAY GROUND AI WRITING — the one predicate, shared by every
 * generative path (Q20).
 *
 * ACTIVE and STALE: STALE means "review due" and is still approved knowledge.
 * Never DRAFT, PROPOSED or ARCHIVED, and never a candidate (another table).
 * And NOT EXPIRED (D6): a fact with a "valid until" day before `asOf` — today
 * in the workspace's time zone, from `knowledgeAsOf` — is never used in
 * writing, whatever its status.
 */
export function usableKnowledgeWhere(asOf: Date): {
  status: { in: ('ACTIVE' | 'STALE')[] };
  OR: ({ validUntil: null } | { validUntil: { gte: Date } })[];
} {
  return {
    status: { in: ['ACTIVE', 'STALE'] },
    OR: [{ validUntil: null }, { validUntil: { gte: asOf } }],
  };
}

// ---------------------------------------------------------------------------
// The deterministic local index
// ---------------------------------------------------------------------------

const VECTOR_DIMENSIONS = 64;

/**
 * Tokenize for indexing. Unicode-aware, so Arabic is a first-class citizen
 * rather than something that falls out of `\w`.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
}

/**
 * A hashed bag-of-tokens vector.
 *
 * Deterministic and dependency-free: the same text always produces the same
 * vector, in this process and in any other, so a stored index does not silently
 * become incomparable after a deploy.
 */
export function indexVector(text: string): number[] {
  const vector = new Array<number>(VECTOR_DIMENSIONS).fill(0);
  for (const token of tokenize(text)) {
    const slot = hashToken(token) % VECTOR_DIMENSIONS;
    vector[slot] = (vector[slot] ?? 0) + 1;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (magnitude === 0) return vector;
  return vector.map((v) => v / magnitude);
}

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

// ---------------------------------------------------------------------------
// Prompt-injection containment
// ---------------------------------------------------------------------------

/*
 * MOVED TO `@brandspace/shared`, AND RE-EXPORTED HERE UNCHANGED.
 *
 * The Content Studio already imported `fenceUntrusted` from this package to
 * fence a context Brand Brain had nothing to do with, and Phase 7 adds three
 * more callers — analytics evidence, the Copilot and strategy grounding — none
 * of which may import Brand Brain. A containment rule implemented per caller is
 * a containment rule with a different hole in each copy.
 *
 * Re-exported rather than relocated silently, so every existing import and every
 * existing test keeps working against the SAME implementation.
 */
export { fenceUntrusted, neutralizeInjection } from '@brandspace/shared';

// Used below by `buildContext`, which fences every block it assembles.

// ---------------------------------------------------------------------------
// The retriever
// ---------------------------------------------------------------------------

export class BrandBrainRetriever {
  readonly #db: TenantScopedClient;

  constructor(options: { db: TenantScopedClient }) {
    this.#db = options.db;
  }

  /**
   * Retrieve grounding for a question.
   *
   * ONLY ELIGIBLE KNOWLEDGE. `status IN (ACTIVE, STALE)` and nothing else: a
   * DRAFT is unfinished, a PROPOSED item has not been approved, and an ARCHIVED
   * one was deliberately retired. Admitting any of them would make the AI
   * ground on something the customer never approved — the failure D-65 exists
   * to prevent. STALE is admitted because it is approved knowledge that is
   * merely unconfirmed, and it is flagged so the answer can say so.
   */
  async retrieve(input: {
    brandId: string;
    question: string;
    options: RetrievalOptions;
    /** Today in the workspace's time zone (`knowledgeAsOf`): expired facts stay out. */
    asOf: Date;
  }): Promise<RetrievalContext> {
    const query = indexVector(input.question);
    const questionTokens = new Set(tokenize(input.question));

    const items = await this.#db.brandKnowledgeItem.findMany({
      where: {
        brandId: input.brandId,
        ...usableKnowledgeWhere(input.asOf),
        ...(input.options.area ? { area: input.options.area } : {}),
      },
      select: {
        id: true,
        area: true,
        memory: true,
        origin: true,
        version: true,
        status: true,
        title: true,
        body: true,
      },
      // A hard ceiling before scoring. A brand with ten thousand items must not
      // pull all of them into memory to rank them.
      take: 500,
    });

    const scoredItems: RetrievedItem[] = items.map((item) => {
      const title = localizedFrom(item.title);
      const body = localizedFrom(item.body);
      const text = [title.en, title.ar, body.en, body.ar].filter(Boolean).join(' ');
      return {
        id: item.id,
        area: item.area,
        memory: item.memory,
        origin: item.origin,
        version: item.version,
        title: title.en ?? title.ar ?? '',
        body: body.en ?? body.ar ?? '',
        score: score(text, query, questionTokens),
        stale: item.status === 'STALE',
      };
    });

    /*
     * PRECEDENCE DECIDES, RELEVANCE ORDERS WITHIN IT.
     *
     * Sorting by similarity alone would let a low-authority learning outrank
     * the brand's own positioning merely by sharing more words with the
     * question — which is how a feedback loop starts grounding itself on its
     * own inferences. So the corpus is sorted by precedence first, and
     * relevance breaks ties inside each (memory, origin) band.
     */
    const relevant = scoredItems.filter((i) => i.score > 0);
    const chosen = sortByPrecedence([...relevant].sort((a, b) => b.score - a.score)).slice(
      0,
      input.options.maxItems,
    );

    const { contextText, citations, usedItems } = buildContext(chosen, input.options.maxChars);

    return {
      items: usedItems,
      facts: usedItems.map((item) => ({ itemId: item.id, version: item.version })),
      contextText,
      citations,
      // "Nothing relevant" and "nothing at all" are both insufficient, and the
      // chat service says so rather than answering from the model's own priors.
      insufficient: usedItems.length === 0,
    };
  }
}

/**
 * Similarity, blended with a direct token overlap.
 *
 * The hashed vector alone collides: two unrelated tokens can land in the same
 * dimension and manufacture a similarity that is not there. Requiring at least
 * one literal shared token is a cheap guard against confidently citing a
 * passage that shares no words with the question.
 */
function score(
  text: string,
  query: readonly number[],
  questionTokens: ReadonlySet<string>,
): number {
  const tokens = tokenize(text);
  const overlap = tokens.filter((t) => questionTokens.has(t)).length;
  if (overlap === 0) return 0;
  const cosine = cosineSimilarity(indexVector(text), query);
  return cosine + Math.min(0.5, overlap / 20);
}

/**
 * Assemble the bounded context.
 *
 * The budget is spent in precedence order, so if it runs out it is the LOWEST
 * authority material that is dropped. Truncating the brand's own positioning to
 * make room for a performance inference would be exactly backwards.
 */
function buildContext(
  items: readonly RetrievedItem[],
  maxChars: number,
): {
  contextText: string;
  citations: Citation[];
  usedItems: RetrievedItem[];
} {
  const parts: string[] = [];
  const citations: Citation[] = [];
  const usedItems: RetrievedItem[] = [];
  let budget = maxChars;

  for (const item of items) {
    const block = fenceUntrusted(
      `BRAND KNOWLEDGE ${item.area} v${item.version}`,
      `${item.title}\n${item.body}`,
    );
    if (block.length > budget) break;
    budget -= block.length;
    parts.push(block);
    usedItems.push(item);
    citations.push({
      kind: 'knowledge',
      id: item.id,
      area: item.area,
      version: item.version,
      label: item.title || item.area,
    });
  }

  return { contextText: parts.join('\n\n'), citations, usedItems };
}
