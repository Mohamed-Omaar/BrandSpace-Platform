import { createHash } from 'node:crypto';
import {
  writeAuditEvent,
  type BrandKnowledgeArea,
  type BrandKnowledgeStatus,
  type ContentStatus,
  type Prisma,
  type TenantScopedClient,
} from '@brandspace/database';
import { AppError, brandIdQueryFilter, systemClock, type Clock } from '@brandspace/shared';
import { localizedFrom } from './knowledge';
import type { GroundedFact } from './retrieval';
import type { LocalizedText } from './schemas';
import { usableKnowledgeWhere } from './retrieval';
import { isExpired, isoDateOf, workspaceKnowledgeAsOf } from './validity';

/**
 * RECORDED FACT USAGE — Phase 2C-3, D9 and D10 (migration M5,
 * `content_knowledge_usage`).
 *
 * WHAT A VARIANT USED IS WRITTEN DOWN WHEN IT IS WRITTEN, NEVER GUESSED LATER.
 * The only input is `Grounding.facts` — the item ids and versions the grounding
 * layer returned and the prompt carried — recorded in the SAME transaction as
 * the caption. Nothing in this module reads caption text, citations, labels or
 * similarity: there is no text matching anywhere in it, and a unit scan keeps
 * it that way.
 *
 *   - THE CURRENT SET of a variant is its rows with `supersededAt` null. The
 *     next AI generation or rewrite of the variant supersedes them (history is
 *     kept) and records its own.
 *   - A MANUAL EDIT CHANGES NOTHING HERE: nobody can know which grounded facts
 *     a person kept, so the record stays until the next AI write replaces it.
 *   - BRAND BRAIN OFF, OR ZERO FACTS: no row is recorded (the previous current
 *     set is still superseded — the caption it described is gone).
 *   - NO BACKFILL: a post written before this release simply has no rows.
 *
 * NON-GENERATIVE. This module compares recorded versions with stored state for
 * the Studio, Home and "Used in N posts"; it never builds a prompt. The one
 * generative consequence of a change — the D10 rewrite — is grounded through
 * `rewriteGroundingFor` in `grounding.ts`, starting from the recorded ids.
 */

/** D10 — the content states whose recorded facts can still be acted on. */
export const D10_CONTENT_STATUSES: readonly ContentStatus[] = [
  'DRAFT',
  'IN_REVIEW',
  'APPROVED',
  'SCHEDULED',
];

/** D10 on Home "Needs you" — only work already on its way out. */
export const D10_HOME_STATUSES: readonly ContentStatus[] = ['SCHEDULED', 'IN_REVIEW'];

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * Replace a variant's CURRENT usage set with exactly `facts`. Must run in the
 * transaction that saves the caption: the caller's client is that transaction,
 * so a failed save leaves neither the new text nor the new set.
 */
export async function recordKnowledgeUsage(
  db: TenantScopedClient,
  input: {
    readonly workspaceId: string;
    readonly brandId: string;
    readonly contentItemId: string;
    readonly contentVariantId: string;
    /** From `Grounding.facts` — never reconstructed. Empty records nothing. */
    readonly facts: readonly GroundedFact[];
    readonly aiRequestId: string | null;
  },
  clock: Clock = systemClock,
): Promise<{ readonly recorded: number; readonly superseded: number }> {
  const now = clock.now();
  const superseded = await db.contentKnowledgeUsage.updateMany({
    where: { contentVariantId: input.contentVariantId, supersededAt: null },
    data: { supersededAt: now },
  });
  const unique = new Map(input.facts.map((fact) => [fact.itemId, fact.version]));
  if (unique.size > 0) {
    await db.contentKnowledgeUsage.createMany({
      data: [...unique].map(([knowledgeItemId, knowledgeVersion]) => ({
        workspaceId: input.workspaceId,
        brandId: input.brandId,
        contentItemId: input.contentItemId,
        contentVariantId: input.contentVariantId,
        knowledgeItemId,
        knowledgeVersion,
        aiRequestId: input.aiRequestId,
        recordedAt: now,
      })),
    });
  }
  return { recorded: unique.size, superseded: superseded.count };
}

// ---------------------------------------------------------------------------
// D10 — the one detection rule
// ---------------------------------------------------------------------------

export type UsageChangeKind = 'changed' | 'replaced' | 'expired' | 'removed';

