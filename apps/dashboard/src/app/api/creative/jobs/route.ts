import { NextResponse } from 'next/server';
import { getFromApi } from '../../content/proxy';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PR 1 (D-597) — the person's recent image jobs on one brand (optionally for
 * some post variants, optionally unfinished only), so a page opened after
 * leaving shows the work still going.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const query = new URL(request.url).searchParams;
  const brandId = query.get('brandId') ?? '';
  if (!UUID.test(brandId)) {
    return NextResponse.json({ error: { code: 'VALIDATION_FAILED' } }, { status: 422 });
  }
  const variants = (query.get('contentVariantIds') ?? '')
    .split(',')
    .filter((id) => UUID.test(id))
    .slice(0, 20);
  const upstream = new URLSearchParams({ brandId });
  if (variants.length > 0) upstream.set('contentVariantIds', variants.join(','));
  if (query.get('unfinished') === '1') upstream.set('unfinished', '1');
  return getFromApi(`/v1/creative/jobs?${upstream.toString()}`);
}
