import 'server-only';
import { systemClock } from '@brandspace/shared';
import { inAssetLibrary } from './assets-context';

function rightsLapsed(expiry: Date | null): boolean {
  return expiry !== null && expiry.getTime() <= systemClock.now().getTime();
}

/**
 * THE MEDIA A COMPOSER MAY OFFER, AND A PREVIEW TOKEN FOR EACH (AC-27.2).
 *
 * ONE LIBRARY, NOT A SECOND ONE. This reads the SAME `Asset` table the Asset
 * Library screen reads, through the same tenant-scoped client and the same
 * download-grant issuer. There is no Content Studio media store and there must
 * never be one: a second library is two answers to "where is our artwork?"
 * (D-193).
 *
 * WHAT IS OFFERED: the brand's own images and video, plus the workspace-SHARED
 * shelf (`brandId IS NULL`), READY and CLEAN only. A quarantined, failed, still
 * uploading or soft-deleted asset is not shown, because offering one would let
 * an author build a post around a file that can never publish.
 *
 * THE TOKEN IS AN OPAQUE, EXPIRING GRANT — never a storage key and never a
 * signed URL in a column. Exactly what the Asset Library screen uses; the route
 * that redeems it re-checks the session, the workspace and the expiry.
 */

export interface MediaOption {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly mimeType: string;
  readonly width: number | null;
  readonly height: number | null;
  /** PHASE 6 FINAL — a video's length, when the processor measured it. */
  readonly durationMs: number | null;
  /** D-286 — the licence has ended; the file can no longer be published. */
  readonly rightsExpired: boolean;
  /** True for the workspace-shared shelf, so the screen can say so. */
  readonly shared: boolean;
  /** `null` when no inline preview can be issued; the row still lists. */
  readonly previewToken: string | null;
}

export async function listMediaOptions(input: {
  readonly workspaceId: string;
  readonly brandId: string;
  readonly userId: string;
  readonly permissionKeys: readonly string[];
  readonly brandScope: readonly string[];
  readonly limit?: number;
}): Promise<readonly MediaOption[]> {
  /*
   * A MEMBER WITHOUT `assets.read` IS OFFERED NOTHING, and that is not a
   * silent failure: the composer shows the honest "no media" state, and the
   * download service would refuse the grant anyway. Checking here as well keeps
   * a pointless query off the request.
   */
  if (!input.permissionKeys.includes('assets.read')) return [];

  return inAssetLibrary(input.workspaceId, async (services) => {
    const library = await services.library();
    const download = await services.download();
    const actor = {
      userId: input.userId,
      permissionKeys: input.permissionKeys,
      brandScope: input.brandScope,
    };

    const page = await library.browse({
      actor,
      brandId: input.brandId,
      // The brand's own shelf AND the shared one, which is what an author means
      // by "our pictures".
      includeShared: true,
      kinds: ['IMAGE', 'VIDEO'],
      statuses: ['READY'],
      limit: input.limit ?? 60,
    });

    return Promise.all(
      page.items
        // D-286: a lapsed licence is not offered, exactly as publishing refuses it.
        .filter(
          (asset) =>
            asset.scanStatus === 'CLEAN' &&
            asset.deletedAt === null &&
            !rightsLapsed(asset.rightsExpiryAt),
        )
        .map(async (asset): Promise<MediaOption> => {
          const token = await download
            .grantFor({ assetId: asset.id, actor, disposition: 'inline' })
            .then((issued) => issued.grant.token)
            .catch(() => null);
          return {
            id: asset.id,
            name: asset.name,
            kind: asset.kind,
            mimeType: asset.mimeType,
            width: asset.width,
            height: asset.height,
            durationMs: asset.durationMs ?? null,
            rightsExpired: false,
            shared: asset.brandId === null,
            previewToken: token,
          };
        }),
    );
  });
}

/**
 * A preview grant for ONE asset, for a screen that has just created it.
 *
 * SAME ISSUER, SAME CHECKS as the Asset Library's listing: the download service
 * re-verifies `assets.read`, the workspace and the member's BrandScope, and
 * refuses an asset that is not selectable. This is a convenience for the
 * Creative Studio, never a shortcut past any of that.
 *
 * It returns the asset's NAME too, because the screen that shows the picture
 * also has to label it, and a second round trip for a string is a second round
 * trip.
 */
export async function issuePreviewToken(input: {
  readonly workspaceId: string;
  readonly assetId: string;
  readonly userId: string;
  readonly permissionKeys: readonly string[];
  readonly brandScope: readonly string[];
}): Promise<{ previewToken: string | null; name: string }> {
  return inAssetLibrary(input.workspaceId, async (services) => {
    const download = await services.download();
    const issued = await download.grantFor({
      assetId: input.assetId,
      actor: {
        userId: input.userId,
        permissionKeys: input.permissionKeys,
        brandScope: input.brandScope,
      },
      disposition: 'inline',
    });
    return { previewToken: issued.grant.token, name: issued.asset.name };
  });
}

/**
 * Preview grants for a specific set of asset ids, keyed by id.
 *
 * FOR A SCREEN THAT ALREADY KNOWS WHAT IT IS SHOWING — an approval under
 * review, a calendar entry — rather than one browsing a library. It issues the
 * same expiring, per-viewer grants through the same download service, which
 * re-checks the permission, the workspace and the member's BrandScope.
 *
 * AN ID THAT CANNOT BE RESOLVED IS SIMPLY ABSENT FROM THE MAP. A deleted or
 * quarantined asset is not shown as a broken tile: the publish pipeline would
 * refuse it too, and a broken tile would suggest the post is still whole.
 */
export async function mediaForVariants(input: {
  readonly workspaceId: string;
  readonly userId: string;
  readonly permissionKeys: readonly string[];
  readonly brandScope: readonly string[];
  readonly assetIds: readonly string[];
}): Promise<Map<string, MediaOption>> {
  const unique = [...new Set(input.assetIds)];
  if (unique.length === 0 || !input.permissionKeys.includes('assets.read')) {
    return new Map();
  }

  return inAssetLibrary(input.workspaceId, async (services) => {
    const library = await services.library();
    const download = await services.download();
    const actor = {
      userId: input.userId,
      permissionKeys: input.permissionKeys,
      brandScope: input.brandScope,
    };

    const found = new Map<string, MediaOption>();
    for (const assetId of unique) {
      const asset = await library.get(assetId, actor).catch(() => null);
      if (!asset || asset.status !== 'READY' || asset.scanStatus !== 'CLEAN') continue;
      const token = await download
        .grantFor({ assetId, actor, disposition: 'inline' })
        .then((issued) => issued.grant.token)
        .catch(() => null);
      found.set(assetId, {
        id: asset.id,
        name: asset.name,
        kind: asset.kind,
        mimeType: asset.mimeType,
        width: asset.width,
        height: asset.height,
        durationMs: asset.durationMs ?? null,
        // Still drawn, so the author can see WHICH slide lapsed and replace it.
        rightsExpired: rightsLapsed(asset.rightsExpiryAt),
        shared: asset.brandId === null,
        previewToken: token,
      });
    }
    return found;
  });
}
