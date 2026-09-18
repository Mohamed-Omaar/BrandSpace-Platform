import 'server-only';
import { inAssetLibrary } from './assets-context';

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
        .filter((asset) => asset.scanStatus === 'CLEAN' && asset.deletedAt === null)
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
            shared: asset.brandId === null,
            previewToken: token,
          };
        }),
    );
  });
}
