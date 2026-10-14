import type { PublishFailureClass } from '@brandspace/database';

/**
 * CONNECTORS C — THE ONE WAY THIS PRODUCT TALKS TO TIKTOK (D-505).
 *
 * Every TikTok call goes through `tiktokRequest` or `tiktokUpload`, so these
 * rules hold everywhere without being remembered at each call site:
 *
 *   - THE VERSION IS CONFIGURATION. Every path is `/<apiVersion>/…` and the
 *     version is `publishing.providers.tiktok.apiVersion` (`v2` today). Nothing
 *     here names it.
 *   - A CUSTOMER'S TOKEN TRAVELS IN THE `Authorization` HEADER, never in a URL.
 *     The token endpoint takes the client secret and the code or refresh token
 *     as a form body, by TikTok's design
 *     (developers.tiktok.com/doc/oauth-user-access-token-management).
 *   - AN ERROR NEVER CARRIES TIKTOK'S MESSAGE. TikTok answers
 *     `{ error: { code, message, log_id } }`; a `TikTokApiError` keeps the HTTP
 *     status and the CODE (a short machine word such as
 *     `spam_risk_too_many_posts`) and nothing else.
 *   - FETCH IS INJECTED. Tests answer from recordings; the suite never reaches
 *     TikTok.
 *
 * THE HOSTS ARE TIKTOK'S DOCUMENTED ENDPOINTS, not configuration: the Open API
 * at `open.tiktokapis.com` and the login page at `www.tiktok.com`
 * (developers.tiktok.com/doc/login-kit-web).
 */

export const TIKTOK_API_HOST = 'https://open.tiktokapis.com';
export const TIKTOK_AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';

/** The slice of `fetch` the adapter uses. The body may be bytes for an upload. */
export type TikTokFetch = (
  url: string,
  init: {
    readonly method: 'GET' | 'POST' | 'PUT';
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string | Uint8Array;
    readonly signal?: AbortSignal;
  },
) => Promise<{ readonly status: number; text(): Promise<string> }>;

/** TikTok answered, and the answer was an error. Its code only — never its text. */
export class TikTokApiError extends Error {
  readonly status: number;
  /** TikTok's machine code (`access_token_invalid`, `invalid_grant`, …), or null. */
  readonly code: string | null;

  constructor(input: { status: number; code: string | null }) {
    super(`TikTok API error (HTTP ${input.status}, ${input.code ?? '-'})`);
    this.name = 'TikTokApiError';
    this.status = input.status;
    this.code = input.code;
  }
}

/** The request left and no answer came back (network failure or our timeout). */
export class TikTokTransportError extends Error {
  constructor() {
    super('TikTok did not answer');
    this.name = 'TikTokTransportError';
  }
}

/** The answer was not what TikTok documents. Never retried blindly. */
export class TikTokShapeError extends Error {
  constructor(what: string) {
    super(`TikTok answer was not as documented: ${what}`);
    this.name = 'TikTokShapeError';
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** One chunk of a video can be 64 MB; give it longer than a JSON call. */
const UPLOAD_TIMEOUT_MS = 300_000;

/** A code is a short machine word. Anything else is not kept (it could be text). */
function machineCode(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z0-9_.]{1,80}$/.test(value) ? value : null;
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = text.length === 0 ? {} : JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function send(
  fetch: TikTokFetch,
  url: string,
  init: Parameters<TikTokFetch>[1],
  timeoutMs: number,
): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return { status: response.status, text: await response.text() };
  } catch {
    // Whatever the transport said is dropped: it can carry the URL.
    throw new TikTokTransportError();
  } finally {
    clearTimeout(timer);
  }
}

export interface TikTokCall {
  readonly fetch: TikTokFetch;
  readonly apiVersion: string;
  readonly method?: 'GET' | 'POST';
  /** Relative to the version, e.g. `post/publish/video/init/`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  /** Sent as JSON. */
  readonly json?: unknown;
  /** Sent as `application/x-www-form-urlencoded` (the token endpoints). */
  readonly form?: Readonly<Record<string, string>>;
  readonly accessToken?: string;
  readonly timeoutMs?: number;
}

