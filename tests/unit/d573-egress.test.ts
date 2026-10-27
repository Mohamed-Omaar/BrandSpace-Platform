import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EgressRefusedError,
  egressRefusal,
  pinnedHttpsTransport,
  pinnedLookup,
} from '@brandspace/ai-gateway/egress';
import {
  isIpAddressLiteral,
  isPublicIpAddress,
  unsafeHostReason,
  unsafeProviderUrlReason,
} from '@brandspace/shared';

/**
 * D-573 — WHERE THE PLATFORM MAY SEND AN AI PROVIDER'S CREDENTIAL.
 *
 * A provider's base URL is configuration and the request carries the
 * platform's key, so the address is a security boundary: https only, no
 * private, loopback or link-local address, no redirect, the owner's
 * allow-list, and — the part a review cannot see — the socket connects to the
 * address that was checked, with no second DNS answer in between.
 */

describe('D-573 · which addresses are public', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '64:ff9b::10.0.0.1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '100::1',
    'not-an-address',
  ])('%s is refused', (address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '104.18.6.192', '172.32.0.1', '2606:4700::6810:6c0', '::ffff:8.8.8.8'])(
    '%s is allowed',
    (address) => {
      expect(isPublicIpAddress(address)).toBe(true);
    },
  );

  it('recognises an IP literal, bracketed or not', () => {
    expect(isIpAddressLiteral('10.0.0.1')).toBe(true);
    expect(isIpAddressLiteral('[::1]')).toBe(true);
    expect(isIpAddressLiteral('api.provider.com')).toBe(false);
  });
});

describe('D-573 · which provider URLs configuration accepts', () => {
  it.each([
    ['http://api.provider.com/v1', 'https'],
    ['ftp://api.provider.com', 'https'],
    ['https://user:pass@api.provider.com', 'user name'],
    ['https://api.provider.com:8443/v1', 'port'],
    ['https://127.0.0.1/v1', 'IP address'],
    ['https://[::1]/v1', 'IP address'],
    ['https://169.254.169.254/latest', 'IP address'],
    ['https://localhost/v1', 'full host name'],
    ['https://metadata.google.internal/v1', 'private network'],
    ['https://printer.local', 'private network'],
    ['https://router.home.arpa', 'private network'],
    ['not a url', 'valid URL'],
    ['', 'empty'],
  ])('%s is refused (%s)', (url, why) => {
    const reason = unsafeProviderUrlReason(url);
    expect(reason).not.toBeNull();
    expect(reason?.toLowerCase()).toContain(why.toLowerCase());
  });

  it('accepts a public https host on the standard port', () => {
    expect(unsafeProviderUrlReason('https://api.provider.com/v1')).toBeNull();
    expect(unsafeProviderUrlReason('https://api.provider.com:443/v1')).toBeNull();
    expect(unsafeHostReason('api.provider.com')).toBeNull();
  });

  it('a host must be the official one or on the allow-list', () => {
    expect(egressRefusal('https://api.provider.com/v1', ['api.provider.com'])).toBeNull();
    expect(egressRefusal('https://gateway.example.com/v1', ['api.provider.com'])).toContain(
      'allow-list',
    );
    // The allow-list does not bypass the address rules.
    expect(egressRefusal('http://api.provider.com/v1', ['api.provider.com'])).toContain('https');
  });
});

/*
 * A local plain-http server stands in for the provider. The transport is the
 * production one (`pinnedHttpsTransport`) with its one test seam: the request
 * function and port, so pinning, redirects and the allow-list run for real.
 */
let server: Server;
let port = 0;
const seen: { path: string; host: string | undefined }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ path: req.url ?? '', host: req.headers.host });
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const HOST = 'provider.example.com';

/** A resolver an attacker controls: every call may answer differently. */
function scriptedResolver(answers: string[]) {
  let calls = 0;
  const resolve = (
    _hostname: string,
    callback: (
      error: NodeJS.ErrnoException | null,
      addresses: { address: string; family: number }[],
    ) => void,
  ) => {
    const address = answers[Math.min(calls, answers.length - 1)] as string;
    calls += 1;
    callback(null, [{ address, family: address.includes(':') ? 6 : 4 }]);
  };
  return { resolve, calls: () => calls };
}

/** In this test the local server's loopback address plays "the public address". */
const loopbackIsPublic = (address: string) => address === '127.0.0.1';

function transportWith(resolver: ReturnType<typeof scriptedResolver>) {
  return pinnedHttpsTransport([HOST], pinnedLookup(resolver.resolve, loopbackIsPublic), {
    request: httpRequest,
    port,
  });
}

const get = (path: string) => ({
  method: 'GET' as const,
  url: `https://${HOST}${path}`,
  headers: { authorization: 'Bearer sk-test-not-a-real-key-000000' },
  signal: AbortSignal.timeout(5_000),
});

describe('D-573 · the connection goes to the address that was checked', () => {
  it('resolves once per connection and connects to that answer', async () => {
    // The attacker's resolver answers the checked address first and a private
    // one on any later call. The socket must never ask a second time.
    const resolver = scriptedResolver(['127.0.0.1', '10.0.0.1']);
    const before = seen.length;
    const response = await transportWith(resolver)(get('/models'));
    expect(response.status).toBe(200);
    expect(resolver.calls()).toBe(1);
    expect(seen.length).toBe(before + 1);
    expect(seen.at(-1)?.host).toBe(`${HOST}:${port}`);
  });

  it('refuses before connecting when the name resolves to a private address', async () => {
    const resolver = scriptedResolver(['10.0.0.1']);
    const before = seen.length;
    await expect(transportWith(resolver)(get('/models'))).rejects.toBeInstanceOf(
      EgressRefusedError,
    );
    expect(seen.length).toBe(before);
  });

  it('refuses when ANY of the answers is private, not only the first', async () => {
    const resolve = (
      _hostname: string,
      callback: (error: null, addresses: { address: string; family: number }[]) => void,
    ) =>
      callback(null, [
        { address: '127.0.0.1', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ]);
    const transport = pinnedHttpsTransport([HOST], pinnedLookup(resolve, loopbackIsPublic), {
      request: httpRequest,
      port,
    });
    await expect(transport(get('/models'))).rejects.toBeInstanceOf(EgressRefusedError);
  });

  it('the production lookup refuses loopback, so a real resolver cannot reach this machine', async () => {
    const resolver = scriptedResolver(['127.0.0.1']);
    const transport = pinnedHttpsTransport([HOST], pinnedLookup(resolver.resolve), {
      request: httpRequest,
      port,
    });
    await expect(transport(get('/models'))).rejects.toBeInstanceOf(EgressRefusedError);
  });

  it('refuses a redirect instead of following it', async () => {
    const resolver = scriptedResolver(['127.0.0.1']);
    await expect(transportWith(resolver)(get('/redirect'))).rejects.toThrow(/redirect/i);
  });

  it('refuses a host that is not allowed, without resolving it', async () => {
    const resolver = scriptedResolver(['127.0.0.1']);
    const transport = pinnedHttpsTransport(
      ['api.provider.com'],
      pinnedLookup(resolver.resolve, loopbackIsPublic),
      { request: httpRequest, port },
    );
    await expect(transport(get('/models'))).rejects.toBeInstanceOf(EgressRefusedError);
    expect(resolver.calls()).toBe(0);
  });

  it('an already-aborted request never connects', async () => {
    const resolver = scriptedResolver(['127.0.0.1']);
    const controller = new AbortController();
    controller.abort();
    await expect(
      transportWith(resolver)({ ...get('/models'), signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(resolver.calls()).toBe(0);
  });
});
