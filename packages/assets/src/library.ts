import {
  writeAuditEvent,
  type Asset,
  type AssetFolder,
  type AssetKind,
  type AssetStatus,
  type AssetVersion,
  type Prisma,
  type TenantScopedClient,
} from '@brandspace/database';
import { AppError, type Clock, systemClock } from '@brandspace/shared';
import {
  assetBrandScopeFilter,
  assertAssetBrandInScope,
  assertPermission,
  type AssetActor,
} from './actor';
import {
  assetNotFound,
  assetNotUsable,
  folderCycle,
  folderNotEmpty,
  folderNotFound,
  folderTooDeep,
  tooManyTags,
} from './errors';
import type { AssetPolicy } from './policy';

/**
 * Browsing, organising and the asset lifecycle.
 *
 * EVERY READ IS SCOPED TWICE. RLS keeps another tenant's rows invisible, and
 * `brandScope` decides which of THIS tenant's brands the member may act on
 * (F-74). The second is not a restatement of the first: inside one workspace
 * every row is legitimately the tenant's, and no database policy can express
 * "which of your own brands may this person touch". So it is enforced HERE, in
 * the service, where a new call site cannot forget it — not at each screen.
 *
 * PAGINATION IS CURSOR-BASED AND ORDERING IS TOTAL. R-26 requires cursors on
 * all tenant data, and the reason bites hardest on a library: a customer
 * scrolling a grid while a colleague uploads would, with offsets, see rows
 * repeat and rows vanish. The sort key is always a PAIR ending in `id`, because
 * `createdAt` alone is not unique — two assets uploaded in the same millisecond
 * would order arbitrarily, and an arbitrary order is not a stable page boundary.
 */

export interface AssetLibraryServiceOptions {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
  readonly policy: AssetPolicy;
  readonly clock?: Clock;
}

export type AssetSortField = 'createdAt' | 'name' | 'sizeBytes';
export type SortDirection = 'asc' | 'desc';

export interface BrowseAssetsInput {
  readonly actor: AssetActor;
  /** `undefined` means every brand the actor may see; `null` means workspace-level only. */
  readonly brandId?: string | null | undefined;
  /**
   * With a brand named, also return the workspace-level (shared) assets.
   *
   * THE DEFAULT VIEW OF A BRAND IS NOT JUST ITS OWN FILES. The logo pack, the
   * fonts and the stock every brand draws on live at `brandId = null`, and a
   * brand view that hid them would send people to "All assets" to find the
   * things they use most — or, worse, to upload a second copy. It changes
   * nothing about authorization: `brandId` is still checked against the actor's
   * scope, and shared assets are workspace-level and already visible to any
   * member who may read assets at all.
   */
  readonly includeShared?: boolean | undefined;
  readonly folderId?: string | null | undefined;
  readonly kinds?: readonly AssetKind[] | undefined;
  readonly statuses?: readonly AssetStatus[] | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly search?: string | undefined;
  readonly sort?: AssetSortField | undefined;
  readonly direction?: SortDirection | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | null | undefined;
  /** Include archived assets. Off by default: the library shows live work. */
  readonly includeArchived?: boolean | undefined;
}

