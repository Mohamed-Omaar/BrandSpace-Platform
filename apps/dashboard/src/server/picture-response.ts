import 'server-only';
import { pictureContentType } from '@brandspace/assets';
import { objectStore } from './assets-context';

/**
 * PR D (D-607) — one stored picture as a response, or the 404 a missing one
 * gets. The bytes were checked and scanned when they were stored; the type is
 * the key's own (png, jpeg or webp — never anything a browser would run).
 * Private to the browser that asked: the link changes with every new picture
 * (`?v=`), so a week of caching costs nothing.
 */
export async function pictureResponse(storageKey: string | null | undefined): Promise<Response> {
  const contentType = storageKey ? pictureContentType(storageKey) : null;
  const bytes = storageKey && contentType ? await objectStore().get(storageKey) : null;
  if (!bytes || !contentType) return notFound();
  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      'content-type': contentType,
      'cache-control': 'private, max-age=604800, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'content-disposition': 'inline',
    },
  });
}

export function notFound(): Response {
  return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
}
