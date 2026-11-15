import { describe, expect, it } from 'vitest';
import type { AdapterContext, AiProviderAdapter, ImageRequest } from '@brandspace/ai-gateway';
import {
  compareImageModels,
  comparisonAuditReason,
  type CompareModelRow,
  type CompareProviderRow,
} from '../../apps/admin/src/server/image-compare';

/**
 * PR G (D-611) — THE OWNER'S SIDE-BY-SIDE BENCH, without a network, a
 * database or a key: each model through its own adapter with its own saved
 * key and the host allow-list, timed, priced by its entered rates, and audited
 * without the brief or the images.
 */

const calls: { request: ImageRequest; ctx: AdapterContext; adapter: string }[] = [];

function fakeAdapter(key: string, behaviour: 'ok' | 'fail'): AiProviderAdapter {
  return {
    key,
    supportedModalities: ['image'],
    testConnection: async () => ({ ok: true, latencyMs: 1, message: 'ok' }),
    generateImage: async (request, ctx) => {
      calls.push({ request, ctx, adapter: key });
      if (behaviour === 'fail') throw new Error('boom');
      return {
        imageRefs: [`${key}://1`],
        images: [
          { ref: `${key}://1`, base64: Buffer.from(key).toString('base64'), mimeType: 'image/png' },
        ],
        usage: { imageCount: 1, promptTokens: 10, completionTokens: 1290 },
        modelKey: request.modelKey,
      };
    },
    classifyError: () => 'PROVIDER_UNAVAILABLE',
  };
}

const models: CompareModelRow[] = [
  {
    key: 'image-a',
    providerKey: 'prov-a',
    modality: 'image',
    imageSizing: { mode: 'fixed', sizes: ['1024x1024', '1024x1536', '1536x1024'] } as never,
    inputCostPerUnitMicroMinor: 0,
    outputCostPerUnitMicroMinor: 4_000_000, // 0.04 USD an image
    costUnit: 'image',
    costCurrency: 'USD',
  },
  {
    key: 'image-b',
    providerKey: 'prov-b',
    modality: 'image',
    imageSizing: { mode: 'fixed', sizes: ['1024x1024', '896x1152'] } as never,
    inputCostPerUnitMicroMinor: 0,
    outputCostPerUnitMicroMinor: 3_360_000, // 0.0336 USD an image
    costUnit: 'image',
    costCurrency: 'USD',
  },
  {
    key: 'image-no-rates',
    providerKey: 'prov-b',
    modality: 'image',
    inputCostPerUnitMicroMinor: null,
    outputCostPerUnitMicroMinor: null,
    costUnit: 'image',
    costCurrency: 'USD',
  },
  {
    key: 'text-model',
    providerKey: 'prov-a',
    modality: 'text',
    inputCostPerUnitMicroMinor: 1,
    outputCostPerUnitMicroMinor: 1,
    costUnit: '1k_tokens',
    costCurrency: 'USD',
  },
];
const providers: CompareProviderRow[] = [
  { key: 'prov-a', adapter: 'adapter-a', baseUrl: 'https://a.example', apiKeySecretRef: 'ref-a' },
  { key: 'prov-b', adapter: 'adapter-b', baseUrl: 'https://b.example', apiKeySecretRef: 'ref-b' },
];

function deps(behaviour: { a: 'ok' | 'fail'; b: 'ok' | 'fail' } = { a: 'ok', b: 'ok' }) {
  let tick = 0;
  return {
    environment: 'STAGING' as const,
    models,
    providers,
    allowedHosts: ['proxy.example'],
    registry: new Map<string, AiProviderAdapter>([
      ['adapter-a', fakeAdapter('adapter-a', behaviour.a)],
      ['adapter-b', fakeAdapter('adapter-b', behaviour.b)],
    ]),
    resolveKey: async (ref: string) => `key-for-${ref}`,
    requestId: 'req',
    // Each call to now() moves 1.5 s. Both sides START before either ends (they
    // run at the same time), so each measures two steps: 3,000 ms.
    now: () => (tick += 1500),
  };
}

