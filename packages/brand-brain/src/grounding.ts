import type { BrandKnowledgeArea, TenantScopedClient } from '@brandspace/database';
import { systemClock, type Clock } from '@brandspace/shared';
import { BrandBrainRetriever, type RetrievalContext } from './retrieval';
import { knowledgeAsOfSafe } from './validity';

/**
 * THE ONE ENTRY POINT FOR BRAND BRAIN GROUNDING (Phase 2C, item 1).
 *
 * Every path that puts Brand Brain knowledge in front of a model asks here:
 * Brand Brain's own "Talk with the brand", the Content Studio (generation and
 * its inline tools), the Copilot, Strategy and the Creative Studio. What they
 * get back is decided in one place:
 *
 *   - APPROVED, UNEXPIRED FACTS ONLY. `BrandBrainRetriever` reads
 *     `usableKnowledgeWhere(asOf)` — `asOf` being today in the WORKSPACE'S time
 *     zone (D6) — and has no way to return a document chunk (Q14, Q20).
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
  return (await brandGroundingFacts(db, brandId))?.useBrandBrain === true;
}

/** The brand's switch and its workspace's clock, in one read. */
async function brandGroundingFacts(
  db: TenantScopedClient,
  brandId: string,
): Promise<{ useBrandBrain: boolean; timezone: string } | null> {
  const brand = await db.brand.findFirst({
    where: { id: brandId, deletedAt: null },
    select: { useBrandBrain: true, workspace: { select: { timezone: true } } },
  });
  return brand ? { useBrandBrain: brand.useBrandBrain, timezone: brand.workspace.timezone } : null;
}

export async function groundingFor(
  db: TenantScopedClient,
  request: GroundingRequest,
  clock: Clock = systemClock,
): Promise<Grounding> {
  const brand = await brandGroundingFacts(db, request.brandId);
  if (request.purpose === 'writing' && brand?.useBrandBrain !== true) return DISABLED;
  const retrieval = await new BrandBrainRetriever({ db }).retrieve({
    brandId: request.brandId,
    question: request.question,
    options: {
      maxItems: request.maxItems,
      maxChars: request.maxChars,
      area: request.area,
    },
    // D6: today in the workspace's zone. A brand this caller cannot see has no
    // facts to return anyway; UTC keeps the call well-formed.
    asOf: knowledgeAsOfSafe(brand?.timezone ?? 'UTC', clock.now()),
  });
  return { ...retrieval, enabled: true };
}
