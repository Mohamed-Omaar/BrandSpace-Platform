import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { CUSTOMER_REALM } from '@brandspace/auth';
import { createLogger, internalErrorFields } from '@brandspace/shared';

const log = createLogger({ context: { component: 'dashboard.commerce.proxy' } });

/**
 * The commerce proxy.
 *
 * The dashboard cannot open a checkout itself: that calls a payment adapter and
 * reads the PLATFORM-owned commercial catalogue, and F-07 keeps both out of
 * tenant-facing apps. So this hands the request to `apps/api` and returns its
 * answer verbatim.
 *
 * IT FORWARDS ONE THING: the customer's session cookie, as a bearer token. Not
 * the cookie jar, not the client's headers, not its origin — a proxy that
 * replays arbitrary headers is a request-forgery primitive.
 *
 * THE UPSTREAM PATH IS A CONSTANT AT EACH CALL SITE. A target taken from a
 * dynamic segment would let a browser aim this credential at any route the API
 * exposes.
 *
 * AND IT ADDS NOTHING TO THE BODY. In particular it never inserts an amount: the
 * price is resolved server-side from the activated catalogue, and a proxy that
 * "helpfully" forwarded one would be the hole the whole design closes (§37).
 */
export async function proxyCommerce(
  request: Request,
  upstreamPath: string,
  method: 'GET' | 'POST' = 'POST',
): Promise<NextResponse> {
  const base = process.env['BRANDSPACE_API_URL'];
  if (!base) {
    log.warn('BRANDSPACE_API_URL is not configured; commerce actions are unavailable');
    return NextResponse.json({ error: { code: 'INTERNAL' } }, { status: 503 });
  }

  const store = await cookies();
  const token = store.get(CUSTOMER_REALM.cookieName)?.value;
  if (!token) return NextResponse.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 });

  let body: string | undefined;
  if (method === 'POST') {
    try {
      body = JSON.stringify(await request.json());
    } catch {
      return NextResponse.json({ error: { code: 'VALIDATION_FAILED' } }, { status: 422 });
    }
  }

  try {
    const upstream = await fetch(`${base.replace(/\/$/, '')}${upstreamPath}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      ...(body === undefined ? {} : { body }),
    });
    const payload: unknown = await upstream.json().catch(() => ({ error: { code: 'INTERNAL' } }));
    return NextResponse.json(payload, { status: upstream.status });
  } catch (error: unknown) {
    log.error('commerce upstream failed', { upstreamPath, ...internalErrorFields(error) });
    return NextResponse.json({ error: { code: 'INTERNAL' } }, { status: 502 });
  }
}
