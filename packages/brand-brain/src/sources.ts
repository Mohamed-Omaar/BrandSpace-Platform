import {
  writeAuditEvent,
  type BrandKnowledgeArea,
  type BrandKnowledgeStatus,
  type TenantScopedClient,
} from '@brandspace/database';
import { QUOTA_FEATURES, type UsageService } from '@brandspace/entitlements';
import { AppError, brandIdQueryFilter, systemClock, type Clock } from '@brandspace/shared';
import { documentNotFound } from './errors';
import { BrandKnowledgeService, type KnowledgeActor } from './knowledge';

/**
 * SOURCES — what one uploaded document is responsible for, and removing it
 * (Phase 2C-4, D5).
 *
 * THIS FILE, NOT `ingestion.ts`, BECAUSE IT CAN ARCHIVE KNOWLEDGE. The
 * ingestion pipeline is structurally unable to touch approved knowledge — it
 * does not import `BrandKnowledgeService` — and "Drop its facts" must, through
 * the ordinary `archiveItem` path. Keeping the two apart keeps that guarantee
 * true of the pipeline.
 *
 * ---------------------------------------------------------------------------
 * WHICH FACT BELONGS TO A SOURCE
 * ---------------------------------------------------------------------------
 *
 * A fact belongs to document D ONLY IF ITS CURRENT VERSION was produced by
 * accepting a candidate from D:
 *
 *     candidate.sourceDocumentId = D
 *     candidate.status IN (ACCEPTED, EDITED_ACCEPTED)
 *     candidate.resultingVersion = item.version
 *
 * where `item` is the fact that candidate wrote — its `targetItemId`, or, for a
 * candidate that created the fact, the brand's item with the candidate's area
 * and key (the same resolution `reviewCandidate` performs, and the pair is
 * unique per brand). Anything that has written a version since — a person's
 * edit, another document's accepted candidate, a learning, an archive — moves
 * `item.version` past `resultingVersion`, and the fact no longer belongs to D.
 * That is what stops removing an old source from archiving knowledge a person
 * wrote later.
 *
 * A PENDING proposal belongs to D when its `sourceDocumentId` is D; nothing
 * else counts.
 */

const ACCEPTED = ['ACCEPTED', 'EDITED_ACCEPTED'] as const;
const APPROVED_STATES: readonly BrandKnowledgeStatus[] = ['ACTIVE', 'STALE'];

export interface SourceFact {
  readonly itemId: string;
  readonly area: BrandKnowledgeArea;
  readonly itemKey: string;
  readonly title: unknown;
  readonly version: number;
  readonly status: BrandKnowledgeStatus;
  readonly validUntil: Date | null;
}

export interface SourcePending {
  readonly candidateId: string;
  readonly area: BrandKnowledgeArea;
  readonly itemKey: string;
  readonly title: unknown;
}

export interface SourceKnowledge {
  /** Approved (ACTIVE or STALE) facts whose CURRENT version came from this source. */
  readonly facts: readonly SourceFact[];
  /** PENDING candidates this source proposed. */
  readonly pending: readonly SourcePending[];
}

/**
 * The facts each document currently owns, and its pending proposals — one
 * read per brand, for the Sources tab.
 *
 * Under the caller's RLS transaction and within the member's brand scope; a
 * document id the reader cannot see simply yields nothing.
 */
