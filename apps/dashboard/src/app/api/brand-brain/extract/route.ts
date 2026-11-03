import type { NextResponse } from 'next/server';
import { proxyCopilot } from '../../copilot/proxy';

export const dynamic = 'force-dynamic';

/** PR B (D-591) — the Copilot's Add card asks the API to read a file whole. */
export async function POST(request: Request): Promise<NextResponse> {
  return proxyCopilot(request, '/v1/brand-brain/extract');
}
