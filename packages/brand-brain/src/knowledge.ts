import {
  writeAuditEvent,
  type BrandKnowledgeArea,
  type BrandKnowledgeItem,
  type BrandKnowledgeOrigin,
  type BrandMemoryLayer,
  type Prisma,
  type TenantScopedClient,
} from '@brandspace/database';
import {
  assertBrandInScope,
  brandIdQueryFilter,
  systemClock,
  type Clock,
} from '@brandspace/shared';
import { areaDefinition } from './areas';
import { mayOverwrite } from './precedence';
import { isExpired } from './validity';
import { indexVector, score, tokenize } from './retrieval';
import {
  alreadyReviewed,
  candidateNotFound,
  humanPrecedenceViolation,
  knowledgeChangedSince,
  knowledgeNotFound,
  versionNotFound,
} from './errors';
import type { LocalizedText } from './schemas';
import {
  type AreaCounts,
  type AreaQuestions,
  computeBrandCompletion,
  type BrandCompletion,
} from './completion';

/**
 * Knowledge governance — the write side of Brand Brain.
 *
 * EVERY MUTATION HERE DOES THREE THINGS TOGETHER, IN ONE TRANSACTION: it
 * changes the item, it appends a version, and it writes an audit event. They
 * are not three calls a future caller could make two of. A version history with
 * a gap is worse than none, because it looks complete.
 *
 * The client passed in is ALWAYS the tenant-scoped one, so every statement runs
 * under RLS. Nothing here filters by workspace in a `where` clause and calls
 * that isolation — the scoping is the transaction's, not this file's.
 */

export interface KnowledgeActor {
  readonly userId: string;
  readonly permissionKeys: readonly string[];
  /**
   * The member's brand scope — docs/SECURITY.md §4.2, and F-74 closed.
   *
   * REQUIRED, not optional. An optional field would default to unrestricted,
   * and a call site that forgot it would silently grant every brand — which is
   * precisely the shape of the gap this closes. An empty array means
   * unrestricted, which is what the schema says and what every membership in
   * existence currently carries; a non-empty one restricts.
   *
   * Every method below that resolves a brand checks it, so the rule is enforced
   * once per operation in the service rather than once per call site in four
   * applications.
   */
  readonly brandScope: readonly string[];
}

/** Why "Accept the confident ones" left a confirmed candidate alone. */
export type BulkSkipReason = 'not_eligible';

export interface BrandKnowledgeCandidateSummary {
  readonly id: string;
  readonly area: BrandKnowledgeArea;
  readonly itemKey: string;
  readonly confidenceMilli: number;
  readonly title: LocalizedText;
}

export interface KnowledgeServiceOptions {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
  /** Injected so tests control time rather than sleeping. */
  readonly clock?: Clock;
}

/** How long an ACTIVE item may go unreviewed before it is stale. */
export interface StalenessPolicy {
  readonly reviewIntervalDays: number;
}

type Db = TenantScopedClient;

/** Prisma's Json input, narrowed to what localized text actually is. */
function toJson(text: LocalizedText): Prisma.InputJsonValue {
  const out: Record<string, string> = {};
  if (text.en?.length) out['en'] = text.en;
  if (text.ar?.length) out['ar'] = text.ar;
  return out;
}

export function localizedFrom(value: Prisma.JsonValue | null): LocalizedText {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const en = typeof record['en'] === 'string' ? record['en'] : undefined;
  const ar = typeof record['ar'] === 'string' ? record['ar'] : undefined;
  return { en, ar };
}

export class BrandKnowledgeService {
  private readonly db: Db;
  private readonly workspaceId: string;
  private readonly clock: Clock;

  constructor(options: KnowledgeServiceOptions) {
    this.db = options.db;
    this.workspaceId = options.workspaceId;
    this.clock = options.clock ?? systemClock;
  }

  private now(): Date {
    return this.clock.now();
  }

  /**
   * Create a human-entered knowledge item.
   *
   * Human-entered means `origin: HUMAN` and `status: ACTIVE` immediately: a
   * person typing into their own brand guidelines is not proposing something
   * for review, they are stating it. D-65's approval gate exists for what the
   * SYSTEM infers, and applying it to human input would be theatre.
   */
  async createItem(input: {
    brandId: string;
    area: BrandKnowledgeArea;
    itemKey: string;
    title: LocalizedText;
    body: LocalizedText;
    actor: KnowledgeActor;
    policy: StalenessPolicy;
    /**
     * HUMAN unless the setup wizard is writing (D-335): its goal is SETUP. No
     * other origin is accepted here — an inference or a document never enters
     * through the human path.
     */
    origin?: 'HUMAN' | 'SETUP';
    /** D6 — the optional last day (a workspace-local calendar date). */
    validUntil?: Date | null | undefined;
  }): Promise<BrandKnowledgeItem> {
    // The brand is named by the caller here, so it is checked before anything
    // is written. An out-of-scope brand is a 404 shaped like a genuine miss.
    assertBrandInScope(input.actor.brandScope, input.brandId);

    const definition = areaDefinition(input.area);
    const now = this.now();

    const item = await this.db.brandKnowledgeItem.create({
      data: {
        workspaceId: this.workspaceId,
        brandId: input.brandId,
        area: input.area,
        memory: definition.memory,
        origin: input.origin ?? 'HUMAN',
        status: 'ACTIVE',
        itemKey: input.itemKey,
        title: toJson(input.title),
        body: toJson(input.body),
        createdByUserId: input.actor.userId,
        version: 1,
        lastReviewedAt: now,
        reviewDueAt: addDays(now, input.policy.reviewIntervalDays),
        validUntil: input.validUntil ?? null,
      },
    });

    await this.appendVersion(item, {
      changedByUserId: input.actor.userId,
      changeKind: 'created',
    });

    await writeAuditEvent(this.db, this.workspaceId, {
      action: 'brand_brain.knowledge.created',
      actorType: 'USER',
      actorId: input.actor.userId,
      resourceType: 'BrandKnowledgeItem',
      resourceId: item.id,
      brandId: input.brandId,
      // `after` passes through the redaction layer. The BODY is customer
      // content, not a secret, and the audit log is the customer's own — but
      // only the shape is recorded, not the prose, so the audit table does not
      // quietly become a second copy of the corpus.
      after: {
        area: input.area,
        itemKey: input.itemKey,
        version: 1,
        ...(input.origin === 'SETUP' ? { origin: 'SETUP' } : {}),
      },
    });

    return item;
  }

