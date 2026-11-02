import { createHash } from 'node:crypto';
import { themeFontFaces, themeStylesheet } from '@brandspace/ui';
import { activeLook } from '../../server/theme';

/**
 * THE ACTIVE LOOK & FEEL THEME, as one stylesheet for every person (LF, P1).
 *
 * The dark palette is keyed on `<html data-color-scheme>`, which the root
 * layout writes from `currentColourScheme()` on the server: `dark` draws it,
 * `system` draws it under `prefers-color-scheme: dark` and so follows the
 * device live, `light` draws nothing. The stylesheet itself no longer depends
 * on who asks, so a page and its stylesheet can never disagree about the
 * scheme — the cause of the dark mode that came and went.
 */
export async function GET(request: Request): Promise<Response> {
  const look = await activeLook();
  const css = `${themeFontFaces(look)}\n${themeStylesheet(look, { scheme: 'attribute' })}\n`;
  const etag = `"${createHash('sha256').update(css).digest('base64url').slice(0, 27)}"`;
  const headers = {
    'content-type': 'text/css; charset=utf-8',
    // Revalidated on every page load, answered with 304 when nothing changed,
    // so an activation reaches the page within the look's 30 s hold.
    'cache-control': 'private, no-cache',
    etag,
    'x-content-type-options': 'nosniff',
  };
  if (request.headers.get('if-none-match') === etag)
    return new Response(null, { status: 304, headers });
  return new Response(css, { headers });
}
