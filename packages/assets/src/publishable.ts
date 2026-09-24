import type { Prisma, TenantScopedClient } from '@brandspace/database';
import type { ObjectStore } from '@brandspace/storage';
import { AppError, systemClock, type Clock } from '@brandspace/shared';

/**
 * WHAT COUNTS AS PUBLISHABLE MEDIA — ONE PREDICATE, TWO CALLERS (AC-27.2, AC-29.3).
 *
 * WHY IT LIVES HERE. Two places ask the same question and must never answer it
 * differently: the Content Studio, when an author attaches a picture, and the
 * publish pipeline, just before a payload reaches a provider. If the Studio
 * admitted something publishing later refused, an author would compose a post
 * that could never go out — and if publishing admitted something the Studio
 * refused, the refusal would be theatre.
 *
 * `ContentVariant.assetIds` IS A UUID ARRAY and cannot carry a composite
 * foreign key, so this predicate IS the tenant boundary for media. The schema
 * says so; this file is where it is kept.
 *
 * WHAT IS ADMISSIBLE, and every clause earns its place:
 *
 *   - THIS WORKSPACE. Enforced by the tenant-scoped client and RLS; a foreign
 *     id returns no row at all.
 *   - THIS BRAND, OR WORKSPACE-SHARED (`brandId IS NULL`). The shared shelf is
 *     the artwork every brand draws on; another BRAND's private file is the
 *     cross-brand leak no foreign key expresses.
 *   - INSIDE THE CALLER'S OWN BrandScope, as a query predicate (D-132).
 *   - READY AND CLEAN. Still uploading means no bytes; a failed scan means
 *     quarantined; soft-deleted means gone. Publishing any of the three is what
 *     the scanner exists to prevent.
 *   - A KIND A POST CAN CARRY. A PDF is a fine asset and not a photograph.
 *   - RIGHTS STILL IN FORCE (Phase 6 final, D-286). `rightsExpiryAt` is the
 *     date the licence to use the file ends; after it the file may not be
 *     attached to a post, and a post already carrying it may not publish.
 *     Absent means no recorded limit. Measured against the caller's clock, so
 *     the composer and the pipeline decide on the same rule at their own
 *     moment — a post scheduled before the date and sent after it is refused.
 */

/** Kinds a social post can carry. A document is an asset and not a picture. */
export const PUBLISHABLE_ASSET_KINDS = ['IMAGE', 'VIDEO'] as const;

export function publishableAssetWhere(input: {
  readonly assetIds: readonly string[];
  readonly workspaceId: string;
  readonly brandId: string;
  readonly brandScope: readonly string[];
  /** The moment the question is asked, for rights expiry (D-286). */
  readonly now: Date;
}): Prisma.AssetWhereInput {
  return {
    id: { in: [...new Set(input.assetIds)] },
    workspaceId: input.workspaceId,
    deletedAt: null,
    status: 'READY',
    scanStatus: 'CLEAN',
    kind: { in: [...PUBLISHABLE_ASSET_KINDS] },
    AND: [
      { OR: [{ brandId: input.brandId }, { brandId: null }] },
      { OR: [{ rightsExpiryAt: null }, { rightsExpiryAt: { gt: input.now } }] },
      /*
       * THE SCOPE CLAUSE FOR AN ASSET IS NOT THE ORDINARY ONE. Restricting
       * `brandId` to the scope would hide the workspace-SHARED shelf, whose
       * `brandId` is null — and a scoped member must still be able to use it.
       * An empty scope is unrestricted and contributes nothing.
       */
      input.brandScope.length === 0
        ? {}
        : { OR: [{ brandId: { in: [...input.brandScope] } }, { brandId: null }] },
    ],
  };
}

export function publishableMediaNotFound(): AppError {
  // The SAME answer a missing asset gets: "that belongs to another brand" and
  // "that is quarantined" both confirm the asset exists (CLAUDE.md §2.1).
  return new AppError('NOT_FOUND', 'Asset not found.');
}

/** One media item, with the bytes a provider adapter will be handed. */
export interface ResolvedPublishMedia {
  readonly assetId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly bytes: Uint8Array;
}

export interface PublishMediaResolverOptions {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
  readonly store: ObjectStore;
  readonly clock?: Clock;
}

/**
 * Resolve media ids to bytes, for the publish pipeline.
 *
 * IT THROWS RATHER THAN RETURNING A SHORT LIST. A resolver that quietly
 * dropped an inadmissible asset would publish the caption the author wrote
 * with the picture missing — a post nobody reviewed.
 *
 * ORDER IS CONTENT: a carousel's first image is its cover, so the caller's
 * order is preserved rather than the database's.
 */
export class PublishMediaResolver {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;
  readonly #store: ObjectStore;
  readonly #clock: Clock;

  constructor(options: PublishMediaResolverOptions) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#store = options.store;
    this.#clock = options.clock ?? systemClock;
  }

  async resolve(input: {
    readonly brandId: string;
    readonly assetIds: readonly string[];
    readonly brandScope: readonly string[];
  }): Promise<readonly ResolvedPublishMedia[]> {
    if (input.assetIds.length === 0) return [];

    const rows = await this.#db.asset.findMany({
      where: publishableAssetWhere({
        assetIds: input.assetIds,
        workspaceId: this.#workspaceId,
        brandId: input.brandId,
        brandScope: input.brandScope,
        now: this.#clock.now(),
      }),
      select: {
        id: true,
        name: true,
        mimeType: true,
        sizeBytes: true,
        width: true,
        height: true,
        storageKey: true,
      },
    });

    const byId = new Map(rows.map((row) => [row.id, row]));
    const resolved: ResolvedPublishMedia[] = [];
    for (const assetId of input.assetIds) {
      const row = byId.get(assetId);
      if (!row) throw publishableMediaNotFound();
      /*
       * THE BYTES ARE READ HERE, not by the adapter. An adapter given a storage
       * key or a signed url would be a place tenant isolation could fail; it is
       * a translator to one provider's API and gets a buffer.
       */
      const bytes = await this.#store.get(row.storageKey);
      if (!bytes || bytes.byteLength === 0) throw publishableMediaNotFound();
      resolved.push({
        assetId: row.id,
        fileName: row.name,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        width: row.width,
        height: row.height,
        bytes,
      });
    }
    return resolved;
  }
}
