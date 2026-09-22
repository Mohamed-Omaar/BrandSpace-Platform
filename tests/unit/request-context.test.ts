import { describe, expect, it } from 'vitest';
import { requestContext, trustedProxyHops } from '@brandspace/shared';

/**
 * WHOSE ADDRESS IS IT — Phase 4 §5.
 *
 * `X-Forwarded-For` is a list the CLIENT can start: anybody may send
 * `X-Forwarded-For: 1.2.3.4`, and every proxy appends rather than replaces. A
 * reader that takes the leftmost entry therefore lets the caller choose their
 * own identity — and once that identity is what a rate limiter counts, choosing
 * it means choosing to have no limit. These assertions are about that one
 * property: nothing a client sends can change which entry is believed.
 */

const AGENT = { 'user-agent': 'Mozilla/5.0 (Test)' };

describe('with no trusted proxies, the header is not read at all', () => {
  it('uses the socket address and ignores a forwarded chain entirely', () => {
    const context = requestContext({
      headers: { ...AGENT, 'x-forwarded-for': '1.2.3.4' },
      socketAddress: '10.0.0.8',
      env: {},
    });
    // The DEFAULT is to trust nothing: a developer running locally, or an
    // operator who forgot to declare the hop count, must not silently accept a
    // client-chosen address.
    expect(context.ip).toBe('10.0.0.8');
    expect(context.userAgent).toBe('Mozilla/5.0 (Test)');
  });

  it('reports no address rather than inventing one when there is no socket', () => {
    const context = requestContext({ headers: AGENT, env: {} });
    // Honest. The limiter treats "no subject" as "skip this dimension", which is
    // right; a fabricated constant would put every caller in one bucket.
    expect(context.ip).toBeUndefined();
  });
});

describe('with one trusted proxy, the client is the entry before ours', () => {
  const env = { TRUSTED_PROXY_HOPS: '1' } as NodeJS.ProcessEnv;

  it('reads the second entry from the right', () => {
    const context = requestContext({
      headers: { ...AGENT, 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
      socketAddress: '10.0.0.1',
      env,
    });
    expect(context.ip).toBe('203.0.113.9');
  });

  it('IGNORES ENTRIES THE CLIENT PREPENDED, however many there are', () => {
    const context = requestContext({
      headers: {
        ...AGENT,
        // The first three are whatever the caller decided to claim.
        'x-forwarded-for': '9.9.9.9, 8.8.8.8, 7.7.7.7, 203.0.113.9, 10.0.0.1',
      },
      socketAddress: '10.0.0.1',
      env,
    });
    // Counted from the right, so a longer lie does not move the answer.
    expect(context.ip).toBe('203.0.113.9');
  });

  it('falls back to the socket when the chain is shorter than the hops', () => {
    const context = requestContext({
      headers: { ...AGENT, 'x-forwarded-for': '203.0.113.9' },
      socketAddress: '10.0.0.1',
      env,
    });
    // A request that did not come through the expected chain is not one whose
    // claimed origin should be believed.
    expect(context.ip).toBe('10.0.0.1');
  });

  it('falls back to the socket when there is no chain at all', () => {
    expect(requestContext({ headers: AGENT, socketAddress: '10.0.0.1', env }).ip).toBe('10.0.0.1');
  });
});

describe('two trusted proxies', () => {
  it('skips both', () => {
    const context = requestContext({
      headers: { ...AGENT, 'x-forwarded-for': '203.0.113.9, 10.0.0.1, 10.0.0.2' },
      socketAddress: '10.0.0.2',
      env: { TRUSTED_PROXY_HOPS: '2' } as NodeJS.ProcessEnv,
    });
    expect(context.ip).toBe('203.0.113.9');
  });
});

describe('an address is normalised to one form', () => {
  const env = { TRUSTED_PROXY_HOPS: '1' } as NodeJS.ProcessEnv;

  it('unwraps an IPv6-mapped IPv4 address', () => {
    // Otherwise one client has two budgets depending on which form the proxy
    // used, and a limiter counting by address counts them separately.
    expect(
      requestContext({
        headers: { 'x-forwarded-for': '::ffff:203.0.113.9, 10.0.0.1' },
        env,
      }).ip,
    ).toBe('203.0.113.9');
  });

  it('drops a port from an IPv4 address and keeps an IPv6 one whole', () => {
    expect(
      requestContext({ headers: { 'x-forwarded-for': '203.0.113.9:51234, 10.0.0.1' }, env }).ip,
    ).toBe('203.0.113.9');
    expect(
      requestContext({ headers: { 'x-forwarded-for': '2001:db8::1, 10.0.0.1' }, env }).ip,
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
      ['x-forwarded-for', '203.0.113.9, 10.0.0.1'],
      ['user-agent', 'Fetcher/1'],
    ]);
    const context = requestContext({
      headers: { get: (name) => bag.get(name) ?? null },
      env: { TRUSTED_PROXY_HOPS: '1' } as NodeJS.ProcessEnv,
    });
    expect(context.ip).toBe('203.0.113.9');
    expect(context.userAgent).toBe('Fetcher/1');
  });

  it('joins a repeated header rather than reading only the first', () => {
    const context = requestContext({
      headers: { 'x-forwarded-for': ['203.0.113.9', '10.0.0.1'] },
      env: { TRUSTED_PROXY_HOPS: '1' } as NodeJS.ProcessEnv,
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
