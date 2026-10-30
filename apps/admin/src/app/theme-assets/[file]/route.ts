import { LOGO_SLOTS, readLogo, type LogoSlot } from '../../../server/theme-logo';
import { currentEnvironment, getConfigService } from '../../../server/platform-context';

/**
 * The active theme's images in the Control Center (LF), for the Look & feel
 * page's own preview. Served as images only; 404 when none is set.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ file: string }> },
): Promise<Response> {
  const { file } = await params;
  const slot = file.replace(/\.img$/, '') as LogoSlot;
  if (!LOGO_SLOTS.includes(slot)) return new Response(null, { status: 404 });
  const theme = await getConfigService().get('theme', currentEnvironment());
  const key = theme.look.logo[slot];
  const image = key ? await readLogo(key) : null;
  if (!image) return new Response(null, { status: 404 });
  return new Response(Buffer.from(image.bytes), {
    headers: {
      'content-type': image.type,
      'cache-control': 'private, max-age=60',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
    },
  });
}
