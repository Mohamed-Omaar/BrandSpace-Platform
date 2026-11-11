import { proxyCopilotStream } from '../proxy';

export const dynamic = 'force-dynamic';

/** PR A (smart Copilot, D-604) — one message, answered as a stream. */
export async function POST(request: Request): Promise<Response> {
  return proxyCopilotStream(request, '/v1/copilot/stream');
}
