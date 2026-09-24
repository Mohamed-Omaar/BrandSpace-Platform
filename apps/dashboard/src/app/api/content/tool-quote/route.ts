import type { NextResponse } from 'next/server';
import { proxyToApi } from '../proxy';

export const dynamic = 'force-dynamic';

/** PHASE 6 FINAL (D-284) — the estimate for one inline AI edit. */
export async function POST(request: Request): Promise<NextResponse> {
  return proxyToApi(request, '/v1/content/tool/quote');
}
