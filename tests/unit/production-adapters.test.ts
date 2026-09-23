import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ResendEmailProvider,
  UnconfiguredEmailProvider,
  createEmailProvider,
  renderEmail,
  type EmailMessageInput,
} from '@brandspace/auth';
import {
  InMemoryObjectStore,
  S3ObjectStore,
  createObjectStore,
  readS3Configuration,
} from '@brandspace/storage';
import { activeProviderSelection, findIntegration } from '@brandspace/integrations';

/**
 * The two production adapters, and the guarantees that must not erode.
 *
 * WHAT THIS FILE IS FOR. Both adapters exist to be configured by an owner and
 * then never thought about again, which is exactly the condition under which a
 * silent fallback goes unnoticed for months. Every test below is about a way
 * the platform could quietly do the wrong thing rather than fail.
 *
 * NO REAL CREDENTIAL AND NO NETWORK. Every value here is invented in this file,
 * every transport is a fake, and nothing resolves a hostname.
 */

/** A credential-shaped value that is visibly not one. Never a real key. */
const FAKE_RESEND_KEY = 'test-only-resend-key-abcdefghijklmnop';
const FAKE_ACCESS_KEY = 'test-only-access-key-id';
const FAKE_SECRET_KEY = 'test-only-secret-access-key';

function message(overrides: Partial<EmailMessageInput> = {}): EmailMessageInput {
  return {
    to: 'Person@Example.com',
    templateKey: 'auth.email_verification',
    locale: 'EN',
    link: 'https://app.example.com/en/verify?token=abc',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Object storage
// ---------------------------------------------------------------------------

describe('production object storage never falls back to local disk', () => {
  it('refuses in production when the S3 configuration is incomplete, naming what is missing', () => {
    expect(() =>
      createObjectStore({
        appEnv: 'production',
        env: { STORAGE_ENDPOINT: 'https://example.invalid', STORAGE_BUCKET: 'media' },
      }),
    ).toThrow(/STORAGE_ACCESS_KEY_ID/);
  });

  it('refuses in production when nothing at all is configured', () => {
    expect(() => createObjectStore({ appEnv: 'production', env: {} })).toThrow(
      /never falls back to local disk/i,
    );
  });

  it('returns an S3 store in production when the configuration is complete', () => {
    const store = createObjectStore({
      appEnv: 'production',
      env: {
        STORAGE_ENDPOINT: 'https://account.r2.example.invalid',
        STORAGE_BUCKET: 'brandspace-media',
        STORAGE_ACCESS_KEY_ID: FAKE_ACCESS_KEY,
        STORAGE_SECRET_ACCESS_KEY: FAKE_SECRET_KEY,
      },
    });
    expect(store).toBeInstanceOf(S3ObjectStore);
  });

  it('uses S3 outside production too, so staging exercises the adapter production will use', () => {
    const store = createObjectStore({
      appEnv: 'staging',
      env: {
        STORAGE_ENDPOINT: 'https://account.r2.example.invalid',
        STORAGE_BUCKET: 'brandspace-media-staging',
        STORAGE_ACCESS_KEY_ID: FAKE_ACCESS_KEY,
        STORAGE_SECRET_ACCESS_KEY: FAKE_SECRET_KEY,
      },
    });
    expect(store).toBeInstanceOf(S3ObjectStore);
  });

  it('keeps the development filesystem store when no S3 configuration exists', () => {
    const store = createObjectStore({ appEnv: 'development', env: {}, directory: '/tmp/x' });
    expect(store).not.toBeInstanceOf(S3ObjectStore);
  });

  it('an injected store still wins, so tests are not forced to configure S3', () => {
    const injected = new InMemoryObjectStore();
    expect(createObjectStore({ appEnv: 'production', store: injected, env: {} })).toBe(injected);
  });

  it('defaults the region to `auto`, which is what R2 requires', () => {
    const read = readS3Configuration({
      STORAGE_ENDPOINT: 'https://account.r2.example.invalid',
      STORAGE_BUCKET: 'b',
      STORAGE_ACCESS_KEY_ID: FAKE_ACCESS_KEY,
      STORAGE_SECRET_ACCESS_KEY: FAKE_SECRET_KEY,
    });
    expect(read.ok && read.config.region).toBe('auto');
  });

  it('turns path-style addressing on only for the exact string `true`', () => {
    const base = {
      STORAGE_ENDPOINT: 'https://account.r2.example.invalid',
      STORAGE_BUCKET: 'b',
      STORAGE_ACCESS_KEY_ID: FAKE_ACCESS_KEY,
      STORAGE_SECRET_ACCESS_KEY: FAKE_SECRET_KEY,
    };
    for (const value of ['1', 'yes', 'TRUE ', '', 'false']) {
      const read = readS3Configuration({ ...base, STORAGE_FORCE_PATH_STYLE: value });
      // `TRUE ` trims and lowercases to `true`; the rest must not enable it.
      const expected = value.trim().toLowerCase() === 'true';
      expect(read.ok && read.config.forcePathStyle, value).toBe(expected);
    }
  });
});

describe('the S3 store speaks the ObjectStore contract, not S3 dialect', () => {
  /** A minimal fake S3 client: records commands, answers from a map. */
  function fakeClient(objects = new Map<string, Uint8Array>()) {
    const sent: string[] = [];
    return {
      objects,
      sent,
      client: {
        send: vi.fn(
          async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
            const name = command.constructor.name;
            sent.push(name);
            const key = String(command.input['Key'] ?? '');
            if (name === 'PutObjectCommand') {
              objects.set(key, command.input['Body'] as Uint8Array);
              return {};
            }
            if (name === 'GetObjectCommand') {
              const bytes = objects.get(key);
              if (!bytes) {
                const error = Object.assign(new Error('missing'), { name: 'NoSuchKey' });
                throw error;
              }
              return { Body: { transformToByteArray: async () => bytes } };
            }
            if (name === 'DeleteObjectCommand') {
              objects.delete(key);
              return {};
            }
            return {};
          },
        ),
      },
    };
  }

  function storeWith(fake: ReturnType<typeof fakeClient>) {
    return new S3ObjectStore({
      endpoint: 'https://account.r2.example.invalid',
      region: 'auto',
      bucket: 'brandspace-media',
      accessKeyId: FAKE_ACCESS_KEY,
      secretAccessKey: FAKE_SECRET_KEY,
      client: fake.client as never,
    });
  }

  it('round-trips exact bytes under the exact key', async () => {
    const fake = fakeClient();
    const store = storeWith(fake);
    const bytes = new Uint8Array([1, 2, 3, 250, 0, 99]);

    const stored = await store.put('ws/a/brand/b/object-1', bytes, 'application/octet-stream');
    expect(stored.storageKey).toBe('ws/a/brand/b/object-1');
    expect(stored.byteSize).toBe(6);

    const read = await store.get('ws/a/brand/b/object-1');
    expect(read && Array.from(read)).toEqual([1, 2, 3, 250, 0, 99]);
  });

  it('computes its own SHA-256 rather than trusting an ETag', async () => {
    const fake = fakeClient();
    const store = storeWith(fake);
    const stored = await store.put('ws/a/o', new Uint8Array([]), 'text/plain');
    // SHA-256 of the empty input. An ETag would be an MD5, or a digest-of-digests.
    expect(stored.checksum).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('returns null for a genuine miss', async () => {
    const store = storeWith(fakeClient());
    expect(await store.get('ws/a/absent')).toBeNull();
  });

  it('PROPAGATES an authentication failure instead of reporting it as a miss', async () => {
    /*
     * THE MOST IMPORTANT TEST IN THIS FILE. If a 403 or a network failure
     * returned null, an expired credential would look exactly like a deleted
     * object — and the ingestion pipeline would mark a customer's document
     * permanently missing because a key rotated.
     */
    const denied = {
      send: vi.fn(async () => {
        throw Object.assign(new Error('denied'), {
          name: 'AccessDenied',
          $metadata: { httpStatusCode: 403 },
        });
      }),
    };
    const store = new S3ObjectStore({
      endpoint: 'https://account.r2.example.invalid',
      region: 'auto',
      bucket: 'b',
      accessKeyId: FAKE_ACCESS_KEY,
      secretAccessKey: FAKE_SECRET_KEY,
      client: denied as never,
    });
    await expect(store.get('ws/a/o')).rejects.toThrow(/denied/);
  });

  it('deletes idempotently', async () => {
    const store = storeWith(fakeClient());
    await expect(store.delete('ws/a/never-existed')).resolves.toBeUndefined();
  });

  it('refuses an unsafe key on every operation, exactly as the filesystem store does', async () => {
    const store = storeWith(fakeClient());
    for (const key of ['ws/../../etc/passwd', 'ws/a/..', 'ws//a']) {
      await expect(store.put(key, new Uint8Array([1]), 'text/plain')).rejects.toThrow(/unsafe/i);
      await expect(store.get(key)).rejects.toThrow(/unsafe/i);
      await expect(store.delete(key)).rejects.toThrow(/unsafe/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

describe('Resend is an EmailProvider and nothing above it knows the vendor', () => {
  /** Captures the request without performing one. */
  function capture(status = 200, body: unknown = { id: 'msg_test_1' }) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchLike = async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    };
    return { calls, fetchLike };
  }

  it('sends the rendered message and returns the provider message id', async () => {
    const { calls, fetchLike } = capture();
    const provider = new ResendEmailProvider({
      apiKey: FAKE_RESEND_KEY,
      fromEmail: 'hello@example.com',
      fromName: 'BrandSpace',
      baseUrl: 'https://resend.example.invalid',
      fetch: fetchLike,
    });

    const result = await provider.send(message());
    expect(result.messageId).toBe('msg_test_1');
    expect(calls).toHaveLength(1);

    const sent = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(sent['from']).toBe('BrandSpace <hello@example.com>');
    // Normalised, exactly as the outbox normalises it.
    expect(sent['to']).toEqual(['person@example.com']);
    expect(String(sent['subject']).length).toBeGreaterThan(0);
    expect(String(sent['text'])).toContain('https://app.example.com/en/verify?token=abc');
  });

  it('never puts the API key anywhere but the Authorization header', async () => {
    const { calls, fetchLike } = capture();
    const provider = new ResendEmailProvider({
      apiKey: FAKE_RESEND_KEY,
      fromEmail: 'hello@example.com',
      baseUrl: 'https://resend.example.invalid',
      fetch: fetchLike,
    });
    await provider.send(message());

    const call = calls[0];
    expect(call?.url).not.toContain(FAKE_RESEND_KEY);
    expect(String(call?.init.body)).not.toContain(FAKE_RESEND_KEY);
    expect((call?.init.headers as Record<string, string>)['authorization']).toBe(
      `Bearer ${FAKE_RESEND_KEY}`,
    );
  });

  it('never leaks the key or the recipient through a provider error', async () => {
    /*
     * THIS IS THE SHAPE A REAL REFUSAL TAKES. Resend explains itself by quoting
     * the request, so its `message` names the recipient — and anything else the
     * request carried. The fixture puts the credential in there too, which is
     * the worst case rather than the likely one, because the assertion below is
     * about what the adapter is ALLOWED to forward, not about what Resend
     * happens to say today.
     */
    const { fetchLike } = capture(422, {
      name: 'validation_error',
      message: `Domain not verified for ${FAKE_RESEND_KEY} sending to person@example.com`,
    });
    const provider = new ResendEmailProvider({
      apiKey: FAKE_RESEND_KEY,
      fromEmail: 'hello@example.com',
      baseUrl: 'https://resend.example.invalid',
      fetch: fetchLike,
    });

    const error = await provider.send(message()).catch((thrown: unknown) => thrown);
    const text = String(error);

    // Diagnosable: the operator gets the status and the vendor's machine code.
    expect(text).toContain('422');
    expect(text).toContain('validation_error');
    // And nothing the request carried.
    expect(text).not.toContain(FAKE_RESEND_KEY);
    expect(text).not.toContain('person@example.com');
    expect(text).not.toContain('Domain not verified');
  });

  it('drops a provider code that is not code-shaped', async () => {
    /*
     * The guard is not decoration. If the vendor ever puts prose — or a
     * recipient — in the field the adapter reads, the shape check is what stops
     * it, and the caller still learns the status.
     */
    const { fetchLike } = capture(500, { name: 'failed to send to person@example.com' });
    const provider = new ResendEmailProvider({
      apiKey: FAKE_RESEND_KEY,
      fromEmail: 'hello@example.com',
      baseUrl: 'https://resend.example.invalid',
      fetch: fetchLike,
    });

    const error = await provider.send(message()).catch((thrown: unknown) => thrown);
    expect(String(error)).toContain('500');
    expect(String(error)).not.toContain('person@example.com');
  });

  it('drops the cause of a transport failure, which can carry the Authorization header', async () => {
    const provider = new ResendEmailProvider({
      apiKey: FAKE_RESEND_KEY,
      fromEmail: 'hello@example.com',
      baseUrl: 'https://resend.example.invalid',
      fetch: async () => {
        throw Object.assign(new Error('connect ECONNREFUSED'), {
          options: { headers: { authorization: `Bearer ${FAKE_RESEND_KEY}` } },
        });
      },
    });
    const error = await provider.send(message()).catch((e: unknown) => e);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(FAKE_RESEND_KEY);
  });

  it('exposes nothing a send-only key cannot do', () => {
    /*
     * THE ADAPTER'S SURFACE MATCHES THE CREDENTIAL'S.
     *
     * There was briefly a `verifyCredential()` here, issuing `GET /domains` for
     * a Test Connection button. The credential BrandSpace asks for is a Resend
     * SENDING-ACCESS key restricted to the verified domain — the least
     * privilege that can do the job — and such a key is refused every read
     * Resend offers. The check would have reported a correctly-scoped
     * production key as broken, and its presence would have pressured somebody
     * into widening the key to make a tick go green.
     *
     * This asserts the absence rather than trusting it: a re-added read method
     * is a re-added reason to ask for a Full Access key.
     */
    const provider = new ResendEmailProvider({
      apiKey: FAKE_RESEND_KEY,
      fromEmail: 'hello@example.com',
      baseUrl: 'https://resend.example.invalid',
      fetch: async () => new Response('{}', { status: 200 }),
    });

    expect((provider as unknown as Record<string, unknown>)['verifyCredential']).toBeUndefined();
    // What it DOES have, so the assertion above cannot pass by the object being
    // empty or the wrong shape.
    expect(typeof provider.send).toBe('function');
    expect(provider.key).toBe('resend');
  });

  it('refuses to construct without a key or a From address', () => {
    expect(() => new ResendEmailProvider({ apiKey: '  ', fromEmail: 'a@b.com' })).toThrow();
    expect(() => new ResendEmailProvider({ apiKey: FAKE_RESEND_KEY, fromEmail: ' ' })).toThrow();
  });
});

describe('every declared template renders in both languages', () => {
  const keys = [
    'auth.email_verification',
    'auth.signup.exists',
    'auth.password_reset',
    'auth.password_reset.unknown',
    'workspace.invitation',
    'workspace.invitation.resent',
    'workspace.suspended',
  ] as const;

  it('produces a subject and a body for each, in AR and EN', () => {
    for (const templateKey of keys) {
      for (const locale of ['AR', 'EN'] as const) {
        const rendered = renderEmail(message({ templateKey, locale }));
        expect(rendered.subject.length, `${templateKey}/${locale}`).toBeGreaterThan(0);
        expect(rendered.text.length, `${templateKey}/${locale}`).toBeGreaterThan(0);
        expect(rendered.html, `${templateKey}/${locale}`).toContain(
          locale === 'AR' ? 'dir="rtl"' : 'dir="ltr"',
        );
      }
    }
  });

  it('escapes the link rather than interpolating it raw', () => {
    const rendered = renderEmail(
      message({ link: 'https://app.example.com/?a=1&b="><script>alert(1)</script>' }),
    );
    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).toContain('&amp;');
  });


  it('matches the BrandSpace protected-preview shell without tracking pixels', () => {
    const rendered = renderEmail(message());
    expect(rendered.html).toContain('BrandSpace');
    expect(rendered.html).toContain('https://www.brandspace.cc/brandspace-logo.svg');
    expect(rendered.html).toContain('SECURE EMAIL');
    expect(rendered.html).toContain('#7935FE');
    expect(rendered.html).toContain('#FFDD15');
    expect(rendered.html).toContain('#111114');
    expect(rendered.html).toContain('background-image:radial-gradient');
    expect(rendered.html).toContain('role="presentation"');
    expect(rendered.html).toContain('background-color:#111114');
    expect(rendered.html).not.toMatch(/tracking[_-]?pixel/i);
  });

  it('keeps the action prominent and the raw URL available as a fallback', () => {
    const link = 'https://app.example.com/en/verify?token=abc';
    const rendered = renderEmail(message({ link }));
    expect(rendered.html).toContain('Confirm my email address');
    expect(rendered.html).toContain(link);
    expect(rendered.text).toContain(link);
  });

  it('gives the two signup templates the same subject, so neither reveals which was sent', () => {
    const free = renderEmail(message({ templateKey: 'auth.email_verification' }));
    const taken = renderEmail(message({ templateKey: 'auth.signup.exists' }));
    expect(taken.subject).toBe(free.subject);
  });
});

describe('the active provider is read from configuration, never guessed', () => {
  const activeResend = {
    activeProviderKey: 'resend',
    providers: [
      {
        key: 'resend',
        name: 'Resend',
        status: 'active',
        settings: { fromEmail: 'hello@example.com', fromName: 'BrandSpace' },
        secretRefs: { apiKey: 'integration/email_provider/resend/production/apiKey' },
      },
    ],
  };

  it('returns the reference, never a value', () => {
    const selection = activeProviderSelection('email', 'PRODUCTION', activeResend);
    expect(selection?.providerKey).toBe('resend');
    expect(selection?.secretRefs['apiKey']).toBe(
      'integration/email_provider/resend/production/apiKey',
    );
    // Settings are configuration. Credentials are references. Nothing here is a
    // credential value, and there is no field that could hold one.
    expect(JSON.stringify(selection)).not.toMatch(/re_[A-Za-z0-9]/);
  });

  it('ignores a provider that is pointed at but not active', () => {
    const disabled = {
      ...activeResend,
      providers: [{ ...activeResend.providers[0], status: 'disabled' }],
    };
    expect(activeProviderSelection('email', 'PRODUCTION', disabled)).toBeNull();
  });

  it('returns null when nothing is activated', () => {
    expect(activeProviderSelection('email', 'PRODUCTION', { activeProviderKey: null })).toBeNull();
    expect(activeProviderSelection('email', 'PRODUCTION', {})).toBeNull();
  });

  it('REFUSES a development double named as active in production', () => {
    /*
     * Documents get restored, copied between environments and edited. The
     * activation path already refuses this; so does the point of use, because
     * the two are different moments and only one of them is happening when a
     * customer is waiting for a verification link.
     */
    const outboxInProduction = {
      activeProviderKey: 'outbox',
      providers: [
        { key: 'outbox', name: 'Outbox', status: 'active', settings: {}, secretRefs: {} },
      ],
    };
    expect(() => activeProviderSelection('email', 'PRODUCTION', outboxInProduction)).toThrow(
      /development-only/i,
    );
    // The same document is fine in development, which is what it is for.
    expect(activeProviderSelection('email', 'DEVELOPMENT', outboxInProduction)?.providerKey).toBe(
      'outbox',
    );
  });

  it('refuses a provider the registry has never heard of', () => {
    const unknown = {
      activeProviderKey: 'sendgrid',
      providers: [{ key: 'sendgrid', name: 'x', status: 'active', settings: {}, secretRefs: {} }],
    };
    expect(() => activeProviderSelection('email', 'PRODUCTION', unknown)).toThrow(/no adapter/i);
  });
});

describe('the registry describes the two real providers honestly', () => {
  it('registers Resend for production, with a write-only key and no invented settings', () => {
    const resend = findIntegration('email', 'resend');
    expect(resend?.developmentOnly).toBe(false);
    expect(resend?.supportedEnvironments).toContain('PRODUCTION');
    expect(resend?.credentialFields.map((f) => f.key)).toEqual(['apiKey']);
    expect(resend?.credentialFields.every((f) => f.secret)).toBe(true);
    expect(resend?.settingFields.map((f) => f.key)).toEqual(['fromEmail', 'fromName', 'replyTo']);
    expect(resend?.settingFields.every((f) => !f.secret)).toBe(true);

    /*
     * NOT TESTABLE FROM THE HUB, and the registry is where that is decided.
     *
     * The recommended production credential is a Sending-access key restricted
     * to the verified domain. Every non-destructive check Resend offers is a
     * read, and a send-only key is refused all of them — so a Test Connection
     * button could only report a working key as broken, demand a wider key, or
     * send an unsolicited probe message. The note has to SAY so, or an owner
     * meets a missing button with no explanation.
     */
    expect(resend?.testable).toBe(false);
    expect(resend?.adapterAvailable).toBe(true);
    expect(resend?.credentialFields[0]?.helpEn).toContain('SENDING ACCESS ONLY');
    expect(resend?.noteEn).toContain('no Test connection button');
    expect(resend?.noteEn).toContain('Sending access');
    expect(resend?.noteAr).toContain('Resend');
  });

  it('registers Cloudflare R2 for production with NO second configuration store', () => {
    /*
     * THE DEFECT THIS PINS DOWN. The object store reads `STORAGE_*` from the
     * environment and reads nothing else. An earlier draft of this pass also
     * gave R2 an endpoint, a bucket and two key fields in the Hub — a form that
     * saved successfully, wrote a real secret into the vault, and changed
     * nothing whatsoever about where the running processes put bytes.
     *
     * An ignored configuration screen is not a harmless extra: an owner who
     * rotates a key there believes they have rotated it. So the entry exists,
     * describes itself, and offers nothing to fill in.
     */
    const r2 = findIntegration('storage', 'cloudflare-r2');
    expect(r2?.developmentOnly).toBe(false);
    expect(r2?.supportedEnvironments).toContain('PRODUCTION');
    expect(r2?.adapterAvailable).toBe(true);
    expect(r2?.credentialFields).toEqual([]);
    expect(r2?.settingFields).toEqual([]);
    // And no green tick from a surface that does not hold a bucket credential.
    expect(r2?.testable).toBe(false);
    // The note has to SAY where it is configured, or the empty screen is a bug.
    expect(r2?.noteEn).toContain('STORAGE_*');
    expect(r2?.noteAr).toContain('STORAGE_*');
  });

  it('leaves the development doubles development-only', () => {
    expect(findIntegration('email', 'outbox')?.developmentOnly).toBe(true);
    expect(findIntegration('storage', 'filesystem')?.developmentOnly).toBe(true);
  });

  it('names no AI, social or payment vendor', () => {
    /*
     * This pass activated storage and email and NOTHING else. The three
     * remaining categories must still be doubles, and no vendor of theirs may
     * appear in the registry.
     */
    for (const category of ['ai', 'social', 'payment'] as const) {
      for (const vendor of ['openai', 'anthropic', 'meta', 'tiktok', 'stripe', 'moyasar']) {
        expect(findIntegration(category, vendor), `${category}/${vendor}`).toBeUndefined();
      }
    }
  });
});

describe('production email cannot be the outbox', () => {
  it('createEmailProvider refuses the outbox in production rather than pretending', () => {
    vi.stubEnv('APP_ENV', 'production');
    try {
      const provider = createEmailProvider(null as never, 'outbox');
      expect(provider).toBeInstanceOf(UnconfiguredEmailProvider);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('the unconfigured provider throws rather than reporting a message as sent', async () => {
    await expect(new UnconfiguredEmailProvider('none').send(message())).rejects.toThrow(
      /nothing was sent/i,
    );
  });
});

/*
 * `import 'server-only'` is a Next.js build-time marker with no runtime
 * behaviour and no resolution outside a Next build. Stubbing it lets this suite
 * import the module under test; `tests/unit/phase2b-boundaries.test.ts` is what
 * asserts the marker is actually present, so nothing here weakens that.
 */
vi.mock('server-only', () => ({}));

describe('links that are read outside the product are absolute', () => {
  /*
   * THE DEFECT THIS PINS DOWN, found by the end-to-end suite the first time it
   * asserted on what was SENT rather than on what was recorded.
   *
   * Every link the dashboard put in an email was a PATH — `/en/verify?token=…`.
   * That was invisible while the only provider was the outbox: the message went
   * to a table and a developer read it in a browser already on the dashboard's
   * origin. In a real inbox the reader is on somebody else's origin, the link
   * resolves to nothing, and a customer who cannot click a verification link
   * cannot finish signing up — with nothing anywhere saying why.
   */
  const ORIGINAL = process.env['PUBLIC_DASHBOARD_BASE_URL'];
  const ORIGINAL_ENV = process.env['APP_ENV'];

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env['PUBLIC_DASHBOARD_BASE_URL'];
    else process.env['PUBLIC_DASHBOARD_BASE_URL'] = ORIGINAL;
    if (ORIGINAL_ENV === undefined) delete process.env['APP_ENV'];
    else process.env['APP_ENV'] = ORIGINAL_ENV;
  });

  it('prefixes the configured origin', async () => {
    process.env['PUBLIC_DASHBOARD_BASE_URL'] = 'https://app.example.test';
    process.env['APP_ENV'] = 'development';
    const { customerLink } = await import('../../apps/dashboard/src/server/email-links');
    expect(customerLink('/en/verify?token=abc')).toBe(
      'https://app.example.test/en/verify?token=abc',
    );
  });

  it('does not double the slash when the origin carries a trailing one', async () => {
    process.env['PUBLIC_DASHBOARD_BASE_URL'] = 'https://app.example.test/';
    process.env['APP_ENV'] = 'development';
    const { customerLink } = await import('../../apps/dashboard/src/server/email-links');
    expect(customerLink('/ar/reset/xyz')).toBe('https://app.example.test/ar/reset/xyz');
  });

  it('keeps the bare path in development, where the outbox is read on this origin', async () => {
    delete process.env['PUBLIC_DASHBOARD_BASE_URL'];
    process.env['APP_ENV'] = 'development';
    const { customerLink } = await import('../../apps/dashboard/src/server/email-links');
    expect(customerLink('/en/verify?token=abc')).toBe('/en/verify?token=abc');
  });

  it('REFUSES in production rather than guessing an origin', async () => {
    /*
     * Guessing `localhost`, or reading a host header, would produce a link that
     * works on the machine that generated it and points at an attacker's host
     * the day a header is trusted. It names the variable instead.
     */
    delete process.env['PUBLIC_DASHBOARD_BASE_URL'];
    process.env['APP_ENV'] = 'production';
    const { customerLink } = await import('../../apps/dashboard/src/server/email-links');
    expect(() => customerLink('/en/verify?token=abc')).toThrow(/PUBLIC_DASHBOARD_BASE_URL/);
  });
});
