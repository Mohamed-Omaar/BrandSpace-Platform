import { createHash } from 'node:crypto';
import { createLogger, internalErrorFields } from '@brandspace/shared';
import { themeFontFaces, themeStylesheet } from '@brandspace/ui';
import { currentEnvironment, getConfigService } from '../../server/platform-context';

/**
 * THE CONTROL CENTER'S LOOK & FEEL STYLESHEET (LF).
 *
 * Safe mode first: "Keep the Control Center on the original look" is ON by
 * default, and while it is on this holds only the ORIGINAL look's dark palette
 * (PR E), for an operator who chose dark — the Control Center an owner uses to
 * fix a bad theme never wears that theme. Turned off, the Control Center takes
 * the active look. Either way the dark palette is keyed on `<html
 * data-color-scheme>`, which the layout writes from the operator's choice and
 * then the owner's default. Anything that goes wrong is the original light
 * look.
 */
const log = createLogger({ context: { component: 'admin.theme' } });

export async function GET(request: Request): Promise<Response> {
  let css = '';
  try {
    const theme = await getConfigService().get('theme', currentEnvironment());
    // PR E: keyed on `<html data-color-scheme>` (the operator's own choice,
    // `currentConsoleColourScheme`), the same rule as the dashboard's.
    css = theme.controlCenterOriginal
      ? `${themeStylesheet({}, { app: 'admin', scheme: 'attribute' })}\n`
      : `${themeFontFaces(theme.look)}\n${themeStylesheet(theme.look, { app: 'admin', scheme: 'attribute' })}\n`;
  } catch (error: unknown) {
    log.warn('The theme could not be read; the original look is used', internalErrorFields(error));
  }
  const etag = `"${createHash('sha256').update(css).digest('base64url').slice(0, 27)}"`;
  const headers = {
    'content-type': 'text/css; charset=utf-8',
    'cache-control': 'private, no-cache',
    etag,
    'x-content-type-options': 'nosniff',
  };
  if (request.headers.get('if-none-match') === etag)
    return new Response(null, { status: 304, headers });
  return new Response(css, { headers });
}
