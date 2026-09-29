import { createHash } from 'node:crypto';
import type { BrandKnowledgeArea, TenantScopedClient } from '@brandspace/database';
import { brandIdQueryFilter, systemClock, type Clock } from '@brandspace/shared';
import {
  BrandBrainRetriever,
  contextFromFacts,
  usableKnowledgeWhere,
  type RetrievalContext,
} from './retrieval';
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

/*
 * ---------------------------------------------------------------------------
 * D10 REWRITE (Phase 2C-3) — "Rewrite with the new fact" / "without this fact"
 * ---------------------------------------------------------------------------
 */

/** What became of one fact a variant recorded, for the rewrite's audit trail. */
export interface RewriteResolution {
  readonly recordedItemId: string;
  /** The fact that grounds the rewrite in its place, or null when dropped. */
  readonly usedItemId: string | null;
  readonly outcome: 'current' | 'replacement' | 'dropped';
}

/**
 * THE REWRITE'S GROUNDING STARTS FROM WHAT THE VARIANT RECORDED — and from
 * nothing else. It is not a question: it does not look for other relevant
 * facts, so a rewrite can never pull in a fact the caption did not use. For
 * each recorded fact id:
 *
 *   - still usable (D-354's rule, today in the workspace's zone) → its CURRENT
 *     version;
 *   - archived, with a `supersededByItemId` replacement that is usable → the
 *     replacement's current version (one step, as recorded by the review);
 *   - anything else — expired, archived with no usable replacement, never
 *     approved — is DROPPED.
 *
 * A pending candidate, an unreviewed fact or a raw chunk cannot appear: only
 * `brand_knowledge_item` rows passing `usableKnowledgeWhere` are read for the
 * prompt. The brand's switch applies as for all writing: off gives an empty,
 * disabled grounding and the knowledge table is not read.
 */
export async function rewriteGroundingFor(
  db: TenantScopedClient,
  request: {
    readonly brandId: string;
    readonly recordedItemIds: readonly string[];
    readonly maxChars: number;
  },
  clock: Clock = systemClock,
): Promise<Grounding & { readonly resolutions: readonly RewriteResolution[] }> {
  const brand = await brandGroundingFacts(db, request.brandId);
  if (brand?.useBrandBrain !== true) {
    return {
      ...DISABLED,
      resolutions: request.recordedItemIds.map((recordedItemId) => ({
        recordedItemId,
        usedItemId: null,
        outcome: 'dropped' as const,
      })),
    };
  }
  const asOf = knowledgeAsOfSafe(brand.timezone, clock.now());
  const recorded = [...new Set(request.recordedItemIds)];
  const select = {
    id: true,
    area: true,
    memory: true,
    origin: true,
    version: true,
    status: true,
    title: true,
    body: true,
  } as const;

  const usable = await db.brandKnowledgeItem.findMany({
    where: { brandId: request.brandId, id: { in: recorded }, ...usableKnowledgeWhere(asOf) },
    select,
  });
  const usableIds = new Set(usable.map((item) => item.id));
  const archived = await db.brandKnowledgeItem.findMany({
    where: {
      brandId: request.brandId,
      id: { in: recorded.filter((id) => !usableIds.has(id)) },
      status: 'ARCHIVED',
      supersededByItemId: { not: null },
    },
    select: { id: true, supersededByItemId: true },
  });
  const replacements = await db.brandKnowledgeItem.findMany({
    where: {
      brandId: request.brandId,
      id: { in: archived.map((item) => item.supersededByItemId as string) },
      ...usableKnowledgeWhere(asOf),
    },
    select,
  });
  const replacementById = new Map(replacements.map((item) => [item.id, item]));

  const chosen = new Map(usable.map((item) => [item.id, item]));
  const resolutions: RewriteResolution[] = recorded.map((recordedItemId) => {
    if (usableIds.has(recordedItemId)) {
      return { recordedItemId, usedItemId: recordedItemId, outcome: 'current' };
    }
    const next = archived.find((item) => item.id === recordedItemId)?.supersededByItemId;
    const replacement = next ? replacementById.get(next) : undefined;
    if (replacement) {
      chosen.set(replacement.id, replacement);
      return { recordedItemId, usedItemId: replacement.id, outcome: 'replacement' };
    }
    return { recordedItemId, usedItemId: null, outcome: 'dropped' };
  });

  return {
    ...contextFromFacts([...chosen.values()], request.maxChars),
    enabled: true,
    resolutions,
  };
}

/**
 * WHETHER A KEY QUESTION IS ANSWERED FOR ASKING (Phase 2C-3, D7/D8): a usable
 * fact (D-354, today in the workspace's zone) with that key exists in that
 * area. Brand Brain's Ask and the Copilot use it to say plainly what is
 * MISSING — "Brand Brain doesn't have Prices yet (Offers)" — only when it is.
 * A yes/no, never text: nothing read here reaches a prompt.
 */