export interface AssetPage {
  readonly items: readonly Asset[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/** The ceiling on one page, whatever a caller asks for. */
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 48;

export class AssetLibraryService {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;
  readonly #policy: AssetPolicy;
  readonly #clock: Clock;

  constructor(options: AssetLibraryServiceOptions) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#policy = options.policy;
    this.#clock = options.clock ?? systemClock;
  }

  /* --- Browsing --------------------------------------------------------- */

  async browse(input: BrowseAssetsInput): Promise<AssetPage> {
    assertPermission(input.actor, 'assets.read');
    if (input.brandId !== undefined) assertAssetBrandInScope(input.actor, input.brandId);

    const limit = Math.min(Math.max(1, input.limit ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
    const sort = input.sort ?? 'createdAt';
    const direction = input.direction ?? (sort === 'name' ? 'asc' : 'desc');

    const where: Prisma.AssetWhereInput = {
      deletedAt: null,
      ...this.#brandFilter(input.actor, input.brandId, input.includeShared === true),
    };
    if (input.folderId !== undefined) where.folderId = input.folderId;
    if (input.kinds && input.kinds.length > 0) where.kind = { in: [...input.kinds] };
    if (input.statuses && input.statuses.length > 0) {
      where.status = { in: [...input.statuses] };
    } else if (!input.includeArchived) {
      where.status = { not: 'ARCHIVED' };
    }
    // `hasEvery`, not `hasSome`: selecting two tags means "both", which is what
    // a person filtering a library expects and what makes filters narrow.
    if (input.tags && input.tags.length > 0) where.tags = { hasEvery: [...input.tags] };
    if (input.search && input.search.trim() !== '') {
      /*
       * NAME ONLY, and case-insensitively. Searching the storage key or the
       * checksum would let a caller confirm a key by probing for it, and
       * neither is something a person would type.
       */
      where.name = { contains: input.search.trim(), mode: 'insensitive' };
    }

    const rows = await this.#db.asset.findMany({
      where: this.#withCursor(where, sort, direction, input.cursor ?? null),
      // A TOTAL ORDER. The second key is what makes the page boundary stable
      // when the first key ties, which it does constantly on `createdAt`.
      orderBy: [{ [sort]: direction }, { id: direction }] as Prisma.AssetOrderByWithRelationInput[],
      // One extra row answers "is there more" without a second COUNT query
      // that could disagree with the page under concurrent writes.
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    return {
      items,
      hasMore,
      nextCursor: hasMore && last ? encodeCursor(last, sort) : null,
    };
  }

  async get(assetId: string, actor: AssetActor): Promise<Asset> {
    assertPermission(actor, 'assets.read');
    // Another workspace's asset is invisible to RLS and arrives as null — the
    // same answer a missing one gives, which is the point (CLAUDE.md §2.1).
    // D-132 puts the BRAND scope in the same place, so an out-of-scope asset
    // is refused by the query rather than after it.
    const asset = await this.#db.asset.findFirst({
      where: { id: assetId, ...assetBrandScopeFilter(actor) },
    });
    if (!asset || asset.deletedAt !== null) throw assetNotFound();
    return asset;
  }

  /**
   * The tags in use, with their counts — the facet list the filter bar shows.
   *
   * DERIVED, NOT CATALOGUED. docs/DATABASE.md §4.6 stores tags as an array with
   * a GIN index rather than as an entity, so the set of tags IS whatever the
   * live assets carry. A catalogue table would be a second source of truth for
   * the same strings, and the two would disagree the first time an asset was
   * deleted.
   */
  async tagFacets(
    actor: AssetActor,
    brandId?: string | null,
  ): Promise<ReadonlyArray<{ tag: string; count: number }>> {
    assertPermission(actor, 'assets.read');
    if (brandId !== undefined) assertAssetBrandInScope(actor, brandId);

    const rows = await this.#db.asset.findMany({
      where: { deletedAt: null, status: { not: 'ARCHIVED' }, ...this.#brandFilter(actor, brandId) },
      select: { tags: true },
    });
    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const tag of row.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return (
      [...counts.entries()]
        .map(([tag, count]) => ({ tag, count }))
        // Commonest first, then alphabetically — a total order, so the filter bar
        // does not reshuffle between two renders of the same data.
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    );
  }

