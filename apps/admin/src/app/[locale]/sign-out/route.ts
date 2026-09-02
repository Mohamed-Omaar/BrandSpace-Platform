import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { PLATFORM_REALM } from '@brandspace/auth';
import { getPlatformAuth } from '../../../server/platform-context';

/**
 * Revokes the session server-side, then clears the cookie.
 *
 * The redirect is RELATIVE and uses 303, both deliberately:
 *
 *   - relative, because building an absolute URL from the request would put a
 *     host the client influences into a `Location` header. Behind a proxy the
 *     request's own host is not reliably the browser's origin, and a redirect
 *     is the last place to trust it.
 *   - 303 See Other, because this is a POST. 307 preserves the method, so the
 *     browser would re-POST to the sign-in page.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ locale: string }> },
): Promise<NextResponse> {
  const { locale } = await params;
  const store = await cookies();
  const token = store.get(PLATFORM_REALM.cookieName)?.value;

  if (token) {
    await getPlatformAuth()
      .revokeSession(token, 'User signed out')
      .catch(() => {
        // Always clear the cookie, even if revocation failed.
      });
  }
  store.delete(PLATFORM_REALM.cookieName);
  return new NextResponse(null, {
    status: 303,
    headers: { Location: `/${locale}/login` },
  });
}