export function tiktokUrl(
  apiVersion: string,
  path: string,
  query?: Readonly<Record<string, string>>,
): string {
  const url = new URL(`${TIKTOK_API_HOST}/${apiVersion}/${path.replace(/^\/+/, '')}`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return url.toString();
}

/**
 * One Open API call. Resolves to the parsed body; throws one of the three
 * errors above.
 *
 * TWO ANSWER SHAPES, BOTH TIKTOK'S. The content and user endpoints answer
 * `{ data, error: { code: "ok" | <code> } }`; the OAuth endpoints answer the
 * token fields at the top level, or `{ error: <code>, error_description }`.
 * Either error is raised with its code alone.
 */
export async function tiktokRequest(call: TikTokCall): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (call.accessToken) headers['authorization'] = `Bearer ${call.accessToken}`;
  let body: string | undefined;
  if (call.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(call.form as Record<string, string>).toString();
  } else if (call.json !== undefined) {
    headers['content-type'] = 'application/json; charset=UTF-8';
    body = JSON.stringify(call.json);
  }
  const { status, text } = await send(
    call.fetch,
    tiktokUrl(call.apiVersion, call.path, call.query),
    { method: call.method ?? 'POST', headers, ...(body === undefined ? {} : { body }) },
    call.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const record = parseObject(text);
  const error = record?.['error'];
  const nestedCode =
    error !== null && typeof error === 'object' ? (error as Record<string, unknown>)['code'] : null;
  const code = typeof error === 'string' ? machineCode(error) : machineCode(nestedCode);
  const failed =
    status >= 400 ||
    typeof error === 'string' ||
    (nestedCode !== null && nestedCode !== undefined && nestedCode !== 'ok');
  if (failed) throw new TikTokApiError({ status, code });
  if (record === null) throw new TikTokShapeError('not a JSON object');
  return record;
}

/** The `data` object of a content or user endpoint's answer. */
export function dataOf(answer: Record<string, unknown>): Record<string, unknown> {
  const data = answer['data'];
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new TikTokShapeError('answer without data');
  }
  return data as Record<string, unknown>;
}

/**
 * One chunk of a `FILE_UPLOAD`, PUT to the `upload_url` TikTok returned
 * (developers.tiktok.com/docs/en/content-posting-api-media-transfer-guide):
 * `Content-Type`, `Content-Length` and `Content-Range: bytes first-last/total`.
 * TikTok answers 206 while more chunks are expected and 201 once the file is
 * complete. The URL is TikTok's own pre-signed address and is never logged.
 */
export async function tiktokUpload(input: {
  readonly fetch: TikTokFetch;
  readonly uploadUrl: string;
  readonly mimeType: string;
  readonly chunk: Uint8Array;
  readonly firstByte: number;
  readonly totalBytes: number;
  readonly timeoutMs?: number;
}): Promise<201 | 206> {
  const last = input.firstByte + input.chunk.byteLength - 1;
  const { status } = await send(
    input.fetch,
    input.uploadUrl,
    {
      method: 'PUT',
      headers: {
        'content-type': input.mimeType,
        'content-length': String(input.chunk.byteLength),
        'content-range': `bytes ${input.firstByte}-${last}/${input.totalBytes}`,
      },
      body: input.chunk,
    },
    input.timeoutMs ?? UPLOAD_TIMEOUT_MS,
  );
  if (status === 201 || status === 206) return status;
  throw new TikTokApiError({ status, code: null });
}

/**
 * TIKTOK'S ERROR CODES → THE PRODUCT'S FAILURE CLASSES, from the Direct Post
 * and Get Post Status references and the OAuth token guide
 * (developers.tiktok.com/doc/content-posting-api-reference-direct-post,
 * …/content-posting-api-reference-get-video-status,
 * …/oauth-user-access-token-management). WHAT IS NOT LISTED IS `UNKNOWN`,
 * which is neither retried nor treated as indeterminate.
 *
 * TIKTOK HAS A REFRESH TOKEN: an access token that no longer works is
 * `AUTH_EXPIRED` (the pipeline refreshes and tries again), while a refused
 * refresh (`invalid_grant`) is `AUTH_REVOKED` — the person must reconnect.
 */
