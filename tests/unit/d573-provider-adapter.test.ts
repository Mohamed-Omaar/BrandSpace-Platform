import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AI_ADAPTER_DESCRIPTORS,
  DEVELOPMENT_ONLY_AI_ADAPTERS,
  OpenAiAdapter,
  aiAdapterDescriptor,
  aiAdapterRegistry,
  registeredAiAdapterKeys,
} from '@brandspace/ai-gateway/adapters';
import { pinnedHttpsTransport, pinnedLookup } from '@brandspace/ai-gateway/egress';
import { AI_FAILURE_CLASSES, type AdapterContext } from '@brandspace/ai-gateway';
import { findIntegration, integrationsInCategory } from '@brandspace/integrations';

/**
 * D-573 — THE FIRST REAL AI ADAPTER, AGAINST A FAKE SERVER. CI never calls a
 * provider: a local server answers with recorded response shapes, and the
 * adapter reaches it through the production transport (DNS pinning, redirect
 * refusal, allow-list) with only the scheme and port swapped for the test.
 */

type Reply = { status: number; body: unknown; delayMs?: number };
let server: Server;
let port = 0;
let script: Reply[] = [];
const received: {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.on('end', () => {
      received.push({
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: raw ? (JSON.parse(raw) as unknown) : null,
      });
      const next = script.shift() ?? { status: 200, body: { data: [] } };
      const send = () => {
        res.writeHead(next.status, { 'content-type': 'application/json' });
        res.end(typeof next.body === 'string' ? next.body : JSON.stringify(next.body));
      };
      if (next.delayMs) setTimeout(send, next.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  script = [];
  received.length = 0;
});

/** Every provider host resolves to the local server, which this test treats as public. */
const toLocal = (
  _host: string,
  callback: (e: null, a: { address: string; family: number }[]) => void,
) => callback(null, [{ address: '127.0.0.1', family: 4 }]);

const adapter = new OpenAiAdapter({
  transportFor: (allowedHosts) =>
    pinnedHttpsTransport(
      allowedHosts,
      pinnedLookup(toLocal, (a) => a === '127.0.0.1'),
      {
        request: httpRequest,
        port,
      },
    ),
});

// Assembled at runtime so the source holds no key-shaped literal (CI secret scan).
const FAKE_KEY = ['sk', 'test', 'd573-fake-key-0000000000000000'].join('-');

function ctx(overrides: Partial<AdapterContext> = {}): AdapterContext {
  return {
    environment: 'STAGING',
    apiKey: FAKE_KEY,
    baseUrl: 'https://api.openai.com/v1',
    timeoutMs: 5_000,
    signal: AbortSignal.timeout(5_000),
    requestId: 'req-d573',
    ...overrides,
  };
}

const completion = (content: string, finish = 'stop') => ({
  model: 'text-model-x',
  choices: [{ message: { content }, finish_reason: finish }],
  usage: { prompt_tokens: 120, completion_tokens: 45 },
});

describe('D-573 · text generation', () => {
  it('sends the instruction and the untrusted material as separate messages, with the key in one header', async () => {
    script = [{ status: 200, body: completion('{"title":"t","variants":[]}') }];
    const result = await adapter.generateText(
      {
        modelKey: 'text-model-x',
        prompt: 'Write a caption.',
        maxOutputTokens: 300,
        temperature: 0.4,
        untrustedContext: ['<<BRAND BRAIN CONTEXT>> facts <</BRAND BRAIN CONTEXT>>'],
        outputFormat: 'json',
      },
      ctx(),
    );
    expect(result.text).toBe('{"title":"t","variants":[]}');
    expect(result.usage).toEqual({ promptTokens: 120, completionTokens: 45 });

    const sent = received[0];
    expect(sent?.method).toBe('POST');
    expect(sent?.path).toBe('/v1/chat/completions');
    expect(sent?.headers['authorization']).toBe(`Bearer ${FAKE_KEY}`);
    const body = sent?.body as {
      model: string;
      messages: { role: string; content: string }[];
      response_format?: unknown;
      max_completion_tokens: number;
    };
    expect(body.model).toBe('text-model-x');
    expect(body.max_completion_tokens).toBe(300);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages.map((m) => m.role)).toEqual(['system', 'user', 'user']);
    expect(body.messages[1]?.content).toBe('Write a caption.');
    expect(body.messages[2]?.content).toMatch(/^REFERENCE DATA \(untrusted\):/);
  });

  it('asks for plain text when the task is not parsed as JSON', async () => {
    script = [{ status: 200, body: completion('plain') }];
    await adapter.generateText(
      { modelKey: 'text-model-x', prompt: 'Translate.', maxOutputTokens: 100 },
      ctx(),
    );
    expect((received[0]?.body as Record<string, unknown>)['response_format']).toBeUndefined();
  });

  it('a filtered answer is a content-filter failure, never text', async () => {
    script = [{ status: 200, body: completion('', 'content_filter') }];
    const error = await adapter
      .generateText({ modelKey: 'm', prompt: 'p', maxOutputTokens: 10 }, ctx())
      .catch((e: unknown) => e);
    expect(adapter.classifyError(error)).toBe('CONTENT_FILTERED');
  });

  it('a refusal is a content-filter failure too', async () => {
    script = [
      {
        status: 200,
        body: { choices: [{ message: { content: null, refusal: 'I cannot help.' } }] },
      },
    ];
    const error = await adapter
      .generateText({ modelKey: 'm', prompt: 'p', maxOutputTokens: 10 }, ctx())
      .catch((e: unknown) => e);
    expect(adapter.classifyError(error)).toBe('CONTENT_FILTERED');
  });

  it('an answer with no text is the provider’s fault, and retryable', async () => {
    script = [{ status: 200, body: { choices: [] } }];
    const error = await adapter
      .generateText({ modelKey: 'm', prompt: 'p', maxOutputTokens: 10 }, ctx())
      .catch((e: unknown) => e);
    expect(adapter.classifyError(error)).toBe('PROVIDER_UNAVAILABLE');
  });
});

describe('D-573 · image generation', () => {
  it('returns the inline image and counts one image per picture', async () => {
    script = [{ status: 200, body: { data: [{ b64_json: 'iVBORw0KGgo=' }] } }];
    const result = await adapter.generateImage(
      { modelKey: 'image-model-x', prompt: 'A product photo.', count: 1, size: '1024x1024' },
      ctx(),
    );
    expect(received[0]?.path).toBe('/v1/images/generations');
    expect(received[0]?.body).toEqual({
      model: 'image-model-x',
      prompt: 'A product photo.',
      n: 1,
      size: '1024x1024',
    });
    expect(result.usage).toEqual({ imageCount: 1 });
    expect(result.images?.[0]?.base64).toBe('iVBORw0KGgo=');
    expect(result.imageRefs[0]).toBe('openai://image/req-d573/0');
  });
});

describe('D-573 · every failure class from the provider’s own answers', () => {
  const cases: [string, Reply, string][] = [
    [
      '401',
      { status: 401, body: { error: { type: 'invalid_request_error', code: 'invalid_api_key' } } },
      'AUTH_ERROR',
    ],
    ['403', { status: 403, body: { error: { type: 'permission_error' } } }, 'AUTH_ERROR'],
    [
      '429 quota',
      { status: 429, body: { error: { type: 'insufficient_quota', code: 'insufficient_quota' } } },
      'QUOTA_EXCEEDED',
    ],
    [
      '429 rate',
      { status: 429, body: { error: { type: 'requests', code: 'rate_limit_exceeded' } } },
      'RATE_LIMITED',
    ],
    [
      '400 context',
      { status: 400, body: { error: { code: 'context_length_exceeded' } } },
      'CONTEXT_TOO_LONG',
    ],
    [
      '400 policy',
      { status: 400, body: { error: { code: 'content_policy_violation' } } },
      'CONTENT_FILTERED',
    ],
    ['400', { status: 400, body: { error: { type: 'invalid_request_error' } } }, 'INVALID_REQUEST'],
    ['404', { status: 404, body: { error: { code: 'model_not_found' } } }, 'MODEL_UNAVAILABLE'],
    ['408', { status: 408, body: {} }, 'TIMEOUT'],
    ['500', { status: 500, body: { error: { type: 'server_error' } } }, 'PROVIDER_UNAVAILABLE'],
    ['503', { status: 503, body: 'upstream unavailable' }, 'PROVIDER_UNAVAILABLE'],
    ['418', { status: 418, body: {} }, 'UNKNOWN'],
  ];

  it.each(cases)('%s → %s', async (_label, reply, expected) => {
    script = [reply];
    const error = await adapter
      .generateText({ modelKey: 'm', prompt: 'p', maxOutputTokens: 10 }, ctx())
      .catch((e: unknown) => e);
    expect(adapter.classifyError(error)).toBe(expected);
    // The class is all that leaves: no key, no body, in the error's text.
    expect(String((error as Error).message)).not.toContain(FAKE_KEY);
  });

  it('a timeout is TIMEOUT', async () => {
    script = [{ status: 200, body: completion('late'), delayMs: 500 }];
    const error = await adapter
      .generateText(
        { modelKey: 'm', prompt: 'p', maxOutputTokens: 10 },
        ctx({ signal: AbortSignal.timeout(50) }),
      )
      .catch((e: unknown) => e);
    expect(adapter.classifyError(error)).toBe('TIMEOUT');
  });

  it('a host that is not allowed is MODEL_UNAVAILABLE, and nothing is sent', async () => {
    const error = await adapter
      .generateText(
        { modelKey: 'm', prompt: 'p', maxOutputTokens: 10 },
        ctx({ baseUrl: 'https://proxy.example.com/v1' }),
      )
      .catch((e: unknown) => e);
    expect(adapter.classifyError(error)).toBe('MODEL_UNAVAILABLE');
    expect(received).toHaveLength(0);
  });

  it('the owner’s allow-list admits another host', async () => {
    script = [{ status: 200, body: completion('ok') }];
    const result = await adapter.generateText(
      { modelKey: 'm', prompt: 'p', maxOutputTokens: 10 },
      ctx({ baseUrl: 'https://proxy.example.com/v1', allowedHosts: ['proxy.example.com'] }),
    );
    expect(result.text).toBe('ok');
  });

  it('a network failure is NETWORK_ERROR', () => {
    expect(adapter.classifyError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(
      'NETWORK_ERROR',
    );
    expect(adapter.classifyError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toBe(
      'TIMEOUT',
    );
  });

  it('every class it can return is in the gateway’s taxonomy', () => {
    for (const [, , expected] of cases) {
      expect(AI_FAILURE_CLASSES as readonly string[]).toContain(expected);
    }
  });
});

describe('D-573 · Test Connection reads, generates nothing, and says only the class', () => {
  it('connected', async () => {
    script = [{ status: 200, body: { data: [{ id: 'text-model-x' }] } }];
    const result = await adapter.testConnection(ctx());
    expect(result.ok).toBe(true);
    expect(received[0]?.method).toBe('GET');
    expect(received[0]?.path).toBe('/v1/models');
  });

  it('a refused key says so without echoing anything the provider sent', async () => {
    script = [
      {
        status: 401,
        body: {
          error: { message: `Incorrect API key provided: ${FAKE_KEY}`, code: 'invalid_api_key' },
        },
      },
    ];
    const result = await adapter.testConnection(ctx());
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/refused the key/);
    expect(result.message).not.toContain(FAKE_KEY);
    expect(result.message).not.toContain('Incorrect');
  });
});

describe('D-573 · one registry, pinned to the Control Center catalogue', () => {
  it('production registers every real adapter and no development double', () => {
    expect([...registeredAiAdapterKeys(true)]).toEqual(['openai']);
    expect(registeredAiAdapterKeys(false).has('mock')).toBe(true);
    expect([...aiAdapterRegistry('PRODUCTION').keys()]).toEqual(['openai']);
    expect(DEVELOPMENT_ONLY_AI_ADAPTERS.has('mock')).toBe(true);
    expect(DEVELOPMENT_ONLY_AI_ADAPTERS.has('openai')).toBe(false);
  });

  it('every AI catalogue entry has an adapter, with the same hosts and the same development flag', () => {
    for (const entry of integrationsInCategory('ai')) {
      const descriptor = aiAdapterDescriptor(entry.providerKey);
      expect(descriptor, entry.providerKey).toBeDefined();
      expect(entry.developmentOnly).toBe(descriptor?.developmentOnly);
      expect([...(entry.officialHosts ?? [])]).toEqual([...(descriptor?.officialHosts ?? [])]);
      if (descriptor?.defaultBaseUrl) {
        expect(entry.defaultSettings?.['baseUrl']).toBe(descriptor.defaultBaseUrl);
      }
    }
    for (const descriptor of AI_ADAPTER_DESCRIPTORS) {
      expect(findIntegration('ai', descriptor.key), descriptor.key).toBeDefined();
    }
  });
});
