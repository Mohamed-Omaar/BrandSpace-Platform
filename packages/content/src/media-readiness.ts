import { missingMediaFor, parseConfigPayload, type MissingMedia } from '@brandspace/config';
import { currentEnvironment } from '@brandspace/shared';
import type { TenantScopedClient } from '@brandspace/database';

/**
 * A CHANNEL THAT NEEDS MEDIA NEVER GOES OUT WITHOUT IT (Studio review, owner
 * decision 1 — D-569).
 *
 * Send-for-review and scheduling ask this before anything is written: for each
 * of the post's channels, does its configured capability
 * (`publishing.providers.<key>.postKinds` and `.mediaRules`) need a picture or
 * a video the post does not have? The Studio's check card asks the same pure
 * rule (`missingMediaFor`), so the card and the refusal say the same thing.
 *
 * The capability is read from the tenant-readable projection of the active
 * `publishing` document, the same one `TenantPublishingPolicySource` reads; no
 * snapshot means nothing is activated yet, and the schema's defaults then ask
 * for no media at all. The workspace predicate sits beside RLS (CLAUDE.md §2.1).
 */
export interface ChannelMissingMedia {
  readonly platformKey: string;
  readonly need: MissingMedia;
}

const PUBLISHING_DOMAIN = 'publishing';

export async function channelsMissingMedia(
  db: TenantScopedClient,
  workspaceId: string,
  item: { readonly id: string; readonly contentType: string },
): Promise<readonly ChannelMissingMedia[]> {
  const variants = await db.contentVariant.findMany({
    where: { workspaceId, contentItemId: item.id },
    select: { platformKey: true, assetIds: true },
    orderBy: { platformKey: 'asc' },
  });
  if (variants.length === 0) return [];
  const snapshot = await db.entitlementCatalogueSnapshot.findUnique({
    where: {
      domain_environment: { domain: PUBLISHING_DOMAIN, environment: currentEnvironment() },
    },
  });
  const providers = (
    parseConfigPayload(PUBLISHING_DOMAIN, snapshot?.payload ?? {}) as {
      providers: Record<
        string,
        { postKinds: string[]; mediaRules?: Record<string, { minItems?: number | null }> }
      >;
    }
  ).providers;
  const assetIds = [...new Set(variants.flatMap((variant) => variant.assetIds))];
  const assets =
    assetIds.length === 0
      ? []
      : await db.asset.findMany({
          where: { workspaceId, id: { in: assetIds }, deletedAt: null },
          select: { id: true, kind: true },
        });
  const kindOf = new Map(assets.map((asset) => [asset.id, asset.kind as string]));
  const missing: ChannelMissingMedia[] = [];
  for (const variant of variants) {
    const kinds = variant.assetIds
      .map((id) => kindOf.get(id))
      .filter((kind): kind is string => kind !== undefined);
    const need = missingMediaFor(item.contentType, kinds, providers[variant.platformKey]);
    if (need) missing.push({ platformKey: variant.platformKey, need });
  }
  return missing;
}
