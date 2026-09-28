import {
  writeAuditEvent,
  type AssetScanStatus,
  type AssetStatus,
  type TenantScopedClient,
} from '@brandspace/database';
import {
  AppError,
  brandIdScopeFilter,
  fontFormatFor,
  systemClock,
  type BrandFontLanguage,
  type Clock,
  type ReadableUploadedFont,
} from '@brandspace/shared';
import { assertAssetBrandInScope, assertPermission, hasPermission, type AssetActor } from './actor';
import type { AssetDownloadService } from './download';
import { isSelectable, type AssetLibraryService } from './library';
import type { AssetPolicy } from './policy';

/**
 * PHASE 2C-2 (item 3) — A BRAND'S UPLOADED FONTS.
 *
 * THE FILE IS AN ORDINARY ASSET. Uploading a font goes through the one upload
 * path (`AssetUploadService`: the signature, the extension, the scan, the quota,
 * the storage meter), and the result is a library asset of kind FONT like any
 * other. What this service adds is the LOGICAL font a brand uses — a
 * `brand_font` row with its language and the name people see — and the rules
 * about it:
 *
 *   - AT MOST `maxUploadedPerLanguage` (four) ACTIVE fonts per brand and
 *     language. The count runs under a lock on the BRAND ROW, which exists even
 *     when the brand has no font yet, so two concurrent first uploads queue
 *     rather than both seeing "none" (the parent-row pattern of
 *     `multi-brand.ts` and `memberships.ts`). Archived fonts do not count.
 *   - REPLACE keeps the same logical font: the row is repointed to a new asset
 *     (a font cannot change container type as an asset VERSION), so it never
 *     takes a second quota position. The previous asset is archived through the
 *     normal archive path unless something else still uses it (owner decision A).
 *   - REMOVE archives the row — history is kept — and archives its asset under
 *     the same rule.
 *
 * PERMISSIONS COMPOSE, NEVER REPLACE. Look & voice is `brand.manage` (the E3
 * deviation); the asset services underneath still check their own keys —
 * `assets.upload` to upload, `assets.archive` (and `assets.read`) to archive —
 * so a member with `brand.manage` but without them is refused by the asset
 * service, not waved through by the outer action.
 *
 * STORAGE IS NEVER ADJUSTED HERE. Archiving an asset keeps its bytes counted
 * (the existing meter counts every stored version until a delete is purged);
 * this service has no refund and no font-specific accounting.
 */

export type BrandFontStatus = 'processing' | 'ready' | 'failed' | 'unavailable';

export interface BrandFontView {
  readonly id: string;
  readonly language: BrandFontLanguage;
  readonly displayName: string;
  readonly assetId: string;
  readonly status: BrandFontStatus;
  readonly mimeType: string;
  readonly createdAt: Date;
}

/** What happened to the previous file on Replace or Remove (owner decision A). */
export type PreviousAssetOutcome = 'archived' | 'already_archived' | 'kept';

export interface BrandFontServiceOptions {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
  readonly policy: AssetPolicy;
  readonly library: AssetLibraryService;
  readonly download?: AssetDownloadService;
  readonly clock?: Clock;
}

const DISPLAY_NAME_MAX = 80;

export function brandFontNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Font not found.');
}

function displayNameOf(raw: string): string {
  const name = raw.replace(/\s+/g, ' ').trim();
  if (name.length === 0 || name.length > DISPLAY_NAME_MAX) {
    throw new AppError('VALIDATION_FAILED', 'A font name is 1 to 80 characters.');
  }
  return name;
}

const toLocale = (language: BrandFontLanguage) => (language === 'ar' ? 'AR' : 'EN');
const toLanguage = (locale: string): BrandFontLanguage => (locale === 'AR' ? 'ar' : 'en');

function statusOf(asset: {
  status: AssetStatus;
  scanStatus: AssetScanStatus;
  kind: string;
  deletedAt: Date | null;
}): BrandFontStatus {
  if (asset.kind !== 'FONT' || asset.deletedAt !== null || asset.status === 'ARCHIVED') {
    return 'unavailable';
  }
  if (isSelectable(asset)) return 'ready';
  if (asset.status === 'UPLOADING' || asset.status === 'PROCESSING') return 'processing';
  return 'failed';
}

export class BrandFontService {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;
  readonly #policy: AssetPolicy;
  readonly #library: AssetLibraryService;
  readonly #download: AssetDownloadService | undefined;
  readonly #clock: Clock;

