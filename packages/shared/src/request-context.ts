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
 * WHY THE HOP COUNT IS EXPLICIT, AND WHAT IT COUNTS. `X-Forwarded-For` is a list
 * the CLIENT can start: anybody may send `X-Forwarded-For: 1.2.3.4` and every
 * proxy in front of us APPENDS to it rather than replacing it. Trusting the
 * leftmost entry therefore lets an attacker choose their own identity — which,
 * once that address is what a rate limiter counts, means choosing to have no
 * limit at all. The only safe reading is to count from the RIGHT.
 *
 * THE APPEND RULE IS THE WHOLE CONTRACT, so it is worth writing out. A proxy
 * appends the address of the PEER THAT CONNECTED TO IT — not its own. With
 * trusted proxies P1…PN, P1 nearest the client:
 *
 *     P1 receives from the client C and appends C
 *     P2 receives from P1         and appends P1
 *     …
 *     PN receives from P(N-1)     and appends P(N-1)
 *     our socket peer is PN, which appears in no header
 *
 * so the header we see is `<anything the client sent>, C, P1, …, P(N-1)`:
 * EXACTLY N entries were appended by infrastructure we run, and the client is
 * the FIRST of them, at `chain.length - N`.
 *
 * WITH ONE TRUSTED PROXY THE CLIENT IS THEREFORE THE RIGHTMOST ENTRY, not the
 * one before it. This is the defect this file shipped with: it read
 * `chain.length - hops - 1`, one position further left, which in the one-proxy
 * case is the last entry the CLIENT supplied. A caller sending
 * `X-Forwarded-For: 9.9.9.9` against a single load balancer was identified as
 * 9.9.9.9, and could pick a new value on every request — a fresh rate-limit
 * budget each time, which is precisely the attack the hop count exists to stop.
 * The same off-by-one made an ordinary one-entry chain look TOO SHORT, so the
 * dashboard — where a Next.js server action has no socket address to fall back
 * to — reported no address at all and the per-source ceiling was skipped
 * entirely on the one path every browser takes.
 *
 * The number of hops is a property of the deployment, never of this code.
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
 * THE ADDRESS IS COUNTED FROM THE RIGHT, at `chain.length - hops`. Our `hops`
 * proxies appended `hops` entries, the FIRST of which is the client; with one
 * trusted hop that is the last entry in the list. Anything the client prepended
 * sits further left and is never reached, however much of it there is. With zero
 * trusted hops the header is not read at all.
 *
 * WHEN THE HEADER IS TOO SHORT for the configured hops the socket address is
 * used, and never an entry from the list. A request that did not traverse the
 * expected chain is not one whose claimed origin we should believe, and reaching
 * left to produce SOME address would hand the caller exactly the control this
 * function exists to deny. When there is no socket address either — a Next.js
 * server action has none — the answer is honestly `undefined`, and
 * `AuthRateLimiter.enforce` says so in the log rather than skipping in silence.
 */
export function requestContext(input: RequestContextInput): RequestContext {
  const env = input.env ?? process.env;
  const userAgent = headerValue(input.headers, USER_AGENT)?.slice(0, 512) || undefined;

  /*
   * THE DECLARED STRATEGY WINS. When none is declared the old behaviour stands:
   * a hop count means `xff-hops`, and no hop count means `direct`. That keeps
   * every existing deployment and test reading the same way, while production
   * is required by `assertProductionSafety` to declare one explicitly.
   */
  const declared = clientOriginStrategy(env);
  const hops = trustedProxyHops(env);
  const strategy: ClientOriginStrategy = declared ?? (hops === 0 ? 'direct' : 'xff-hops');

  if (strategy === 'direct') {
    return { ip: normalizeAddress(input.socketAddress), userAgent };
  }

  const forwarded = headerValue(input.headers, FORWARDED_FOR);
  const chain = (forwarded ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  if (strategy === 'railway-edge') {
    /*
     * THE LEFTMOST ENTRY, because the edge wrote it. Railway strips whatever
     * `X-Forwarded-For` the caller sent and puts the real connecting address
     * first, so position 0 is infrastructure's word and not the client's. An
     * empty chain means the request did not arrive through that edge at all,
     * and the socket peer is the only thing left worth believing.
     */
    if (chain.length === 0) return { ip: normalizeAddress(input.socketAddress), userAgent };
    return { ip: normalizeAddress(chain[0]), userAgent };
  }

  /*
   * `hops` entries were appended by infrastructure we run, and the client is the
   * FIRST of those — the one our outermost proxy wrote down as its own peer.
   * Indexed from the END, so nothing the client prepended can shift it.
   */
  const index = chain.length - hops;
  if (index < 0) return { ip: normalizeAddress(input.socketAddress), userAgent };
  return { ip: normalizeAddress(chain[index]), userAgent };
}
