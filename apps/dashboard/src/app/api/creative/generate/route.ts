import { NextResponse } from 'next/server';
import { proxyToApi } from '../../content/proxy';
import { requireWorkspace } from '../../../../server/customer-context';
import { issuePreviewToken } from '../../../../server/media-picker';

export const dynamic = 'force-dynamic';

/**
 * One generation, and a way to look at what came back.
 *
 * WHY THIS ROUTE DOES MORE THAN PROXY. `apps/api` answers with an asset id,
 * which is correct — it has no business minting a download grant, and the
 * grant's signing key belongs to the dashboard. But a studio that generated an
 * image and could not show it would be a studio nobody would use, so the id is
 * turned into an expiring, per-viewer preview grant HERE, on the tenant side,
 * through the same issuer the Asset Library uses.
 *
 * THE GRANT IS NOT A SHORTCUT PAST AUTHORIZATION. It is issued by the asset
 * download service, which re-checks the permission, the workspace and the
 * member's BrandScope, and refuses an asset that is not selectable. If it
 * cannot be issued the response still carries the asset id and the screen shows
 * the library link instead of a picture.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const body: unknown = await request
    .clone()
    .json()
    .catch(() => null);
  const upstream = await proxyToApi(request, '/v1/creative/generate');
  if (upstream.status !== 200) return upstream;

  const payload = (await upstream.json().catch(() => null)) as Record<string, unknown> | null;
  const assetId = typeof payload?.['assetId'] === 'string' ? payload['assetId'] : null;
  if (!payload || !assetId) return NextResponse.json(payload ?? {}, { status: upstream.status });

  try {
    const locale =
      typeof (body as { locale?: unknown } | null)?.locale === 'string'
        ? String((body as { locale: string }).locale)
        : 'en';
    const session = await requireWorkspace(locale, 'assets.read');
    const preview = await issuePreviewToken({
      workspaceId: session.workspace.workspaceId,
      assetId,
      userId: session.customer.userId,
      permissionKeys: session.workspace.permissionKeys,
      brandScope: session.workspace.brandScope,
    });
    return NextResponse.json({ ...payload, ...preview }, { status: 200 });
  } catch {
    // The image exists and is in the library; only the preview is unavailable.
    return NextResponse.json(payload, { status: 200 });
  }
}
