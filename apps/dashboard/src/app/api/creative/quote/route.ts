import type { NextResponse } from 'next/server';
import { proxyToApi } from '../../content/proxy';

export const dynamic = 'force-dynamic';

/**
 * The Creative Studio's price check.
 *
 * SAME PROXY AS THE CONTENT STUDIO'S, deliberately. It forwards one credential
 * to one constant upstream path and nothing else; a second implementation of
 * that rule is a second chance to get it wrong.
 */
export async function POST(request: Request): Promise<NextResponse> {
  return proxyToApi(request, '/v1/creative/quote');
}
