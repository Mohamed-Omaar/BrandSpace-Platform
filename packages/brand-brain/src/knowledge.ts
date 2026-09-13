import {
  writeAuditEvent,
  type BrandKnowledgeArea,
  type BrandKnowledgeItem,
  type BrandKnowledgeOrigin,
  type BrandMemoryLayer,
  type Prisma,
  type TenantScopedClient,
} from '@brandspace/database';
import { type Clock, systemClock } from '@brandspace/shared';
import { areaDefinition } from './areas';
import { mayOverwrite } from './precedence';
import {
  alreadyReviewed,
  candidateNotFound,
  humanPrecedenceViolation,
  knowledgeNotFound,
  versionNotFound,
} from './errors';
import type { LocalizedText } from './schemas';
import { type AreaCounts, computeBrandCompletion, type BrandCompletion } from './completion';

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

function hasBothLocales(value: Prisma.JsonValue | null): boolean {
  const text = localizedFrom(value);
  return Boolean(text.en?.length) && Boolean(text.ar?.length);
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
  }): Promise<BrandKnowledgeItem> {
    const definition = areaDefinition(input.area);
    const now = this.now();

    const item = await this.db.brandKnowledgeItem.create({
      data: {
        workspaceId: this.workspaceId,
        brandId: input.brandId,
        area: input.area,
        memory: definition.memory,
        origin: 'HUMAN',
        status: 'ACTIVE',
        itemKey: input.itemKey,
        title: toJson(input.title),
        body: toJson(input.body),
        createdByUserId: input.actor.userId,
        version: 1,
        lastReviewedAt: now,
        reviewDueAt: addDays(now, input.policy.reviewIntervalDays),
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
      after: { area: input.area, itemKey: input.itemKey, version: 1 },
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
  }): Promise<BrandKnowledgeItem> {
    const existing = await this.db.brandKnowledgeItem.findUnique({
      where: { id: input.itemId },
    });
    // RLS already returned null for another tenant. Both cases land here, and
    // both produce the same 404 — the caller cannot tell them apart.
    if (!existing) throw knowledgeNotFound();

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
    const updated = await this.db.brandKnowledgeItem.update({
      where: { id: existing.id },
      data: {
        title: toJson(input.title),
        body: toJson(input.body),
        version: { increment: 1 },
        // A human editing an item has just reviewed it, by definition.
        lastReviewedAt: now,
        reviewDueAt: addDays(now, input.policy.reviewIntervalDays),
        // An edit resolves the staleness that prompted it, and clears a
        // conflict flag that referred to the previous text.
        conflictsWithItemId: null,
        status: existing.status === 'STALE' ? 'ACTIVE' : existing.status,
      },
    });

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
      before: { version: existing.version },
      after: { version: updated.version, reason: input.changeReason ?? null },
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
    const item = await this.db.brandKnowledgeItem.findUnique({ where: { id: input.itemId } });
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
  }): Promise<BrandKnowledgeItem> {
    const item = await this.db.brandKnowledgeItem.findUnique({ where: { id: input.itemId } });
    if (!item) throw knowledgeNotFound();

    const archived = await this.db.brandKnowledgeItem.update({
      where: { id: item.id },
      data: { status: 'ARCHIVED', archivedAt: this.now(), version: { increment: 1 } },
    });

    await this.appendVersion(archived, {
      changedByUserId: input.actor.userId,
      changeKind: 'archived',
      changeReason: input.reason,
    });

    await writeAuditEvent(this.db, this.workspaceId, {
      action: 'brand_brain.knowledge.archived',
      actorType: 'USER',
      actorId: input.actor.userId,
      resourceType: 'BrandKnowledgeItem',
      resourceId: item.id,
      brandId: item.brandId,
      after: { reason: input.reason ?? null },
    });

    return archived;
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
  }): Promise<{ readonly itemId: string | null; readonly version: number | null }> {
    const candidate = await this.db.brandKnowledgeCandidate.findUnique({
      where: { id: input.candidateId },
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

    /*
     * ORIGIN AFTER ACCEPTANCE.
     *
     * A candidate a human read, judged and accepted is no longer an inference:
     * a person has taken responsibility for it. It therefore lands as DOCUMENT
     * — sourced from a document the customer supplied — rather than
     * AI_INFERRED. That is what stops the review queue from producing knowledge
     * that can never afterwards be edited by the very people who approved it,
     * which `mayOverwrite` would otherwise enforce against them.
     */
    const definition = areaDefinition(candidate.area);
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
        incomingOrigin: 'DOCUMENT',
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
          origin: 'DOCUMENT',
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
        resultingItemId: itemId,
        resultingVersion: version,
      },
    });

    return { itemId, version };
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

  /** Per-area counts, computed in the database rather than in memory. */
  async areaCounts(brandId: string): Promise<AreaCounts[]> {
    const now = this.now();
    const [items, candidates] = await Promise.all([
      this.db.brandKnowledgeItem.findMany({
        where: { brandId, status: { in: ['ACTIVE', 'STALE'] } },
        select: {
          area: true,
          status: true,
          title: true,
          body: true,
          reviewDueAt: true,
          conflictsWithItemId: true,
        },
      }),
      this.db.brandKnowledgeCandidate.groupBy({
        by: ['area'],
        where: { brandId, status: 'PENDING' },
        _count: { _all: true },
      }),
    ]);

    const pendingByArea = new Map<BrandKnowledgeArea, number>(
      candidates.map((c) => [c.area, c._count._all]),
    );
    const byArea = new Map<BrandKnowledgeArea, AreaCounts>();

    for (const item of items) {
      const current =
        byArea.get(item.area) ??
        ({
          area: item.area,
          activeItems: 0,
          bilingualActiveItems: 0,
          staleItems: 0,
          conflictedItems: 0,
          pendingCandidates: pendingByArea.get(item.area) ?? 0,
        } satisfies AreaCounts);

      // A STALE item still counts as active knowledge — it is real, it is just
      // unconfirmed. Excluding it would drop a brand's completion the moment a
      // review window lapsed, which reads as data loss to the customer.
      const isStale =
        item.status === 'STALE' || (item.reviewDueAt !== null && item.reviewDueAt < now);

      byArea.set(item.area, {
        ...current,
        activeItems: current.activeItems + 1,
        bilingualActiveItems:
          current.bilingualActiveItems +
          (hasBothLocales(item.title) && hasBothLocales(item.body) ? 1 : 0),
        staleItems: current.staleItems + (isStale ? 1 : 0),
        conflictedItems: current.conflictedItems + (item.conflictsWithItemId ? 1 : 0),
      });
    }

    // Areas with candidates but no items must still appear, or a queue waiting
    // on review would be invisible on the card.
    for (const [area, count] of pendingByArea) {
      if (!byArea.has(area)) {
        byArea.set(area, {
          area,
          activeItems: 0,
          bilingualActiveItems: 0,
          staleItems: 0,
          conflictedItems: 0,
          pendingCandidates: count,
        });
      }
    }

    return [...byArea.values()];
  }

  async completion(brandId: string): Promise<BrandCompletion> {
    return computeBrandCompletion(await this.areaCounts(brandId));
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
