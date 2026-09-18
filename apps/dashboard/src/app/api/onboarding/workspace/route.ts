import type { NextResponse } from 'next/server';
import { proxyCommerce } from '../../commerce/proxy';

export const dynamic = 'force-dynamic';

/**
 * Creating a workspace goes to `apps/api`.
 *
 * `workspace` carries FORCE ROW LEVEL SECURITY and the row being inserted IS the
 * tenant that would authorise it, so creation needs the platform connection —
 * which F-07 keeps out of this app entirely.
 */
export async function POST(request: Request): Promise<NextResponse> {
  return proxyCommerce(request, '/v1/onboarding/workspace');
}
