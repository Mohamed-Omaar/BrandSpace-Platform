import type { NextResponse } from 'next/server';
import { proxyCopilot } from '../proxy';

export const dynamic = 'force-dynamic';

/**
 * Decline a plan (P6-12). "Cancel" used to forget the plan in the browser only,
 * leaving it open on the server and counting against the open-plan ceiling.
 */
export async function POST(request: Request): Promise<NextResponse> {
  return proxyCopilot(request, '/v1/copilot/cancel');
}
