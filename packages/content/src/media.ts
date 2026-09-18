import { AppError, assertBrandInScope } from '@brandspace/shared';
import type { TenantScopedClient } from '@brandspace/database';
import type { ContentPolicy } from './policy';
import { findPlatform } from './policy';

/**
 * THE ONE GATE EVERY MEDIA REFERENCE PASSES THROUGH (AC-27.2, AC-29.3).
 *
 * WHY THIS IS A MODULE AND NOT A FEW LINES IN THE COMPOSER. `ContentVariant`
 * stores media as `assetIds String[]`, which is a uuid array and therefore
 * CANNOT carry a composite foreign key — the tenant boundary that protects
 * every other reference in this schema is not available here. The schema says
 * so out loud: "the tenant boundary here is enforced in the SERVICE".
 *
 * That makes this file the boundary. It is used by the Studio when media is
 * attached, and again by the publish preflight before a payload reaches a
 * provider adapter — the same rules, in one place, so the screen and the
 * pipeline cannot disagree about what is publishable.
 *
 * WHAT AN ADMISSIBLE ASSET IS, and every clause earns its place:
 *
 *   - IN THIS WORKSPACE. Enforced by the tenant-scoped client and RLS; a
 *     foreign id simply returns no row.
 *   - THE VARIANT'S OWN BRAND, OR WORKSPACE-SHARED (`brandId IS NULL`). The
 *     shared shelf is the logo pack every brand draws on; another BRAND's
 *     private artwork is the cross-brand leak `BrandScope` exists to prevent,
 *     and no foreign key expresses it.
 *   - WITHIN THE CALLER'S OWN BrandScope, as a query predicate (D-132), so an
 *     asset outside it is never read rather than read and then rejected.
 *   - READY AND CLEAN. An asset still uploading has no bytes, one whose scan
 *     failed is quarantined, and one that is soft-deleted is gone. Publishing
 *     any of the three is the thing the scanner exists to stop.
 *   - A KIND A POST CAN CARRY. A PDF is a fine asset and not a photograph.
 *
 * EVERY REFUSAL IS A MISS. "That asset is quarantined" tells a caller the asset
 * exists; so does "that belongs to another brand". Both answer NOT_FOUND, the
 * same answer a fabricated uuid gets (CLAUDE.md §2.1).
 */

/** Kinds a social post can carry. A document is an asset and not a picture. */
export const PUBLISHABLE_ASSET_KINDS = ['IMAGE', 'VIDEO'] as const;

export interface ResolvedMedia {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly mimeType: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly brandId: string | null;
}

export function mediaNotFound(): AppError {
  // The SAME message a missing asset gets. See the note above on refusals.
  return new AppError('NOT_FOUND', 'Asset not found.');
}

export function tooManyMedia(platformKey: string, max: number): AppError {
  return new AppError(
    'VALIDATION_FAILED',
    `The ${platformKey} platform accepts at most ${max} media item(s) on one post.`,
  );
}

export interface MediaResolverOptions {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
}

export class ContentMediaResolver {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;

  constructor(options: MediaResolverOptions) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
  }

  /**
   * Resolve media ids for one brand, IN ORDER, refusing anything inadmissible.
   *
   * ORDER IS CONTENT. A carousel's first image is its cover, so the caller's
   * order is preserved rather than the database's — which is why this maps over
   * the input rather than returning what `findMany` happened to give back.
   *
   * DUPLICATES ARE REFUSED rather than de-duplicated: the same picture twice in
   * a carousel is far more likely to be a mistake than an intention, and
   * silently dropping one would publish something the author did not review.
   */
  async resolve(input: {
    readonly assetIds: readonly string[];
    readonly brandId: string;
    readonly brandScope: readonly string[];
  }): Promise<readonly ResolvedMedia[]> {
    if (input.assetIds.length === 0) return [];

    // The brand the media is being attached FOR must itself be in scope: an
    // out-of-scope brand cannot borrow the shared shelf either.
    assertBrandInScope(input.brandScope, input.brandId);

    const unique = new Set(input.assetIds);
    if (unique.size !== input.assetIds.length) {
      throw new AppError('VALIDATION_FAILED', 'The same asset was attached more than once.');
    }

    const rows = await this.#db.asset.findMany({
      where: {
        id: { in: [...unique] },
        workspaceId: this.#workspaceId,
        deletedAt: null,
        status: 'READY',
        scanStatus: 'CLEAN',
        kind: { in: [...PUBLISHABLE_ASSET_KINDS] },
        /*
         * THE BRAND CLAUSE, IN THE QUERY. `OR` of "this brand" and "shared",
         * intersected with the member's own scope — so an asset belonging to a
         * brand the member cannot see is not read even when the target brand
         * would otherwise admit it.
         */
        AND: [
          { OR: [{ brandId: input.brandId }, { brandId: null }] },
          assetScopeClause(input.brandScope),
        ],
      },
      select: {
        id: true,
        name: true,
        kind: true,
        mimeType: true,
        width: true,
        height: true,
        brandId: true,
      },
    });

    const byId = new Map(rows.map((row) => [row.id, row]));
    return input.assetIds.map((id) => {
      const row = byId.get(id);
      if (!row) throw mediaNotFound();
      return row;
    });
  }

  /**
   * Resolve AND check the platform's own authoring ceiling.
   *
   * The publish preflight checks the PROVIDER's ceiling separately, against the
   * publishing policy, because the two are different facts: what the product
   * lets somebody compose, and what the platform will actually accept today.
   */
  async resolveForPlatform(input: {
    readonly assetIds: readonly string[];
    readonly brandId: string;
    readonly brandScope: readonly string[];
    readonly platformKey: string;
    readonly policy: ContentPolicy;
  }): Promise<readonly ResolvedMedia[]> {
    const platform = findPlatform(input.policy, input.platformKey);
    if (!platform) throw new AppError('VALIDATION_FAILED', 'That platform is not enabled.');
    if (input.assetIds.length > platform.maxMediaItems) {
      throw tooManyMedia(platform.key, platform.maxMediaItems);
    }
    return this.resolve({
      assetIds: input.assetIds,
      brandId: input.brandId,
      brandScope: input.brandScope,
    });
  }
}

/**
 * The BrandScope clause for an asset, which is NOT the ordinary one.
 *
 * `brandIdQueryFilter` restricts `brandId` to the scope — correct for a
 * brand-owned row, wrong for an asset, because a workspace-SHARED asset has
 * `brandId = null` and a scoped member must still be able to use the shared
 * shelf. This admits the scope plus null, and contributes nothing at all when
 * the scope is empty (unrestricted).
 */
function assetScopeClause(brandScope: readonly string[]): Record<string, unknown> {
  if (brandScope.length === 0) return {};
  return { OR: [{ brandId: { in: [...brandScope] } }, { brandId: null }] };
}

/** Exported for the isolation suite, which asserts the clause directly. */
export const __assetScopeClause = assetScopeClause;
