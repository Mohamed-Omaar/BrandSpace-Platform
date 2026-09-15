import type { NextResponse } from 'next/server';
import { proxyToApi } from '../proxy';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  return proxyToApi(request, '/v1/content/quote');
}
