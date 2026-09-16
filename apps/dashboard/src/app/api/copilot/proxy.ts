import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { CUSTOMER_REALM } from '@brandspace/auth';
import { createLogger, internalErrorFields } from '@brandspace/shared';

const log = createLogger({ context: { component: 'dashboard.copilot.proxy' } });

/**
 * The Copilot proxy — the same construction the Content Studio proxy uses, and
 * for the same reason.
 *
 * THE DASHBOARD CANNOT RUN A COPILOT TURN ITSELF: the orchestrator calls the AI
 * Gateway, which needs the platform database identity that F-07 keeps out of
 * tenant-facing apps. So this hands the request to `apps/api` and returns its
 * answer verbatim.
 *
 * IT FORWARDS ONE THING AND NOTHING ELSE: the customer's session cookie, as a
 * bearer token. A proxy that replays arbitrary headers is a request-forgery
 * primitive, and the API needs exactly one credential to identify the caller.
 *
 * THE UPSTREAM PATH IS A CONSTANT AT EACH CALL SITE, never a value from the
 * request — a target from a dynamic segment would let a browser aim this
 * credential at any route the API exposes.
 *
 * THE CONFIRMATION TOKEN PASSES THROUGH THIS PROXY AND IS NEVER STORED HERE.
 * It exists in the `/turn` response, in the browser's memory, and in the
 * `/confirm` request body. It is not written to a cookie, not put in a URL, and
 * not logged — only its hash was ever written down, and that is in the database.
 */
export async function proxyCopilot(request: Request, upstreamPath: string): Promise<NextResponse> {
  const base = process.env['BRANDSPACE_API_URL'];
  if (!base) {
    log.warn('BRANDSPACE_API_URL is not configured; the Copilot is unavailable');
    return NextResponse.json({ error: { code: 'INTERNAL' } }, { status: 503 });
  }

  const store = await cookies();
  const token = store.get(CUSTOMER_REALM.cookieName)?.value;
  if (!token) return NextResponse.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: { code: 'VALIDATION_FAILED' } }, { status: 422 });
  }

  try {
    const upstream = await fetch(`${base.replace(/\/$/, '')}${upstreamPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const payload: unknown = await upstream.json().catch(() => ({ error: { code: 'INTERNAL' } }));
    return NextResponse.json(payload, { status: upstream.status });
  } catch (error: unknown) {
    log.error('copilot upstream failed', { upstreamPath, ...internalErrorFields(error) });
    return NextResponse.json({ error: { code: 'INTERNAL' } }, { status: 502 });
  }
}
