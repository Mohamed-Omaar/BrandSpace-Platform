import { NextResponse } from 'next/server';
import { getFromApi } from '../../../content/proxy';
import { requireWorkspace } from '../../../../../server/customer-context';
import { issuePreviewToken } from '../../../../../server/media-picker';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PR 1 (D-597) — ONE IMAGE JOB'S STATE, for the person who asked.
 *
 * The API owns the job and answers 404 for anyone else's. Once it has
 * SUCCEEDED, a short-lived preview token for its image is added here, the
 * same way the synchronous route used to, so the Studio can show it at once.
 * The state shown is always the row's: never guessed by the browser.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
  const upstream = await getFromApi(`/v1/creative/jobs/${id}`);
  if (upstream.status !== 200) return upstream;
  const payload = (await upstream.json().catch(() => null)) as {
    job?: { status?: string; assetId?: string | null };
  } | null;
  const job = payload?.job;
  if (!job || job.status !== 'SUCCEEDED' || typeof job.assetId !== 'string') {
    return NextResponse.json(payload ?? {}, { headers: { 'cache-control': 'private, no-store' } });
  }
  try {
    const locale = new URL(request.url).searchParams.get('locale') === 'ar' ? 'ar' : 'en';
    const session = await requireWorkspace(locale, 'assets.read');
    const preview = await issuePreviewToken({
      workspaceId: session.workspace.workspaceId,
      assetId: job.assetId,
      userId: session.customer.userId,
      permissionKeys: session.workspace.permissionKeys,
      brandScope: session.workspace.brandScope,
    });
    return NextResponse.json(
      { ...payload, ...preview },
      { headers: { 'cache-control': 'private, no-store' } },
    );
  } catch {
    return NextResponse.json(payload, { headers: { 'cache-control': 'private, no-store' } });
  }
}
