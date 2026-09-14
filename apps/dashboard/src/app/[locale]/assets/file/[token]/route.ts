import { NextResponse } from 'next/server';
import { DownloadGrantIssuer, contentDispositionHeader } from '@brandspace/storage';
import { createLogger, internalErrorFields } from '@brandspace/shared';
import { requireWorkspace } from '../../../../../server/customer-context';
import { downloadSigningKey, objectStore } from '../../../../../server/assets-context';

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
  const { locale, token } = await context.params;

  // The SESSION decides the workspace; the token never does. A grant naming
  // another workspace is refused below even with a perfect signature.
  const { workspace } = await requireWorkspace(locale, 'assets.read');

  try {
    const issuer = new DownloadGrantIssuer({ signingKey: downloadSigningKey() });
    const claims = issuer.redeem(token, workspace.workspaceId);

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
        'content-disposition': contentDispositionHeader(
          claims.disposition,
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
        // A grant is short-lived and per-viewer; a shared cache must not keep it.
        'cache-control': 'private, no-store',
      },
    });
  } catch (error: unknown) {
    // Logged WITHOUT the token, the key or the file name. The token is a bearer
    // capability, so writing it to a log sink would leak the very thing it
    // authorises (docs/SECURITY.md §5.1).
    log.warn('a download grant was refused', {
      workspaceId: workspace.workspaceId,
      ...internalErrorFields(error),
    });
    return new NextResponse(null, { status: 404 });
  }
}
