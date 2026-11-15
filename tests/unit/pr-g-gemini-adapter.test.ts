import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  GeminiAdapter,
  aiAdapterDescriptor,
  geminiImageConfig,
} from '@brandspace/ai-gateway/adapters';
import { pinnedHttpsTransport, pinnedLookup } from '@brandspace/ai-gateway/egress';
import type { AdapterContext } from '@brandspace/ai-gateway';
import { findIntegration } from '@brandspace/integrations';

/**
 * PR G (D-611) — GOOGLE'S IMAGE MODELS, AGAINST A FAKE SERVER. CI never calls
 * Google: a local server answers with the documented response shapes, reached
 * through the production transport (DNS pinning, redirect refusal, allow-list)
 * with only the scheme and port swapped for the test.
 */

type Reply = { status: number; body: unknown };
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
      const next = script.shift() ?? { status: 200, body: { models: [] } };
      res.writeHead(next.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(next.body));
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

const toLocal = (
  _host: string,
  callback: (e: null, a: { address: string; family: number }[]) => void,
) => callback(null, [{ address: '127.0.0.1', family: 4 }]);

const adapter = new GeminiAdapter({
  transportFor: (allowedHosts) =>
    pinnedHttpsTransport(
      allowedHosts,
      pinnedLookup(toLocal, (a) => a === '127.0.0.1'),
      { request: httpRequest, port },
    ),
});

// Assembled at runtime so the source holds no key-shaped literal (CI secret scan).
const FAKE_KEY = ['AIza', 'pr-g-fake-key-00000000000000000'].join('');

function ctx(overrides: Partial<AdapterContext> = {}): AdapterContext {
  return {
    environment: 'STAGING',
    apiKey: FAKE_KEY,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    timeoutMs: 5_000,
    signal: AbortSignal.timeout(5_000),
    requestId: 'req-pr-g',
    ...overrides,
  };
}

const PNG_B64 = Buffer.from('fake-png-bytes').toString('base64');
const imageAnswer = (extra: Record<string, unknown> = {}) => ({
  candidates: [
    {
      finishReason: 'STOP',
      content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }] },
    },
  ],
  usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 1290, thoughtsTokenCount: 300 },
  ...extra,
});

