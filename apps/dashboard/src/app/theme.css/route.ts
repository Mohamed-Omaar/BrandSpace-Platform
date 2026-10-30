import { createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import { colourSchemeSchema } from '@brandspace/shared/theme';
import { themeFontFaces, themeStylesheet } from '@brandspace/ui';
import { COLOUR_SCHEME_COOKIE } from '../../server/colour-scheme';
import { activeLook } from '../../server/theme';

/**
 * THE LOOK & FEEL STYLESHEET (LF): `<link rel="stylesheet" href="/theme.css">`
 * in the root layout, which stays static.
 *
 * The active theme is `activeLook()` (server/theme.ts). The user's own light / dark / device choice is a cookie
 * (per device, owner decision); without one, the owner's default applies.
 *
 * Anything that goes wrong is the ORIGINAL LOOK: an empty stylesheet, never a
 * broken page.
 */
export async function GET(request: Request): Promise<Response> {
  const look = await activeLook();
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
