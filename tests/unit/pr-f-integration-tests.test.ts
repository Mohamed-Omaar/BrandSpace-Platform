import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryObjectStore } from '@brandspace/storage';

// `server-only` is a build-time marker with no Node implementation. Mocked by
// the path the admin app resolves it to: the bare id does not resolve from
// `tests/`, so a bare-id mock would not match the admin module's import.
vi.mock('server-only', () => ({}));
vi.mock('../../apps/admin/node_modules/server-only/index.js', () => ({}));

/*
 * THE VAULT, FAKED AT THE ONE SEAM THE TESTER USES. The tester exchanges each
 * saved reference for its value through `getSecretService().resolveSecret`;
 * here that is a map, so the test controls exactly which value the saved
 * reference resolves to and can then look for it everywhere it must not be.
 */
const VAULT: Record<string, string> = {};
vi.mock('../../apps/admin/src/server/platform-context', () => ({
  currentEnvironment: () => 'DEVELOPMENT',
  getSecretService: () => ({
    resolveSecret: async (ref: string) => {
      const value = VAULT[ref];
      if (value === undefined) throw new Error(`no such secret: ${ref}`);
      return value;
    },
  }),
}));
vi.mock('@brandspace/database/platform', () => ({
  getPlatformClient: () => {
    throw new Error('The email and storage tests never touch the platform database.');
  },
}));

const { integrationTester } = await import('../../apps/admin/src/server/integration-tester');
const { runStorageSelfTest, SELF_TEST_PREFIX } =
  await import('../../apps/api/src/routes/internal-storage');

/**
 * PR F — THE CONTROL CENTER'S EMAIL AND STORAGE TESTS, without a network.
 *
 * Readiness could never read "ready" for email or storage, because neither
 * provider had a Test and readiness says "Connected" only after a check
 * passed. These are the two Tests, proven at the tester:
 *
 *   - Resend sends ONE message, to the signed-in requester and nobody else,
 *     with the key the owner saved — and the sentence it returns carries no
 *     credential.
 *   - Cloudflare R2 asks the API (which holds the bucket credential) to run a
 *     write/read/delete round trip, with the service token in a header and
 *     nowhere else.
 */

const FAKE_KEY = 'fixture-not-a-credential-0c9d1e7a55b2f4aa';
const KEY_REF = 'integration/email/resend/development/apiKey';
const FROM = 'no-reply@brandspace.test';
const OWNER = 'owner@brandspace.test';
const SERVICE_TOKEN = 'fixture-service-token-'.padEnd(48, 'x');

type FetchCall = { url: string; init: RequestInit };

