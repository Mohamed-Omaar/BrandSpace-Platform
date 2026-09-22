import { describe, expect, it } from 'vitest';
import { requestContext, trustedProxyHops } from '@brandspace/shared';

/**
 * WHOSE ADDRESS IS IT — Phase 4 §5, corrected after review.
 *
 * `X-Forwarded-For` is a list the CLIENT can start: anybody may send
 * `X-Forwarded-For: 1.2.3.4`, and every proxy APPENDS rather than replaces. A
 * reader that takes the leftmost entry therefore lets the caller choose their
 * own identity — and once that identity is what a rate limiter counts, choosing
 * it means choosing to have no limit.
 *
 * THE FIRST VERSION OF THIS FILE ENCODED THE WRONG CONTRACT, which is why the
 * off-by-one it was meant to catch sailed straight through it. The fixtures said
 * that with ONE trusted proxy the chain reads `client, proxy` and the client is
 * the second entry from the right. That is not how a proxy behaves: a proxy
 * appends the address of the PEER THAT CONNECTED TO IT, never its own. So with
 * proxies P1…PN, P1 nearest the client, the header we see is
 *
 *     <anything the client sent>, C, P1, …, P(N-1)
 *
 * — exactly N entries appended by infrastructure we run, the FIRST of which is
 * the client, at `chain.length - N`. With one trusted proxy the client is the
 * RIGHTMOST entry.
 *
 * EVERY FIXTURE BELOW IS NOW BUILT BY `through()`, which performs those appends
 * rather than asserting a hand-written string. A test that hand-writes the chain
 * can only ever confirm whatever its author believed; one that simulates the
 * hops cannot encode an off-by-one without the simulation itself being wrong.
 *
 * THE INVARIANT ALL OF THIS SERVES: no value a client can prepend to
 * `X-Forwarded-For` may become the identity a security rate limiter counts.
 */

/**
 * Build the header a request carries after traversing `proxies`, in order from
 * the client outward, exactly as real proxies build it.
 *
 * `clientSent` is whatever the caller chose to put in the header before any of
 * our infrastructure saw it — i.e. the attacker-controlled part.
 */
function through(options: {
  clientSent?: readonly string[];
  client: string;
  proxies: readonly string[];
}): { header: string; socketAddress: string } {
  const { clientSent = [], client, proxies } = options;
  if (proxies.length === 0) throw new Error('a chain with no proxy appends nothing');
  const chain = [...clientSent];
  // The first proxy's peer is the client; each later one's peer is the proxy
  // before it. The LAST proxy is our socket peer and appends nothing about
  // itself — it appears in no header.
  chain.push(client);
  for (let i = 0; i < proxies.length - 1; i += 1) chain.push(proxies[i]!);
  return { header: chain.join(', '), socketAddress: proxies[proxies.length - 1]! };
}

const AGENT = { 'user-agent': 'Mozilla/5.0 (Test)' };
/** One trusted proxy — the shape almost every deployment actually has. */
const ONE = { TRUSTED_PROXY_HOPS: '1' } as NodeJS.ProcessEnv;

describe('CASE 1 — no trusted proxy: the header is not read at all', () => {
  it('uses the real transport peer and ignores a forwarded chain entirely', () => {
    const context = requestContext({
      headers: { ...AGENT, 'x-forwarded-for': '1.2.3.4' },
      socketAddress: '203.0.113.9',
      env: {},
    });
    // The DEFAULT is to trust nothing: a developer running locally, or an
    // operator who forgot to declare the hop count, must not silently accept a
    // client-chosen address.
    expect(context.ip).toBe('203.0.113.9');
    expect(context.userAgent).toBe('Mozilla/5.0 (Test)');
  });

  it('reports no address rather than inventing one when there is no socket', () => {
    const context = requestContext({ headers: AGENT, env: {} });
    expect(context.ip).toBeUndefined();
  });
});

describe('CASE 2 — one trusted proxy, ordinary request', () => {
  it('SELECTS THE CLIENT, which is the RIGHTMOST entry', () => {
    const { header, socketAddress } = through({ client: '203.0.113.9', proxies: ['10.0.0.1'] });
    // One proxy appended one entry: its peer, the client. Nothing else is there.
    expect(header).toBe('203.0.113.9');

    expect(
      requestContext({ headers: { ...AGENT, 'x-forwarded-for': header }, socketAddress, env: ONE })
        .ip,
    ).toBe('203.0.113.9');
  });
});

