import 'server-only';
import { canPreviewWithoutDerivative, isSelectable } from '@brandspace/assets';
import { inAssetLibrary } from './assets-context';

/** A post's first picture: an expiring inline grant, or a video's marker. */
export type FirstPicture =
  { readonly kind: 'image'; readonly src: string } | { readonly kind: 'video' };

/**
 * THE FIRST PICTURE OF EACH POST, as an expiring grant — only for an asset
 * that is ready, clean and previewable inline. A video is shown as a video,
 * never as a broken image. Shared by the Posts library and the Approvals
 * queue (review of #67, round 3), so both draw the post's real cover through
 * the one download service.
 */
export async function firstPictures(input: {
  readonly locale: string;
  readonly workspaceId: string;
  readonly actor: {
    readonly userId: string;
    readonly permissionKeys: readonly string[];
    readonly brandScope: readonly string[];
  };
  readonly assetIds: readonly string[];
}): Promise<Map<string, FirstPicture>> {
  const wanted = [...new Set(input.assetIds)];
  const media = new Map<string, FirstPicture>();
  if (wanted.length === 0 || !input.actor.permissionKeys.includes('assets.read')) return media;
  await inAssetLibrary(input.workspaceId, async (services) => {
    const assets = await services.db.asset.findMany({
      where: { id: { in: wanted }, deletedAt: null },
    });
    const download = await services.download();
    for (const asset of assets) {
      if (!isSelectable(asset)) continue;
      if (asset.kind === 'VIDEO') {
        media.set(asset.id, { kind: 'video' });
      } else if (canPreviewWithoutDerivative(asset.mimeType, asset.sizeBytes)) {
        const grant = await download
          .grantFor({ assetId: asset.id, actor: input.actor, disposition: 'inline' })
          .then((issued) => issued.grant.token)
          .catch(() => null);
        if (grant) {
          media.set(asset.id, { kind: 'image', src: `/${input.locale}/assets/file/${grant}` });
        }
      }
    }
  });
  return media;
}