/** A fact as the Studio may show it: title and area only. */
export interface FactView {
  readonly id: string;
  readonly area: BrandKnowledgeArea;
  readonly title: LocalizedText;
  readonly version: number;
}

/** Everything `usageChangeFor` needs about one recorded use, already loaded. */
export interface UsageRowState {
  readonly usageId: string;
  readonly brandId: string;
  readonly contentItemId: string;
  readonly contentVariantId: string;
  readonly contentStatus: ContentStatus;
  readonly knowledgeItemId: string;
  readonly usedVersion: number;
  /**
   * The recorded version's title and body, from the append-only history; null
   * when the history has no row for it (seeded or imported data).
   */
  readonly used: { readonly title: LocalizedText; readonly body: LocalizedText } | null;
  readonly area: BrandKnowledgeArea;
  readonly current: {
    readonly status: BrandKnowledgeStatus;
    readonly version: number;
    readonly title: LocalizedText;
    readonly body: LocalizedText;
    readonly validUntil: Date | null;
    /**
     * The version that introduced the CURRENT title and body — lower than
     * `version` when later versions changed only metadata (an end date, a
     * status). It is what a content change is signed with, so a
     * bookkeeping-only bump never signs a new alert.
     */
    readonly contentVersion: number;
  };
  /** The recorded `supersededByItemId`, when it points at a USABLE fact. */
  readonly replacement: FactView | null;
  readonly dismissedChangeSignature: string | null;
}

export interface UsageChange {
  readonly kind: UsageChangeKind;
  readonly signature: string;
}

/** sha256(itemId | usedVersion | kind | currentVersion-or-validUntil), lowercase hex. */
export function changeSignature(
  itemId: string,
  usedVersion: number,
  kind: UsageChangeKind,
  marker: string,
): string {
  return createHash('sha256')
    .update([itemId, String(usedVersion), kind, marker].join('|'))
    .digest('hex');
}

function sameText(a: LocalizedText, b: LocalizedText): boolean {
  return (a.en ?? '') === (b.en ?? '') && (a.ar ?? '') === (b.ar ?? '');
}

/**
 * D10 — WHAT, IF ANYTHING, HAPPENED TO A FACT THIS VARIANT USED. The only
 * implementation of the rule; the Studio, Home, the rewrite and the tests all
 * call it. Stored versions and state only — no text matching.
 *
 *   1. ARCHIVED with a usable replacement → `replaced` (old → replacement).
 *   2. ARCHIVED with none, or no longer approved at all → `removed`.
 *   3. EXPIRED in the workspace's day (`asOf`) → `expired`.
 *   4. A later version whose TITLE OR BODY differs from the recorded version →
 *      `changed` (old → new). A later version with the same title and body —
 *      an end date moved, a status touched — is no content change.
 *   5. Otherwise nothing.
 *
 * The signature names the used version and what it changed to (the version
 * that introduced the current text, the archive's version, or the end day), so
 * "Keep as is" dismisses exactly that change and a different later one alerts
 * again.
 */
export function usageChangeFor(row: UsageRowState, asOf: Date): UsageChange | null {
  const sign = (kind: UsageChangeKind, marker: string): UsageChange => ({
    kind,
    signature: changeSignature(row.knowledgeItemId, row.usedVersion, kind, marker),
  });
  const { current } = row;
  if (current.status === 'ARCHIVED') {
    return row.replacement
      ? sign('replaced', String(current.version))
      : sign('removed', String(current.version));
  }
  if (current.status !== 'ACTIVE' && current.status !== 'STALE') {
    return sign('removed', String(current.version));
  }
  if (isExpired(current.validUntil, asOf)) {
    return sign('expired', isoDateOf(current.validUntil as Date));
  }
  // Without the recorded text a later version cannot be proved unchanged, so it
  // counts as a change: a missed alert is the worse mistake.
  if (
    current.version > row.usedVersion &&
    !(
      row.used !== null &&
      sameText(current.title, row.used.title) &&
      sameText(current.body, row.used.body)
    )
  ) {
    return sign('changed', String(current.contentVersion));
  }
  return null;
}