describe('CASE 3 — one trusted proxy, attacker pre-populates the header', () => {
  it('IGNORES THE PREPENDED VALUE and selects what the proxy appended', () => {
    const { header, socketAddress } = through({
      clientSent: ['9.9.9.9'],
      client: '203.0.113.9',
      proxies: ['10.0.0.1'],
    });
    expect(header).toBe('9.9.9.9, 203.0.113.9');

    /*
     * THIS IS THE DEFECT THE REVIEW FOUND. `chain.length - hops - 1` selected
     * 9.9.9.9 here — a value the caller typed — so a caller could hand
     * themselves a new identity, and therefore a fresh rate-limit budget, on
     * every request.
     */
    expect(
      requestContext({ headers: { 'x-forwarded-for': header }, socketAddress, env: ONE }).ip,
    ).toBe('203.0.113.9');
  });

  it('DOES NOT MOVE however many entries the attacker prepends', () => {
    for (const clientSent of [
      ['9.9.9.9'],
      ['1.1.1.1', '2.2.2.2'],
      ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4', '5.5.5.5'],
    ]) {
      const { header, socketAddress } = through({
        clientSent,
        client: '203.0.113.9',
        proxies: ['10.0.0.1'],
      });
      expect(
        requestContext({ headers: { 'x-forwarded-for': header }, socketAddress, env: ONE }).ip,
      ).toBe('203.0.113.9');
    }
  });

  it('GIVES ONE CALLER ONE IDENTITY however they vary the spoof', () => {
    // The rate-limiter consequence stated directly: a varying prepended value
    // must not produce a varying subject, because a varying subject is a fresh
    // budget each time.
    const seen = new Set(
      ['1.1.1.1', '2.2.2.2', '3.3.3.3'].map((spoof) => {
        const { header, socketAddress } = through({
          clientSent: [spoof],
          client: '203.0.113.9',
          proxies: ['10.0.0.1'],
        });
        return requestContext({ headers: { 'x-forwarded-for': header }, socketAddress, env: ONE })
          .ip;
      }),
    );
    expect([...seen]).toEqual(['203.0.113.9']);
  });
});

describe('CASE 4 — two trusted proxies', () => {
  const TWO = { TRUSTED_PROXY_HOPS: '2' } as NodeJS.ProcessEnv;

  it('derives the client from real append semantics', () => {
    const { header, socketAddress } = through({
      client: '203.0.113.9',
      proxies: ['10.0.0.1', '10.0.0.2'],
    });
    // P1 appended the client; P2 appended P1. P2 is our socket peer.
    expect(header).toBe('203.0.113.9, 10.0.0.1');
    expect(socketAddress).toBe('10.0.0.2');

    expect(
      requestContext({ headers: { 'x-forwarded-for': header }, socketAddress, env: TWO }).ip,
    ).toBe('203.0.113.9');
  });

  it('no client-prepended value may move it', () => {
    const { header, socketAddress } = through({
      clientSent: ['9.9.9.9', '8.8.8.8'],
      client: '203.0.113.9',
      proxies: ['10.0.0.1', '10.0.0.2'],
    });
    expect(header).toBe('9.9.9.9, 8.8.8.8, 203.0.113.9, 10.0.0.1');
    expect(
      requestContext({ headers: { 'x-forwarded-for': header }, socketAddress, env: TWO }).ip,
    ).toBe('203.0.113.9');
  });
});

describe('CASE 5 — a dashboard server action, which has NO socket address', () => {
  /*
   * A Next.js server action reads `headers()` and cannot see the transport
   * peer. Under the old off-by-one a perfectly ordinary one-proxy chain looked
   * TOO SHORT, so this path fell through to an undefined socket address — and
   * `AuthRateLimiter.enforce` skips a dimension whose subject is undefined. The
   * result was that the one path every customer browser takes had no per-source
   * ceiling at all, while every test of the pure helper passed.
   */
  it('STILL PRODUCES A SOURCE ADDRESS rather than silently skipping per-IP limiting', () => {
    const { header } = through({ client: '203.0.113.9', proxies: ['10.0.0.1'] });
    const context = requestContext({ headers: { ...AGENT, 'x-forwarded-for': header }, env: ONE });

    expect(context.ip).toBe('203.0.113.9');
    // Stated as the limiter sees it: a defined, non-empty subject is the whole
    // difference between a counted dimension and an uncounted one.
    expect(context.ip).toBeDefined();
    expect(context.ip?.trim()).not.toBe('');
  });

  it('is still not spoofable without a socket address to fall back on', () => {
    const { header } = through({
      clientSent: ['9.9.9.9'],
      client: '203.0.113.9',
      proxies: ['10.0.0.1'],
    });
    expect(requestContext({ headers: { 'x-forwarded-for': header }, env: ONE }).ip).toBe(
      '203.0.113.9',
    );
  });
});

