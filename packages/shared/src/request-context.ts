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
 * THERE ARE THREE STRATEGIES AND THEY DISAGREE ABOUT WHICH ENTRY TO BELIEVE.
 * That is not an inconsistency to be reconciled — it is a property of the
 * infrastructure in front of the process, so the deployment DECLARES which one
 * is in force (`CLIENT_ORIGIN_STRATEGY`) and this file never guesses.
 *
 * ── `railway-edge` — THE LEFTMOST ENTRY ─────────────────────────────────────
 *
 * Railway's edge proxy STRIPS whatever `X-Forwarded-For` the caller sent and
 * writes the real connecting address as the FIRST entry; its own network then
 * appends as the request travels inward. Position 0 is therefore infrastructure's
 * word and not the client's, and it does not move when the number of internal
 * hops changes — which it does, because the CDN layer adds one and is not always
 * in the path. A right-counted index cannot be correct under this contract.
 *
 * IT HAS NO SOCKET FALLBACK, deliberately. Under this strategy the trusted
 * origin is DEFINED as the edge-controlled header value; the transport peer is a
 * Railway proxy, not a customer. Substituting it would collapse unrelated
 * customers into one rate-limit subject — the opposite of what a per-source
 * ceiling is for. When the header is absent or unusable the honest answer is
 * `undefined`, and in production the limiter turns that into a generic refusal.
 *
 * ── `xff-hops` — COUNTED FROM THE RIGHT ─────────────────────────────────────
 *
 * The ORDINARY reverse-proxy contract, where nothing strips the header: the
 * client may start the list, and every proxy APPENDS the address of the peer
 * that connected to it. With trusted proxies P1…PN, P1 nearest the client:
 *
 *     P1 receives from the client C and appends C
 *     P2 receives from P1         and appends P1
 *     …
 *     PN receives from P(N-1)     and appends P(N-1)
 *     our socket peer is PN, which appears in no header
 *
 * so the header is `<anything the client sent>, C, P1, …, P(N-1)` — exactly N
 * appended entries, the FIRST of which is the client, at `chain.length - N`.
 * Here the LEFTMOST entry is attacker-controlled and must never be believed.
 *
 * ITS SOCKET FALLBACK IS PART OF THE STRATEGY. A chain shorter than the declared
 * hops means the request did not traverse the expected proxies, and the transport
 * peer — the last real proxy — is the only thing left that the client could not
 * have written. Reaching left into the list instead would hand the caller exactly
 * the control this reading exists to deny.
 *
 * ── `direct` — THE TRANSPORT PEER ───────────────────────────────────────────
 *
 * No proxy at all, so the socket peer IS the client and no header is read. It is
 * refused in production for the two customer-facing services, where it would put
 * every customer behind a balancer into one bucket.
 *
 * ────────────────────────────────────────────────────────────────────────────
 *
 * THE DEFAULT IS TO TRUST NOTHING. With nothing declared and no hop count, the
 * forwarded header is ignored entirely. Defaulting the other way would mean a
 * developer running locally, or an operator who forgot, silently accepting a
 * client-chosen address — the failure that is invisible until it matters.
 */

/** Header names this reads. Lower-case, because Node lower-cases them. */
const FORWARDED_FOR = 'x-forwarded-for';
const USER_AGENT = 'user-agent';