/** An undismissed change on content D10 may still act on. */
export function isFlagged(row: UsageRowState, asOf: Date): boolean {
  if (!D10_CONTENT_STATUSES.includes(row.contentStatus)) return false;
  const change = usageChangeFor(row, asOf);
  return change !== null && change.signature !== row.dismissedChangeSignature;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const USAGE_SELECT = {
  id: true,
  brandId: true,
  contentItemId: true,
  contentVariantId: true,
  knowledgeItemId: true,
  knowledgeVersion: true,
  dismissedChangeSignature: true,
  item: { select: { status: true } },
  knowledge: {
    select: {
      area: true,
      status: true,
      version: true,
      title: true,
      body: true,
      validUntil: true,
      supersededByItemId: true,
    },
  },
} as const satisfies Prisma.ContentKnowledgeUsageSelect;

/**
 * The CURRENT uses matching `where`, with everything the rule needs. Deleted
 * posts are never loaded. Bounded: a caller asks for a variant, a post or a
 * page of Home, never the corpus.
 */
export async function loadCurrentUsage(
  db: TenantScopedClient,
  where: Prisma.ContentKnowledgeUsageWhereInput,
  options: { readonly take?: number } = {},
  clock: Clock = systemClock,
): Promise<UsageRowState[]> {
  const rows = await db.contentKnowledgeUsage.findMany({
    // AND, so a caller's own `item` condition (a status) is kept, not replaced.
    where: { AND: [where, { supersededAt: null, item: { is: { deletedAt: null } } }] },
    select: USAGE_SELECT,
    orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
    take: options.take ?? 500,
  });
  if (rows.length === 0) return [];

  // Versions from the oldest recorded one onwards, per fact — to find the
  // version that introduced the current text.
  const lowest = new Map<string, number>();
  for (const row of rows) {
    const known = lowest.get(row.knowledgeItemId);
    if (known === undefined || row.knowledgeVersion < known) {
      lowest.set(row.knowledgeItemId, row.knowledgeVersion);
    }
  }
  const versions = await db.brandKnowledgeVersion.findMany({
    where: {
      OR: [...lowest].map(([knowledgeItemId, version]) => ({
        knowledgeItemId,
        version: { gte: version },
      })),
    },
    select: { knowledgeItemId: true, version: true, title: true, body: true },
    orderBy: { version: 'desc' },
  });

  const replacementIds = [
    ...new Set(
      rows
        .map((row) => row.knowledge.supersededByItemId)
        .filter((id): id is string => typeof id === 'string'),
    ),
  ];
  const replacements = new Map<string, FactView>();
  if (replacementIds.length > 0) {
    const asOf = await workspaceKnowledgeAsOf(db, clock);
    for (const item of await db.brandKnowledgeItem.findMany({
      where: { id: { in: replacementIds }, ...usableKnowledgeWhere(asOf) },
      select: { id: true, area: true, title: true, version: true },
    })) {
      replacements.set(item.id, {
        id: item.id,
        area: item.area,
        title: localizedFrom(item.title),
        version: item.version,
      });
    }
  }

  const usedVersionOf = (itemId: string, version: number) => {
    const found = versions.find(
      (entry) => entry.knowledgeItemId === itemId && entry.version === version,
    );
    return found ? { title: localizedFrom(found.title), body: localizedFrom(found.body) } : null;
  };

  return rows.map((row) => {
    const title = localizedFrom(row.knowledge.title);
    const body = localizedFrom(row.knowledge.body);
    // Walk back from the current version while the text stays the same.
    let contentVersion = row.knowledge.version;
    for (const version of versions) {
      if (version.knowledgeItemId !== row.knowledgeItemId) continue;
      if (version.version > row.knowledge.version) continue;
      if (
        !sameText(localizedFrom(version.title), title) ||
        !sameText(localizedFrom(version.body), body)
      ) {
        break;
      }
      contentVersion = version.version;
    }
    const replacementId = row.knowledge.supersededByItemId;
    return {
      usageId: row.id,
      brandId: row.brandId,
      contentItemId: row.contentItemId,
      contentVariantId: row.contentVariantId,
      contentStatus: row.item.status,
      knowledgeItemId: row.knowledgeItemId,
      usedVersion: row.knowledgeVersion,
      used: usedVersionOf(row.knowledgeItemId, row.knowledgeVersion),
      area: row.knowledge.area,
      current: {
        status: row.knowledge.status,
        version: row.knowledge.version,
        title,
        body,
        validUntil: row.knowledge.validUntil,
        contentVersion,
      },
      replacement: replacementId ? (replacements.get(replacementId) ?? null) : null,
      dismissedChangeSignature: row.dismissedChangeSignature,
    };
  });
}

// ---------------------------------------------------------------------------
// The Studio's list, Home and "Keep as is"
// ---------------------------------------------------------------------------

/** How one recorded fact reads in the Studio's "Used N Brand Brain facts". */
export type UsageState = 'current' | UsageChangeKind;

export interface VariantUsageEntry {
  readonly usageId: string;
  readonly knowledgeItemId: string;
  readonly area: BrandKnowledgeArea;
  /** The recorded version. */
  readonly usedVersion: number;
  readonly state: UsageState;
  /**
   * The title to show. A REMOVED fact shows none ("Removed fact"): archived
   * text is not repeated beyond what the Brand Brain screen itself shows.
   */
  readonly title: LocalizedText | null;
  /** The title of the version that was used (for old → new). */
  readonly usedTitle: LocalizedText | null;
  /** For `changed`, the current title; for `replaced`, the replacement's. */
  readonly newTitle: LocalizedText | null;
  readonly replacementId: string | null;
  readonly change: UsageChange | null;
  /** An undismissed change on content D10 may act on — the banner shows it. */
  readonly flagged: boolean;
}

export function usageEntryOf(row: UsageRowState, asOf: Date): VariantUsageEntry {
  const change = usageChangeFor(row, asOf);
  const removed = change?.kind === 'removed';
  return {
    usageId: row.usageId,
    knowledgeItemId: row.knowledgeItemId,
    area: row.area,
    usedVersion: row.usedVersion,
    state: change?.kind ?? 'current',
    title: removed ? null : row.current.title,
    usedTitle: removed ? null : (row.used?.title ?? null),
    newTitle:
      change?.kind === 'changed'
        ? row.current.title
        : change?.kind === 'replaced'
          ? (row.replacement?.title ?? null)
          : null,
    replacementId: change?.kind === 'replaced' ? (row.replacement?.id ?? null) : null,
    change,
    flagged: isFlagged(row, asOf),
  };
}

/**
 * The current recorded facts of each variant, for the Studio. The variants are
 * read through the member's brand scope as a predicate.
 */
export async function variantKnowledgeUsage(
  db: TenantScopedClient,
  input: { readonly variantIds: readonly string[]; readonly brandScope: readonly string[] },
  clock: Clock = systemClock,
): Promise<ReadonlyMap<string, readonly VariantUsageEntry[]>> {
  const out = new Map<string, VariantUsageEntry[]>();
  if (input.variantIds.length === 0) return out;
  const rows = await loadCurrentUsage(
    db,
    {
      contentVariantId: { in: [...input.variantIds] },
      ...brandIdQueryFilter({ brandScope: input.brandScope }),
    },
    {},
    clock,
  );
  const asOf = await workspaceKnowledgeAsOf(db, clock);
  for (const row of rows) {
    const list = out.get(row.contentVariantId) ?? [];
    list.push(usageEntryOf(row, asOf));
    out.set(row.contentVariantId, list);
  }
  return out;
}

/**
 * HOME "NEEDS YOU" (D10): the SCHEDULED and IN_REVIEW posts, within the
 * member's brand scope, with at least one undismissed change. Ids only — the
 * caller counts them and links to them.
 */
export async function contentWithFactChanges(
  db: TenantScopedClient,
  input: { readonly brandScope: readonly string[]; readonly statuses?: readonly ContentStatus[] },
  clock: Clock = systemClock,
): Promise<readonly string[]> {
  const statuses = input.statuses ?? D10_HOME_STATUSES;
  const rows = await loadCurrentUsage(
    db,
    {
      item: { is: { deletedAt: null, status: { in: [...statuses] } } },
      ...brandIdQueryFilter({ brandScope: input.brandScope }),
    },
    { take: 2_000 },
    clock,
  );
  const asOf = await workspaceKnowledgeAsOf(db, clock);
  return [...new Set(rows.filter((row) => isFlagged(row, asOf)).map((row) => row.contentItemId))];
}

/**
 * "USED IN N POSTS" (D6 remainder): per fact, the number of DISTINCT posts —
 * not deleted, not archived — whose CURRENT variant usage contains the fact,
 * whatever version was recorded. Brand-scoped and under RLS; a count only, so
 * no post title, caption or variant is disclosed.
 */
export async function usedInPostsCounts(
  db: TenantScopedClient,
  input: { readonly brandId: string; readonly knowledgeItemIds?: readonly string[] },
): Promise<ReadonlyMap<string, number>> {
  const rows = await db.contentKnowledgeUsage.findMany({
    where: {
      brandId: input.brandId,
      supersededAt: null,
      ...(input.knowledgeItemIds ? { knowledgeItemId: { in: [...input.knowledgeItemIds] } } : {}),
      item: { is: { deletedAt: null, status: { not: 'ARCHIVED' } } },
    },
    select: { knowledgeItemId: true, contentItemId: true },
    distinct: ['knowledgeItemId', 'contentItemId'],
  });
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.knowledgeItemId, (counts.get(row.knowledgeItemId) ?? 0) + 1);
  }
  return counts;
}

