import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { CUSTOMER_REALM } from '@brandspace/auth';
import { createLogger, internalErrorFields } from '@brandspace/shared';

const log = createLogger({ context: { component: 'dashboard.content.proxy' } });

/**
 * The Content Studio proxy.
 *
 * The dashboard cannot execute an AI request itself — the gateway needs the
 * platform database identity, and F-07 keeps that out of tenant-facing apps
 * (see apps/api/src/routes/content.ts for the full reasoning). So this hands the
 * request to `apps/api` and returns its answer verbatim.
 *
 * IT FORWARDS ONE THING AND NOTHING ELSE: the customer's session cookie, as a
 * bearer token. Not the whole cookie jar, not the client's headers, not its
 * origin — a proxy that replays arbitrary headers is a request-forgery
 * primitive, and the API needs exactly one credential to identify the caller.
 *
 * THE UPSTREAM PATH IS A CONSTANT AT EACH CALL SITE, never a value from the
 * request. A proxy whose target came out of a dynamic segment would let a
 * browser aim this credential at any route the API exposes.
 *
 * When no API base URL is configured the answer is an honest 503 with a stable
 * code, and the screen shows its own error copy. Silently returning an empty
 * result would look to a customer like a studio that generated nothing.
 */
export async function proxyToApi(request: Request, upstreamPath: string): Promise<NextResponse> {
  const base = process.env['BRANDSPACE_API_URL'];
  if (!base) {
    log.warn('BRANDSPACE_API_URL is not configured; the Content Studio is unavailable');
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
    log.error('content upstream failed', { upstreamPath, ...internalErrorFields(error) });
    return NextResponse.json({ error: { code: 'INTERNAL' } }, { status: 502 });
  }
}