describe('CASE 6 — a chain shorter than the configured hops, or malformed', () => {
  const TWO = { TRUSTED_PROXY_HOPS: '2' } as NodeJS.ProcessEnv;

  it('falls back to the socket peer rather than reaching left', () => {
    // Two hops configured, one entry present: the request did not traverse the
    // chain we were told to expect. The single entry could be anything the
    // caller typed, so it is not believed.
    const context = requestContext({
      headers: { 'x-forwarded-for': '9.9.9.9' },
      socketAddress: '10.0.0.2',
      env: TWO,
    });
    expect(context.ip).toBe('10.0.0.2');
    expect(context.ip).not.toBe('9.9.9.9');
  });

  it('REPORTS NOTHING rather than an attacker value when there is no socket either', () => {
    // The safe answer is "unknown". Producing SOME address by reaching into the
    // client-controlled part of the list is the one thing that must never
    // happen, because that address would become a rate-limiter subject.
    const context = requestContext({ headers: { 'x-forwarded-for': '9.9.9.9' }, env: TWO });
    expect(context.ip).toBeUndefined();
  });

  it('treats an empty or whitespace-only header as no chain at all', () => {
    expect(
      requestContext({ headers: { 'x-forwarded-for': '' }, socketAddress: '10.0.0.1', env: ONE })
        .ip,
    ).toBe('10.0.0.1');
    expect(
      requestContext({
        headers: { 'x-forwarded-for': ' , , ' },
        socketAddress: '10.0.0.1',
        env: ONE,
      }).ip,
    ).toBe('10.0.0.1');
  });

  it('reports nothing when there is neither a chain nor a socket', () => {
    expect(requestContext({ headers: AGENT, env: ONE }).ip).toBeUndefined();
  });
});

describe('an address is normalised to one form', () => {
  const env = ONE;

  it('unwraps an IPv6-mapped IPv4 address', () => {
    // Otherwise one client has two budgets depending on which form the proxy
    // used, and a limiter counting by address counts them separately.
    expect(
      requestContext({
        headers: { 'x-forwarded-for': '10.0.0.9, ::ffff:203.0.113.9' },
        env,
      }).ip,
    ).toBe('203.0.113.9');
  });

  it('drops a port from an IPv4 address and keeps an IPv6 one whole', () => {
    expect(
      requestContext({ headers: { 'x-forwarded-for': '10.0.0.9, 203.0.113.9:51234' }, env }).ip,
    ).toBe('203.0.113.9');
    expect(
      requestContext({ headers: { 'x-forwarded-for': '10.0.0.9, 2001:db8::1' }, env }).ip,
    ).toBe('2001:db8::1');
  });

  it('unwraps a bracketed literal with a port', () => {
    expect(requestContext({ headers: {}, socketAddress: '[2001:db8::1]:443', env: {} }).ip).toBe(
      '2001:db8::1',
    );
  });
});

describe('the header bag may be either shape', () => {
  it('reads a Headers-like object with get()', () => {
    const bag = new Map<string, string>([
      ['x-forwarded-for', '10.0.0.9, 203.0.113.9'],
      ['user-agent', 'Fetcher/1'],
    ]);
    const context = requestContext({
      headers: { get: (name) => bag.get(name) ?? null },
      env: ONE,
    });
    expect(context.ip).toBe('203.0.113.9');
    expect(context.userAgent).toBe('Fetcher/1');
  });

  it('joins a repeated header rather than reading only the first', () => {
    const context = requestContext({
      headers: { 'x-forwarded-for': ['10.0.0.9', '203.0.113.9'] },
      env: ONE,
    });
    expect(context.ip).toBe('203.0.113.9');
  });
});

describe('the hop count is read defensively', () => {
  it('treats absent, empty, negative and unparseable values as zero', () => {
    expect(trustedProxyHops({})).toBe(0);
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: '' })).toBe(0);
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: '  ' })).toBe(0);
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: '-3' })).toBe(0);
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: 'lots' })).toBe(0);
  });

  it('caps a typo rather than reading the far end of a long list', () => {
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: '900' })).toBe(10);
  });
});

describe('a user agent is bounded', () => {
  it('truncates rather than storing an arbitrary length', () => {
    const context = requestContext({ headers: { 'user-agent': 'x'.repeat(5_000) }, env: {} });
    expect(context.userAgent).toHaveLength(512);
  });

  it('reports none rather than an empty string', () => {
    expect(requestContext({ headers: { 'user-agent': '' }, env: {} }).userAgent).toBeUndefined();
  });
});
