import type { TenantScopedClient } from '@brandspace/database';
import { AppError } from '@brandspace/shared';

/**
 * A NEWLY CHOSEN BRAND LOGO MUST BE A USABLE IMAGE (Phase 2C-2, owner
 * decision D).
 *
 * The composite foreign key and the `brand_canonical_asset_scope` trigger keep
 * a logo inside the workspace and inside the brand (its own asset, or a shared
 * one); they cannot say IMAGE, READY, CLEAN or not archived. The picker only
 * offers such assets, but a crafted request is not the picker — so the server
 * checks, for both logo columns, whenever a value changes. An unchanged value
 * is not re-checked, so a logo that was later archived does not make the rest
 * of the profile unsaveable.
 */

export function logoNotUsable(): AppError {
  return new AppError('VALIDATION_FAILED', 'A logo must be a ready, clean image of this brand.', {
    reason: 'LOGO_NOT_USABLE',
  });
}

/** IMAGE, READY, CLEAN, not archived or deleted, this brand's or shared. */
export async function assertUsableLogo(
  db: TenantScopedClient,
  brandId: string,
  assetId: string,
): Promise<void> {
  const asset = await db.asset.findFirst({
    where: {
      id: assetId,
      kind: 'IMAGE',
      status: 'READY',
      scanStatus: 'CLEAN',
      archivedAt: null,
      deletedAt: null,
      OR: [{ brandId }, { brandId: null }],
    },
    select: { id: true },
  });
  if (!asset) throw logoNotUsable();
}