/**
 * HOW THE CLIENT'S ADDRESS IS ESTABLISHED, named rather than inferred.
 *
 * A BARE HOP COUNT CANNOT EXPRESS RAILWAY, which is why this exists. Railway's
 * edge proxy STRIPS a client-supplied `X-Forwarded-For` and writes the real
 * connecting address as the FIRST entry, then its own network appends as the
 * request travels inward — and the number of internal hops varies with the
 * routing path, because the CDN layer adds one and is not always in the path.
 * A right-counted index against a hop count that is not stable is wrong
 * intermittently, which is the worst way for a security control to be wrong.
 * The leftmost entry is stable, and is the value Railway documents as the real
 * client IP.
 *
 * SO THE STRATEGY IS DECLARED, NOT GUESSED:
 *
 *   `railway-edge`  the leftmost `X-Forwarded-For` entry. Correct wherever the
 *                   edge strips client input and writes the client first.
 *   `xff-hops`      generic append semantics: `chain.length - TRUSTED_PROXY_HOPS`,
 *                   for an ordinary reverse proxy that appends its own peer.
 *   `direct`        no proxy at all; the transport peer is the client.
 *
 * `X-REAL-IP` IS DELIBERATELY NOT USED. Railway sets it, and on paper a single
 * value is stronger than a list — but Railway documents it as CURRENTLY WRONG
 * when the CDN is in the path, where it carries the CDN edge address instead of
 * the client. A header that is right most of the time and silently wrong behind
 * a CDN is worse for a rate limiter than a list with a documented reading, and
 * switching to it later is a one-line change to this file plus a strategy name.
 */
export const CLIENT_ORIGIN_STRATEGIES = ['railway-edge', 'xff-hops', 'direct'] as const;

export type ClientOriginStrategy = (typeof CLIENT_ORIGIN_STRATEGIES)[number];

/** Raised for configuration this module refuses to interpret. */
export class ClientOriginConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientOriginConfigurationError';
  }
}

/**
 * Parse a hop count STRICTLY. Never coerces.
 *
 * THE OLD READER COERCED EVERYTHING TO A SAFE-LOOKING NUMBER: `''`, `-3`,
 * `lots` and `1.5` all became 0, and `900` became 10. Every one of those is an
 * operator who believed they had configured something, and 0 means "do not read
 * the header at all" — so a typo silently disabled the per-source rate limiter
 * and looked exactly like a working deployment. Malformed security
 * configuration must fail, loudly, at start-up.
 */
export function parseTrustedProxyHops(raw: string | undefined): number {
  if (raw === undefined) {
    throw new ClientOriginConfigurationError('TRUSTED_PROXY_HOPS is not set.');
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new ClientOriginConfigurationError('TRUSTED_PROXY_HOPS is empty.');
  }
  // Digits only: `1abc`, `1.5`, `-1`, ` 1 2` and `0x1` are all refused rather
  // than truncated by `parseInt`, which happily reads `1abc` as 1.
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new ClientOriginConfigurationError(
      'TRUSTED_PROXY_HOPS must be a whole number of proxies, written in digits only.',
    );
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (parsed < 1) {
    throw new ClientOriginConfigurationError(
      'TRUSTED_PROXY_HOPS must be at least 1 under the xff-hops strategy; ' +
        'a deployment with no proxy in front of it uses the direct strategy instead.',
    );
  }
  if (parsed > MAX_TRUSTED_PROXY_HOPS) {
    throw new ClientOriginConfigurationError(
      `TRUSTED_PROXY_HOPS must not exceed ${MAX_TRUSTED_PROXY_HOPS}: a larger value reads ` +
        'further into the part of the chain a client controls.',
    );
  }
  return parsed;
}

/** The most proxies this will believe in. A typo must not read the far end. */
export const MAX_TRUSTED_PROXY_HOPS = 10;

/** The declared strategy, or undefined when none is set. Never guesses. */
export function clientOriginStrategy(
  env: NodeJS.ProcessEnv = process.env,
): ClientOriginStrategy | undefined {
  const raw = env['CLIENT_ORIGIN_STRATEGY']?.trim();
  if (raw === undefined || raw === '') return undefined;
  if ((CLIENT_ORIGIN_STRATEGIES as readonly string[]).includes(raw)) {
    return raw as ClientOriginStrategy;
  }
  throw new ClientOriginConfigurationError(
    `CLIENT_ORIGIN_STRATEGY must be one of ${CLIENT_ORIGIN_STRATEGIES.join(', ')}.`,
  );
}

/**
 * How many proxies sit in front of this process.
 *
 * KEPT FOR THE `xff-hops` STRATEGY AND FOR COMPATIBILITY. An unset value is 0,
 * which means "read no header"; a SET value is parsed strictly and a malformed
 * one throws rather than quietly becoming 0.
 */
