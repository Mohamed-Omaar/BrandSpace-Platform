import { NextResponse } from 'next/server';
import { DownloadGrantIssuer } from '@brandspace/storage';
import { createLogger, internalErrorFields } from '@brandspace/shared';
import { getCustomerAuth, getSessionToken } from '../../../../../server/customer-context';
import { downloadSigningKey, objectStore } from '../../../../../server/assets-context';
import { servedUploadDisposition } from '../../../../../server/served-upload';

const log = createLogger({ context: { component: 'dashboard.assets.download' } });

/**
 * Redeem a download grant and serve the bytes.
 *
 * WHAT THIS ROUTE IS ALLOWED TO ASSUME, AND WHAT IT IS NOT.
 *
 * The GRANT is the authorisation decision, made once when it was issued:
 * permission, brand scope, asset lifecycle and scan verdict were all checked
 * there. Re-deriving them here would be a SECOND authorisation implementation,
 * and two of those disagree eventually.
 *
 * What it must still check is everything that can change under a grant, and it
 * checks all three: the SIGNATURE (so the token was minted by this platform),
 * the EXPIRY (so a leaked token stops working), and the WORKSPACE — the grant
 * is redeemed against the workspace of the CURRENT session, so a token that
 * leaked to someone in another tenant is useless to them even though it is
 * perfectly valid.
 *
 * EVERY REFUSAL IS THE SAME 404. Forged, expired, malformed, wrong workspace,
 * and an object that is no longer there all answer identically, because "this
 * token expired" confirms it was once real, which confirms the object exists.
 *
 * WHY IT SERVES BYTES AT ALL. R-09 and docs/SECURITY.md §11.6 want assets on a
 * separate domain or CDN, never the application origin — and that needs a
 * storage vendor, which has not been chosen. Until one is, this route is the
 * only way to honour a grant, so it takes the precautions that matter without
 * the CDN: a `Content-Disposition` built from a re-derived name, a
 * `Content-Type` taken from the SIGNATURE-verified value pinned into the grant
 * rather than sniffed here, `X-Content-Type-Options: nosniff` so a browser
 * cannot re-interpret it, and a restrictive CSP so nothing served this way can
 * execute in the app's security context. Recorded as a production blocker
 * rather than left to look finished.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ locale: string; token: string }> },
): Promise<Response> {
  const { token } = await context.params;

  let workspaceId: string | null = null;
  try {
    /*
     * B1 (performance) — THE GRANT FIRST, THEN A LIGHT CHECK OF THE SESSION.
     * An image used to resolve the whole session and every workspace on each
     * request (dozens of statements, and a session write), for every tile on
     * a page. Now: the signature and expiry, with no database work; then one
     * light check that the session is live and that the grant's workspace is
     * the session's ACTIVE workspace, with `assets.read` there
     * (`canReadInActiveWorkspace`). So the SESSION still decides the
     * workspace: a grant naming any other workspace is refused, even with a
     * perfect signature.
     */
    const issuer = new DownloadGrantIssuer({ signingKey: downloadSigningKey() });
    const claims = issuer.verify(token);
    workspaceId = claims.workspaceId;
    const session = (await getSessionToken()) ?? '';
    const allowed = await getCustomerAuth()
      .canReadInActiveWorkspace(session, claims.workspaceId, 'assets.read')
      .catch(() => false);
    if (!allowed) return new NextResponse(null, { status: 404 });

    const bytes = await objectStore().get(claims.storageKey);
    // The row said the object exists and it does not. The same 404 as every
    // other refusal: a distinguishable answer would confirm the key was real.
    if (!bytes) return new NextResponse(null, { status: 404 });

    return new NextResponse(Buffer.from(bytes), {
      status: 200,
      headers: {
        // The type the file's own SIGNATURE proved at upload, pinned into the
        // grant. Never sniffed here, and never derived from a file name.
        'content-type': claims.contentType,
        'content-length': String(bytes.byteLength),
        /*
         * THE NAME IS RE-DERIVED, NEVER PASSED THROUGH. A customer file name
         * can contain quotes, semicolons and newlines — all of which either
         * break the header or let a caller inject one. The grant carries no
         * name at all, so the last path segment of the key is used: an
         * identifier, not customer input.
         */
        // PR F (g): always a download, whatever the grant asked for.
        'content-disposition': servedUploadDisposition(
          claims.storageKey.split('/').at(-1) ?? 'file',
        ),
        // A browser must not re-interpret these bytes as something else.
        'x-content-type-options': 'nosniff',
        /*
         * NOTHING SERVED HERE MAY EXECUTE. Until assets move to their own
         * origin, a sandbox plus a CSP that permits no script, no object and no
         * frame ancestor is what keeps a hostile file from running in the
         * application's security context (docs/SECURITY.md §11.6).
         */
        'content-security-policy':
          "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'none'; script-src 'none'; sandbox",
        /*
         * B1 — THIS BROWSER MAY KEEP IT UNTIL THE GRANT ENDS; NO SHARED CACHE
         * EVER MAY. An on-screen image keeps one URL for its window
         * (`INLINE_SHARE_WINDOW_SECONDS`), so a re-render or a repeat visit
         * reuses the bytes instead of fetching every tile again.
         */
        'cache-control': `private, max-age=${Math.max(
          0,
          claims.expiresAt - Math.floor(Date.now() / 1_000),
        )}`,
      },
    });
  } catch (error: unknown) {
    // Logged WITHOUT the token, the key or the file name. The token is a bearer
    // capability, so writing it to a log sink would leak the very thing it
    // authorises (docs/SECURITY.md §5.1).
    log.warn('a download grant was refused', {
      workspaceId,
      ...internalErrorFields(error),
    });
    return new NextResponse(null, { status: 404 });
  }
}