const BRIEF = 'A secret product launch picture';

describe('PR G · the image comparison bench', () => {
  it('runs each model through its own adapter with its own key, size and the allow-list', async () => {
    calls.length = 0;
    const [a, b] = await compareImageModels(
      { brief: BRIEF, format: '1080x1350', quality: 'medium', modelKeys: ['image-a', 'image-b'] },
      deps(),
    );
    expect(calls.map((c) => [c.adapter, c.ctx.apiKey, c.ctx.baseUrl])).toEqual(
      expect.arrayContaining([
        ['adapter-a', 'key-for-ref-a', 'https://a.example'],
        ['adapter-b', 'key-for-ref-b', 'https://b.example'],
      ]),
    );
    for (const call of calls) {
      expect(call.ctx.allowedHosts).toEqual(['proxy.example']);
      expect(call.request).toMatchObject({ prompt: BRIEF, count: 1, quality: 'medium' });
    }
    // The size each model accepts with the same orientation, as the gateway resolves it.
    expect(a.sizeSent).toBe('1024x1536');
    expect(b.sizeSent).toBe('896x1152');
    expect(a).toMatchObject({ ok: true, latencyMs: 3000, costCurrency: 'USD' });
    expect(b.latencyMs).toBe(3000);
    expect(a.costMicroMinor).toBe(4_000_000n);
    expect(b.costMicroMinor).toBe(3_360_000n);
    expect(a.images[0]).toBe(
      `data:image/png;base64,${Buffer.from('adapter-a').toString('base64')}`,
    );
    expect(b.usage).toEqual({ imageCount: 1, promptTokens: 10, completionTokens: 1290 });
  });

  it('a failure is that side’s alone, classified by its adapter; the other side still answers', async () => {
    const [a, b] = await compareImageModels(
      { brief: BRIEF, format: '1024x1024', quality: 'low', modelKeys: ['image-a', 'image-b'] },
      deps({ a: 'fail', b: 'ok' }),
    );
    expect(a).toMatchObject({ ok: false, failureClass: 'PROVIDER_UNAVAILABLE', images: [] });
    expect(a.costMicroMinor).toBeNull();
    expect(b.ok).toBe(true);
  });

  it('a model with no rates is timed and shown, its cost not invented', async () => {
    const [, noRates] = await compareImageModels(
      {
        brief: BRIEF,
        format: '1024x1024',
        quality: 'low',
        modelKeys: ['image-a', 'image-no-rates'],
      },
      deps(),
    );
    expect(noRates.ok).toBe(true);
    expect(noRates.costMicroMinor).toBeNull();
  });

  it('an unknown model, or one that is not an image model, is NOT_CONFIGURED and calls nothing', async () => {
    calls.length = 0;
    const [missing, text] = await compareImageModels(
      { brief: BRIEF, format: '1024x1024', quality: 'low', modelKeys: ['nope', 'text-model'] },
      deps(),
    );
    expect(missing.failureClass).toBe('NOT_CONFIGURED');
    expect(text.failureClass).toBe('NOT_CONFIGURED');
    expect(calls).toHaveLength(0);
  });

  it('the audit reason names models, outcome, time and cost — never the brief or an image', async () => {
    const sides = await compareImageModels(
      { brief: BRIEF, format: '1080x1350', quality: 'high', modelKeys: ['image-a', 'image-b'] },
      deps(),
    );
    const reason = comparisonAuditReason({ format: '1080x1350', quality: 'high' }, sides);
    expect(reason).toContain('image-a (prov-a) ok 3000ms cost 4000000 micro-minor USD');
    expect(reason).toContain('image-b (prov-b) ok');
    expect(reason).not.toContain(BRIEF);
    expect(reason).not.toContain('base64');
  });
});
