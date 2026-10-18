import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * D-566 — CONNECTED AI APPS: THE PURE HALF OF THE AUTHORIZATION SERVER.
 *
 * Brandspace is the OAuth 2.1 authorization server and the MCP resource server
 * for Claude, ChatGPT and any MCP client (MCP authorization spec 2025-11-25).
 * Everything here is a pure function the unit suite asserts directly: token
 * shapes, hashing, PKCE, scopes, redirect rules, the metadata documents.
 *
 * TOKENS ARE OPAQUE AND HASHED. 256 random bits, a readable prefix so a leak is
 * recognisable (and redacted by `@brandspace/shared`), and only the SHA-256 of
 * the value is ever stored. They are not customer sessions: an existing API
 * route handed one answers 401, because no session has that hash.
 */

export const TOKEN_PREFIX = {
  access: 'bsp_at_',
  refresh: 'bsp_rt_',
  code: 'bsp_code_',
  client: 'bsp_cli_',
} as const;

/** The scopes this server knows (the migration's CHECK holds the same three). */
export const SCOPES = ['brandspace.read', 'brandspace.write', 'offline_access'] as const;
export type Scope = (typeof SCOPES)[number];

/** What an AI app may ask for at once; `brandspace.write` implies read. */
export const DEFAULT_SCOPES: readonly Scope[] = ['brandspace.read', 'brandspace.write'];

export function newSecret(kind: keyof typeof TOKEN_PREFIX): string {
  return `${TOKEN_PREFIX[kind]}${randomBytes(32).toString('base64url')}`;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** A presented value that cannot be one of ours never reaches the database. */
export function looksLike(kind: keyof typeof TOKEN_PREFIX, value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith(TOKEN_PREFIX[kind]) &&
    value.length <= 120 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

/**
 * PKCE S256 (RFC 7636 §4.6): BASE64URL(SHA256(ASCII(code_verifier))) equals the
 * stored challenge. A verifier outside the RFC's alphabet or length is refused.
 * `plain` is never accepted: the authorization request already refused it.
 */
export function pkceS256Matches(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const computed = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isS256Challenge(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

/**
 * The scopes granted for a request: the known ones it asked for, `brandspace.read`
 * always (an app that may write may read), and the default pair when it asked
 * for nothing. An unknown scope is IGNORED, not an error — RFC 6749 §3.3 lets
 * the server grant fewer than asked, and Claude and ChatGPT add their own.
 */
export function grantedScopes(requested: unknown): Scope[] {
  const asked =
    typeof requested === 'string' && requested.trim() !== ''
      ? requested.trim().split(/\s+/)
      : [...DEFAULT_SCOPES];
  const known = new Set<Scope>(
    asked.filter((scope): scope is Scope => (SCOPES as readonly string[]).includes(scope)),
  );
  known.add('brandspace.read');
  return SCOPES.filter((scope) => known.has(scope));
}

export function scopeString(scopes: readonly string[]): string {
  return scopes.join(' ');
}

const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?\//;

/**
 * A redirect URI an app may register (MCP spec: "either localhost or HTTPS"):
 * https, or http to a loopback host; no fragment; no credentials; at most 500
 * characters (the migration's bound).
 */
export function isAcceptableRedirectUri(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash !== '' || value.includes('#')) return false;
  if (url.username !== '' || url.password !== '') return false;
  if (url.protocol === 'https:') return true;
  return LOOPBACK.test(value);
}

/**
 * EXACT match against what the app registered, except that a loopback address
 * matches on ANY port (RFC 8252 §7.3), which native and command-line clients
 * such as Claude Code need: they choose a free port at run time.
 */
export function redirectUriRegistered(presented: string, registered: readonly string[]): boolean {
  if (registered.includes(presented)) return true;
  if (!LOOPBACK.test(presented)) return false;
  const strip = (uri: string) => {
    try {
      const url = new URL(uri);
      url.port = '';
      return url.toString();
    } catch {
      return null;
    }
  };
  const bare = strip(presented);
  return bare !== null && registered.some((uri) => LOOPBACK.test(uri) && strip(uri) === bare);
}

/** Where this server lives, from the deployment's own public addresses. */
export interface AiAppsAddresses {
  /** `PUBLIC_API_BASE_URL`, no trailing slash: the issuer. */
  readonly api: string;
  /** `PUBLIC_DASHBOARD_BASE_URL`, no trailing slash: where consent happens. */
  readonly dashboard: string;
}

export function addressesFrom(env: NodeJS.ProcessEnv = process.env): AiAppsAddresses | null {
  const api = env['PUBLIC_API_BASE_URL'];
  const dashboard = env['PUBLIC_DASHBOARD_BASE_URL'];
  if (!api || !dashboard) return null;
  return { api: api.replace(/\/+$/, ''), dashboard: dashboard.replace(/\/+$/, '') };
}

/** The MCP endpoint, exactly as a person types it into Claude or ChatGPT. */
export function resourceUrl(addresses: AiAppsAddresses): string {
  return `${addresses.api}/mcp`;
}

/** RFC 9728 — OAuth 2.0 Protected Resource Metadata. */
export function protectedResourceMetadata(addresses: AiAppsAddresses) {
  return {
    resource: resourceUrl(addresses),
    // One entry: Claude uses the first and does not fall back.
    authorization_servers: [addresses.api],
    scopes_supported: ['brandspace.read', 'brandspace.write'],
    bearer_methods_supported: ['header'],
    resource_name: 'Brandspace',
    resource_documentation: `${addresses.dashboard}/en/settings/ai-apps/connect`,
  };
}

/** RFC 8414 — OAuth 2.0 Authorization Server Metadata. */
export function authorizationServerMetadata(addresses: AiAppsAddresses) {
  return {
    issuer: addresses.api,
    // On the dashboard origin: the customer's sign-in cookie lives there.
    authorization_endpoint: `${addresses.dashboard}/oauth/authorize`,
    token_endpoint: `${addresses.api}/oauth/token`,
    registration_endpoint: `${addresses.api}/oauth/register`,
    revocation_endpoint: `${addresses.api}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...SCOPES],
    // RFC 9207: the redirect carries `iss`, so a client can tell servers apart.
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${addresses.dashboard}/en/settings/ai-apps/connect`,
  };
}

/** The `WWW-Authenticate` value on a 401 from `/mcp` (MCP spec, RFC 9728 §5.1). */
export function bearerChallenge(
  addresses: AiAppsAddresses,
  extra: { readonly error?: string; readonly scope?: string } = {},
): string {
  const parts = [
    `resource_metadata="${addresses.api}/.well-known/oauth-protected-resource/mcp"`,
    `scope="${extra.scope ?? 'brandspace.read brandspace.write'}"`,
  ];
  if (extra.error) parts.unshift(`error="${extra.error}"`);
  return `Bearer ${parts.join(', ')}`;
}

/** The query string an authorization response carries back to the app. */
export function authorizationRedirect(
  redirectUri: string,
  params: Readonly<Record<string, string | undefined>>,
): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}
