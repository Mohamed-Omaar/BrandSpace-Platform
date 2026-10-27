import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import type { LookupFunction } from 'node:net';
import { isPublicIpAddress, unsafeProviderUrlReason } from '@brandspace/shared';

/**
 * D-573 — THE ONLY WAY AN AI ADAPTER REACHES THE NETWORK.
 *
 * A provider's `baseUrl` is configuration, and the request carries the
 * platform's credential, so where it goes is a security boundary:
 *
 *   1. The URL must pass the same rules configuration validation applies
 *      (https, standard port, no credentials, no IP literal, no private name)
 *      AND its host must be the adapter's official one or on the owner's
 *      allow-list (`ai.providers.allowedHosts`).
 *   2. The host is resolved on every connection, and EVERY address it resolves
 *      to must be public: never loopback, private, link-local (where the cloud
 *      metadata service lives), carrier-grade NAT or multicast.
 *   3. The socket connects to the address that was checked. The check runs
 *      INSIDE the connection's own lookup (`pinnedLookup`), so there is no
 *      second resolution between "checked" and "connected" — no DNS-rebinding
 *      window. TLS still verifies the certificate against the host name.
 *   4. Redirects are refused, not followed: a 3xx could otherwise send the
 *      credential somewhere step 1 never saw.
 *
 * Nothing here logs a header, a body or the URL's query.
 */

/** Refused before or during connection. Classified by adapters as unusable, never retried. */
export class EgressRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EgressRefusedError';
  }
}

/** Why this URL may not be called with these allowed hosts, or null when it may. */
export function egressRefusal(url: string, allowedHosts: readonly string[]): string | null {
  const unsafe = unsafeProviderUrlReason(url);
  if (unsafe) return unsafe;
  const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  const allowed = new Set(allowedHosts.map((entry) => entry.toLowerCase().replace(/\.$/, '')));
  return allowed.has(host)
    ? null
    : `The host "${host}" is not the provider's official host and is not on the owner's allow-list.`;
}

type ResolveAll = (
  hostname: string,
  callback: (error: NodeJS.ErrnoException | null, addresses: readonly LookupAddress[]) => void,
) => void;

const resolveAll: ResolveAll = (hostname, callback) =>
  dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) =>
    callback(error, (addresses ?? []) as LookupAddress[]),
  );

/**
 * A `lookup` for the socket itself: resolve once, refuse unless every address
 * is allowed, and hand the socket exactly the addresses that were checked.
 */
export function pinnedLookup(
  resolve: ResolveAll = resolveAll,
  isAllowed: (address: string) => boolean = isPublicIpAddress,
): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, (error, addresses) => {
      if (error) {
        callback(error, '', 0);
        return;
      }
      const family = typeof options === 'object' && options ? options.family : undefined;
      const wanted = addresses.filter(
        (entry) => family === undefined || family === 0 || entry.family === family,
      );
      if (wanted.length === 0) {
        const missing = Object.assign(new Error(`No address for ${hostname}.`), {
          code: 'ENOTFOUND',
        });
        callback(missing, '', 0);
        return;
      }
      // EVERY address, not just the first: a resolver may rotate, and the one
      // the socket picks must be one that passed.
      if (!addresses.every((entry) => isAllowed(entry.address))) {
        callback(
          new EgressRefusedError(
            `The provider host resolves to an address the platform may not call.`,
          ),
          '',
          0,
        );
        return;
      }
      if (typeof options === 'object' && options && 'all' in options && options.all) {
        (callback as unknown as (e: null, a: readonly LookupAddress[]) => void)(null, wanted);
        return;
      }
      const first = wanted[0]!;
      callback(null, first.address, first.family);
    });
  };
}

export interface EgressRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal: AbortSignal;
}

export interface EgressResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/** How an adapter sends one request. Injectable so a test can use a fake server. */
export type EgressTransport = (request: EgressRequest) => Promise<EgressResponse>;

/** The largest body an AI response may have (generated images arrive inline). */
const MAX_RESPONSE_BYTES = 40 * 1024 * 1024;

/**
 * The production transport: https only, through `pinnedLookup`, no connection
 * reuse (each request is resolved and checked afresh), redirects refused.
 */
export function pinnedHttpsTransport(
  allowedHosts: readonly string[],
  lookup: LookupFunction = pinnedLookup(),
): EgressTransport {
  return (request) =>
    new Promise<EgressResponse>((resolvePromise, reject) => {
      const refusal = egressRefusal(request.url, allowedHosts);
      if (refusal) {
        reject(new EgressRefusedError(refusal));
        return;
      }
      if (request.signal.aborted) {
        reject(abortError());
        return;
      }
      const target = new URL(request.url);
      const outgoing = httpsRequest(
        {
          protocol: 'https:',
          hostname: target.hostname,
          port: 443,
          path: `${target.pathname}${target.search}`,
          method: request.method,
          headers: {
            ...request.headers,
            ...(request.body !== undefined
              ? { 'content-length': Buffer.byteLength(request.body).toString() }
              : {}),
          },
          lookup,
          agent: false,
          signal: request.signal,
        },
        (response) => {
          const status = response.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            response.resume();
            reject(
              new EgressRefusedError('The provider answered with a redirect, which is refused.'),
            );
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              response.destroy(new EgressRefusedError('The provider response is too large.'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () =>
            resolvePromise({
              status,
              headers: response.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
          response.on('error', reject);
        },
      );
      outgoing.on('error', reject);
      if (request.body !== undefined) outgoing.write(request.body);
      outgoing.end();
    });
}

function abortError(): Error {
  return Object.assign(new Error('The request was aborted.'), { name: 'AbortError' });
}
