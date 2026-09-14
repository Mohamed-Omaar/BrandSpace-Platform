import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { CUSTOMER_REALM } from '@brandspace/auth';
import { createLogger, internalErrorFields } from '@brandspace/shared';

export const dynamic = 'force-dynamic';

const log = createLogger({ context: { component: 'dashboard.brand-brain.chat-proxy' } });

/**
 * The chat proxy.
 *
 * The dashboard cannot execute an AI request itself — the gateway needs the
 * platform database identity, and F-07 keeps that out of tenant-facing apps
 * (see apps/api/src/routes/brand-brain.ts for the full reasoning). So this
 * hands the request to `apps/api` and returns its answer verbatim.
 *
 * IT FORWARDS ONE THING AND NOTHING ELSE: the customer's session cookie, as a
 * bearer token. Not the whole cookie jar, not the client's headers, not its
 * origin — a proxy that replays arbitrary headers is a request-forgery
 * primitive, and the API needs exactly one credential to identify the caller.
 *
 * When no API base URL is configured the answer is an honest 503 with a stable
 * code. The screen then shows its own error copy. Silently returning an empty
 * answer would look to a customer like a Brand Brain that knows nothing.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const base = process.env['BRANDSPACE_API_URL'];
  if (!base) {
    log.warn('BRANDSPACE_API_URL is not configured; chat is unavailable');
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
    const upstream = await fetch(`${base.replace(/\/$/, '')}/v1/brand-brain/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The ONLY forwarded credential.
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    const payload: unknown = await upstream.json().catch(() => ({ error: { code: 'INTERNAL' } }));
    return NextResponse.json(payload, { status: upstream.status });
  } catch (error: unknown) {
    // A network failure reaching the API. Logged with internals, answered with
    // a code — the browser never sees a hostname or a stack.
    log.error('chat upstream failed', internalErrorFields(error));
    return NextResponse.json({ error: { code: 'INTERNAL' } }, { status: 502 });
  }
}
