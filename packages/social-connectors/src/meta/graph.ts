import type { PublishFailureClass } from '@brandspace/database';

/**
 * CONNECTORS B — THE ONE WAY THIS PRODUCT TALKS TO META'S GRAPH API.
 *
 * Every Facebook and Instagram call goes through `graphRequest`, so four rules
 * hold everywhere without being remembered at each call site:
 *
 *   - THE VERSION IS CONFIGURATION. Every path is `/<apiVersion>/…`, and the
 *     version is `publishing.providers.<key>.apiVersion`, which the owner moves
 *     when Meta retires one (D-533). Nothing here names a version.
 *   - A CUSTOMER'S TOKEN IS SENT IN THE `Authorization` HEADER, never in a
 *     URL, so a proxy log, a span or an error that carries a URL carries no
 *     token. The one exception is Meta's own documented token endpoint
 *     (`oauth/access_token`), whose parameters — the code, the app secret, the
 *     short-lived token being exchanged — are query parameters by Meta's
 *     design; that URL is built here and never logged.
 *   - AN ERROR NEVER CARRIES META'S MESSAGE. Meta's `message` can echo the
 *     request; a `MetaGraphError` holds the numbers (HTTP status, code,
 *     subcode) and nothing else, and `classifyMetaError` turns them into the
 *     product's failure classes.
 *   - FETCH IS INJECTED. Tests hand in recorded answers; nothing in the test
 *     suite reaches Meta.
 *
 * THE HOSTS ARE META'S DOCUMENTED ENDPOINTS, not configuration: the Graph API
 * at `graph.facebook.com` and the login dialog at `www.facebook.com`
 * (developers.facebook.com/docs/graph-api/overview,
 * developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow).
 */

export const META_GRAPH_HOST = 'https://graph.facebook.com';
export const META_DIALOG_HOST = 'https://www.facebook.com';

/** The slice of `fetch` the adapters use, so a test can answer from a recording. */
export type GraphFetch = (
  url: string,
  init: {
    readonly method: 'GET' | 'POST' | 'DELETE';
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  },
) => Promise<{ readonly status: number; text(): Promise<string> }>;

/** Meta answered, and the answer was an error. Numbers only — never Meta's text. */
export class MetaGraphError extends Error {
  readonly status: number;
  readonly code: number | null;
  readonly subcode: number | null;
  readonly transient: boolean;

  constructor(input: {
    status: number;
    code: number | null;
    subcode: number | null;
    transient: boolean;
  }) {
    super(
      `Meta Graph API error (HTTP ${input.status}, code ${input.code ?? '-'}, subcode ${input.subcode ?? '-'})`,
    );
    this.name = 'MetaGraphError';
    this.status = input.status;
    this.code = input.code;
    this.subcode = input.subcode;
    this.transient = input.transient;
  }
}

/** The request left and no answer came back (network failure or our timeout). */
export class MetaTransportError extends Error {
  constructor() {
    super('Meta Graph API did not answer');
    this.name = 'MetaTransportError';
  }
}

/** The answer was not what Meta documents. Never retried blindly. */
export class MetaShapeError extends Error {
  constructor(what: string) {
    super(`Meta Graph API answer was not as documented: ${what}`);
    this.name = 'MetaShapeError';
  }
}

export interface GraphCall {
  readonly fetch: GraphFetch;
  readonly apiVersion: string;
  readonly method?: 'GET' | 'POST' | 'DELETE';
  /** Relative to the version, e.g. `me/accounts`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  /** Sent as `application/x-www-form-urlencoded`. */
  readonly form?: Readonly<Record<string, string>>;
  readonly accessToken?: string;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function graphUrl(apiVersion: string, path: string, query?: Record<string, string>): string {
  const url = new URL(`${META_GRAPH_HOST}/${apiVersion}/${path.replace(/^\/+/, '')}`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return url.toString();
}

/** One Graph call. Resolves to the parsed JSON body; throws one of the three errors above. */
export async function graphRequest(call: GraphCall): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (call.accessToken) headers['authorization'] = `Bearer ${call.accessToken}`;
  let body: string | undefined;
  if (call.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(call.form as Record<string, string>).toString();
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), call.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let status: number;
  let text: string;
  try {
    const response = await call.fetch(
      graphUrl(call.apiVersion, call.path, call.query as Record<string, string> | undefined),
      {
        method: call.method ?? 'GET',
        headers,
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
      },
    );
    status = response.status;
    text = await response.text();
  } catch {
    // Whatever the transport said is dropped: it can carry the URL.
    throw new MetaTransportError();
  } finally {
    clearTimeout(timer);
  }

  let parsed: unknown = null;
  try {
    parsed = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    parsed = null;
  }
  const record =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  const error = record?.['error'];
  if (status >= 400 || (error !== undefined && error !== null)) {
    const detail =
      error !== null && typeof error === 'object' ? (error as Record<string, unknown>) : {};
    throw new MetaGraphError({
      status,
      code: typeof detail['code'] === 'number' ? detail['code'] : null,
      subcode: typeof detail['error_subcode'] === 'number' ? detail['error_subcode'] : null,
      transient: detail['is_transient'] === true,
    });
  }
  if (record === null) throw new MetaShapeError('not a JSON object');
  return record;
}

/** A string field Meta documents, or a shape error. */
export function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number') return String(value);
  throw new MetaShapeError(`missing ${key}`);
}

