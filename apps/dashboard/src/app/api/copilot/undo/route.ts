import type { NextResponse } from 'next/server';
import { proxyCopilot } from '../proxy';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  return proxyCopilot(request, '/v1/copilot/undo');
}
