import type { NextResponse } from 'next/server';
import { proxyCommerce } from '../../proxy';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  return proxyCommerce(request, '/v1/commerce/subscription/preview');
}
