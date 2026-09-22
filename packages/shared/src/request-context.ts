/**
 * The request context a security event needs to be investigable.
 *
 * WHY THIS IS SHARED AND NOT A HELPER IN EACH APP. Authentication happens on
 * two surfaces — the customer dashboard's server actions and the API's routes —
 * and until Phase 4 only one of them passed anything at all. The dashboard, the
 * surface a browser actually uses, passed NO address and NO user agent, so every
 * customer sign-in, password reset and MFA challenge in the running product
 * recorded `ip: null, userAgent: null`. An operator asking "where did this
 * takeover come from" had nothing to read. One shared extractor, used by both,
 * is what stops the two surfaces disagreeing again.
 *
 * WHY THE HOP COUNT IS EXPLICIT. `X-Forwarded-For` is a list the CLIENT can
 * start: anybody may send `X-Forwarded-For: 1.2.3.4` and every proxy in front of
 * us appends to it rather than replacing it. Trusting the leftmost entry
 * therefore lets an attacker choose their own identity — which, once that
 * address is what a rate limiter counts, means choosing to have no limit at all.
 * The only safe reading is to count from the RIGHT, skipping exactly as many
 * hops as we actually run, and the number of hops is a property of the
 * deployment rather than of this code.
 *
 * THE DEFAULT IS TO TRUST NOTHING. With no `TRUSTED_PROXY_HOPS` set, the
 * forwarded header is ignored entirely and the socket address is used. A
 * deployment behind a load balancer sets it to 1. Defaulting the other way would
 * mean a developer running locally, or an operator who forgot, silently accepts
 * a client-chosen address — the failure that is invisible until it matters.
 */

/** Header names this reads. Lower-case, because Node lower-cases them. */
const FORWARDED_FOR = 'x-forwarded-for';
const USER_AGENT = 'user-agent';

/** How many proxies sit in front of this process, from the environment. */
export function trustedProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['TRUSTED_PROXY_HOPS'];
  if (raw === undefined || raw.trim() === '') return 0;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  // A ceiling, so a typo cannot turn into "read the far end of a long list".
  return Math.min(parsed, 10);
}

/** A header bag in either of the two shapes the two apps hand us. */
export interface HeaderSource {
  get(name: string): string | null | undefined;
}

type HeaderInput = HeaderSource | Record<string, string | string[] | undefined>;

function headerValue(headers: HeaderInput, name: string): string | undefined {
  if (typeof (headers as HeaderSource).get === 'function') {
    return (headers as HeaderSource).get(name) ?? undefined;
  }
  const raw = (headers as Record<string, string | string[] | undefined>)[name];
  if (Array.isArray(raw)) return raw.join(',');
  return raw ?? undefined;
}

/**
 * Normalise one address, or return undefined.
 *
 * IPv6-mapped IPv4 (`::ffff:203.0.113.9`) is unwrapped so the same client is one
 * subject rather than two — otherwise a limiter counting by address gives every
 * caller two budgets depending on which form the proxy used. A port suffix on an
 * IPv4 address is dropped for the same reason.
 */
function normalizeAddress(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  let address = trimmed;
  if (address.startsWith('[')) {
    // `[::1]:443` — a bracketed IPv6 literal with a port.
    const close = address.indexOf(']');
    if (close > 0) address = address.slice(1, close);
  } else if (address.startsWith('::ffff:')) {
    address = address.slice('::ffff:'.length);
  }
  if (address.startsWith('::ffff:')) address = address.slice('::ffff:'.length);
  // An IPv4 address with a port. An IPv6 address has many colons, so the count
  // is what tells the two apart without parsing either.
  const colons = address.split(':').length - 1;
  if (colons === 1) address = address.slice(0, address.indexOf(':'));
  if (address === '') return undefined;
  return address.slice(0, 45);
}

export interface RequestContextInput {
  readonly headers: HeaderInput;
  /** The transport peer: `req.socket.remoteAddress`, or Fastify's `req.ip`. */
  readonly socketAddress?: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
}

export interface RequestContext {
  readonly ip: string | undefined;
  readonly userAgent: string | undefined;
}

/**
 * The client's address and user agent, read safely.
 *
 * THE ADDRESS IS COUNTED FROM THE RIGHT. With one trusted hop, the last entry of
 * `X-Forwarded-For` is the one our own proxy appended and therefore the only one
 * we know to be true; the entry before it is the client. Anything the client
 * prepended sits further left and is never reached. With zero trusted hops the
 * header is not read at all.
 *
 * WHEN THE HEADER IS TOO SHORT for the configured hops, the socket address is
 * used rather than the leftmost entry: a request that did not come through the
 * expected chain is not a request whose claimed origin we should believe.
 */
export function requestContext(input: RequestContextInput): RequestContext {
  const hops = trustedProxyHops(input.env ?? process.env);
  const userAgent = headerValue(input.headers, USER_AGENT)?.slice(0, 512) || undefined;

  if (hops === 0) {
    return { ip: normalizeAddress(input.socketAddress), userAgent };
  }

  const forwarded = headerValue(input.headers, FORWARDED_FOR);
  const chain = (forwarded ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  // `hops` entries were appended by infrastructure we run. The one before them
  // is the client. Index from the end so nothing the client sent can shift it.
  const index = chain.length - hops - 1;
  if (index < 0) return { ip: normalizeAddress(input.socketAddress), userAgent };
  return { ip: normalizeAddress(chain[index]), userAgent };
}