export async function sourceKnowledge(
  db: TenantScopedClient,
  request: {
    readonly brandId: string;
    readonly documentIds: readonly string[];
    readonly brandScope: readonly string[];
  },
): Promise<ReadonlyMap<string, SourceKnowledge>> {
  const result = new Map<string, { facts: SourceFact[]; pending: SourcePending[] }>(
    request.documentIds.map((id) => [id, { facts: [], pending: [] }]),
  );
  if (request.documentIds.length === 0) return result;
  const scope = brandIdQueryFilter({ brandId: request.brandId, brandScope: request.brandScope });

  const candidates = await db.brandKnowledgeCandidate.findMany({
    where: {
      ...scope,
      sourceDocumentId: { in: [...request.documentIds] },
      status: { in: ['PENDING', ...ACCEPTED] },
    },
    select: {
      id: true,
      sourceDocumentId: true,
      status: true,
      area: true,
      itemKey: true,
      targetItemId: true,
      resultingVersion: true,
      extractedTitle: true,
      reviewedTitle: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  for (const candidate of candidates) {
    if (candidate.status !== 'PENDING' || !candidate.sourceDocumentId) continue;
    result.get(candidate.sourceDocumentId)?.pending.push({
      candidateId: candidate.id,
      area: candidate.area,
      itemKey: candidate.itemKey,
      title: candidate.extractedTitle,
    });
  }

  const owned = await ownedFacts(db, {
    brandId: request.brandId,
    brandScope: request.brandScope,
    accepted: candidates.filter((candidate) => candidate.status !== 'PENDING'),
    states: APPROVED_STATES,
  });
  for (const { documentId, fact } of owned) result.get(documentId)?.facts.push(fact);
  return result;
}

/**
 * THE OWNERSHIP RULE, applied to a set of accepted candidates: each resolves to
 * the fact it wrote, and counts only while that fact's current version is the
 * one it produced.
 */
async function ownedFacts(
  db: TenantScopedClient,
  request: {
    readonly brandId: string;
    readonly brandScope: readonly string[];
    readonly accepted: readonly {
      readonly sourceDocumentId: string | null;
      readonly area: BrandKnowledgeArea;
      readonly itemKey: string;
      readonly targetItemId: string | null;
      readonly resultingVersion: number | null;
    }[];
    readonly states: readonly BrandKnowledgeStatus[];
  },
): Promise<readonly { readonly documentId: string; readonly fact: SourceFact }[]> {
  const accepted = request.accepted.filter(
    (candidate) => candidate.sourceDocumentId !== null && candidate.resultingVersion !== null,
  );
  if (accepted.length === 0) return [];

  const items = await db.brandKnowledgeItem.findMany({
    where: {
      ...brandIdQueryFilter({ brandId: request.brandId, brandScope: request.brandScope }),
      OR: [
        { id: { in: accepted.flatMap((c) => (c.targetItemId ? [c.targetItemId] : [])) } },
        ...accepted
          .filter((c) => !c.targetItemId)
          .map((c) => ({ area: c.area, itemKey: c.itemKey })),
      ],
    },
    select: {
      id: true,
      area: true,
      itemKey: true,
      title: true,
      version: true,
      status: true,
      validUntil: true,
    },
  });
  const byId = new Map(items.map((item) => [item.id, item]));
  const byKey = new Map(items.map((item) => [`${item.area}\u0000${item.itemKey}`, item]));

  const seen = new Set<string>();
  const out: { documentId: string; fact: SourceFact }[] = [];
  for (const candidate of accepted) {
    const item = candidate.targetItemId
      ? byId.get(candidate.targetItemId)
      : byKey.get(`${candidate.area}\u0000${candidate.itemKey}`);
    if (!item) continue;
    if (item.version !== candidate.resultingVersion) continue;
    if (!request.states.includes(item.status)) continue;
    const documentId = candidate.sourceDocumentId as string;
    const key = `${documentId}\u0000${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      documentId,
      fact: {
        itemId: item.id,
        area: item.area,
        itemKey: item.itemKey,
        title: item.title,
        version: item.version,
        status: item.status,
        validUntil: item.validUntil,
      },
    });
  }
  return out;
}

export type SourceRemovalMode = 'keep' | 'drop';

export interface SourceRemovalResult {
  readonly documentId: string;
  readonly brandId: string;
  /** PENDING proposals marked SUPERSEDED. */
  readonly supersededCandidates: number;
  /** Raw chunks deleted. */
  readonly chunksRemoved: number;
  /** Bytes given back to the storage quota (0 for a file refused before storage). */
  readonly refundedBytes: number;
  /** Facts archived — always empty for `keep`. */
  readonly archivedItemIds: readonly string[];
  /**
   * The object to delete from storage AFTER the transaction commits, or null
   * when nothing was stored. Deleting it inside the transaction would lose the
   * bytes of a removal that then rolled back.
   */
  readonly storageKeyToDelete: string | null;
}

/**
 * REMOVE A SOURCE (Phase 2C-4, D5) — "Keep its facts" or "Drop its facts".
 *
 * ALWAYS, for both:
 *   - the document is soft-deleted (`deletedAt`) — its row, name, checksum
 *     history and audit trail stay; M6 releases its checksum;
 *   - its raw extracted chunks are deleted (derived data, never grounding);
 *   - its PENDING proposals become SUPERSEDED — not REJECTED: nobody judged
 *     them, their source went away;
 *   - an ingestion job still in flight is ended, so the worker writes nothing
 *     for a removed document;
 *   - its exact stored bytes are refunded ONCE through the existing B-8 path,
 *     `UsageService.refundBytes`, keyed on the document, so a replay refunds
 *     nothing more;
 *   - `brand_brain.source.removed` is audited.
 *
 * KEEP leaves every approved fact exactly as it is — still usable, still
 * grounding writing; nothing D10 watches changes.
 *
 * DROP additionally archives every fact the document CURRENTLY owns (the rule
 * above) through `BrandKnowledgeService.archiveItem` with the reason
 * `source_removed`: a new version, the ordinary audit event, and — because the
 * fact is no longer usable — the existing D10 machinery flags posts that used
 * it. Nothing is hard-deleted. It needs `brand_brain.edit` as well as
 * `brand_brain.upload`, re-checked here.
 */
export async function removeSource(
  db: TenantScopedClient,
  input: {
    readonly workspaceId: string;
    readonly documentId: string;
    readonly mode: SourceRemovalMode;
    readonly actor: KnowledgeActor;
    readonly usage: UsageService;
    readonly clock?: Clock;
  },
): Promise<SourceRemovalResult> {
  if (input.mode === 'drop' && !input.actor.permissionKeys.includes('brand_brain.edit')) {
    throw new AppError('FORBIDDEN', 'Dropping a source’s facts needs brand_brain.edit.', {
      permission: 'brand_brain.edit',
    });
  }
  const clock = input.clock ?? systemClock;

  const document = await db.brandSourceDocument.findFirst({
    where: {
      id: input.documentId,
      deletedAt: null,
      ...brandIdQueryFilter({ brandScope: input.actor.brandScope }),
    },
  });
  if (!document) throw documentNotFound();

  // Ownership is decided BEFORE anything changes: the candidates' links and the
  // facts' versions are read as they stand at removal.
  const owned =
    input.mode === 'drop'
      ? await ownedFacts(db, {
          brandId: document.brandId,
          brandScope: input.actor.brandScope,
          accepted: await db.brandKnowledgeCandidate.findMany({
            where: { sourceDocumentId: document.id, status: { in: [...ACCEPTED] } },
            select: {
              sourceDocumentId: true,
              area: true,
              itemKey: true,
              targetItemId: true,
              resultingVersion: true,
            },
          }),
          states: APPROVED_STATES,
        })
      : [];

  const now = clock.now();
  await db.brandSourceDocument.update({
    where: { id: document.id },
    data: { deletedAt: now },
  });
  const chunks = await db.brandSourceChunk.deleteMany({
    where: { sourceDocumentId: document.id },
  });
  const superseded = await db.brandKnowledgeCandidate.updateMany({
    where: { sourceDocumentId: document.id, status: 'PENDING' },
    data: { status: 'SUPERSEDED', reviewReason: 'source_removed' },
  });
  await db.brandIngestionJob.updateMany({
    where: {
      sourceDocumentId: document.id,
      stage: { in: ['QUEUED', 'EXTRACTING', 'CHUNKING', 'EXTRACTING_FACTS'] },
    },
    data: {
      stage: 'FAILED',
      failureCode: 'source_removed',
      failureMessage: 'source_removed',
      completedAt: now,
    },
  });

  if (document.byteSize > 0) {
    await input.usage.refundBytes({
      workspaceId: input.workspaceId,
      featureKey: QUOTA_FEATURES.storageGb,
      bytes: document.byteSize,
      idempotencyKey: `brand-source-remove:${input.workspaceId}:${document.id}`,
    });
  }

  const knowledge = new BrandKnowledgeService({ db, workspaceId: input.workspaceId });
  const archivedItemIds: string[] = [];
  for (const { fact } of owned) {
    if (archivedItemIds.includes(fact.itemId)) continue;
    await knowledge.archiveItem({
      itemId: fact.itemId,
      reason: 'source_removed',
      actor: input.actor,
    });
    archivedItemIds.push(fact.itemId);
  }

  await writeAuditEvent(db, input.workspaceId, {
    action: 'brand_brain.source.removed',
    actorType: 'USER',
    actorId: input.actor.userId,
    resourceType: 'BrandSourceDocument',
    resourceId: document.id,
    brandId: document.brandId,
    after: {
      mode: input.mode,
      fileName: document.fileName,
      refundedBytes: document.byteSize,
      chunksRemoved: chunks.count,
      supersededCandidates: superseded.count,
      archivedFacts: archivedItemIds.length,
    },
  });

  return {
    documentId: document.id,
    brandId: document.brandId,
    supersededCandidates: superseded.count,
    chunksRemoved: chunks.count,
    refundedBytes: document.byteSize,
    archivedItemIds,
    storageKeyToDelete:
      document.byteSize > 0 && document.storageKey !== '' && document.storageKey !== 'pending'
        ? document.storageKey
        : null,
  };
}
