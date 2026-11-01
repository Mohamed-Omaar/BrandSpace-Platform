import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  AiGateway,
  deterministicPng,
  parseImageSize,
  resolveImageSize,
  type AiConfiguration,
  type AiProviderAdapter,
  type ImageSizing,
} from '@brandspace/ai-gateway';
import { OpenAiAdapter } from '@brandspace/ai-gateway/adapters';
import { pinnedHttpsTransport, pinnedLookup } from '@brandspace/ai-gateway/egress';
import { CREATIVE_FORMATS } from '@brandspace/creative';
import { CreditLedgerService, type CreditPolicy } from '@brandspace/entitlements';

/**
 * PR A (item 6) — IMAGE GENERATION ON EVERY STUDIO SIZE, against a FAKE image
 * server that enforces OpenAI's published gpt-image-2 rules (edges multiples
 * of 16, max edge 3840, aspect at most 3:1, 655,360 to 8,294,400 pixels) and
 * answers like the real Images API. CI never calls a real provider.
 *
 * Through the REAL gateway, the REAL OpenAI adapter and the REAL wallet: what
 * size and quality reach the provider, what is charged per quality, and what
 * the operator sees when the provider refuses.
 *
 * Sources: https://developers.openai.com/api/docs/guides/image-generation and
 * https://developers.openai.com/api/reference/resources/images/methods/generate
 */

const GPT_IMAGE_2: ImageSizing = {
  mode: 'custom',
  multipleOf: 16,
  minPixels: 655_360,
  maxPixels: 8_294_400,
  maxEdge: 3_840,
  maxAspectRatio: 3,
};

const POLICY: CreditPolicy = {
  hardStopAtZero: true,
  purchasedPackExpiryMonths: 12,
  promotionalExpiryMonths: 3,
  planGrantExpiryMonths: 0,
  lowBalanceThresholdPercents: [],
  reservationTimeoutSeconds: 900,
};

const MODEL = 'gpt-image-2';
// The proposed prices (D-588): whole credits per image, per quality.
const PRICE = { low: 1_000, medium: 6_000, high: 24_000 } as const;

interface Received {
  readonly path: string;
  readonly body: { size?: string; quality?: string; n?: number; model?: string };
}
let server: Server;
let port = 0;
const received: Received[] = [];
let refuseNext: { code: string; message: string } | null = null;