function fakeFetch(answer: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return answer(call);
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

function resendInput(settings: Record<string, string> = {}) {
  return {
    category: 'email' as const,
    providerKey: 'resend',
    environment: 'DEVELOPMENT' as const,
    settings: { fromEmail: FROM, fromName: 'Brandspace', ...settings },
    credentialRefs: { apiKey: KEY_REF },
  };
}

function storageInput() {
  return {
    category: 'storage' as const,
    providerKey: 'cloudflare-r2',
    environment: 'DEVELOPMENT' as const,
    settings: {},
    credentialRefs: {},
  };
}

function headerOf(init: RequestInit, name: string): string | undefined {
  const headers = init.headers as Record<string, string> | undefined;
  return headers?.[name];
}

beforeEach(() => {
  VAULT[KEY_REF] = FAKE_KEY;
  // The transport seam must not redirect anything here: the global fetch is
  // the fake, so no request can leave the process.
  vi.stubEnv('BRANDSPACE_RESEND_BASE_URL', '');
  vi.stubEnv('APP_ENV', 'development');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('PR F · the email Test (Resend) sends one message to the signed-in owner', () => {
  it('sends exactly one message, to the requester only, with the saved key', async () => {
    const calls = fakeFetch(() => Response.json({ id: 'msg_fixture' }, { status: 200 }));
    const tester = integrationTester({ requester: { email: OWNER, locale: 'en' } });

    const result = await tester.test(resendInput());

    expect(result.ok).toBe(true);
    expect(result.message).toBe('Sent a test message to your address. Check your inbox.');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.resend.com/emails');

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body['to']).toEqual([OWNER]);
    expect(body['from']).toBe(`Brandspace <${FROM}>`);
    expect(body['subject']).toBe('Brandspace test message');
    expect(String(body['text'])).toContain('test message from the Brandspace Control Center');
    // The SAVED key is the one doing the sending — resolved from the vault.
    expect(headerOf(calls[0]!.init, 'authorization')).toBe(`Bearer ${FAKE_KEY}`);
  });

  it('writes the message in the requester’s language', async () => {
    const calls = fakeFetch(() => Response.json({ id: 'msg_fixture' }, { status: 200 }));
    await integrationTester({ requester: { email: OWNER, locale: 'ar' } }).test(resendInput());
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body['subject']).toBe('رسالة اختبار من Brandspace');
  });

  it('refuses without a requester, and sends nothing', async () => {
    const calls = fakeFetch(() => Response.json({ id: 'never' }, { status: 200 }));

    const result = await integrationTester().test(resendInput());

    expect(result.ok).toBe(false);
    expect(result.message).toContain('no signed-in address');
    expect(calls).toHaveLength(0);
  });

  it('returns no credential, address or settings in its sentence — on success or refusal', async () => {
    fakeFetch(() => Response.json({ id: 'msg_fixture' }, { status: 200 }));
    const passed = await integrationTester({ requester: { email: OWNER, locale: 'en' } }).test(
      resendInput({ replyTo: 'replies@brandspace.test' }),
    );

    // A refusal whose body quotes the key back — Resend echoes requests.
    fakeFetch(() =>
      Response.json(
        { name: 'invalid_api_key', message: `API key ${FAKE_KEY} is invalid for ${OWNER}` },
        { status: 403 },
      ),
    );
    const refused = await integrationTester({ requester: { email: OWNER, locale: 'en' } }).test(
      resendInput(),
    );
    expect(refused.ok).toBe(false);
    expect(refused.message).toBe('Resend refused the test message (HTTP 403, invalid_api_key).');

    for (const result of [passed, refused]) {
      const text = JSON.stringify(result);
      expect(text).not.toContain(FAKE_KEY);
      expect(text).not.toContain(OWNER);
      expect(text).not.toContain(FROM);
      expect(text).not.toContain('replies@brandspace.test');
      expect(text.toLowerCase()).not.toContain('apikey');
    }
  });

  it('turns an unreachable vendor into a fixed sentence', async () => {
    fakeFetch(() => {
      throw Object.assign(new Error('connect ECONNREFUSED'), {
        options: { headers: { authorization: `Bearer ${FAKE_KEY}` } },
      });
    });
    const result = await integrationTester({ requester: { email: OWNER, locale: 'en' } }).test(
      resendInput(),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toBe('Resend could not be reached, so the test message was not sent.');
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
  });
});

describe('PR F · the storage Test (Cloudflare R2) asks the API', () => {
  const API = 'http://api.internal.test:3003';

  beforeEach(() => {
    vi.stubEnv('BRANDSPACE_API_URL', `${API}/`);
    vi.stubEnv('INTERNAL_SERVICE_TOKEN', SERVICE_TOKEN);
  });

  it('posts to the self-test route with the service token, and reports the round trip', async () => {
    const calls = fakeFetch(() => Response.json({ ok: true, latencyMs: 42 }, { status: 200 }));

    const result = await integrationTester().test(storageInput());

    expect(result).toEqual({
      ok: true,
      latencyMs: 42,
      message: 'Wrote, read back and deleted a small test file.',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${API}/v1/internal/storage/self-test`);
    expect(calls[0]?.init.method).toBe('POST');
    expect(headerOf(calls[0]!.init, 'x-brandspace-service-token')).toBe(SERVICE_TOKEN);
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    // Sent in the header — never in what comes back.
    expect(JSON.stringify(result)).not.toContain(SERVICE_TOKEN);
  });

  it.each([
    ['write', 'The test file could not be written.'],
    ['read', 'The test file could not be read back.'],
    ['compare', 'The test file read back did not match what was written.'],
    ['delete', 'The test file could not be deleted.'],
  ] as const)('maps a failure at %s to a sentence', async (step, message) => {
    fakeFetch(() => Response.json({ ok: false, latencyMs: 7, step }, { status: 200 }));
    const result = await integrationTester().test(storageInput());
    expect(result).toEqual({ ok: false, latencyMs: 7, message });
  });

  it('says when the API has no object store at all', async () => {
    fakeFetch(() =>
      Response.json(
        { ok: false, latencyMs: 0, step: 'write', notConfigured: true },
        { status: 200 },
      ),
    );
    const result = await integrationTester().test(storageInput());
    expect(result.ok).toBe(false);
    expect(result.message).toContain('not configured on the API');
  });

  it('passes on nothing the API adds beyond the four known fields', async () => {
    fakeFetch(() =>
      Response.json(
        { ok: false, latencyMs: 5, step: 'read', bucket: 'customer-files', endpoint: 'https://x' },
        { status: 200 },
      ),
    );
    const result = await integrationTester().test(storageInput());
    expect(result.message).toBe('The test file could not be read back.');
    expect(JSON.stringify(result)).not.toContain('customer-files');
  });

  it.each([
    ['BRANDSPACE_API_URL', ''],
    ['INTERNAL_SERVICE_TOKEN', ''],
  ])('refuses without %s, and calls nothing', async (name, value) => {
    vi.stubEnv(name, value);
    const calls = fakeFetch(() => Response.json({ ok: true, latencyMs: 1 }, { status: 200 }));
    const result = await integrationTester().test(storageInput());
    expect(result.ok).toBe(false);
    expect(result.message).toBe('The Control Center cannot reach the API to run the storage test.');
    expect(calls).toHaveLength(0);
  });

  it('treats a refused or unreachable API as a failed test, without the token', async () => {
    fakeFetch(
      () => new Response(JSON.stringify({ error: { code: 'NOT_FOUND' } }), { status: 404 }),
    );
    const refused = await integrationTester().test(storageInput());
    expect(refused.ok).toBe(false);
    expect(refused.message).toBe('The API did not run the storage test (HTTP 404).');

    fakeFetch(() => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    const timedOut = await integrationTester().test(storageInput());
    expect(timedOut.ok).toBe(false);
    expect(timedOut.message).toBe(
      'The Control Center cannot reach the API to run the storage test.',
    );

    for (const result of [refused, timedOut]) {
      expect(JSON.stringify(result)).not.toContain(SERVICE_TOKEN);
    }
  });
});

describe('PR F · the API’s self-test round trip', () => {
  it('writes, reads back, compares and deletes under the reserved prefix', async () => {
    const store = new InMemoryObjectStore();
    const put = vi.spyOn(store, 'put');

    const result = await runStorageSelfTest(store);

    expect(result.ok).toBe(true);
    expect(Object.keys(result).sort()).toEqual(['latencyMs', 'ok']);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]?.[0]).toMatch(new RegExp(`^${SELF_TEST_PREFIX}/[0-9a-f-]{36}\\.bin$`));
    expect(store.size).toBe(0);
  });

  it('names the failing step and still deletes the test object', async () => {
    class UnreadableStore extends InMemoryObjectStore {
      override async get(): Promise<Uint8Array | null> {
        throw new Error('GET https://bucket.example.invalid/secret-bucket failed');
      }
    }
    const store = new UnreadableStore();
    const removed = vi.spyOn(store, 'delete');

    const result = await runStorageSelfTest(store);

    expect(result).toMatchObject({ ok: false, step: 'read' });
    expect(Object.keys(result).sort()).toEqual(['latencyMs', 'ok', 'step']);
    expect(removed).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(0);
    expect(JSON.stringify(result)).not.toContain('secret-bucket');
  });

  it('reports a mismatch as compare', async () => {
    class CorruptingStore extends InMemoryObjectStore {
      override async get(key: string): Promise<Uint8Array | null> {
        const bytes = await super.get(key);
        return bytes ? new Uint8Array(bytes.byteLength) : null;
      }
    }
    const store = new CorruptingStore();
    const result = await runStorageSelfTest(store);
    expect(result).toMatchObject({ ok: false, step: 'compare' });
    expect(store.size).toBe(0);
  });

  it('reports an object that survives its delete as delete', async () => {
    class StickyStore extends InMemoryObjectStore {
      override async delete(): Promise<void> {
        // Accepts the delete and keeps the object.
      }
    }
    const result = await runStorageSelfTest(new StickyStore());
    expect(result).toMatchObject({ ok: false, step: 'delete' });
  });
});