  /** Every version of an asset, newest first. */
  async versions(assetId: string, actor: AssetActor): Promise<readonly AssetVersion[]> {
    const asset = await this.get(assetId, actor);
    return this.#db.assetVersion.findMany({
      where: { assetId: asset.id },
      orderBy: { versionNumber: 'desc' },
    });
  }

  /* --- Metadata --------------------------------------------------------- */

  async updateMetadata(input: {
    readonly assetId: string;
    readonly actor: AssetActor;
    readonly name?: string | undefined;
    readonly tags?: readonly string[] | undefined;
    readonly folderId?: string | null | undefined;
    readonly license?: string | null | undefined;
    readonly rightsExpiryAt?: Date | null | undefined;
  }): Promise<Asset> {
    assertPermission(input.actor, 'assets.edit');
    const asset = await this.get(input.assetId, input.actor);

    const data: Prisma.AssetUncheckedUpdateInput = {};
    if (input.name !== undefined) {
      const trimmed = input.name.trim();
      if (trimmed === '') throw new AppError('VALIDATION_FAILED', 'A name is required.');
      data.name = trimmed.slice(0, this.#policy.upload.maxFileNameLength);
    }
    if (input.tags !== undefined) data.tags = this.#normaliseTags(input.tags);
    if (input.license !== undefined) data.license = input.license;
    if (input.rightsExpiryAt !== undefined) data.rightsExpiryAt = input.rightsExpiryAt;
    if (input.folderId !== undefined) {
      /*
       * THE SCALAR, NOT `connect`.
       *
       * `folderId` is half of a COMPOSITE relation — `(workspaceId, folderId)`
       * — so Prisma implements `connect: { id }` by writing BOTH columns from
       * the row it looked up. That rewrite of `workspaceId` is what the RLS
       * `WITH CHECK` refuses, and the failure surfaces as
       * "new row violates row-level security policy" from a statement that only
       * meant to move a file into a folder. Found by the isolation suite.
       *
       * Writing the scalar leaves `workspaceId` untouched. The foreign key
       * still holds the pair together, and `#assertFolderAccepts` has already
       * established that the folder is visible to this tenant and accepts this
       * brand.
       */
      if (input.folderId !== null) {
        await this.#assertFolderAccepts(input.folderId, asset.brandId, input.actor);
      }
      data.folderId = input.folderId;
    }

    const updated = await this.#db.asset.update({ where: { id: asset.id }, data });

    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'assets.metadata_updated',
      actorType: 'USER',
      actorId: input.actor.userId,
      resourceType: 'Asset',
      resourceId: asset.id,
      brandId: asset.brandId ?? undefined,
      before: { name: asset.name, tags: asset.tags, folderId: asset.folderId },
      after: { name: updated.name, tags: updated.tags, folderId: updated.folderId },
    });
    return updated;
  }

  /* --- Lifecycle -------------------------------------------------------- */

  async archive(assetId: string, actor: AssetActor): Promise<Asset> {
    assertPermission(actor, 'assets.archive');
    const asset = await this.get(assetId, actor);
    const updated = await this.#db.asset.update({
      where: { id: asset.id },
      data: { status: 'ARCHIVED', archivedAt: this.#clock.now() },
    });
    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'assets.archived',
      actorType: 'USER',
      actorId: actor.userId,
      resourceType: 'Asset',
      resourceId: asset.id,
      brandId: asset.brandId ?? undefined,
      before: { status: asset.status },
      after: { status: updated.status },
    });
    return updated;
  }

  async restore(assetId: string, actor: AssetActor): Promise<Asset> {
    assertPermission(actor, 'assets.restore');
    const asset = await this.get(assetId, actor);
    /*
     * RESTORING RETURNS THE ASSET TO WHAT IT WAS, NOT TO USABLE.
     *
     * The scan verdict decides the status, not the restore: an asset archived
     * while infected must not come back READY because somebody pressed
     * restore. `CLEAN` returns it to READY; anything else returns it to
     * quarantine, where it was.
     */
    const status: AssetStatus = asset.scanStatus === 'CLEAN' ? 'READY' : 'QUARANTINED';
    const updated = await this.#db.asset.update({
      where: { id: asset.id },
      data: { status, archivedAt: null },
    });
    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'assets.restored',
      actorType: 'USER',
      actorId: actor.userId,
      resourceType: 'Asset',
      resourceId: asset.id,
      brandId: asset.brandId ?? undefined,
      before: { status: asset.status },
      after: { status: updated.status },
    });
    return updated;
  }

  /**
   * Delete an asset.
   *
   * SOFT, AND THE OBJECTS OUTLIVE THE ROW ON PURPOSE. The retention sweep
   * removes the bytes after the configured grace (`purgeDeletedAfterDays`), so
   * a deletion somebody regrets is recoverable for as long as an operator said
   * it should be. Deleting the objects here would make the grace period a lie.
   */
  async delete(assetId: string, actor: AssetActor): Promise<void> {
    assertPermission(actor, 'assets.delete');
    const asset = await this.get(assetId, actor);
    const now = this.#clock.now();
    await this.#db.asset.update({
      where: { id: asset.id },
      data: { deletedAt: now, status: 'ARCHIVED', archivedAt: asset.archivedAt ?? now },
    });
    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'assets.deleted',
      actorType: 'USER',
      actorId: actor.userId,
      resourceType: 'Asset',
      resourceId: asset.id,
      brandId: asset.brandId ?? undefined,
      severity: 'NOTICE',
      before: { name: asset.name, status: asset.status },
    });
  }

  /* --- Selection for other modules -------------------------------------- */

  /**
   * Resolve an asset for USE by another module, or refuse.
   *
   * THE ONE ENTRY POINT other features call, and the reason `assets.use` is its
   * own permission. docs/DATABASE.md §4.6: "an asset is usable only when
   * status='ready' AND scanStatus='clean'". Putting that rule here rather than
   * in each consumer means the Content Studio, the Calendar and the publisher
   * cannot each get it slightly wrong — and cannot forget it entirely, which is
   * the failure that puts an unscanned file in front of the public.
   */
  async resolveForUse(assetId: string, actor: AssetActor): Promise<Asset> {
    assertPermission(actor, 'assets.use');
    const asset = await this.get(assetId, actor);
    if (!isSelectable(asset)) throw assetNotUsable();
    return asset;
  }

  /* --- Folders ---------------------------------------------------------- */

  async createFolder(input: {
    readonly actor: AssetActor;
    readonly name: string;
    readonly brandId: string | null;
    readonly parentFolderId: string | null;
  }): Promise<AssetFolder> {
    assertPermission(input.actor, 'assets.manage_taxonomy');
    assertAssetBrandInScope(input.actor, input.brandId);

    const name = input.name.trim();
    if (name === '') throw new AppError('VALIDATION_FAILED', 'A folder name is required.');

    if (input.parentFolderId !== null) {
      const parent = await this.#loadFolder(input.parentFolderId, input.actor);
      if (parent.brandId !== input.brandId) throw folderNotFound();
      const depth = await this.#depthOf(parent.id);
      /*
       * `maxFolderDepth` is how many LEVELS are allowed, so a folder created at
       * exactly that depth is legal and the one below it is not. The first
       * version used `>=`, which silently allowed one level fewer than an
       * operator configured — invisible until a test set the ceiling to 2 and
       * got one level.
       */
      if (depth + 1 > this.#policy.upload.maxFolderDepth) throw folderTooDeep();
    }

    const folder = await this.#db.assetFolder.create({
      data: {
        workspaceId: this.#workspaceId,
        brandId: input.brandId,
        parentFolderId: input.parentFolderId,
        name,
        createdByUserId: input.actor.userId,
      },
    });
    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'assets.folder_created',
      actorType: 'USER',
      actorId: input.actor.userId,
      resourceType: 'AssetFolder',
      resourceId: folder.id,
      brandId: input.brandId ?? undefined,
      after: { name: folder.name, parentFolderId: folder.parentFolderId },
    });
    return folder;
  }

  async listFolders(actor: AssetActor, brandId?: string | null): Promise<readonly AssetFolder[]> {
    assertPermission(actor, 'assets.read');
    if (brandId !== undefined) assertAssetBrandInScope(actor, brandId);
    return this.#db.assetFolder.findMany({
      where: { deletedAt: null, ...this.#brandFilter(actor, brandId) },
      // A total order, so a tree render is stable between two loads.
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }

  async renameFolder(input: {
    readonly actor: AssetActor;
    readonly folderId: string;
    readonly name: string;
  }): Promise<AssetFolder> {
    assertPermission(input.actor, 'assets.manage_taxonomy');
    const folder = await this.#loadFolder(input.folderId, input.actor);
    const name = input.name.trim();
    if (name === '') throw new AppError('VALIDATION_FAILED', 'A folder name is required.');

    const updated = await this.#db.assetFolder.update({
      where: { id: folder.id },
      data: { name },
    });
    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'assets.folder_renamed',
      actorType: 'USER',
      actorId: input.actor.userId,
      resourceType: 'AssetFolder',
      resourceId: folder.id,
      brandId: folder.brandId ?? undefined,
      before: { name: folder.name },
      after: { name: updated.name },
    });
    return updated;
  }

  async moveFolder(input: {
    readonly actor: AssetActor;
    readonly folderId: string;
    readonly parentFolderId: string | null;
  }): Promise<AssetFolder> {
    assertPermission(input.actor, 'assets.manage_taxonomy');
    const folder = await this.#loadFolder(input.folderId, input.actor);

    if (input.parentFolderId !== null) {
      if (input.parentFolderId === folder.id) throw folderCycle();
      const parent = await this.#loadFolder(input.parentFolderId, input.actor);
      if (parent.brandId !== folder.brandId) throw folderNotFound();
      /*
       * A FOLDER CANNOT BE MOVED INSIDE ITS OWN SUBTREE.
       *
       * Not a tidiness rule: the resulting cycle is detached from the root, so
       * it disappears from every listing AND makes every walk of the tree — the
       * depth check, the breadcrumb, the delete guard — loop forever. The first
       * one to run takes the process with it.
       */
      if (await this.#isDescendantOf(parent.id, folder.id)) throw folderCycle();
      const depth = await this.#depthOf(parent.id);
      /*
       * `maxFolderDepth` is how many LEVELS are allowed, so a folder created at
       * exactly that depth is legal and the one below it is not. The first
       * version used `>=`, which silently allowed one level fewer than an
       * operator configured — invisible until a test set the ceiling to 2 and
       * got one level.
       */
      if (depth + 1 > this.#policy.upload.maxFolderDepth) throw folderTooDeep();
    }

    const updated = await this.#db.assetFolder.update({
      where: { id: folder.id },
      data: { parentFolderId: input.parentFolderId },
    });
    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'assets.folder_moved',
      actorType: 'USER',
      actorId: input.actor.userId,
      resourceType: 'AssetFolder',
      resourceId: folder.id,
      brandId: folder.brandId ?? undefined,
      before: { parentFolderId: folder.parentFolderId },
      after: { parentFolderId: updated.parentFolderId },
    });
    return updated;
  }

  /**
   * Delete a folder.
   *
   * REFUSED WHILE IT HOLDS ANYTHING. The database says the same thing — the
   * composite foreign key is `onDelete: Restrict` — but a constraint violation
   * reaches a customer as an opaque failure, and "this folder still has items
   * in it" is something they can act on. The constraint is the backstop for a
   * race between the check and the delete.
   */
  async deleteFolder(input: { actor: AssetActor; folderId: string }): Promise<void> {
    assertPermission(input.actor, 'assets.manage_taxonomy');
    const folder = await this.#loadFolder(input.folderId, input.actor);

    const [assetCount, childCount] = await Promise.all([
      this.#db.asset.count({ where: { folderId: folder.id, deletedAt: null } }),
      this.#db.assetFolder.count({ where: { parentFolderId: folder.id, deletedAt: null } }),
    ]);
    if (assetCount > 0 || childCount > 0) throw folderNotEmpty();

    await this.#db.assetFolder.update({
      where: { id: folder.id },
      data: { deletedAt: this.#clock.now() },
    });
    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'assets.folder_deleted',
      actorType: 'USER',
      actorId: input.actor.userId,
      resourceType: 'AssetFolder',
      resourceId: folder.id,
      brandId: folder.brandId ?? undefined,
      before: { name: folder.name },
    });
  }

  /* --- Internals -------------------------------------------------------- */

  /**
   * The brand predicate for a listing.
   *
   * REFUSING AFTER THE FACT IS TOO LATE FOR A LIST: rows the member may not see
   * would already have been read. A restricted member's listing is filtered to
   * their scope PLUS workspace-level rows, which belong to the workspace rather
   * than to any brand and are therefore in scope for every member of it.
   */
  #brandFilter(
    actor: AssetActor,
    brandId: string | null | undefined,
    includeShared = false,
  ): {
    brandId?: string | null;
    OR?: Array<{ brandId: { in: string[] } | null } | { brandId: string | null }>;
  } {
    if (brandId !== undefined) {
      // ONE BRAND PLUS THE SHARED SHELF, when the caller asked for it. Still an
      // `OR` rather than an `in`, for the reason below: Prisma's `in` cannot
      // carry null and the shared rows are exactly the null ones.
      if (brandId !== null && includeShared) return { OR: [{ brandId }, { brandId: null }] };
      return { brandId };
    }
    if (actor.brandScope.length === 0) return {};
    /*
     * AN `OR` RATHER THAN `in: [...scope, null]`, because Prisma's `in` does not
     * admit null — and a filter that silently dropped the null would hide every
     * workspace-level asset from anyone with a scope set, which is the one group
     * that most needs the shared logo pack.
     */
    return { OR: [{ brandId: { in: [...actor.brandScope] } }, { brandId: null }] };
  }

  #withCursor(
    where: Prisma.AssetWhereInput,
    sort: AssetSortField,
    direction: SortDirection,
    cursor: string | null,
  ): Prisma.AssetWhereInput {
    if (!cursor) return where;
    const decoded = decodeCursor(cursor);
    if (!decoded) return where;
    /*
     * A KEYSET PREDICATE, not an offset. "Strictly after the last row in the
     * previous page" is expressed as "the sort value is past it, OR it ties and
     * the id is past it" — which is exactly the total order the `orderBy`
     * above uses, and is what makes a page boundary hold while rows are being
     * inserted.
     */
    const operator = direction === 'desc' ? 'lt' : 'gt';
    return {
      AND: [
        where,
        {
          OR: [
            { [sort]: { [operator]: decoded.value } },
            { [sort]: decoded.value, id: { [operator]: decoded.id } },
          ],
        } as Prisma.AssetWhereInput,
      ],
    };
  }

  #normaliseTags(tags: readonly string[]): string[] {
    const cleaned = tags
      .map((tag) => tag.trim().toLowerCase())
      .filter((tag) => tag !== '')
      .map((tag) => tag.slice(0, this.#policy.upload.maxTagLength));
    // De-duplicated AFTER normalisation, so "Hero" and "hero " are one tag
    // rather than two rows that look the same in a filter bar.
    const unique = [...new Set(cleaned)].sort();
    if (unique.length > this.#policy.upload.maxTagsPerAsset) throw tooManyTags();
    return unique;
  }

  /**
   * D-132: the ACTOR is required, so the brand scope is applied in the query.
   *
   * It is a parameter rather than something a caller may forget: every folder
   * read went through here already, so making the scope part of the signature
   * means a new caller cannot reintroduce the post-read form without deleting
   * an argument the compiler demands.
   */
  async #loadFolder(folderId: string, actor: AssetActor): Promise<AssetFolder> {
    const folder = await this.#db.assetFolder.findFirst({
      where: { id: folderId, ...assetBrandScopeFilter(actor) },
    });
    if (!folder || folder.deletedAt !== null) throw folderNotFound();
    return folder;
  }

  async #assertFolderAccepts(
    folderId: string,
    brandId: string | null,
    actor: AssetActor,
  ): Promise<void> {
    const folder = await this.#loadFolder(folderId, actor);
    if (folder.brandId !== null && folder.brandId !== brandId) throw folderNotFound();
  }

  /**
   * How deep a folder sits.
   *
   * BOUNDED BY THE POLICY CEILING rather than by trust in the data. A cycle
   * that somehow exists — a migration, a direct write — must not turn this into
   * an infinite loop, so the walk stops at the configured maximum and reports
   * it. Refusing a legitimate move at the ceiling is recoverable; hanging is
   * not.
   */
  async #depthOf(folderId: string): Promise<number> {
    let depth = 0;
    let current: string | null = folderId;
    while (current !== null && depth <= this.#policy.upload.maxFolderDepth) {
      const row: { parentFolderId: string | null } | null = await this.#db.assetFolder.findUnique({
        where: { id: current },
        select: { parentFolderId: true },
      });
      if (!row) break;
      depth += 1;
      current = row.parentFolderId;
    }
    return depth;
  }

  /** Whether `candidate` sits anywhere beneath `ancestor`. */
  async #isDescendantOf(candidate: string, ancestor: string): Promise<boolean> {
    let current: string | null = candidate;
    let steps = 0;
    while (current !== null && steps <= this.#policy.upload.maxFolderDepth) {
      if (current === ancestor) return true;
      const row: { parentFolderId: string | null } | null = await this.#db.assetFolder.findUnique({
        where: { id: current },
        select: { parentFolderId: true },
      });
      if (!row) return false;
      current = row.parentFolderId;
      steps += 1;
    }
    return false;
  }
}