function acceptedByGptImage2(size: string): boolean {
  const d = parseImageSize(size);
  if (!d) return false;
  const pixels = d.width * d.height;
  return (
    d.width % 16 === 0 &&
    d.height % 16 === 0 &&
    Math.max(d.width, d.height) <= 3_840 &&
    Math.max(d.width, d.height) / Math.min(d.width, d.height) <= 3 &&
    pixels >= 655_360 &&
    pixels <= 8_294_400
  );
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.on('end', () => {
      const body = (raw ? JSON.parse(raw) : {}) as Received['body'];
      received.push({ path: req.url ?? '', body });
      const reply = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (refuseNext) {
        const refusal = refuseNext;
        refuseNext = null;
        return reply(400, {
          error: { type: 'invalid_request_error', code: refusal.code, message: refusal.message },
        });
      }
      if (!body.size || !acceptedByGptImage2(body.size)) {
        return reply(400, {
          error: {
            type: 'invalid_request_error',
            code: 'invalid_value',
            message: `Invalid value: '${body.size}'. Sizes must be multiples of 16 within the supported bounds.`,
          },
        });
      }
      const png = deterministicPng(`${body.size}:${body.quality}`, body.size);
      return reply(200, {
        data: [{ b64_json: Buffer.from(png.bytes).toString('base64') }],
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

const toLocal = (
  _host: string,
  callback: (e: null, a: { address: string; family: number }[]) => void,
) => callback(null, [{ address: '127.0.0.1', family: 4 }]);

function configuration(): AiConfiguration {
  return {
    providers: [
      {
        key: 'openai',
        adapterKey: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKeySecretRef: null,
        status: 'active',
        timeoutMs: 30_000,
      },
    ],
    models: [
      {
        key: MODEL,
        providerKey: 'openai',
        modality: 'image',
        qualityTier: 'premium',
        status: 'available',
        disableSwitch: false,
        imageSizing: GPT_IMAGE_2,
      },
    ],
    costBases: [],
    routingRules: [
      {
        taskKey: 'image.generate',
        scope: 'global',
        planKey: null,
        workspaceId: null,
        primaryModelKey: MODEL,
        fallbackModelKeys: [],
        timeoutMs: 20_000,
        maxCostPerRequestMinor: null,
        priority: 0,
        parameters: {
          temperature: 0.7,
          maxOutputTokens: 1,
          promptTemplateVersion: 1,
          persistOutput: false,
          outputRetentionDays: null,
          imageQuality: 'medium',
        },
        retryPolicy: { maxAttempts: 1, backoff: 'none', initialDelayMs: 0, jitter: false },
        moderateInput: false,
        moderationModelKey: null,
      },
    ],
    creditRules: (['low', 'medium', 'high'] as const).map((quality) => ({
      taskKey: 'image.generate',
      modelKey: MODEL,
      baseMilliCredits: PRICE[quality],
      perUnitMilliCredits: 0,
      unit: 'request' as const,
      imageQuality: quality,
    })),
    budgets: {
      defaults: {
        creditsPerDayMilli: null,
        creditsPerMonthMilli: null,
        maxConcurrentRequests: null,
      },
      perPlan: [],
    },
  };
}

let platform: PrismaClient;
let ledger: CreditLedgerService;
let gateway: AiGateway;
let workspaceId: string;
const OUT = process.env['PR_A_IMAGE_DIR'];

beforeAll(async () => {
  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) throw new Error('DATABASE_PLATFORM_URL is required.');
  platform = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  ledger = new CreditLedgerService({ prisma: platform, policy: POLICY });
  const adapter = new OpenAiAdapter({
    transportFor: (allowedHosts) =>
      pinnedHttpsTransport(
        allowedHosts,
        pinnedLookup(toLocal, (a) => a === '127.0.0.1'),
        { request: httpRequest, port },
      ),
  });
  gateway = new AiGateway({
    prisma: platform,
    ledger,
    adapters: new Map<string, AiProviderAdapter>([['openai', adapter]]),
    configuration: { load: async () => configuration() },
    // Assembled at runtime: the fake server never checks it (CI secret scan).
    credentials: { resolve: async () => ['sk', 'test', 'pra-image-0000000000000000'].join('-') },
    environment: 'STAGING',
  });

  const id = crypto.randomUUID();
  const user = await platform.user.create({
    data: { email: `pra-img-${id}@example.local`, name: 'Img', status: 'ACTIVE', timezone: 'UTC' },
  });
  await platform.workspace.create({
    data: {
      id,
      workspaceId: id,
      country: 'SA',
      defaultLocale: 'AR',
      timezone: 'UTC',
      currency: 'USD',
      slug: `pra-img-${id.slice(0, 12)}`,
      name: 'PR A images',
      ownerUserId: user.id,
      status: 'ACTIVE',
    },
  });
  await platform.creditWallet.create({ data: { workspaceId: id } });
  await ledger.grant({
    workspaceId: id,
    source: 'PLAN_GRANT',
    credits: 200,
    reason: 'PR A image fixture',
    idempotencyKey: `pra-img-${id}`,
  });
  workspaceId = id;
}, 90_000);

afterAll(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await platform?.creditReservation.deleteMany({ where: { workspaceId } });
  await platform?.$disconnect();
});

beforeEach(() => {
  received.length = 0;
  refuseNext = null;
});

const EXPECTED: Record<string, string> = {
  square: '1088x1088',
  portrait: '1088x1360',
  story: '1152x2048',
  landscape: '1280x720',
};

describe('item 6 — every Studio size reaches the provider as a size it accepts', () => {
  it.each(CREATIVE_FORMATS.map((format) => [format.key, format.size] as const))(
    '%s (%s): same aspect ratio, accepted, generated, medium quality and its price',
    async (formatKey, studioSize) => {
      const result = await gateway.execute({
        workspaceId,
        userId: null,
        taskKey: 'image.generate',
        planKey: null,
        idempotencyKey: `pra-img-${formatKey}-${crypto.randomUUID()}`,
        input: { kind: 'image', prompt: 'A cup of cardamom coffee', count: 1, size: studioSize },
      });

      expect(result.status).toBe('SUCCEEDED');
      const sent = received.at(-1)?.body;
      expect(sent?.size).toBe(EXPECTED[formatKey]);
      expect(sent?.quality).toBe('medium');
      // The Studio's aspect ratio, exactly: no crop is needed or made.
      const want = parseImageSize(studioSize)!;
      const got = parseImageSize(sent!.size!)!;
      expect(got.width * want.height).toBe(got.height * want.width);
      expect(result.creditsChargedMilli).toBe(BigInt(PRICE.medium));

      const image = result.output?.kind === 'image' ? result.output.images?.[0] : undefined;
      expect(image?.base64?.length).toBeGreaterThan(0);
      if (OUT && image?.base64) {
        mkdirSync(OUT, { recursive: true });
        writeFileSync(
          path.join(OUT, `${formatKey}-${sent!.size}-medium.png`),
          Buffer.from(image.base64, 'base64'),
        );
      }
    },
  );

  it('every Studio size as it was sent before the fix breaks the rules; every resolved one keeps them', () => {
    for (const format of CREATIVE_FORMATS) {
      // The KNOWN bug: these went to the provider unchanged and were refused.
      expect(acceptedByGptImage2(format.size)).toBe(false);
      expect(acceptedByGptImage2(resolveImageSize(format.size, GPT_IMAGE_2))).toBe(true);
    }
  });
});

describe('item 6 / F-106 — quality is sent and priced per quality', () => {
  it.each(['low', 'high'] as const)('%s is sent and charged at its own price', async (quality) => {
    const result = await gateway.execute({
      workspaceId,
      userId: null,
      taskKey: 'image.generate',
      planKey: null,
      idempotencyKey: `pra-img-q-${quality}-${crypto.randomUUID()}`,
      input: { kind: 'image', prompt: 'A cup', count: 1, size: '1080x1080', quality },
    });
    expect(result.status).toBe('SUCCEEDED');
    expect(received.at(-1)?.body.quality).toBe(quality);
    expect(result.creditsChargedMilli).toBe(BigInt(PRICE[quality]));
  });

  it('the quote is the quality’s price, before anything is spent', async () => {
    for (const quality of ['low', 'medium', 'high'] as const) {
      const quote = await gateway.quote({
        workspaceId,
        taskKey: 'image.generate',
        planKey: null,
        input: { kind: 'image', prompt: '', count: 1, size: '1080x1920', quality },
      });
      expect(quote.estimateMilli).toBe(BigInt(PRICE[quality]));
    }
  });
});

describe('item 6 — the provider’s error code and reason reach the operator, not the customer', () => {
  it('a refusal is recorded with its code and redacted reason; nothing is charged', async () => {
    const wallet = async () =>
      (await platform.creditWallet.findUniqueOrThrow({ where: { workspaceId } }))
        .balanceMilliCredits;
    const before = await wallet();
    refuseNext = {
      code: 'moderation_blocked',
      message: 'Your request was rejected by the safety system.',
    };
    const result = await gateway.execute({
      workspaceId,
      userId: null,
      taskKey: 'image.generate',
      planKey: null,
      idempotencyKey: `pra-img-refused-${crypto.randomUUID()}`,
      input: { kind: 'image', prompt: 'A cup', count: 1, size: '1080x1080' },
    });
    expect(result.status).toBe('FAILED');
    expect(result.creditsChargedMilli).toBe(0n);
    expect(await wallet()).toBe(before);
    const row = await platform.aiRequest.findUniqueOrThrow({ where: { id: result.requestId } });
    expect(row.providerErrorCode).toBe('moderation_blocked');
    expect(row.failureReason).toBe('Your request was rejected by the safety system.');
    expect(
      JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? String(v) : v)),
    ).not.toContain('moderation_blocked');
  });
});