const CODE_CLASSES: Readonly<Record<string, PublishFailureClass>> = {
  access_token_invalid: 'AUTH_EXPIRED',
  invalid_grant: 'AUTH_REVOKED',
  auth_removed: 'AUTH_REVOKED',
  scope_not_authorized: 'INSUFFICIENT_SCOPE',
  scope_permission_missed: 'INSUFFICIENT_SCOPE',
  rate_limit_exceeded: 'RATE_LIMITED',
  spam_risk_too_many_posts: 'RATE_LIMITED',
  spam_risk_too_many_pending_share: 'RATE_LIMITED',
  reached_active_user_cap: 'RATE_LIMITED',
  spam_risk_user_banned_from_posting: 'TARGET_UNAVAILABLE',
  privacy_level_option_mismatch: 'CONTENT_REJECTED',
  unaudited_client_can_only_post_to_private_accounts: 'CONTENT_REJECTED',
  invalid_param: 'CONTENT_REJECTED',
  url_ownership_unverified: 'MEDIA_INVALID',
  file_format_check_failed: 'MEDIA_INVALID',
  duration_check_failed: 'MEDIA_INVALID',
  frame_rate_check_failed: 'MEDIA_INVALID',
  picture_size_check_failed: 'MEDIA_INVALID',
  video_pull_failed: 'MEDIA_INVALID',
  photo_pull_failed: 'MEDIA_INVALID',
  internal_error: 'PLATFORM_UNAVAILABLE',
};

export function classifyTikTokError(error: unknown): PublishFailureClass {
  if (error instanceof TikTokTransportError) return 'TIMEOUT';
  if (!(error instanceof TikTokApiError)) return 'UNKNOWN';
  const known = error.code === null ? undefined : CODE_CLASSES[error.code];
  if (known) return known;
  if (error.status === 401) return 'AUTH_EXPIRED';
  if (error.status === 429) return 'RATE_LIMITED';
  if (error.status >= 500) return 'PLATFORM_UNAVAILABLE';
  return 'UNKNOWN';
}

/** A fail reason from a post's status (a machine word), classified the same way. */
export function classifyTikTokFailReason(reason: string | null): PublishFailureClass {
  if (reason === null) return 'UNKNOWN';
  return CODE_CLASSES[reason] ?? 'UNKNOWN';
}

/** Stable machine code stored on the job: `tiktok.` and TikTok's code when there is one. */
export function tiktokFailureCode(error: unknown): string {
  if (error instanceof TikTokApiError) return `tiktok.${error.code ?? `http_${error.status}`}`;
  if (error instanceof TikTokTransportError) return 'tiktok.no_answer';
  if (error instanceof TikTokShapeError) return 'tiktok.unexpected_answer';
  return 'tiktok.error';
}

export const TIKTOK_SAFE_SUMMARIES: Record<PublishFailureClass, string> = {
  CONTENT_REJECTED: 'TikTok rejected this post.',
  RATE_LIMITED: 'TikTok is limiting how often this account can post.',
  AUTH_EXPIRED: 'The TikTok access token has expired.',
  AUTH_REVOKED: 'Access was removed at TikTok; the account must be reconnected.',
  INSUFFICIENT_SCOPE: 'The permissions granted at TikTok do not cover publishing.',
  PLATFORM_UNAVAILABLE: 'TikTok is temporarily unavailable.',
  TIMEOUT: 'TikTok did not answer in time.',
  DUPLICATE_CONTENT: 'TikTok reports this post already exists.',
  MEDIA_INVALID: 'TikTok did not accept the attached media.',
  TARGET_UNAVAILABLE: 'This TikTok account cannot post right now.',
  APPROVAL_REVOKED: 'Approval was withdrawn before publishing.',
  NOT_CONNECTED: 'The account is not connected.',
  UNSUPPORTED: 'TikTok does not support this kind of post here.',
  UNKNOWN: 'TikTok returned an unexpected response.',
};

export function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number') return String(value);
  throw new TikTokShapeError(`missing ${key}`);
}

export function optionalString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
