import { writeAuditEvent, type TenantScopedClient } from '@brandspace/database';
import { AppError, typographyJson, type BrandTypographySlots } from '@brandspace/shared';

/**
 * THE ONE WRITE OF A BRAND'S PROFILE AND APPEARANCE (D-193, Phase 2C-2).
 *
 * Settings → Brand and Brand Brain → Look & voice both save through here, so
 * the brand row, the `brand.profile.updated` audit event and the rules below
 * cannot differ between the two screens. Callers have already required
 * `brand.manage` and the member's BrandScope; this runs inside their
 * `withWorkspace` transaction, so RLS applies to every statement.
 *
 * A FIELD THAT IS NOT IN THE PATCH IS NOT TOUCHED. That is what keeps Settings →
 * Brand from overwriting the typography Look & voice owns (owner decision E):
 * it simply never sends typography, and the only typography writer is the v2
 * one below — no path can write v1 or drop a slot.
 *
 * A NEWLY CHOSEN LOGO MUST BE A USABLE IMAGE (owner decision D). The composite
 * foreign key and the `brand_canonical_asset_scope` trigger already keep a logo
 * inside the workspace and inside the brand (its own asset, or a shared one);
 * they cannot say IMAGE, READY, CLEAN or not archived, so this does, on the
 * server, for both logo columns. A value that is unchanged is not re-checked,
 * so an existing logo that was later archived does not make the rest of the
 * profile unsaveable.
 */

export interface BrandProfilePatch {
  readonly name?: string;
  readonly industry?: string | null;
  readonly description?: string | null;
  readonly websiteUrl?: string | null;
  readonly defaultLocale?: 'AR' | 'EN';
  readonly supportedLocales?: readonly ('AR' | 'EN')[];
  readonly colorPalette?: readonly string[];
  readonly typography?: BrandTypographySlots;
  readonly primaryLogoAssetId?: string | null;
  readonly secondaryLogoAssetId?: string | null;
}

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

export async function saveBrandProfile(
  db: TenantScopedClient,
  input: {
    readonly workspaceId: string;
    readonly actorUserId: string;
    readonly brandId: string;
    readonly patch: BrandProfilePatch;
  },
): Promise<'saved' | 'not_found'> {
  const before = await db.brand.findFirst({
    where: { id: input.brandId, deletedAt: null },
    select: {
      name: true,
      industry: true,
      description: true,
      websiteUrl: true,
      defaultLocale: true,
      supportedLocales: true,
      colorPalette: true,
      typography: true,
      primaryLogoAssetId: true,
      secondaryLogoAssetId: true,
    },
  });
  if (!before) return 'not_found';

  const { patch } = input;
  for (const column of ['primaryLogoAssetId', 'secondaryLogoAssetId'] as const) {
    const next = patch[column];
    if (next !== undefined && next !== null && next !== before[column]) {
      await assertUsableLogo(db, input.brandId, next);
    }
  }

  const data = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.industry !== undefined ? { industry: patch.industry } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.websiteUrl !== undefined ? { websiteUrl: patch.websiteUrl } : {}),
    ...(patch.defaultLocale !== undefined ? { defaultLocale: patch.defaultLocale } : {}),
    ...(patch.supportedLocales !== undefined
      ? { supportedLocales: [...patch.supportedLocales] }
      : {}),
    ...(patch.colorPalette !== undefined ? { colorPalette: [...patch.colorPalette] } : {}),
    ...(patch.typography !== undefined ? { typography: typographyJson(patch.typography) } : {}),
    ...(patch.primaryLogoAssetId !== undefined
      ? { primaryLogoAssetId: patch.primaryLogoAssetId }
      : {}),
    ...(patch.secondaryLogoAssetId !== undefined
      ? { secondaryLogoAssetId: patch.secondaryLogoAssetId }
      : {}),
  };
  await db.brand.update({ where: { id: input.brandId }, data });

  // EVERY STATE CHANGE IS AUDITED (CLAUDE.md §5). The before/after are profile
  // fields — a brand's own description of itself — and carry no secret.
  await writeAuditEvent(db, input.workspaceId, {
    action: 'brand.profile.updated',
    actorType: 'USER',
    actorId: input.actorUserId,
    resourceType: 'brand',
    resourceId: input.brandId,
    brandId: input.brandId,
    severity: 'NOTICE',
    before,
    after: data,
  });
  return 'saved';
}
