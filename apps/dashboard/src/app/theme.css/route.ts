import { createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import {
  colourSchemeSchema,
  createLogger,
  internalErrorFields,
  themeLookSchema,
} from '@brandspace/shared';
import { themeFontFaces, themeStylesheet } from '@brandspace/ui';
import { COLOUR_SCHEME_COOKIE } from '../../server/colour-scheme';

/**
 * THE LOOK & FEEL STYLESHEET (LF): `<link rel="stylesheet" href="/theme.css">`
 * in the root layout, which stays static.
 *
 * The active theme comes from the API's public `/v1/theme` (the customer
 * database role cannot read the configuration store, by design), held here
 * for 30 s like every configuration read, so an activation reaches every page
 * within a minute. The user's own light / dark / device choice is a cookie
 * (per device, owner decision); without one, the owner's default applies.
 *
 * Anything that goes wrong is the ORIGINAL LOOK: an empty stylesheet, never a
 * broken page.
 */
const log = createLogger({ context: { component: 'dashboard.theme' } });
const TTL_MS = 30_000;
let held: { look: unknown; at: number } | null = null;

async function activeLook(): Promise<unknown> {
  if (held && Date.now() - held.at < TTL_MS) return held.look;
  const base = process.env['BRANDSPACE_API_URL'];
  let look: unknown = {};
  if (base) {
    try {
      const upstream = await fetch(`${base.replace(/\/$/, '')}/v1/theme`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(1500),
      });
      if (upstream.ok) look = ((await upstream.json()) as { look?: unknown }).look ?? {};
    } catch (error: unknown) {
      log.warn(
        'The theme could not be read; the original look is used',
        internalErrorFields(error),
      );
    }
  }
  held = { look, at: Date.now() };
  return look;
}

export async function GET(request: Request): Promise<Response> {
  const parsed = themeLookSchema.safeParse(await activeLook());
  const look = parsed.success ? parsed.data : themeLookSchema.parse({});
  const chosen = colourSchemeSchema.safeParse((await cookies()).get(COLOUR_SCHEME_COOKIE)?.value);
  const scheme = chosen.success ? chosen.data : look.dark.mode;
  const css = `${themeFontFaces(look)}\n${themeStylesheet(look, { scheme })}\n`;
  const etag = `"${createHash('sha256').update(css).digest('base64url').slice(0, 27)}"`;
  const headers = {
    'content-type': 'text/css; charset=utf-8',
    // Revalidated on every page load (the user's scheme is a cookie), answered
    // with 304 when nothing changed.
    'cache-control': 'private, no-cache',
    etag,
    'x-content-type-options': 'nosniff',
  };
  if (request.headers.get('if-none-match') === etag)
    return new Response(null, { status: 304, headers });
  return new Response(css, { headers });
}