/**
 * docs/DATABASE.md §4.6: "an asset is usable only when status='ready' AND
 * scanStatus='clean'".
 *
 * BOTH CONDITIONS, AND EXPORTED SO THERE IS ONE COPY. A caller that checked
 * only the status would select a file that finished processing while the
 * scanner was still deciding — which is the exact window quarantine exists to
 * close.
 */
export function isSelectable(asset: Pick<Asset, 'status' | 'scanStatus' | 'deletedAt'>): boolean {
  return asset.deletedAt === null && asset.status === 'READY' && asset.scanStatus === 'CLEAN';
}

interface DecodedCursor {
  readonly value: string | number | Date;
  readonly id: string;
}

/**
 * The cursor is OPAQUE to the caller and carries no secret.
 *
 * It holds a sort value and an id the caller has already been shown, so base64
 * is encoding rather than protection — it exists so a client cannot come to
 * depend on the shape, and so a malformed one is ignored rather than
 * misinterpreted. A forged cursor can only move a reader within rows RLS
 * already lets them see.
 */
function encodeCursor(asset: Asset, sort: AssetSortField): string {
  const value = sort === 'createdAt' ? asset.createdAt.toISOString() : asset[sort];
  return Buffer.from(JSON.stringify([value, asset.id]), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): DecodedCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [raw, id] = parsed as [unknown, unknown];
    if (typeof id !== 'string') return null;
    if (typeof raw === 'number') return { value: raw, id };
    if (typeof raw !== 'string') return null;
    // An ISO timestamp round-trips as a string; a Date is what Prisma needs to
    // compare against a timestamptz column.
    const asDate = new Date(raw);
    const looksLikeTimestamp = /^\d{4}-\d{2}-\d{2}T/.test(raw) && !Number.isNaN(asDate.getTime());
    return { value: looksLikeTimestamp ? asDate : raw, id };
  } catch {
    return null;
  }
}