  constructor(options: BrandFontServiceOptions) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#policy = options.policy;
    this.#library = options.library;
    this.#download = options.download;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * THE LOCK. The brand row, inside the caller's one transaction, so the count
   * that follows and the insert after it cannot interleave with another upload
   * for the same brand. A brand outside this workspace (RLS) or deleted is the
   * same NOT_FOUND as one that never existed.
   */
  async #lockBrand(brandId: string): Promise<void> {
    const locked = await this.#db.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "brand"
      WHERE "id" = ${brandId}::uuid
        AND "workspaceId" = ${this.#workspaceId}::uuid
        AND "deletedAt" IS NULL
      FOR UPDATE
    `;
    if (locked.length === 0) throw new AppError('NOT_FOUND', 'Brand not found.');
  }

  /**
   * An active font of a brand in the actor's scope. The scope is a PREDICATE of
   * the query (D-132): a font of a brand outside it is never read, and is the
   * same NOT_FOUND as one that does not exist.
   */
  async #activeFont(brandFontId: string, actor: AssetActor) {
    const font = await this.#db.brandFont.findFirst({
      where: {
        id: brandFontId,
        archivedAt: null,
        ...brandIdScopeFilter(actor.brandScope),
      },
    });
    if (!font) throw brandFontNotFound();
    return font;
  }

  /** The brand's active fonts and the state of each file, for Look & voice. */
  async list(brandId: string, actor: AssetActor): Promise<readonly BrandFontView[]> {
    assertPermission(actor, 'brand.read');
    assertAssetBrandInScope(actor, brandId);
    const rows = await this.#db.brandFont.findMany({
      where: { brandId, archivedAt: null },
      orderBy: [{ language: 'asc' }, { createdAt: 'asc' }],
      include: {
        asset: {
          select: { status: true, scanStatus: true, kind: true, deletedAt: true, mimeType: true },
        },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      language: toLanguage(row.language),
      displayName: row.displayName,
      assetId: row.assetId,
      status: statusOf(row.asset),
      mimeType: row.asset.mimeType,
      createdAt: row.createdAt,
    }));
  }

  /**
   * Add a font. `upload` puts the file into the library through the ordinary
   * upload path and runs INSIDE the same transaction, after the limit check —
   * so a refused fifth font stores and charges nothing.
   */
  async add(input: {
    readonly brandId: string;
    readonly language: BrandFontLanguage;
    readonly displayName: string;
    readonly actor: AssetActor;
    readonly upload: () => Promise<{ readonly assetId: string }>;
  }): Promise<{ readonly brandFontId: string; readonly assetId: string }> {
    assertPermission(input.actor, 'brand.manage');
    assertAssetBrandInScope(input.actor, input.brandId);
    const displayName = displayNameOf(input.displayName);

    await this.#lockBrand(input.brandId);
    const active = await this.#db.brandFont.count({
      where: { brandId: input.brandId, language: toLocale(input.language), archivedAt: null },
    });
    if (active >= this.#policy.brandFonts.maxUploadedPerLanguage) {
      throw new AppError(
        'QUOTA_EXCEEDED',
        'This brand already has as many fonts in this language as it can hold.',
        { reason: 'BRAND_FONT_LIMIT' },
      );
    }

    const { assetId } = await input.upload();
    const created = await this.#db.brandFont.create({
      data: {
        workspaceId: this.#workspaceId,
        brandId: input.brandId,
        assetId,
        language: toLocale(input.language),
        displayName,
        createdByUserId: input.actor.userId,
      },
    });
    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'brand.font.added',
      actorType: 'USER',
      actorId: input.actor.userId,
      resourceType: 'brand_font',
      resourceId: created.id,
      brandId: input.brandId,
      after: { language: created.language, assetId, displayName },
    });
    return { brandFontId: created.id, assetId };
  }

  /** The name people see. The file and its storage object are untouched. */
  async rename(input: {
    readonly brandFontId: string;
    readonly displayName: string;
    readonly actor: AssetActor;
  }): Promise<void> {
    assertPermission(input.actor, 'brand.manage');
    const displayName = displayNameOf(input.displayName);
    const font = await this.#activeFont(input.brandFontId, input.actor);
    await this.#db.brandFont.update({ where: { id: font.id }, data: { displayName } });
    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'brand.font.renamed',
      actorType: 'USER',
      actorId: input.actor.userId,
      resourceType: 'brand_font',
      resourceId: font.id,
      brandId: font.brandId,
      before: { displayName: font.displayName },
      after: { displayName },
    });
  }

  /**
   * Replace the file of ONE logical font. The row is repointed to the newly
   * uploaded asset — the same quota position — and the previous asset is
   * archived unless something else still uses it.
   */
  async replace(input: {
    readonly brandFontId: string;
    readonly actor: AssetActor;
    readonly upload: () => Promise<{ readonly assetId: string }>;
  }): Promise<{ readonly assetId: string; readonly previous: PreviousAssetOutcome }> {
    assertPermission(input.actor, 'brand.manage');
    const found = await this.#activeFont(input.brandFontId, input.actor);
    await this.#lockBrand(found.brandId);
    // Re-read under the lock: a concurrent Remove may have archived it.
    const font = await this.#activeFont(input.brandFontId, input.actor);

    const { assetId } = await input.upload();
    await this.#db.brandFont.update({ where: { id: font.id }, data: { assetId } });
    const previous = await this.#archiveIfUnused(font.assetId, font.brandId, input.actor);
    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'brand.font.replaced',
      actorType: 'USER',
      actorId: input.actor.userId,
      resourceType: 'brand_font',
      resourceId: font.id,
      brandId: font.brandId,
      before: { assetId: font.assetId },
      after: { assetId, previousAsset: previous },
    });
    return { assetId, previous };
  }

  /** Remove: the row is archived (never deleted), and so is its file if unused. */
  async remove(input: {
    readonly brandFontId: string;
    readonly actor: AssetActor;
  }): Promise<{ readonly previous: PreviousAssetOutcome }> {
    assertPermission(input.actor, 'brand.manage');
    const found = await this.#activeFont(input.brandFontId, input.actor);
    await this.#lockBrand(found.brandId);
    const font = await this.#activeFont(input.brandFontId, input.actor);
    await this.#db.brandFont.update({
      where: { id: font.id },
      data: { archivedAt: this.#clock.now() },
    });
    const previous = await this.#archiveIfUnused(font.assetId, font.brandId, input.actor);
    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'brand.font.removed',
      actorType: 'USER',
      actorId: input.actor.userId,
      resourceType: 'brand_font',
      resourceId: font.id,
      brandId: font.brandId,
      before: { archivedAt: null },
      after: { assetId: font.assetId, previousAsset: previous },
    });
    return { previous };
  }

  /**
   * OWNER DECISION A. Archive the file through the normal archive path only when
   * no other ACTIVE brand font points at it and it is neither of the brand's
   * logos. A note thread about it does not block the archive (archiving keeps
   * the thread). Already archived (or deleted): nothing to do.
   */
  async #archiveIfUnused(
    assetId: string,
    brandId: string,
    actor: AssetActor,
  ): Promise<PreviousAssetOutcome> {
    const asset = await this.#db.asset.findFirst({
      where: { id: assetId },
      select: { status: true, deletedAt: true },
    });
    if (!asset || asset.deletedAt !== null || asset.status === 'ARCHIVED') {
      return 'already_archived';
    }
    const [otherFonts, logos] = await Promise.all([
      this.#db.brandFont.count({ where: { assetId, archivedAt: null } }),
      this.#db.brand.count({
        where: {
          id: brandId,
          OR: [{ primaryLogoAssetId: assetId }, { secondaryLogoAssetId: assetId }],
        },
      }),
    ]);
    if (otherFonts > 0 || logos > 0) return 'kept';
    await this.#library.archive(assetId, actor);
    return 'archived';
  }

  /**
   * THE UPLOADED FONTS THIS READER MAY USE, each with a short-lived,
   * same-origin URL. A reader without `assets.read` AND `brand.read`, or outside
   * the brand's scope, gets none — and every slot then falls back to the
   * language's default catalogue font. Only READY + CLEAN FONT files of ACTIVE
   * fonts are granted; the grant itself re-checks the asset (`grantFor`).
   */
  async readable(input: {
    readonly brandId: string;
    readonly actor: AssetActor;
    /** Builds the URL of the authenticated font route from a grant token. */
    readonly urlFor: (token: string) => string;
  }): Promise<readonly ReadableUploadedFont[]> {
    if (!this.#download) return [];
    if (!hasPermission(input.actor, 'assets.read') || !hasPermission(input.actor, 'brand.read')) {
      return [];
    }
    try {
      assertAssetBrandInScope(input.actor, input.brandId);
    } catch {
      return [];
    }
    const rows = await this.#db.brandFont.findMany({
      where: { brandId: input.brandId, archivedAt: null, brand: { deletedAt: null } },
      include: {
        asset: {
          select: {
            id: true,
            kind: true,
            status: true,
            scanStatus: true,
            deletedAt: true,
            mimeType: true,
          },
        },
      },
    });
    const out: ReadableUploadedFont[] = [];
    for (const row of rows) {
      if (row.asset.kind !== 'FONT' || !isSelectable(row.asset)) continue;
      const format = fontFormatFor(row.asset.mimeType);
      if (!format) continue;
      try {
        const { grant } = await this.#download.grantFor({
          assetId: row.assetId,
          actor: input.actor,
          disposition: 'inline',
        });
        out.push({
          brandFontId: row.id,
          language: toLanguage(row.language),
          displayName: row.displayName,
          url: input.urlFor(grant.token),
          format,
        });
      } catch {
        // Not readable for this reader: the slot falls back.
      }
    }
    return out;
  }
}
