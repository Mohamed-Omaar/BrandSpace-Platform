import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError, type Clock, systemClock } from '@brandspace/shared';
import { safeStorageKeySegments } from './object-store';

/**
 * Authorised, time-limited download.
 *
 * WHY THIS EXISTS RATHER THAN A PATH OR A KEY. docs/SECURITY.md §11.7 requires
 * that "direct object access requires a signed, short-TTL URL", and §11.6 that
 * assets are never served from the application origin. Both are properties of
 * the CONTRACT, not of a vendor: the caller must never receive a filesystem
 * path, and must never receive a provider object key it could feed back to a
 * bucket. What it receives is a GRANT — an opaque token naming one object, one
 * workspace, one expiry and one disposition.
 *
 * THE GRANT IS THE AUTHORISATION DECISION, MADE ONCE. Issuing it is the moment
 * permission, brand scope, scan status and asset lifecycle were all checked. A
 * redemption therefore re-checks only the things that can change under it —
 * signature, expiry, and the workspace the redeemer is acting in — rather than
 * re-running a policy the issuer already ran. That split is deliberate: a
 * redemption path that re-derives authorisation is a second authorisation
 * implementation, and two of those disagree eventually.
 *
 * WHY IT IS SIGNED AND NOT STORED. A stored grant is a row per download on the
 * hot path of every thumbnail on a gallery screen. An HMAC over the fields IS
 * the record, costs nothing, and cannot be replayed past its expiry. The key is
 * a deployment secret resolved by the caller — never a literal here, and never
 * reachable from frontend code (CLAUDE.md §2.3).
 *
 * WHAT A REAL ADAPTER CHANGES. A vendor-backed store would redeem a grant by
 * issuing its own pre-signed URL for the same key and TTL, so the customer's
 * browser fetches the bytes from the CDN rather than from us. The grant's shape
 * does not change; only what `resolve` returns does. That is the whole point of
 * putting the boundary here.
 */

/** How the browser should treat the bytes. Never derived from the file name. */
export type DownloadDisposition = 'inline' | 'attachment';

export interface DownloadGrantClaims {
  readonly storageKey: string;
  readonly workspaceId: string;
  /** Seconds since the epoch. Whole seconds, so the token is stable. */
  readonly expiresAt: number;
  readonly disposition: DownloadDisposition;
  /**
   * The type the response will declare.
   *
   * SERVED, NOT SNIFFED. The stored value was decided from the file's own
   * signature at upload (never from the browser's claim), and pinning it into
   * the grant means a later edit to the row cannot change what an already
   * issued grant serves.
   */
  readonly contentType: string;
}

export interface DownloadGrant extends DownloadGrantClaims {
  /** Opaque. The only thing a caller ever hands to a client. */
  readonly token: string;
}

export interface DownloadGrantIssuerOptions {
  /**
   * The signing key. REQUIRED and never defaulted: a default would mean every
   * deployment that forgot to configure one shared a forgeable signature.
   */
  readonly signingKey: string;
  readonly clock?: Clock;
}

/** Refused for every reason a grant can be bad. One message, deliberately. */
function invalidGrant(): AppError {
  /*
   * ONE ERROR FOR FORGED, EXPIRED, MALFORMED AND WRONG-WORKSPACE.
   *
   * Distinguishing them tells a prober which half of a guess was right: "this
   * token expired" confirms it was once real, which confirms the object exists.
   * The 404 shape is the same one CLAUDE.md §2.1 requires of cross-tenant
   * access, for the same reason.
   */
  return new AppError('NOT_FOUND', 'File not found.');
}

const SEPARATOR = '.';

function encodeClaims(claims: DownloadGrantClaims): string {
  return Buffer.from(
    JSON.stringify([
      claims.storageKey,
      claims.workspaceId,
      claims.expiresAt,
      claims.disposition,
      claims.contentType,
    ]),
    'utf8',
  ).toString('base64url');
}