  /**
   * Edit an item. A new VERSION, never an overwrite.
   *
   * The precedence check runs even for a human edit, because the same path
   * serves an accepted AI candidate. `mayOverwrite` is what refuses an
   * inference aimed at human knowledge (D-65) — and it is checked HERE, at the
   * write, rather than in the review screen, so a second caller cannot bypass
   * it by not being a screen.
   */
  async updateItem(input: {
    itemId: string;
    title: LocalizedText;
    body: LocalizedText;
    changeReason?: string | undefined;
    actor: KnowledgeActor;
    policy: StalenessPolicy;
    /** What is doing the writing. Defaults to a human edit. */
    incomingOrigin?: BrandKnowledgeOrigin;
    changeKind?: string;
    /**
     * D6 — the fact's last valid day. `undefined` leaves it as it is; `null`
     * clears it. Setting it is part of THIS version, so the history shows it.
     */
    validUntil?: Date | null | undefined;
    /**
     * D7 (Phase 2C-3) — an OPTIONAL concurrency precondition: the version the
     * person was looking at. When given, the write happens only if the fact is
     * still at that version, checked by the write itself (a conditional
     * UPDATE in this transaction), so two people editing at once cannot lose
     * each other's work: the second is told "changed since" and nothing is
     * written. Callers that omit it keep their behaviour exactly.
     */
    expectedVersion?: number | undefined;
  }): Promise<BrandKnowledgeItem> {
    // D-132: BOTH tenancy checks are PREDICATES. RLS supplies the workspace
    // one; `brandIdQueryFilter` supplies the brand one, so a row outside the
    // member's scope is never retrieved rather than retrieved and then
    // rejected. Every miss produces the same 404 — another tenant's row,
    // another brand's row, and an id that never existed are indistinguishable
    // (F-74).
    const existing = await this.db.brandKnowledgeItem.findFirst({
      where: { id: input.itemId, ...brandIdQueryFilter({ brandScope: input.actor.brandScope }) },
    });
    if (!existing) throw knowledgeNotFound();
    if (input.expectedVersion !== undefined && existing.version !== input.expectedVersion) {
      throw knowledgeChangedSince(input.expectedVersion);
    }

    const incomingOrigin = input.incomingOrigin ?? 'HUMAN';
    const decision = mayOverwrite(
      {
        memory: existing.memory,
        origin: existing.origin,
        version: existing.version,
        id: existing.id,
      },
      {
        memory: existing.memory,
        origin: incomingOrigin,
        version: existing.version + 1,
        id: existing.id,
      },
    );
    if (!decision.allowed) throw humanPrecedenceViolation();

    const now = this.now();
    const data = {
      title: toJson(input.title),
      body: toJson(input.body),
      /*
       * THE ROW SAYS WHO WROTE WHAT IT NOW SAYS (D-335). The origin is the
       * effective origin of THIS write, not of the row's first one: a person
       * editing a SETUP or DOCUMENT fact makes it HUMAN, and a document
       * accepted on the setup wizard's Review step makes it SETUP. Keeping
       * the old origin would let a later lower-authority write replace text
       * a person wrote, because `mayOverwrite` would still see the old
       * origin. `appendVersion` copies the updated row, so the version
       * carries the same origin as the item it represents.
       */
      origin: incomingOrigin,
      version: { increment: 1 },
      // A human editing an item has just reviewed it, by definition.
      lastReviewedAt: now,
      reviewDueAt: addDays(now, input.policy.reviewIntervalDays),
      // An edit resolves the staleness that prompted it, and clears a
      // conflict flag that referred to the previous text.
      conflictsWithItemId: null,
      status: existing.status === 'STALE' ? 'ACTIVE' : existing.status,
      ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}),
    } satisfies Prisma.BrandKnowledgeItemUncheckedUpdateManyInput;

    let updated: BrandKnowledgeItem;
    if (input.expectedVersion === undefined) {
      updated = await this.db.brandKnowledgeItem.update({ where: { id: existing.id }, data });
    } else {
      /*
       * THE PRECONDITION IS PART OF THE WRITE. The read above answers the
       * common case; this conditional UPDATE is what decides a race — it takes
       * the row lock and matches only while the version is still the expected
       * one, so a concurrent edit that committed first makes this write no
       * rows, and nothing is overwritten.
       */
      const written = await this.db.brandKnowledgeItem.updateMany({
        where: { id: existing.id, version: input.expectedVersion },
        data,
      });
      if (written.count !== 1) throw knowledgeChangedSince(input.expectedVersion);
      updated = await this.db.brandKnowledgeItem.findUniqueOrThrow({ where: { id: existing.id } });
    }

    await this.appendVersion(updated, {
      changedByUserId: input.actor.userId,
      changeKind: input.changeKind ?? 'edited',
      changeReason: input.changeReason,
    });

    await writeAuditEvent(this.db, this.workspaceId, {
      action: 'brand_brain.knowledge.updated',
      actorType: incomingOrigin === 'AI_INFERRED' ? 'AUTOMATION' : 'USER',
      actorId: input.actor.userId,
      resourceType: 'BrandKnowledgeItem',
      resourceId: updated.id,
      brandId: updated.brandId,
      before: {
        version: existing.version,
        origin: existing.origin,
        validUntil: existing.validUntil ? isoDay(existing.validUntil) : null,
      },
      after: {
        version: updated.version,
        origin: updated.origin,
        reason: input.changeReason ?? null,
        validUntil: updated.validUntil ? isoDay(updated.validUntil) : null,
      },
    });

    return updated;
  }

  /**
   * Restore a previous version.
   *
   * A rollback is a FORWARD version, not a rewind: the history gains a row
   * saying "restored to v3", and v3 itself is untouched. Deleting the versions
   * in between would destroy the record of what happened, which is exactly what
   * D-65 versioning exists to prevent — and the append-only trigger would
   * refuse it anyway.
   */
  async rollback(input: {
    itemId: string;
    toVersion: number;
    reason?: string | undefined;
    actor: KnowledgeActor;
    policy: StalenessPolicy;
  }): Promise<BrandKnowledgeItem> {
    // D-132, as in `upsert` above: the scope is part of the WHERE.
    const item = await this.db.brandKnowledgeItem.findFirst({
      where: { id: input.itemId, ...brandIdQueryFilter({ brandScope: input.actor.brandScope }) },
    });
    if (!item) throw knowledgeNotFound();

    const target = await this.db.brandKnowledgeVersion.findFirst({
      where: { knowledgeItemId: item.id, version: input.toVersion },
    });
    if (!target) throw versionNotFound();

    const now = this.now();
    const restored = await this.db.brandKnowledgeItem.update({
      where: { id: item.id },
      data: {
        title: target.title as Prisma.InputJsonValue,
        body: target.body as Prisma.InputJsonValue,
        version: { increment: 1 },
        lastReviewedAt: now,
        reviewDueAt: addDays(now, input.policy.reviewIntervalDays),
        conflictsWithItemId: null,
        status: 'ACTIVE',
      },
    });

    await this.appendVersion(restored, {
      changedByUserId: input.actor.userId,
      changeKind: 'rolled_back',
      changeReason: input.reason ?? `Restored version ${input.toVersion}`,
    });

    await writeAuditEvent(this.db, this.workspaceId, {
      action: 'brand_brain.knowledge.rolled_back',
      actorType: 'USER',
      actorId: input.actor.userId,
      resourceType: 'BrandKnowledgeItem',
      resourceId: item.id,
      brandId: item.brandId,
      before: { version: item.version },
      after: { version: restored.version, restoredFrom: input.toVersion },
    });

    return restored;
  }

  /** Archive an item. Never a hard delete: the corpus keeps its history. */
  async archiveItem(input: {
    itemId: string;
    reason?: string | undefined;
    actor: KnowledgeActor;
    /**
     * D4 — the fact that replaced this one, when an accepted candidate that
     * conflicted with it is what archived it. Recorded on the row; the version
     * history is untouched.
     */
    supersededByItemId?: string | undefined;
  }): Promise<BrandKnowledgeItem> {
    // D-132, as in `upsert` above: the scope is part of the WHERE.
    const item = await this.db.brandKnowledgeItem.findFirst({
      where: { id: input.itemId, ...brandIdQueryFilter({ brandScope: input.actor.brandScope }) },
    });
    if (!item) throw knowledgeNotFound();

    const archived = await this.db.brandKnowledgeItem.update({
      where: { id: item.id },
      data: {
        status: 'ARCHIVED',
        archivedAt: this.now(),
        version: { increment: 1 },
        ...(input.supersededByItemId ? { supersededByItemId: input.supersededByItemId } : {}),
      },
    });

    await this.appendVersion(archived, {
      changedByUserId: input.actor.userId,
      changeKind: input.supersededByItemId ? 'superseded' : 'archived',
      changeReason: input.reason,
    });

    await writeAuditEvent(this.db, this.workspaceId, {
      action: 'brand_brain.knowledge.archived',
      actorType: 'USER',
      actorId: input.actor.userId,
      resourceType: 'BrandKnowledgeItem',
      resourceId: item.id,
      brandId: item.brandId,
      after: {
        reason: input.reason ?? null,
        ...(input.supersededByItemId ? { supersededByItemId: input.supersededByItemId } : {}),
      },
    });

    return archived;
  }

  /**
   * UNDO A REMOVE — Brand Brain chat's Remove mode (D7, Phase 2C-3).
   *
   * Undo is the ordinary `rollback` to the version before the archive, and ONLY
   * for the archive the person just made: the fact must still be ARCHIVED and
   * still at `archivedVersion`. The precondition is checked by a conditional
   * UPDATE in THIS transaction — it takes the row lock and matches nothing if
   * the fact was restored, edited or archived again since — so a second click,
   * or an Undo after somebody else's change, writes nothing and is told
   * "changed since". The generic `rollback` keeps its meaning for every other
   * caller; the wrapper also clears `archivedAt`, which the rollback does not
   * touch, because the fact is no longer archived.
   */
  async undoArchive(input: {
    itemId: string;
    archivedVersion: number;
    actor: KnowledgeActor;
    policy: StalenessPolicy;
  }): Promise<BrandKnowledgeItem> {
    const claimed = await this.db.brandKnowledgeItem.updateMany({
      where: {
        id: input.itemId,
        status: 'ARCHIVED',
        version: input.archivedVersion,
        ...brandIdQueryFilter({ brandScope: input.actor.brandScope }),
      },
      data: { archivedAt: null },
    });
    if (claimed.count !== 1) {
      // A fact outside the member's scope, or one that never existed, is the
      // same miss; one that exists but moved on is "changed since".
      const visible = await this.db.brandKnowledgeItem.findFirst({
        where: { id: input.itemId, ...brandIdQueryFilter({ brandScope: input.actor.brandScope }) },
        select: { id: true },
      });
      if (!visible) throw knowledgeNotFound();
      throw knowledgeChangedSince(input.archivedVersion);
    }
    return this.rollback({
      itemId: input.itemId,
      toVersion: input.archivedVersion - 1,
      reason: 'Undo remove',
      actor: input.actor,
      policy: input.policy,
    });
  }

  /**
   * SEND FOR REVIEW — a MEMBER candidate (D7, Phase 2C-3; migrations M4a/M4b).
   *
   * A member who may EDIT Brand Brain but may not REVIEW it does not create an
   * approved fact: they propose one, into the one review inbox, exactly where a
   * document's facts wait. `sourceKind = MEMBER`, no document, no insight, and
   * `proposedByUserId` names them (the M4b CHECK requires it). Accepting it
   * later is the ordinary `reviewCandidate` by somebody with
   * `brand_brain.review`, and the fact lands as HUMAN — a person wrote it.
   *
   * The caller decides WHO may call this (`brand_brain.edit`); nothing here
   * reads a permission, so no screen can widen it.
   */
  async proposeFact(input: {
    brandId: string;
    area: BrandKnowledgeArea;
    itemKey: string;
    title: LocalizedText;
    body: LocalizedText;
    actor: KnowledgeActor;
  }): Promise<{ readonly candidateId: string }> {
    assertBrandInScope(input.actor.brandScope, input.brandId);
    const target = await this.db.brandKnowledgeItem.findFirst({
      where: { brandId: input.brandId, area: input.area, itemKey: input.itemKey },
      select: { id: true },
    });
    const candidate = await this.db.brandKnowledgeCandidate.create({
      data: {
        workspaceId: this.workspaceId,
        brandId: input.brandId,
        sourceKind: 'MEMBER',
        sourceDocumentId: null,
        insightId: null,
        proposedByUserId: input.actor.userId,
        targetItemId: target?.id ?? null,
        area: input.area,
        itemKey: input.itemKey,
        extractedTitle: toJson(input.title),
        extractedBody: toJson(input.body),
        // A person's statement is not a probability; the inbox shows who
        // proposed it instead of a confidence (D-358 stays for documents).
        confidenceMilli: 1000,
        evidence: { method: 'member' },
        status: 'PENDING',
      },
      select: { id: true },
    });
    await writeAuditEvent(this.db, this.workspaceId, {
      action: 'brand_brain.fact.proposed',
      actorType: 'USER',
      actorId: input.actor.userId,
      resourceType: 'BrandKnowledgeCandidate',
      resourceId: candidate.id,
      brandId: input.brandId,
      after: { area: input.area, itemKey: input.itemKey, replaces: target !== null },
    });
    return { candidateId: candidate.id };
  }

  /**
   * THE MANAGEMENT LOOKUP for Brand Brain chat's Edit and Remove modes (D7).
   *
   * NOT GROUNDING, AND NEVER A PROMPT: it finds the facts a person may want to
   * change, and they choose one. So it reads what grounding never does —
   * EXPIRED facts, which a person can still edit (D-356) — and never an
   * archived one, which there is nothing left to edit or remove. The matching
   * is the retriever's own local lexical `score`: overlapping words and the
   * deterministic local vector, no model, no network, no credits.
   */
  async matchFacts(input: {
    brandId: string;
    query: string;
    limit: number;
    brandScope: readonly string[];
  }): Promise<
    readonly {
      readonly id: string;
      readonly area: BrandKnowledgeArea;
      readonly itemKey: string;
      readonly version: number;
      readonly title: LocalizedText;
      readonly body: LocalizedText;
      readonly validUntil: Date | null;
    }[]
  > {
    assertBrandInScope(input.brandScope, input.brandId);
    const vector = indexVector(input.query);
    const tokens = new Set(tokenize(input.query));
    const rows = await this.db.brandKnowledgeItem.findMany({
      where: { brandId: input.brandId, status: { in: ['ACTIVE', 'STALE'] } },
      select: {
        id: true,
        area: true,
        itemKey: true,
        version: true,
        title: true,
        body: true,
        validUntil: true,
      },
      orderBy: { updatedAt: 'desc' },
      // The retriever's ceiling, for the same reason.
      take: 500,
    });
    return rows
      .map((row) => {
        const title = localizedFrom(row.title);
        const body = localizedFrom(row.body);
        const text = [title.en, title.ar, body.en, body.ar, row.itemKey.replace(/[._-]/g, ' ')]
          .filter(Boolean)
          .join(' ');
        return { row, title, body, relevance: score(text, vector, tokens) };
      })
      .filter((entry) => entry.relevance > 0)
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, input.limit)
      .map(({ row, title, body }) => ({
        id: row.id,
        area: row.area,
        itemKey: row.itemKey,
        version: row.version,
        title,
        body,
        validUntil: row.validUntil,
      }));
  }

  /**
   * Facts by id for MANAGEMENT screens (D7: "Fix it" opens Edit on one fact; a
   * changed-since answer shows the fresh version). ACTIVE or STALE, expired
   * included; read through the member's brand scope as a predicate. Never a
   * prompt.
   */
  async factsById(input: { itemIds: readonly string[]; brandScope: readonly string[] }): Promise<
    readonly {
      readonly id: string;
      readonly brandId: string;
      readonly area: BrandKnowledgeArea;
      readonly itemKey: string;
      readonly version: number;
      readonly title: LocalizedText;
      readonly body: LocalizedText;
      readonly validUntil: Date | null;
    }[]
  > {
    if (input.itemIds.length === 0) return [];
    const rows = await this.db.brandKnowledgeItem.findMany({
      where: {
        id: { in: [...input.itemIds] },
        status: { in: ['ACTIVE', 'STALE'] },
        ...brandIdQueryFilter({ brandScope: input.brandScope }),
      },
      select: {
        id: true,
        brandId: true,
        area: true,
        itemKey: true,
        version: true,
        title: true,
        body: true,
        validUntil: true,
      },
    });
    return rows.map((row) => ({
      ...row,
      title: localizedFrom(row.title),
      body: localizedFrom(row.body),
    }));
  }

  /**
   * PROPOSE AN INFERRED LEARNING — Phase 7, and the close of D-64's return path.
   *
   * WHAT THIS DELIBERATELY IS NOT: a write to Brand Brain. It creates a
   * CANDIDATE, in the same table, with the same PENDING status, judged through
   * the same `reviewCandidate` by the same `brand_brain.review` permission a
   * document candidate needs. Analytics does not get a private door into the
   * corpus; it gets the queue everything else uses.
   *
   * THREE PROPERTIES THAT MAKE IT SAFE TO POINT A STATISTIC AT A BRAND:
   *
   *  1. IT ONLY EVER TARGETS A LEARNING. The area is `LEARNINGS`, whose memory
   *     layer is D-64's lowest, and `targetItemId` is resolved WITHIN that area —
   *     so an inference can never be aimed at an item in CANONICAL, STRATEGY or
   *     any other area, whatever key it proposes. That is the structural half of
   *     "human-authored facts outrank inferred learning": the inference has
   *     nothing to overwrite.
   *
   *  2. A DISAGREEMENT IS RECORDED, NOT RESOLVED. When the proposed learning
   *     contradicts an ACTIVE, human-authored item elsewhere in the brand, the
   *     candidate records it in `conflictsWithItemId` and the review screen shows
   *     both. Nothing touches the human item. D-65 is explicit that the platform
   *     does not correct the brand on the strength of a statistic.
   *
   *  3. IT CARRIES ITS EVIDENCE. `insightId` points at the insight the inference
   *     came from, whose own evidence rows carry the metric, the value and the
   *     window — so a reviewer retraces the reasoning rather than trusting a
   *     sentence. That is what D-65 calls reproducibility.
   *
   * IDEMPOTENT ON (brand, area, itemKey, insight): the same inference proposed
   * twice finds its pending candidate rather than filling the queue with copies.
   */
  async proposeLearning(input: {
    brandId: string;
    itemKey: string;
    title: LocalizedText;
    body: LocalizedText;
    /** 0-1000 per mille. An inference is a probability; a human statement is not. */
    confidenceMilli: number;
    /** The insight this was drawn from. Required: an inference without evidence
     *  is an opinion, and this queue does not carry opinions. */
    insightId: string;
    /** Evidence references, copied from the insight so the candidate is readable
     *  on its own. Never a provider payload. */
    evidence: unknown;
    actorBrandScope: readonly string[];
  }): Promise<{ readonly candidateId: string; readonly created: boolean }> {
    assertBrandInScope(input.actorBrandScope, input.brandId);

    // D-132: the insight is read through the scope PREDICATE, so a foreign or
    // fabricated insight id is a miss rather than a link to somebody else's row.
    const insight = await this.db.insight.findFirst({
      where: {
        id: input.insightId,
        brandId: input.brandId,
        ...brandIdQueryFilter({ brandScope: input.actorBrandScope }),
      },
      select: { id: true },
    });
    if (!insight) throw candidateNotFound();

    const existing = await this.db.brandKnowledgeCandidate.findFirst({
      where: {
        brandId: input.brandId,
        area: 'LEARNINGS',
        itemKey: input.itemKey,
        insightId: input.insightId,
        status: 'PENDING',
      },
      select: { id: true },
    });
    if (existing) return { candidateId: existing.id, created: false };

    /*
     * THE TARGET IS RESOLVED INSIDE `LEARNINGS` AND NOWHERE ELSE. Even if a
     * caller proposed a key that collides with a canonical item, the lookup is
     * scoped to the learnings area, so the candidate can only ever offer to
     * replace a previous learning.
     */
    const target = await this.db.brandKnowledgeItem.findFirst({
      where: { brandId: input.brandId, area: 'LEARNINGS', itemKey: input.itemKey },
      select: { id: true },
    });

    /*
     * A CONFLICT IS ANYTHING HUMAN-AUTHORED, STILL ACTIVE, THAT SHARES THIS KEY
     * OUTSIDE THE LEARNINGS AREA. Detected here rather than at review time
     * because the reviewer needs to see it in the queue, before they decide.
     */
    const conflict = await this.db.brandKnowledgeItem.findFirst({
      where: {
        brandId: input.brandId,
        itemKey: input.itemKey,
        area: { not: 'LEARNINGS' },
        status: 'ACTIVE',
        origin: { in: ['HUMAN', 'DOCUMENT', 'SETUP'] },
      },
      select: { id: true },
    });

    const candidate = await this.db.brandKnowledgeCandidate.create({
      data: {
        workspaceId: this.workspaceId,
        brandId: input.brandId,
        sourceKind: 'ANALYTICS',
        // No document: an inference has none, and the CHECK constraint requires
        // the insight instead.
        sourceDocumentId: null,
        insightId: input.insightId,
        targetItemId: target?.id ?? null,
        conflictsWithItemId: conflict?.id ?? null,
        area: 'LEARNINGS',
        itemKey: input.itemKey,
        extractedTitle: toJson(input.title),
        extractedBody: toJson(input.body),
        confidenceMilli: input.confidenceMilli,
        evidence: input.evidence as Prisma.InputJsonValue,
        status: 'PENDING',
      },
    });

    await writeAuditEvent(this.db, this.workspaceId, {
      action: 'brand_brain.learning.proposed',
      // AUTOMATION, not USER: nobody asked for this, the system inferred it.
      actorType: 'AUTOMATION',
      resourceType: 'BrandKnowledgeCandidate',
      resourceId: candidate.id,
      brandId: input.brandId,
      after: {
        itemKey: input.itemKey,
        confidenceMilli: input.confidenceMilli,
        insightId: input.insightId,
        conflictsWithHumanKnowledge: conflict !== null,
      },
    });

    return { candidateId: candidate.id, created: true };
  }

  /**
   * Accept, edit-and-accept, or reject a candidate.
   *
   * THE ONLY PATH FROM AN UPLOAD TO APPROVED KNOWLEDGE. Extraction cannot call
   * anything else: it writes candidates, and this method is what a human uses
   * to promote one. The original extraction is preserved on the candidate row
   * whatever the reviewer does, so "what did the system actually say" remains
   * answerable after an edit.
   */
  async reviewCandidate(input: {
    candidateId: string;
    decision: 'accept' | 'accept_edited' | 'reject';
    title?: LocalizedText | undefined;
    body?: LocalizedText | undefined;
    reason?: string | undefined;
    actor: KnowledgeActor;
    policy: StalenessPolicy;
    /**
     * Set by the setup wizard's Review step (D-335): a DOCUMENT candidate
     * accepted there lands as SETUP. An ANALYTICS candidate stays AI_INFERRED
     * whatever the screen — see below.
     */
    acceptedInSetup?: boolean;
  }): Promise<{ readonly itemId: string | null; readonly version: number | null }> {
    // D-132, as above.
    const candidate = await this.db.brandKnowledgeCandidate.findFirst({
      where: {
        id: input.candidateId,
        ...brandIdQueryFilter({ brandScope: input.actor.brandScope }),
      },
    });
    if (!candidate) throw candidateNotFound();
    // Two reviewers opening the same queue is ordinary. The second one must be
    // told, not silently allowed to re-apply a decision.
    if (candidate.status !== 'PENDING') throw alreadyReviewed();

    const now = this.now();

    if (input.decision === 'reject') {
      await this.db.brandKnowledgeCandidate.update({
        where: { id: candidate.id },
        data: {
          status: 'REJECTED',
          reviewedByUserId: input.actor.userId,
          reviewedAt: now,
          reviewReason: input.reason ?? null,
        },
      });
      await writeAuditEvent(this.db, this.workspaceId, {
        action: 'brand_brain.candidate.rejected',
        actorType: 'USER',
        actorId: input.actor.userId,
        resourceType: 'BrandKnowledgeCandidate',
        resourceId: candidate.id,
        brandId: candidate.brandId,
        after: { area: candidate.area, itemKey: candidate.itemKey },
      });
      return { itemId: null, version: null };
    }

    const title =
      input.decision === 'accept_edited' && input.title
        ? input.title
        : localizedFrom(candidate.extractedTitle);
    const body =
      input.decision === 'accept_edited' && input.body
        ? input.body
        : localizedFrom(candidate.extractedBody);

    const definition = areaDefinition(candidate.area);

    /*
     * WHAT THE ACCEPTED ITEM'S ORIGIN BECOMES, and why it is not one answer.
     *
     * A DOCUMENT candidate a human read, judged and accepted is no longer an
     * inference: a person has taken responsibility for it, and it lands as
     * DOCUMENT — sourced from a file the customer supplied. That is what stops
     * the review queue from producing knowledge the very people who approved it
     * can never afterwards edit, which `mayOverwrite` would otherwise enforce
     * against them.
     *
     * AN ANALYTICS candidate stays AI_INFERRED, and that is deliberate rather
     * than an omission. A human agreeing that an inference looks right does not
     * turn it into a statement the brand made about itself, and CLAUDE.md is
     * explicit that human-authored facts outrank inferred learning. Accepted, it
     * is the lowest authority in the system twice over — LEARNING by memory and
     * AI_INFERRED by origin — which is exactly what a statistic deserves against
     * something the customer wrote. A human may still edit it afterwards, because
     * an incoming HUMAN origin outranks an existing AI_INFERRED one.
     *
     * ACCEPTED ON THE SETUP WIZARD'S REVIEW STEP, a document candidate lands as
     * SETUP (D-335) — the same rank as DOCUMENT, so nothing about what may
     * overwrite it changes; only the label says where it was accepted.
     */
    // A MEMBER candidate (Phase 2C-3) is a person's own statement: HUMAN.
    const acceptedOrigin: BrandKnowledgeOrigin =
      candidate.sourceKind === 'MEMBER'
        ? 'HUMAN'
        : candidate.sourceKind === 'ANALYTICS'
          ? 'AI_INFERRED'
          : input.acceptedInSetup === true
            ? 'SETUP'
            : 'DOCUMENT';

    /*
     * D4 + OWNER DECISION 2.a (Option A; D-65 stands). A candidate that
     * CONFLICTS with another approved fact (a different item) may only be
     * accepted where the incoming knowledge is allowed to replace that fact —
     * `mayOverwrite`, the same precedence rule every write obeys. Then the old
     * fact is archived as superseded, through the normal archive path. Where it
     * is not allowed — an analytics learning against a human, document or
     * setup fact — a plain accept is REFUSED: the reviewer rejects it, or edits
     * the fact itself as an ordinary human edit.
     */
    const conflicting = candidate.conflictsWithItemId
      ? await this.db.brandKnowledgeItem.findFirst({
          where: { id: candidate.conflictsWithItemId, status: { in: ['ACTIVE', 'STALE'] } },
        })
      : null;
    if (conflicting) {
      const replace = mayOverwrite(
        {
          memory: conflicting.memory,
          origin: conflicting.origin,
          version: conflicting.version,
          id: conflicting.id,
        },
        { memory: definition.memory, origin: acceptedOrigin, version: 1, id: candidate.id },
      );
      if (!replace.allowed) throw humanPrecedenceViolation();
    }

    let itemId: string;
    let version: number;

    const existing = candidate.targetItemId
      ? await this.db.brandKnowledgeItem.findUnique({ where: { id: candidate.targetItemId } })
      : await this.db.brandKnowledgeItem.findFirst({
          where: {
            brandId: candidate.brandId,
            area: candidate.area,
            itemKey: candidate.itemKey,
          },
        });

    if (existing) {
      const updated = await this.updateItem({
        itemId: existing.id,
        title,
        body,
        changeReason: input.reason ?? 'Accepted from document review',
        actor: input.actor,
        policy: input.policy,
        incomingOrigin: acceptedOrigin,
        changeKind: 'approved',
      });
      itemId = updated.id;
      version = updated.version;
    } else {
      const created = await this.db.brandKnowledgeItem.create({
        data: {
          workspaceId: this.workspaceId,
          brandId: candidate.brandId,
          area: candidate.area,
          memory: definition.memory,
          origin: acceptedOrigin,
          status: 'ACTIVE',
          itemKey: candidate.itemKey,
          title: toJson(title),
          body: toJson(body),
          createdByUserId: input.actor.userId,
          sourceDocumentId: candidate.sourceDocumentId,
          confidenceMilli: candidate.confidenceMilli,
          evidence: candidate.evidence as Prisma.InputJsonValue,
          version: 1,
          lastReviewedAt: now,
          reviewDueAt: addDays(now, input.policy.reviewIntervalDays),
        },
      });
      await this.appendVersion(created, {
        changedByUserId: input.actor.userId,
        changeKind: 'approved',
        changeReason: input.reason,
      });
      itemId = created.id;
      version = created.version;
    }

    await this.db.brandKnowledgeCandidate.update({
      where: { id: candidate.id },
      data: {
        status: input.decision === 'accept' ? 'ACCEPTED' : 'EDITED_ACCEPTED',
        reviewedByUserId: input.actor.userId,
        reviewedAt: now,
        reviewReason: input.reason ?? null,
        resultingVersion: version,
        // The reviewer's edit, kept ALONGSIDE the extraction rather than over it.
        ...(input.decision === 'accept_edited'
          ? { reviewedTitle: toJson(title), reviewedBody: toJson(body) }
          : {}),
      },
    });

    if (conflicting && conflicting.id !== itemId) {
      await this.archiveItem({
        itemId: conflicting.id,
        reason: 'superseded_by_review',
        actor: input.actor,
        supersededByItemId: itemId,
      });
    }

    await writeAuditEvent(this.db, this.workspaceId, {
      action: 'brand_brain.candidate.accepted',
      actorType: 'USER',
      actorId: input.actor.userId,
      resourceType: 'BrandKnowledgeCandidate',
      resourceId: candidate.id,
      brandId: candidate.brandId,
      after: {
        area: candidate.area,
        itemKey: candidate.itemKey,
        edited: input.decision === 'accept_edited',
        origin: acceptedOrigin,
        resultingItemId: itemId,
        resultingVersion: version,
      },
    });

    return { itemId, version };
  }

  /**
   * THE ONE BULK PATH — "Accept the confident ones" (D4, C1).
   *
   * Not a second way to approve: every accepted candidate goes through
   * `reviewCandidate` above, with its precedence checks, version and audit
   * event, inside the caller's ONE transaction — so a failure part-way leaves
   * nothing accepted. The caller previews `confidentCandidates` first and the
   * person confirms; the ids they confirmed are re-checked here, and anything
   * that no longer qualifies is SKIPPED and reported, never accepted:
   *
   *   - not PENDING any more (somebody else decided it);
   *   - below the configured confidence threshold;
   *   - a CONFLICT — it names an approved fact it contradicts, or it would
   *     replace an approved fact with the same key. A conflict is a decision a
   *     person makes looking at both, never one made in bulk.
   */
  async reviewCandidates(input: {
    brandId: string;
    candidateIds: readonly string[];
    minimumConfidenceMilli: number;
    actor: KnowledgeActor;
    policy: StalenessPolicy;
  }): Promise<{
    readonly accepted: readonly string[];
    readonly skipped: readonly { readonly id: string; readonly reason: BulkSkipReason }[];
  }> {
    assertBrandInScope(input.actor.brandScope, input.brandId);
    const eligible = new Set(
      (
        await this.confidentCandidates({
          brandId: input.brandId,
          minimumConfidenceMilli: input.minimumConfidenceMilli,
          brandScope: input.actor.brandScope,
        })
      ).map((candidate) => candidate.id),
    );
    const accepted: string[] = [];
    const skipped: { id: string; reason: BulkSkipReason }[] = [];
    for (const id of [...new Set(input.candidateIds)]) {
      if (!eligible.has(id)) {
        skipped.push({ id, reason: 'not_eligible' });
        continue;
      }
      await this.reviewCandidate({
        candidateId: id,
        decision: 'accept',
        actor: input.actor,
        policy: input.policy,
      });
      accepted.push(id);
    }
    await writeAuditEvent(this.db, this.workspaceId, {
      action: 'brand_brain.candidate.bulk_accepted',
      actorType: 'USER',
      actorId: input.actor.userId,
      resourceType: 'Brand',
      resourceId: input.brandId,
      brandId: input.brandId,
      after: {
        accepted: accepted.length,
        skipped: skipped.length,
        minimumConfidenceMilli: input.minimumConfidenceMilli,
      },
    });
    return { accepted, skipped };
  }

  /**
   * The preview for "Accept the confident ones": PENDING candidates at or above
   * the threshold that conflict with nothing approved. The same rule
   * `reviewCandidates` re-applies when the person confirms.
   */
  async confidentCandidates(input: {
    brandId: string;
    minimumConfidenceMilli: number;
    brandScope: readonly string[];
    take?: number;
  }): Promise<BrandKnowledgeCandidateSummary[]> {
    const candidates = await this.db.brandKnowledgeCandidate.findMany({
      where: {
        brandId: input.brandId,
        status: 'PENDING',
        confidenceMilli: { gte: input.minimumConfidenceMilli },
        conflictsWithItemId: null,
        // A member's proposal is judged one at a time: "confident" is about
        // what an extractor measured, and a person's words carry no score.
        sourceKind: { not: 'MEMBER' },
        ...brandIdQueryFilter({ brandScope: input.brandScope }),
      },
      orderBy: [{ confidenceMilli: 'desc' }, { createdAt: 'asc' }],
      take: input.take ?? 100,
      select: {
        id: true,
        area: true,
        itemKey: true,
        targetItemId: true,
        confidenceMilli: true,
        extractedTitle: true,
      },
    });
    if (candidates.length === 0) return [];
    // A candidate that would REPLACE an approved fact with the same key is a
    // conflict too: that fact is on screen beside it only in the inbox.
    // Expired facts count: they are still approved knowledge a person chose,
    // and replacing one is a decision to make looking at it.
    const approved = await this.db.brandKnowledgeItem.findMany({
      where: {
        brandId: input.brandId,
        status: { in: ['ACTIVE', 'STALE'] },
        OR: candidates.map((candidate) => ({ area: candidate.area, itemKey: candidate.itemKey })),
      },
      select: { id: true, area: true, itemKey: true },
    });
    const taken = new Set(approved.map((item) => `${item.area}:${item.itemKey}`));
    const approvedIds = new Set(approved.map((item) => item.id));
    return candidates
      .filter(
        (candidate) =>
          !taken.has(`${candidate.area}:${candidate.itemKey}`) &&
          !(candidate.targetItemId && approvedIds.has(candidate.targetItemId)),
      )
      .map((candidate) => ({
        id: candidate.id,
        area: candidate.area,
        itemKey: candidate.itemKey,
        confidenceMilli: candidate.confidenceMilli,
        title: localizedFrom(candidate.extractedTitle),
      }));
  }

  /**
   * Mark items whose review window has passed.
   *
   * Staleness is a STATUS change, not a deletion and not an exclusion from
   * retrieval: knowledge that has not been confirmed recently is still the best
   * the brand has. It is surfaced so a human can confirm it.
   */
  async markStale(brandId: string): Promise<number> {
    const result = await this.db.brandKnowledgeItem.updateMany({
      where: { brandId, status: 'ACTIVE', reviewDueAt: { lt: this.now() } },
      data: { status: 'STALE' },
    });
    return result.count;
  }

  /**
   * Flag an unresolved conflict between two items.
   *
   * D-65: surfaced, never resolved silently. The flag goes on the LOWER-ranked
   * item, so the higher-authority statement stays clean and the conflict is
   * attached to the thing that would have to change.
   */
  async flagConflict(input: { itemId: string; conflictsWithItemId: string }): Promise<void> {
    await this.db.brandKnowledgeItem.updateMany({
      where: { id: input.itemId },
      data: { conflictsWithItemId: input.conflictsWithItemId },
    });
  }

  /**
   * Per-area counts for completeness (Q19): usable, stale, expired, conflicted
   * and pending, and the keys of the usable facts — which is what answers a
   * key question. `asOf` is today in the workspace's time zone (D6).
   */
  async areaCounts(brandId: string, asOf: Date): Promise<AreaCounts[]> {
    const now = this.now();
    const [items, candidates] = await Promise.all([
      this.db.brandKnowledgeItem.findMany({
        where: { brandId, status: { in: ['ACTIVE', 'STALE'] } },
        select: {
          area: true,
          status: true,
          itemKey: true,
          reviewDueAt: true,
          conflictsWithItemId: true,
          validUntil: true,
        },
      }),
      this.db.brandKnowledgeCandidate.groupBy({
        by: ['area'],
        where: { brandId, status: 'PENDING' },
        _count: { _all: true },
      }),
    ]);

    type Mutable = {
      usableItems: number;
      staleItems: number;
      expiredItems: number;
      conflictedItems: number;
      pendingCandidates: number;
      answeredKeys: Set<string>;
    };
    const byArea = new Map<BrandKnowledgeArea, Mutable>();
    const bucket = (area: BrandKnowledgeArea): Mutable => {
      let current = byArea.get(area);
      if (!current) {
        current = {
          usableItems: 0,
          staleItems: 0,
          expiredItems: 0,
          conflictedItems: 0,
          pendingCandidates: 0,
          answeredKeys: new Set(),
        };
        byArea.set(area, current);
      }
      return current;
    };

    for (const item of items) {
      const current = bucket(item.area);
      if (item.conflictsWithItemId) current.conflictedItems += 1;
      // EXPIRED IS NOT USABLE: it answers no question and grounds nothing, but
      // it is still shown ("Expired · not used in writing") and counted here.
      if (isExpired(item.validUntil, asOf)) {
        current.expiredItems += 1;
        continue;
      }
      current.usableItems += 1;
      current.answeredKeys.add(item.itemKey);
      // STALE is separate from expiry: review due, still usable.
      if (item.status === 'STALE' || (item.reviewDueAt !== null && item.reviewDueAt < now)) {
        current.staleItems += 1;
      }
    }
    for (const candidate of candidates) {
      bucket(candidate.area).pendingCandidates = candidate._count._all;
    }

    return [...byArea.entries()].map(([area, counts]) => ({ area, ...counts }));
  }

  async completion(
    brandId: string,
    questions: AreaQuestions,
    asOf: Date,
  ): Promise<BrandCompletion> {
    return computeBrandCompletion(await this.areaCounts(brandId, asOf), questions);
  }

  /** Append a version row. Private: every mutation above must go through it. */
  private async appendVersion(
    item: BrandKnowledgeItem,
    meta: {
      changedByUserId: string;
      changeKind: string;
      changeReason?: string | undefined;
    },
  ): Promise<void> {
    // `exactOptionalPropertyTypes` distinguishes an absent Json column from an
    // explicit null, and `undefined` is assignable to neither. The optional
    // half is therefore built separately rather than widening the compiler
    // settings — the same shape `writeAuditEvent` uses.
    const evidence: { evidence?: Prisma.InputJsonValue } = {};
    if (item.evidence !== null && item.evidence !== undefined) {
      evidence.evidence = item.evidence as Prisma.InputJsonValue;
    }

    await this.db.brandKnowledgeVersion.create({
      data: {
        workspaceId: item.workspaceId,
        brandId: item.brandId,
        knowledgeItemId: item.id,
        version: item.version,
        area: item.area,
        memory: item.memory satisfies BrandMemoryLayer,
        origin: item.origin,
        status: item.status,
        title: item.title as Prisma.InputJsonValue,
        body: item.body as Prisma.InputJsonValue,
        confidenceMilli: item.confidenceMilli,
        validUntil: item.validUntil,
        ...evidence,
        changedByUserId: meta.changedByUserId,
        changeKind: meta.changeKind,
        changeReason: meta.changeReason ?? null,
      },
    });
  }
}

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

function isoDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}
