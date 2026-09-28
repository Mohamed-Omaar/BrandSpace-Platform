import { NextResponse } from 'next/server';
import { DownloadGrantIssuer } from '@brandspace/storage';
import { brandInScope, createLogger, internalErrorFields } from '@brandspace/shared';
import { requireWorkspace, inWorkspace } from '../../../../../server/customer-context';
import { downloadSigningKey, objectStore } from '../../../../../server/assets-context';

const log = createLogger({ context: { component: 'dashboard.assets.font' } });

/**
 * PHASE 2C-2 — SERVE ONE UPLOADED BRAND FONT, the sibling of `assets/file`.
 *
 * The same grant (HMAC-signed, bound to the workspace of the CURRENT session,
 * the storage key and the content type the signature proved, 300 s by default)
 * and the same session guard — but a font is loaded by `@font-face` on every
 * page that uses it, so this route also re-checks at redeem time what the file
 * route leaves to the grant:
 *
 *   - the reader holds `assets.read` AND `brand.read` (the session guard);
 *   - the asset is a FONT, READY and CLEAN, not archived or deleted;
 *   - an ACTIVE `brand_font` of a live brand points at it;
 *   - that brand is inside the reader's BrandScope;
 *   - all under RLS, in the reader's own workspace.
 *
 * Anything else is the same 404, and a page that cannot load the font renders
 * the language's default catalogue font instead. There is no public path, no
 * object-store URL and no cross-workspace reach: the grant is redeemed against
 * the session's workspace, and the lookup runs inside it.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ locale: string; token: string }> },
): Promise<Response> {
  const { locale, token } = await context.params;
  const { workspace } = await requireWorkspace(locale, ['assets.read', 'brand.read']);

  try {
    const issuer = new DownloadGrantIssuer({ signingKey: downloadSigningKey() });
    const claims = issuer.redeem(token, workspace.workspaceId);

    const usable = await inWorkspace(workspace.workspaceId, async ({ db }) => {
      const asset = await db.asset.findFirst({
        where: {
          storageKey: claims.storageKey,
          kind: 'FONT',
          status: 'READY',
          scanStatus: 'CLEAN',
          archivedAt: null,
          deletedAt: null,
          brandFonts: { some: { archivedAt: null, brand: { deletedAt: null } } },
        },
        select: { brandId: true, mimeType: true },
      });
      if (!asset || asset.brandId === null) return false;
      // The member's BrandScope, by the one shared rule.
      if (!brandInScope(workspace.brandScope, asset.brandId)) return false;
      // The type pinned into the grant must still be the asset's own.
      return asset.mimeType === claims.contentType;
    });
    if (!usable) return new NextResponse(null, { status: 404 });

    const bytes = await objectStore().get(claims.storageKey);
    if (!bytes) return new NextResponse(null, { status: 404 });

    // PRIVATE, and never kept past the grant.
    const maxAge = Math.max(0, claims.expiresAt - Math.floor(Date.now() / 1000));

    return new NextResponse(Buffer.from(bytes), {
      status: 200,
      headers: {
        // The type the file's own SIGNATURE proved at upload, pinned into the grant.
        'content-type': claims.contentType,
        'content-length': String(bytes.byteLength),
        'x-content-type-options': 'nosniff',
        // Nothing served here may execute (docs/SECURITY.md §11.6).
        'content-security-policy':
          "default-src 'none'; style-src 'none'; script-src 'none'; sandbox",
        'cache-control': `private, max-age=${maxAge}`,
        'cross-origin-resource-policy': 'same-origin',
      },
    });
  } catch (error: unknown) {
    // Logged WITHOUT the token, the key or the file name (docs/SECURITY.md §5.1).
    log.warn('a font grant was refused', {
      workspaceId: workspace.workspaceId,
      ...internalErrorFields(error),
    });
    return new NextResponse(null, { status: 404 });
  }
}