export function usageChangedSince(): AppError {
  return new AppError('CONFLICT', 'This fact changed again since the page was opened.', {
    expectedLockVersion: 0,
  });
}

/**
 * "KEEP AS IS" (D10): dismiss exactly the change the person saw on one
 * recorded use. The signature they send is re-derived here from stored state;
 * if the fact moved on in between, nothing is written and they are told it
 * changed since. The post's own status must still be one D10 acts on and the
 * post must still be editable. Audited.
 *
 * The caller checks `content.edit`; the variant is read through the member's
 * brand scope as a predicate, so another brand's variant is a plain miss.
 */
export async function keepFactChange(
  db: TenantScopedClient,
  input: {
    readonly workspaceId: string;
    readonly contentVariantId: string;
    readonly knowledgeItemId: string;
    readonly signature: string;
    readonly actorUserId: string;
    readonly brandScope: readonly string[];
  },
  clock: Clock = systemClock,
): Promise<void> {
  const [row] = await loadCurrentUsage(
    db,
    {
      contentVariantId: input.contentVariantId,
      knowledgeItemId: input.knowledgeItemId,
      ...brandIdQueryFilter({ brandScope: input.brandScope }),
    },
    { take: 1 },
    clock,
  );
  if (!row) throw new AppError('NOT_FOUND', 'Not found.');
  if (!D10_CONTENT_STATUSES.includes(row.contentStatus)) {
    throw new AppError('CONFLICT', 'This post can no longer be changed.');
  }
  const change = usageChangeFor(row, await workspaceKnowledgeAsOf(db, clock));
  if (!change || change.signature !== input.signature) throw usageChangedSince();
  if (row.dismissedChangeSignature === change.signature) return;

  const now = clock.now();
  const written = await db.contentKnowledgeUsage.updateMany({
    where: { id: row.usageId, supersededAt: null },
    data: {
      dismissedChangeSignature: change.signature,
      dismissedByUserId: input.actorUserId,
      dismissedAt: now,
    },
  });
  if (written.count !== 1) throw usageChangedSince();

  await writeAuditEvent(db, input.workspaceId, {
    action: 'content.knowledge_change.kept',
    actorType: 'USER',
    actorId: input.actorUserId,
    resourceType: 'ContentVariant',
    resourceId: input.contentVariantId,
    brandId: row.brandId,
    after: {
      knowledgeItemId: input.knowledgeItemId,
      usedVersion: row.usedVersion,
      kind: change.kind,
    },
  });
}

/**
 * D10 REWRITE — what a `refresh_facts` rewrite of one variant starts from: the
 * fact ids its CURRENT usage recorded, and the undismissed changes that make a
 * rewrite worth offering (the post must be one D10 acts on). The signatures
 * name this exact set of changes, so two tabs, a double click or a retry of
 * the same rewrite are the same request.
 */
export async function refreshPlanFor(
  db: TenantScopedClient,
  input: { readonly contentVariantId: string },
  clock: Clock = systemClock,
): Promise<{
  readonly recordedItemIds: readonly string[];
  readonly flaggedSignatures: readonly string[];
}> {
  const rows = await loadCurrentUsage(db, { contentVariantId: input.contentVariantId }, {}, clock);
  const asOf = await workspaceKnowledgeAsOf(db, clock);
  const flaggedSignatures = rows
    .filter((row) => isFlagged(row, asOf))
    .map((row) => (usageChangeFor(row, asOf) as UsageChange).signature)
    .sort();
  return { recordedItemIds: rows.map((row) => row.knowledgeItemId), flaggedSignatures };
}