export async function keyQuestionAnswered(
  db: TenantScopedClient,
  request: {
    readonly brandId: string;
    readonly area: BrandKnowledgeArea;
    readonly itemKey: string;
  },
  clock: Clock = systemClock,
): Promise<boolean> {
  const brand = await brandGroundingFacts(db, request.brandId);
  if (!brand) return false;
  const found = await db.brandKnowledgeItem.findFirst({
    where: {
      brandId: request.brandId,
      area: request.area,
      itemKey: request.itemKey,
      ...usableKnowledgeWhere(knowledgeAsOfSafe(brand.timezone, clock.now())),
    },
    select: { id: true },
  });
  return found !== null;
}

/*
 * ---------------------------------------------------------------------------
 * PHASE 2C-4 (Item 6) — the Strategy page's two readers
 * ---------------------------------------------------------------------------
 */

/**
 * D13 — THE SIGNATURE OF A BRAND'S USABLE KNOWLEDGE.
 *
 * Lowercase hex SHA-256 over the brand's usable facts as `itemId:version`
 * pairs, SORTED (so the order they are read in cannot change it) and joined by
 * a newline. "Usable" is THIS layer's rule — `usableKnowledgeWhere`: ACTIVE or
 * STALE (so reviewed and not archived), and not expired as of today in the
 * WORKSPACE's time zone. It deliberately ignores the brand's "Use Brand Brain"
 * switch: it describes what the brand has approved, not whether writing reads
 * it.
 *
 * So it changes when a usable fact gets a new version, is archived, expires,
 * or a new fact is approved — and does not change for a PENDING candidate, a
 * re-read that only proposes, a page view, or a fact that was not usable
 * anyway. The Strategy engine stores it on the STRATEGY and MONTHLY_PLAN it
 * generates (M7); the Strategy page compares it with this.
 *
 * Reads ids and versions only — no title, no body: nothing here reaches a
 * prompt.
 */
export async function knowledgeSignatureFor(
  db: TenantScopedClient,
  request: { readonly brandId: string },
  clock: Clock = systemClock,
): Promise<string> {
  const brand = await brandGroundingFacts(db, request.brandId);
  const rows = brand
    ? await db.brandKnowledgeItem.findMany({
        where: {
          brandId: request.brandId,
          ...usableKnowledgeWhere(knowledgeAsOfSafe(brand.timezone, clock.now())),
        },
        select: { id: true, version: true },
      })
    : [];
  return knowledgeSignatureOf(rows.map((row) => ({ itemId: row.id, version: row.version })));
}

/**
 * D13 — WHETHER "BRAND BRAIN CHANGED" SINCE A STRATEGY WAS GENERATED: its
 * stored signature differs from the current one. A strategy with NO stored
 * signature (older than M7) has no baseline and never alerts. Reads only.
 */
export async function brandBrainChangedSince(
  db: TenantScopedClient,
  request: { readonly brandId: string; readonly storedSignature: string | null | undefined },
  clock: Clock = systemClock,
): Promise<boolean> {
  if (typeof request.storedSignature !== 'string') return false;
  return request.storedSignature !== (await knowledgeSignatureFor(db, request, clock));
}

/** The signature's arithmetic, on its own so it can be checked without a database. */
export function knowledgeSignatureOf(
  facts: readonly { readonly itemId: string; readonly version: number }[],
): string {
  const lines = facts.map((fact) => `${fact.itemId}:${fact.version}`).sort();
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

/**
 * THE STRATEGY PAGE'S DISPLAY LISTS — audience, key messages and declared
 * pillars (the §9.1 fix). They used `status: 'ACTIVE'`, so an EXPIRED fact
 * was still shown and a STALE one (usable, only due for review) was not. They
 * now read the SAME usable rule writing uses, with today in the workspace's
 * time zone. Display only: the page builds no prompt from these, so the
 * brand's "Use Brand Brain" switch does not hide them — a brand that writes
 * ungrounded still shows the approved knowledge it has.
 */
export async function usableFactsForDisplay(
  db: TenantScopedClient,
  request: {
    readonly brandId: string;
    readonly areas: readonly BrandKnowledgeArea[];
    readonly take: number;
  },
  clock: Clock = systemClock,
): Promise<
  readonly {
    readonly id: string;
    readonly area: BrandKnowledgeArea;
    readonly title: unknown;
    readonly body: unknown;
  }[]
> {
  return db.brandKnowledgeItem.findMany({
    where: {
      brandId: request.brandId,
      area: { in: [...request.areas] },
      ...usableKnowledgeWhere(await workspaceKnowledgeAsOf(db, clock)),
      NOT: { itemKey: { startsWith: GOAL_KEY_PREFIX } },
    },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, area: true, title: true, body: true },
    take: request.take,
  });
}