export function optionalString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * META'S ERROR NUMBERS → THE PRODUCT'S FAILURE CLASSES.
 *
 * From Meta's published error reference
 * (developers.facebook.com/docs/graph-api/guides/error-handling) and the
 * Instagram publishing error codes
 * (developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/error-codes).
 * WHAT IS NOT LISTED IS `UNKNOWN`, which is neither retried nor treated as
 * indeterminate: guessing is how a post goes out twice.
 *
 * META HAS NO REFRESH TOKEN for these grants, so an invalid or expired token
 * (code 190) is a reconnection, never a refresh: `AUTH_REVOKED`.
 */
export function classifyMetaError(error: unknown): PublishFailureClass {
  if (error instanceof MetaTransportError) return 'TIMEOUT';
  if (!(error instanceof MetaGraphError)) return 'UNKNOWN';
  const { code, subcode, status } = error;
  if (code === 190 || code === 102) return 'AUTH_REVOKED';
  if (code === 10 || (code !== null && code >= 200 && code <= 299)) return 'INSUFFICIENT_SCOPE';
  // Application, user and Page request limits; business-use-case limits.
  if (code === 4 || code === 17 || code === 32 || code === 613) return 'RATE_LIMITED';
  if (code !== null && code >= 80_001 && code <= 80_014) return 'RATE_LIMITED';
  // Instagram: the account has reached its publishing limit.
  if (code === 9 && subcode === 2_207_042) return 'RATE_LIMITED';
  if (code === 506) return 'DUPLICATE_CONTENT';
  if (code === 368) return 'CONTENT_REJECTED';
  // Instagram media the platform could not use (format, size, ratio, fetch).
  if (subcode !== null && subcode >= 2_207_001 && subcode <= 2_207_099) return 'MEDIA_INVALID';
  if (code === 9_004) return 'MEDIA_INVALID';
  // "Object does not exist / no permission on it": the Page or account is gone.
  if (code === 100 && subcode === 33) return 'TARGET_UNAVAILABLE';
  if (code === 1 || code === 2 || error.transient) return 'PLATFORM_UNAVAILABLE';
  if (status >= 500) return 'PLATFORM_UNAVAILABLE';
  return 'UNKNOWN';
}

/** Stable machine code stored on the job: the class, plus Meta's number when there is one. */
export function metaFailureCode(error: unknown): string {
  if (error instanceof MetaGraphError) {
    return `meta.${error.code ?? 'http'}${error.subcode === null ? '' : `.${error.subcode}`}`;
  }
  if (error instanceof MetaTransportError) return 'meta.no_answer';
  if (error instanceof MetaShapeError) return 'meta.unexpected_answer';
  return 'meta.error';
}

export const META_SAFE_SUMMARIES: Record<PublishFailureClass, string> = {
  CONTENT_REJECTED: 'Meta rejected this post.',
  RATE_LIMITED: 'Meta is limiting how often this account can post.',
  AUTH_EXPIRED: 'The Meta access token has expired.',
  AUTH_REVOKED: 'Access was removed at Meta; the account must be reconnected.',
  INSUFFICIENT_SCOPE: 'The permissions granted at Meta do not cover publishing.',
  PLATFORM_UNAVAILABLE: 'Meta is temporarily unavailable.',
  TIMEOUT: 'Meta did not answer in time.',
  DUPLICATE_CONTENT: 'Meta reports this post already exists.',
  MEDIA_INVALID: 'Meta did not accept the attached media.',
  TARGET_UNAVAILABLE: 'The Page or account is no longer reachable at Meta.',
  APPROVAL_REVOKED: 'Approval was withdrawn before publishing.',
  NOT_CONNECTED: 'The account is not connected.',
  UNSUPPORTED: 'Meta does not support this kind of post here.',
  UNKNOWN: 'Meta returned an unexpected response.',
};
