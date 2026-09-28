import type { BrandKnowledgeArea, TenantScopedClient } from '@brandspace/database';
import { BrandBrainRetriever, type RetrievalContext } from './retrieval';

/**
 * THE ONE ENTRY POINT FOR BRAND BRAIN GROUNDING (Phase 2C, item 1).
 *
 * Every path that puts Brand Brain knowledge in front of a model asks here:
 * Brand Brain's own "Talk with the brand", the Content Studio (generation and
 * its inline tools), the Copilot, Strategy and the Creative Studio. What they
 * get back is decided in one place:
 *
 *   - APPROVED FACTS ONLY. `BrandBrainRetriever` reads `usableKnowledgeWhere()`
 *     and has no way to return a document chunk (Q14, Q20).
 *   - THE BRAND'S "USE BRAND BRAIN" SWITCH (D9). For WRITING, a brand that has
 *     switched it off gets an empty grounding, and the knowledge table is not
 *     even read. Brand Brain's own chat is `purpose: 'ask'` and is not affected
 *     (owner, 2026-09-28): it IS Brand Brain.
 *
 * AN EMPTY GROUNDING BECAUSE THE SWITCH IS OFF IS NOT "INSUFFICIENT". Callers
 * that refuse when nothing relevant was found (the Studio, Strategy) must write
 * ungrounded instead when `enabled` is false — nothing refuses because the
 * switch is off (owner, 2026-09-28).
 */

export type GroundingPurpose = 'ask' | 'writing';

export interface Grounding extends RetrievalContext {
  /** False when the brand switched Brand Brain off for writing. */
  readonly enabled: boolean;
}

export interface GroundingRequest {
  readonly brandId: string;
  readonly question: string;
  readonly purpose: GroundingPurpose;
  readonly maxItems: number;
  readonly maxChars: number;
  readonly area?: BrandKnowledgeArea | undefined;
}

const DISABLED: Grounding = {
  enabled: false,
  items: [],
  facts: [],
  contextText: '',
  citations: [],
  insufficient: true,
};

/**
 * Whether this brand lets Brand Brain ground AI WRITING. Read under the
 * caller's RLS transaction; a brand that is not visible reads as switched off,
 * so a miss can never widen what a model is shown.
 */
export async function brandBrainEnabledForWriting(
  db: TenantScopedClient,
  brandId: string,
): Promise<boolean> {
  const brand = await db.brand.findFirst({
    where: { id: brandId, deletedAt: null },
    select: { useBrandBrain: true },
  });
  return brand?.useBrandBrain === true;
}

export async function groundingFor(
  db: TenantScopedClient,
  request: GroundingRequest,
): Promise<Grounding> {
  if (request.purpose === 'writing' && !(await brandBrainEnabledForWriting(db, request.brandId))) {
    return DISABLED;
  }
  const retrieval = await new BrandBrainRetriever({ db }).retrieve({
    brandId: request.brandId,
    question: request.question,
    options: {
      maxItems: request.maxItems,
      maxChars: request.maxChars,
      area: request.area,
    },
  });
  return { ...retrieval, enabled: true };
}
