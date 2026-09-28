import type { BrandKnowledgeArea, TenantScopedClient } from '@brandspace/database';
import { brandIdQueryFilter, systemClock, type Clock } from '@brandspace/shared';
import { BrandBrainRetriever, usableKnowledgeWhere, type RetrievalContext } from './retrieval';
import { knowledgeAsOfSafe, workspaceKnowledgeAsOf } from './validity';

/**
 * THE ONE GROUNDING LAYER FOR BRAND BRAIN (Phase 2C, item 1; D-354).
 *
 * Every path that puts Brand Brain knowledge in front of a model asks this
 * module — `groundingFor` for a question-shaped lookup, and the narrowly named
 * helpers at the end of the file for the few writing paths that need a fixed
 * selection rather than a ranked one:
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

/*
 * ---------------------------------------------------------------------------
 * NON-LEXICAL WRITING LOOKUPS (owner review of PR #52)
 * ---------------------------------------------------------------------------
 *
 * Some writing paths do not ask a question; they need a FIXED selection of
 * facts: the Creative Studio's identity and voice lines, the pillars Strategy
 * checks for gaps, the pillar ideas and the goal the composer turns into a
 * brief. They live here, beside `groundingFor`, so the three writing rules are
 * applied in ONE module and no caller re-implements them:
 *
 *   - `usableKnowledgeWhere` — ACTIVE or STALE, never expired;
 *   - `asOf` — today in the WORKSPACE's time zone (D6);
 *   - the brand's "Use Brand Brain" switch (D9) — a brand that turned it off
 *     contributes nothing, and neither does a deleted one.
 *
 * The switch is a condition of the same query (`brand.useBrandBrain`), so a
 * lookup across several brands honours each brand's own switch. Each helper
 * selects only what its callers use: none of them widens what a caller sees.
 */

/** Keys under `goal.` are a brand's GOALS (D-277 §6, D-335) — never a content pillar. */
export const GOAL_KEY_PREFIX = 'goal.';

/**
 * What a reader of the brand's goal asks for (D-335): its title, where it came
 * from, the kind of its latest version, and the goal key the brand carries.
 * The dashboard's `GOAL_ITEM_SELECT` IS this object, so every reader of the
 * goal reads it the same way.
 */
export const BRAND_GOAL_SELECT = {
  title: true,
  origin: true,
  versions: { orderBy: { version: 'desc' }, take: 1, select: { changeKind: true } },
  brand: { select: { primaryGoalKey: true } },
} as const;

/** The usable-fact rule plus the switch, as one query condition. */
async function writingKnowledgeWhere(db: TenantScopedClient, clock: Clock) {
  return {
    ...usableKnowledgeWhere(await workspaceKnowledgeAsOf(db, clock)),
    brand: { useBrandBrain: true, deletedAt: null },
  };
}

/**
 * CREATIVE: the brand's usable facts in the given areas, in a stable order
 * (area, then key), at most `maxItems`. Bodies only — the image prompt fences
 * them (`@brandspace/creative`).
 */
export async function writingFactsInAreas(
  db: TenantScopedClient,
  request: {
    readonly brandId: string;
    readonly areas: readonly BrandKnowledgeArea[];
    readonly maxItems: number;
  },
  clock: Clock = systemClock,
): Promise<readonly { readonly body: unknown }[]> {
  return db.brandKnowledgeItem.findMany({
    where: {
      brandId: request.brandId,
      area: { in: [...request.areas] },
      ...(await writingKnowledgeWhere(db, clock)),
    },
    orderBy: [{ area: 'asc' }, { itemKey: 'asc' }],
    take: request.maxItems,
    select: { body: true },
  });
}

/**
 * STRATEGY: the KEYS of the content pillars a brand declared — its usable
 * STRATEGY facts that are not goals. Keys only: a gap is "no post used this
 * pillar", and a post carries the pillar's key.
 */
export async function declaredPillarKeys(
  db: TenantScopedClient,
  request: { readonly brandId: string; readonly maxItems: number },
  clock: Clock = systemClock,
): Promise<readonly string[]> {
  const rows = await db.brandKnowledgeItem.findMany({
    where: {
      brandId: request.brandId,
      area: 'STRATEGY',
      ...(await writingKnowledgeWhere(db, clock)),
      NOT: { itemKey: { startsWith: GOAL_KEY_PREFIX } },
    },
    select: { itemKey: true },
    take: request.maxItems,
  });
  return rows.map((row) => row.itemKey);
}

/**
 * THE COMPOSER: pillar IDEAS — each becomes an AI brief when picked. One brand,
 * or every brand in the member's scope; each brand's own switch applies.
 */
export async function declaredPillarIdeas(
  db: TenantScopedClient,
  request: {
    readonly brandId?: string | undefined;
    readonly brandScope?: readonly string[] | null | undefined;
    readonly maxItems: number;
  },
  clock: Clock = systemClock,
): Promise<readonly { readonly id: string; readonly title: unknown }[]> {
  return db.brandKnowledgeItem.findMany({
    where: {
      area: 'STRATEGY',
      ...(await writingKnowledgeWhere(db, clock)),
      NOT: { itemKey: { startsWith: GOAL_KEY_PREFIX } },
      ...brandIdQueryFilter({ brandId: request.brandId, brandScope: request.brandScope }),
    },
    select: { id: true, title: true },
    take: request.maxItems,
  });
}

/**
 * THE BRAND'S GOAL, FOR WRITING: the composer and Strategy turn it into a brief
 * or an objective. Null when it is expired, not approved, or the brand turned
 * Brand Brain off — a writing flow then simply has no recommended goal.
 */
export async function writingGoal(
  db: TenantScopedClient,
  request: { readonly brandId: string; readonly itemKey: string },
  clock: Clock = systemClock,
) {
  return db.brandKnowledgeItem.findFirst({
    where: {
      brandId: request.brandId,
      area: 'STRATEGY',
      itemKey: request.itemKey,
      ...(await writingKnowledgeWhere(db, clock)),
    },
    select: BRAND_GOAL_SELECT,
  });
}