describe('PR G · Google image generation', () => {
  it('posts generateContent with the key in one header, IMAGE only, and the size as ratio + class', async () => {
    script = [{ status: 200, body: imageAnswer() }];
    const result = await adapter.generateImage(
      { modelKey: 'gemini-image-model', prompt: 'A cup of coffee', count: 1, size: '1080x1350' },
      ctx(),
    );
    expect(received).toHaveLength(1);
    const call = received[0]!;
    expect(call.method).toBe('POST');
    expect(call.path).toBe('/v1beta/models/gemini-image-model:generateContent');
    expect(call.headers['x-goog-api-key']).toBe(FAKE_KEY);
    expect(call.headers['authorization']).toBeUndefined();
    expect(call.body).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'A cup of coffee' }] }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig: { aspectRatio: '4:5', imageSize: '2K' },
      },
    });
    expect(result.images?.[0]).toMatchObject({ base64: PNG_B64, mimeType: 'image/png' });
    // Thinking is billed as output, so it is counted with the image tokens.
    expect(result.usage).toEqual({ imageCount: 1, promptTokens: 20, completionTokens: 1590 });
    expect(result.imageRefs).toEqual(['gemini://image/req-pr-g/0']);
  });

  it('asks once per image', async () => {
    script = [
      { status: 200, body: imageAnswer() },
      { status: 200, body: imageAnswer() },
    ];
    const result = await adapter.generateImage(
      { modelKey: 'm', prompt: 'p', count: 2, size: '1024x1024' },
      ctx(),
    );
    expect(received).toHaveLength(2);
    expect(result.usage.imageCount).toBe(2);
  });

  it('a withheld image is CONTENT_FILTERED; a length stop is OUTPUT_TRUNCATED; no image is a provider fault', async () => {
    const cases: [unknown, string][] = [
      [
        { candidates: [{ finishReason: 'IMAGE_SAFETY', content: { parts: [] } }] },
        'CONTENT_FILTERED',
      ],
      [{ promptFeedback: { blockReason: 'SAFETY' } }, 'CONTENT_FILTERED'],
      [
        { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] },
        'OUTPUT_TRUNCATED',
      ],
      [
        { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'no' }] } }] },
        'PROVIDER_UNAVAILABLE',
      ],
    ];
    for (const [body, failure] of cases) {
      script = [{ status: 200, body }];
      const error = await adapter
        .generateImage({ modelKey: 'm', prompt: 'p', count: 1, size: '1024x1024' }, ctx())
        .catch((e: unknown) => e);
      expect(adapter.classifyError(error), JSON.stringify(body)).toBe(failure);
    }
  });

  it('classifies Google errors, and never carries the key or the message into the error text', async () => {
    const cases: [number, string, string, string][] = [
      [400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.', 'AUTH_ERROR'],
      [400, 'INVALID_ARGUMENT', 'Unsupported aspect ratio.', 'INVALID_REQUEST'],
      [403, 'PERMISSION_DENIED', 'denied', 'AUTH_ERROR'],
      [404, 'NOT_FOUND', 'model not found', 'MODEL_UNAVAILABLE'],
      [
        429,
        'RESOURCE_EXHAUSTED',
        'Resource has been exhausted (e.g. check quota).',
        'QUOTA_EXCEEDED',
      ],
      [429, 'RESOURCE_EXHAUSTED', 'Too many requests.', 'RATE_LIMITED'],
      [500, 'INTERNAL', 'internal', 'PROVIDER_UNAVAILABLE'],
      [503, 'UNAVAILABLE', 'overloaded', 'PROVIDER_UNAVAILABLE'],
      [504, 'DEADLINE_EXCEEDED', 'slow', 'TIMEOUT'],
    ];
    for (const [status, word, message, failure] of cases) {
      script = [
        {
          status,
          body: { error: { code: status, status: word, message: `${message} ${FAKE_KEY}` } },
        },
      ];
      const error = (await adapter
        .generateImage({ modelKey: 'm', prompt: 'p', count: 1, size: '1024x1024' }, ctx())
        .catch((e: unknown) => e)) as Error;
      expect(adapter.classifyError(error), `${status} ${word} ${message}`).toBe(failure);
      expect(error.message).not.toContain(FAKE_KEY);
      expect(error.message).not.toContain(message);
    }
  });

  it('refuses a host that is neither Google’s nor on the allow-list, before sending anything', async () => {
    const error = await adapter
      .generateImage(
        { modelKey: 'm', prompt: 'p', count: 1, size: '1024x1024' },
        ctx({ baseUrl: 'https://example.com/v1beta' }),
      )
      .catch((e: unknown) => e);
    expect(adapter.classifyError(error)).toBe('MODEL_UNAVAILABLE');
    expect(received).toHaveLength(0);
  });

  it('tests the connection by listing models: no generation, no cost', async () => {
    script = [{ status: 200, body: { models: [] } }];
    const ok = await adapter.testConnection(ctx());
    expect(ok.ok).toBe(true);
    expect(received[0]?.method).toBe('GET');
    expect(received[0]?.path).toBe('/v1beta/models?pageSize=1');
    script = [
      {
        status: 400,
        body: { error: { status: 'INVALID_ARGUMENT', message: 'API key not valid.' } },
      },
    ];
    const refused = await adapter.testConnection(ctx());
    expect(refused).toMatchObject({ ok: false, message: 'The provider refused the key.' });
    expect(refused.message).not.toContain(FAKE_KEY);
  });
});

describe('PR G · sizes, catalogue', () => {
  it('maps the size the gateway resolved to Google’s ratio and size class', () => {
    expect(geminiImageConfig('1024x1024')).toEqual({ aspectRatio: '1:1', imageSize: '1K' });
    expect(geminiImageConfig('1080x1350')).toEqual({ aspectRatio: '4:5', imageSize: '2K' });
    expect(geminiImageConfig('1080x1920')).toEqual({ aspectRatio: '9:16', imageSize: '2K' });
    expect(geminiImageConfig('1536×1024')).toEqual({ aspectRatio: '3:2', imageSize: '2K' });
    expect(geminiImageConfig('3840x2160')).toEqual({ aspectRatio: '16:9', imageSize: '4K' });
  });

  it('is an image-only, real (not development) adapter whose hosts match the Control Center catalogue', () => {
    const descriptor = aiAdapterDescriptor('gemini');
    expect(descriptor).toMatchObject({
      modalities: ['image'],
      developmentOnly: false,
      officialHosts: ['generativelanguage.googleapis.com'],
    });
    const entry = findIntegration('ai', 'gemini');
    expect(entry?.officialHosts).toEqual(['generativelanguage.googleapis.com']);
    expect(entry?.defaultSettings?.['baseUrl']).toBe(descriptor?.defaultBaseUrl);
    expect(entry?.capabilities).toMatchObject({ image: true, text: false });
  });
});