export function trustedProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['TRUSTED_PROXY_HOPS'];
  /*
   * ABSENT IS ZERO — "read no header" — and that is the one safe coercion: a
   * deployment that configured nothing trusts nothing.
   *
   * PRESENT-BUT-EMPTY IS NOT ABSENT. Somebody who wrote `TRUSTED_PROXY_HOPS=`
   * believes they configured a hop count, and reading that as zero is the
   * silent-disable this whole parser exists to stop.
   */
  if (raw === undefined) return 0;
  return parseTrustedProxyHops(raw);
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
 * WHICH ENTRY IS BELIEVED DEPENDS ENTIRELY ON THE DECLARED STRATEGY — see the
 * three blocks at the top of this file. In one word each: `railway-edge` reads
 * the LEFTMOST entry and has no socket fallback; `xff-hops` counts from the
 * RIGHT and falls back to the socket peer; `direct` reads only the socket peer.
 *
 * `TRUSTED_PROXY_HOPS` IS PARSED ONLY UNDER `xff-hops`. A variable that is
 * irrelevant to the active strategy must not be able to fail a request later:
 * a stale hop count left on a `railway-edge` service is a configuration error
 * the START-UP contract rejects, not something for this function to throw over
 * mid-request.
 */
export function requestContext(input: RequestContextInput): RequestContext {
  const env = input.env ?? process.env;
  const userAgent = headerValue(input.headers, USER_AGENT)?.slice(0, 512) || undefined;

  /*
   * THE DECLARED STRATEGY WINS, and the fallback reads only the PRESENCE of a
   * hop count, never its value — parsing it here would let a variable that this
   * strategy ignores decide whether the request survives.
   */
  const declared = clientOriginStrategy(env);
  const strategy: ClientOriginStrategy =
    declared ?? (env['TRUSTED_PROXY_HOPS'] === undefined ? 'direct' : 'xff-hops');

  if (strategy === 'direct') {
    // The socket peer IS the client here; that is what the strategy means.
    return { ip: normalizeAddress(input.socketAddress), userAgent };
  }

  const forwarded = headerValue(input.headers, FORWARDED_FOR);
  const chain = (forwarded ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  if (strategy === 'railway-edge') {
    /*
     * THE LEFTMOST ENTRY, AND NOTHING ELSE.
     *
     * Railway strips whatever `X-Forwarded-For` the caller sent and writes the
     * real connecting address first, so position 0 is infrastructure's word.
     *
     * NO SOCKET FALLBACK — this is the security contract, not an omission.
     * Under this strategy the transport peer is a Railway proxy, never a
     * customer: on the API it is `req.ip`, which behind the edge is
     * infrastructure. Substituting it when the header is missing would give
     * unrelated customers ONE shared rate-limit subject, which is worse than
     * having no subject at all. So an absent or unusable chain answers
     * `undefined`, and in production `AuthRateLimiter.enforce` turns that into a
     * generic refusal. Trustworthy edge origin, or refusal — never a proxy peer
     * wearing a customer's identity.
     */
    const client = normalizeAddress(chain[0]);
    return { ip: client, userAgent };
  }

  /*
   * `xff-hops`: `hops` entries were appended by infrastructure we run, and the
   * client is the FIRST of those — the one our outermost proxy wrote down as its
   * own peer. Indexed from the END, so nothing the client prepended can shift it.
   *
   * THE SOCKET FALLBACK IS PART OF THIS STRATEGY. Nothing strips the header
   * here, so a chain shorter than the declared hops means the request did not
   * traverse the expected proxies — and the transport peer is the last thing the
   * client could not have written. Reaching left into the list instead would
   * hand the caller exactly the control this reading denies.
   */
  const hops = trustedProxyHops(env);
  const index = chain.length - hops;
  if (index < 0) return { ip: normalizeAddress(input.socketAddress), userAgent };
  return { ip: normalizeAddress(chain[index]), userAgent };
}
