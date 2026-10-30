import { detectFormat } from '@brandspace/shared';
import { objectStore } from '../../../server/assets-context';
import { LOGO_SLOTS, activeLook, type LogoSlot } from '../../../server/theme';

/**
 * THE LOOK & FEEL IMAGES (LF): `/theme-assets/<slot>.img` serves the active
 * theme's logo for light surfaces, for dark ones, the small mark and the
 * favicon. The bytes were checked when they were uploaded (type by signature,
 * size); they are checked again here, and only PNG, JPEG or WebP is ever
 * served, as an image, never as a document. No image set: 404, except the
 * favicon, which then answers with the original icon.
 */
const TYPES = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as const;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ file: string }> },
): Promise<Response> {
  const { file } = await params;
  const slot = file.replace(/\.img$/, '') as LogoSlot;
  if (!LOGO_SLOTS.includes(slot)) return new Response(null, { status: 404 });
  const key = (await activeLook()).logo[slot];
  // No favicon set: the original icon.
  if (!key && slot === 'favicon') {
    return new Response(null, { status: 307, headers: { location: '/icon.svg' } });
  }
  if (!key) return new Response(null, { status: 404 });
  const bytes = await objectStore()
    .get(key)
    .catch(() => null);
  const format = bytes ? detectFormat(bytes) : null;
  if (!bytes || !format || !(format in TYPES)) return new Response(null, { status: 404 });
  return new Response(Buffer.from(bytes), {
    headers: {
      'content-type': TYPES[format as keyof typeof TYPES],
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
    },
  });
}
