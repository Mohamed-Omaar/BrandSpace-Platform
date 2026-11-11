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

/**
 * PR A (smart Copilot, D-604) — THE ANSWER AS A STREAM.
 *
 * The same session handling as `proxyCopilot`, but the upstream body is
 * PASSED THROUGH as it arrives (server-sent events) rather than read whole,
 * and the browser's abort is passed on: when the person presses Stop (or
 * leaves), the request to the API is cancelled, its connection closes, and
 * the running model call is aborted and never charged. A refusal before the
 * stream starts is JSON, exactly as before.
 */
export async function proxyCopilotStream(
  request: Request,
  upstreamPath: string,
): Promise<Response> {
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

  /*
   * STOP MUST REACH THE MODEL. Closing the browser's stream cancels the body
   * handed back below, and that cancel aborts this upstream request: the API
   * sees its connection close and cancels the running model call. The
   * request's own signal is passed on too, for a disconnect before the first
   * byte. Without this the provider would finish an answer nobody reads.
   */
  const upstreamAbort = new AbortController();
  request.signal.addEventListener('abort', () => upstreamAbort.abort(), { once: true });
  try {
    const upstream = await fetch(`${base.replace(/\/$/, '')}${upstreamPath}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: upstreamAbort.signal,
    });
    const type = upstream.headers.get('content-type') ?? '';
    if (!type.startsWith('text/event-stream') || !upstream.body) {
      const payload: unknown = await upstream.json().catch(() => ({ error: { code: 'INTERNAL' } }));
      return NextResponse.json(payload, { status: upstream.status });
    }
    const reader = upstream.body.getReader();
    const passThrough = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { value, done } = await reader.read();
          if (done) controller.close();
          else controller.enqueue(value);
        } catch {
          controller.close();
        }
      },
      cancel() {
        upstreamAbort.abort();
        void reader.cancel().catch(() => undefined);
      },
    });
    return new Response(passThrough, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-store, no-transform',
        'x-accel-buffering': 'no',
      },
    });
  } catch (error: unknown) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    log.error('copilot upstream failed', { upstreamPath, ...internalErrorFields(error) });
    return NextResponse.json({ error: { code: 'INTERNAL' } }, { status: 502 });
  }
}
