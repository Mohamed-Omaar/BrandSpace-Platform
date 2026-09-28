import 'server-only';
import { BrandFontService, type AssetActor } from '@brandspace/assets';
import type { TenantScopedClient } from '@brandspace/database';
import {
  allSlots,
  fontFaceCss,
  readStoredTypography,
  resolveTypography,
  type BrandFontCatalogue,
  type ReadableUploadedFont,
  type ResolvedTypography,
} from '@brandspace/shared';
import { assetPolicy, inAssetLibrary, type AssetServices } from './assets-context';
import type { WorkspaceSession } from './customer-context';

/**
 * PHASE 2C-2 — BRAND FONTS IN THE DASHBOARD.
 *
 * The service lives in `@brandspace/assets`; this module wires it to the
 * dashboard's session, transaction and URLs, and answers the two questions the
 * screens ask:
 *
 *   - `brandTypographyFor` — the four slots AS THIS READER SEES THEM, with the
 *     @font-face CSS for exactly the fonts in use. Uploaded fonts reach the page
 *     only as short-lived URLs of the authenticated font route, and only when
 *     the reader holds `assets.read` and `brand.read` and the brand is in their
 *     scope; otherwise the slot falls back to the catalogue default.
 *   - `typographySummaryFor` — the four slots' NAMES for a management or
 *     summary line, whoever reads them; nothing is served.
 */

export function assetActorOf(session: WorkspaceSession): AssetActor {
  return {
    userId: session.customer.userId,
    permissionKeys: session.workspace.permissionKeys,
    brandScope: session.workspace.brandScope,
  };
}

export function fontUrl(locale: string, token: string): string {
  return `/${locale}/assets/font/${token}`;
}

export async function brandFontServiceFrom(
  services: Pick<AssetServices, 'db' | 'policy' | 'library' | 'download'>,
  workspaceId: string,
): Promise<BrandFontService> {
  return new BrandFontService({
    db: services.db,
    workspaceId,
    policy: await services.policy(),
    library: await services.library(),
    download: await services.download(),
  });
}

export function catalogueOf(policy: {
  readonly brandFonts: BrandFontCatalogue;
}): BrandFontCatalogue {
  return { catalogue: policy.brandFonts.catalogue, defaults: policy.brandFonts.defaults };
}

export interface BrandTypographyView {
  readonly resolved: ResolvedTypography;
  /** @font-face rules for exactly the fonts the slots use. Same-origin URLs only. */
  readonly css: string;
}

export async function brandTypographyFor(input: {
  readonly session: WorkspaceSession;
  readonly locale: string;
  readonly brandId: string;
}): Promise<BrandTypographyView> {
  return inAssetLibrary(input.session.workspace.workspaceId, async (services) => {
    const brand = await services.db.brand.findFirst({
      where: { id: input.brandId, deletedAt: null },
      select: { typography: true },
    });
    const policy = await services.policy();
    const fonts = await brandFontServiceFrom(services, input.session.workspace.workspaceId);
    const readable = await fonts.readable({
      brandId: input.brandId,
      actor: assetActorOf(input.session),
      urlFor: (token) => fontUrl(input.locale, token),
    });
    const resolved = resolveTypography({
      stored: brand?.typography ?? null,
      catalogue: catalogueOf(policy),
      readable,
    });
    return { resolved, css: fontFaceCss({ used: allSlots(resolved), readable }) };
  });
}

/**
 * The slots' NAMES — for Settings → Brand, the Asset Library's brand kit and
 * the image prompt. Uploaded fonts are named when their file is ready; nothing
 * is granted or served.
 */
export async function typographySummaryFor(
  db: TenantScopedClient,
  brandId: string,
  stored: unknown,
): Promise<ResolvedTypography> {
  const policy = await assetPolicy(db);
  const rows = await db.brandFont.findMany({
    where: {
      brandId,
      archivedAt: null,
      asset: {
        kind: 'FONT',
        status: 'READY',
        scanStatus: 'CLEAN',
        deletedAt: null,
      },
    },
    select: { id: true, language: true, displayName: true },
  });
  const named: ReadableUploadedFont[] = rows.map((row) => ({
    brandFontId: row.id,
    language: row.language === 'AR' ? 'ar' : 'en',
    displayName: row.displayName,
    url: '',
    format: 'truetype',
  }));
  return resolveTypography({ stored, catalogue: catalogueOf(policy), readable: named });
}

/**
 * The Asset Library's brand-kit line. A brand still on the v1 shape shows its
 * stored names as before; a v2 brand shows its four slots' names.
 */
export async function brandKitFontNames(
  db: TenantScopedClient,
  brandId: string,
  stored: unknown,
): Promise<readonly string[]> {
  const read = readStoredTypography(stored);
  if (read.version === 1) {
    return [read.legacy.heading, read.legacy.body].filter((name): name is string => !!name);
  }
  if (read.version === 0) return [];
  const resolved = await typographySummaryFor(db, brandId, stored);
  return [...new Set(allSlots(resolved).map((slot) => slot.name))];
}