function decodeClaims(encoded: string): DownloadGrantClaims | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 5) return null;
    const [storageKey, workspaceId, expiresAt, disposition, contentType] = parsed as unknown[];
    if (typeof storageKey !== 'string' || typeof workspaceId !== 'string') return null;
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null;
    if (disposition !== 'inline' && disposition !== 'attachment') return null;
    if (typeof contentType !== 'string') return null;
    return { storageKey, workspaceId, expiresAt, disposition, contentType };
  } catch {
    return null;
  }
}

export class DownloadGrantIssuer {
  readonly #signingKey: string;
  readonly #clock: Clock;

  constructor(options: DownloadGrantIssuerOptions) {
    if (!options.signingKey) {
      throw new Error('A download-grant signing key is required.');
    }
    this.#signingKey = options.signingKey;
    this.#clock = options.clock ?? systemClock;
  }

  #sign(encoded: string): string {
    return createHmac('sha256', this.#signingKey).update(encoded).digest('base64url');
  }

  /**
   * Issue a grant for one object.
   *
   * `ttlSeconds` is the caller's — in practice an operator's, through the
   * `assets` configuration document — because the right window depends on how
   * long a page may sit open before a thumbnail 404s, which is an operational
   * fact rather than a developer's (CLAUDE.md §2.2).
   */
  issue(input: {
    readonly storageKey: string;
    readonly workspaceId: string;
    readonly ttlSeconds: number;
    readonly disposition: DownloadDisposition;
    readonly contentType: string;
  }): DownloadGrant {
    if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds <= 0) {
      throw new AppError('VALIDATION_FAILED', 'A download window is a positive whole number.');
    }
    /*
     * THE KEY IS CHECKED AT ISSUE, NOT ONLY AT READ.
     *
     * A grant for `../../etc/passwd` that is refused later is still a signed
     * statement that the platform considered the key legitimate. Refusing here
     * means a malformed key never acquires a signature at all.
     */
    safeStorageKeySegments(input.storageKey);

    const claims: DownloadGrantClaims = {
      storageKey: input.storageKey,
      workspaceId: input.workspaceId,
      expiresAt: Math.floor(this.#clock.now().getTime() / 1_000) + input.ttlSeconds,
      disposition: input.disposition,
      contentType: input.contentType,
    };
    const encoded = encodeClaims(claims);
    return { ...claims, token: `${encoded}${SEPARATOR}${this.#sign(encoded)}` };
  }

  /**
   * Verify a token and return what it authorises.
   *
   * `workspaceId` is the workspace the REDEEMER is acting in. A grant issued in
   * another workspace is refused even with a perfect signature, so a leaked
   * token is useless to anyone outside the tenant it was minted for.
   */
  redeem(token: string, workspaceId: string): DownloadGrantClaims {
    const index = token.lastIndexOf(SEPARATOR);
    if (index <= 0) throw invalidGrant();

    const encoded = token.slice(0, index);
    const provided = Buffer.from(token.slice(index + 1), 'utf8');
    const expected = Buffer.from(this.#sign(encoded), 'utf8');
    // CONSTANT TIME. A byte-by-byte comparison leaks the signature one
    // character at a time to anyone willing to measure.
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw invalidGrant();
    }

    const claims = decodeClaims(encoded);
    if (!claims) throw invalidGrant();
    if (claims.workspaceId !== workspaceId) throw invalidGrant();
    if (claims.expiresAt * 1_000 <= this.#clock.now().getTime()) throw invalidGrant();

    return claims;
  }
}

/**
 * The `Content-Disposition` header value for a grant.
 *
 * THE FILE NAME IS RE-DERIVED, NEVER PASSED THROUGH. A customer's file name can
 * contain quotes, semicolons, newlines and non-ASCII — all of which either
 * break the header or let a caller inject one. The ASCII fallback is sanitised
 * to a conservative alphabet and the real name travels in `filename*`, which is
 * percent-encoded and therefore cannot carry a delimiter (RFC 6266).
 */
export function contentDispositionHeader(
  disposition: DownloadDisposition,
  fileName: string,
): string {
  const ascii = fileName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'file';
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
