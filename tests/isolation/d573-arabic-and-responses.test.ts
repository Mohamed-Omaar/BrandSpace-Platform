import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hashSessionToken } from '@brandspace/auth';
import {
  AiGateway,
  FORMAL_ARABIC_INSTRUCTION,
  type AiConfiguration,
  type AiProviderAdapter,
  type TextRequest,
} from '@brandspace/ai-gateway';
import { BrandBrainChatService } from '@brandspace/brand-brain';
import { ContentStudioService, type ContentPolicy } from '@brandspace/content';
import { withWorkspace } from '@brandspace/database';
import { CreditLedgerService, type CreditPolicy } from '@brandspace/entitlements';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';
import { captureConfig, type ActivatedConfig } from './config-activation';

/**
 * D-573 — an ARABIC brand through the real Studio and the real Brand Brain
 * chat: every prompt asks for correct formal Arabic (D-474), never a dialect,
 * and the chat answers in the brand's language when the question does not
 * decide it. Then the customer API: a real AI route answers with no provider
 * cost, model, provider or price in its body.
 */

const POLICY: CreditPolicy = {
  hardStopAtZero: true,
  purchasedPackExpiryMonths: 12,
  promotionalExpiryMonths: 3,
  planGrantExpiryMonths: 0,
  lowBalanceThresholdPercents: [],
  reservationTimeoutSeconds: 900,
};

const CONTENT_POLICY: ContentPolicy = {
  dialects: {
    defaultKey: 'msa',
    supported: [{ key: 'msa', labelKey: 'content.dialect.msa', bcp47: 'ar' }],
  },
  platforms: [
    {
      key: 'instagram',
      labelKey: 'content.platform.instagram',
      maxBodyChars: 2_200,
      maxHashtags: 30,
      allowsFirstComment: true,
      maxMediaItems: 10,
    },
  ],
  generation: {
    maxVariantsPerRequest: 4,
    maxDraftsPerBrand: 500,
    maxContextItems: 12,
    maxContextChunks: 8,
    maxContextChars: 12_000,
    maxBriefChars: 2_000,
  },
  retention: { cancellationGraceDays: 30, minCustomerRetentionDays: 7 },
  calendar: {
    weekStartsOn: 0,
    maxDaysAhead: 365,
    minLeadMinutes: 5,
    maxSlotsPerDay: 25,
    requireApprovalBeforeScheduling: false,
  },
  learning: {
    preferenceMinObservations: 4,
    preferenceMinPosts: 3,
    workflowMinRepeats: 4,
    windowDays: 90,
    snoozeDays: 30,
  },
  approvals: {
    requireApprovalBeforeScheduling: false,
    allowSelfApproval: false,
    clientApprovalEnabled: false,
    maxNoteLength: 1_000,
    maxCyclesPerItem: 25,
  },
};

const ARABIC_CAPTION = 'مجموعتنا الربيعية متاحة الآن لدى تجار التجزئة المستقلين.';

/** Records every text request and answers in the shape each task parses. */
class RecordingAdapter implements AiProviderAdapter {
  readonly key = 'mock';
  readonly supportedModalities = ['text'] as const;
  readonly requests: TextRequest[] = [];

  async testConnection() {
    return { ok: true, latencyMs: 0, message: 'ok' };
  }

  async generateText(request: TextRequest) {
    this.requests.push(request);
    const text =
      request.taskKey === 'copilot.chat'
        ? JSON.stringify({ kind: 'answer', answer: 'نخدم تجار التجزئة المستقلين.' })
        : JSON.stringify({
            title: 'إطلاق الربيع',
            variants: [{ platformKey: 'instagram', body: ARABIC_CAPTION, hashtags: [] }],
          });
    return { text, usage: { promptTokens: 100, completionTokens: 50 }, modelKey: request.modelKey };
  }

  classifyError() {
    return 'UNKNOWN' as const;
  }
}

function rule(taskKey: string) {
  return {
    taskKey,
    scope: 'global' as const,
    planKey: null,
    workspaceId: null,
    primaryModelKey: 'mock-fast',
    fallbackModelKeys: [],
    timeoutMs: 10_000,
    maxCostPerRequestMinor: null,
    priority: 0,
    parameters: {
      temperature: 0.4,
      maxOutputTokens: 400,
      promptTemplateVersion: 1,
      persistOutput: false,
      outputRetentionDays: null,
    },
    retryPolicy: { maxAttempts: 1, backoff: 'none' as const, initialDelayMs: 0, jitter: false },
    moderateInput: false,
    moderationModelKey: null,
  };
}

function configuration(): AiConfiguration {
  return {
    providers: [
      {
        key: 'mock',
        baseUrl: 'https://mock.invalid',
        apiKeySecretRef: null,
        status: 'active',
        timeoutMs: 30_000,
      },
    ],
    models: [
      {
        key: 'mock-fast',
        providerKey: 'mock',
        modality: 'text',
        qualityTier: 'fast',
        status: 'beta',
        disableSwitch: false,
      },
    ],
    costBases: [],
    routingRules: [rule('caption.generate'), rule('copilot.chat')],
    creditRules: ['caption.generate', 'copilot.chat'].map((taskKey) => ({
      taskKey,
      modelKey: 'mock-fast',
      baseMilliCredits: 100,
      perUnitMilliCredits: 50,
      unit: '1k_tokens' as const,
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

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let ledger: CreditLedgerService;
const recorder = new RecordingAdapter();
let gateway: AiGateway;
let originalLocale: 'AR' | 'EN' = 'EN';

beforeAll(async () => {
  app = appRoleClient();
  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) throw new Error('DATABASE_PLATFORM_URL is required.');
  platform = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  fixtures = await createIsolationFixtures(app);
  ledger = new CreditLedgerService({ prisma: platform, policy: POLICY });
  gateway = new AiGateway({
    prisma: platform,
    ledger,
    adapters: new Map<string, AiProviderAdapter>([['mock', recorder]]),
    configuration: { load: async () => configuration() },
    credentials: { resolve: async () => null },
    environment: 'DEVELOPMENT',
  });
  await platform.creditWallet.upsert({
    where: { workspaceId: fixtures.a.workspaceId },
    create: { workspaceId: fixtures.a.workspaceId },
    update: {},
  });
  await ledger.grant({
    workspaceId: fixtures.a.workspaceId,
    source: 'PLAN_GRANT',
    credits: 2_000,
    reason: 'd573 arabic fixture',
    idempotencyKey: `d573-ar-grant-${randomUUID()}`,
  });
  const brand = await platform.brand.findUniqueOrThrow({
    where: { id: fixtures.a.brandId },
    select: { defaultLocale: true },
  });
  originalLocale = brand.defaultLocale;
  // An ARABIC brand.
  await platform.brand.update({ where: { id: fixtures.a.brandId }, data: { defaultLocale: 'AR' } });
  await withWorkspace(
    fixtures.a.workspaceId,
    async (db) => {
      await db.brandKnowledgeItem.updateMany({
        where: { brandId: fixtures.a.brandId },
        data: {
          body: {
            en: 'We serve independent retailers with a spring collection.',
            ar: 'نخدم تجار التجزئة المستقلين بمجموعة ربيعية.',
          },
        },
      });
    },
    { prisma: app },
  );
}, 120_000);

afterAll(async () => {
  await platform?.brand.update({
    where: { id: fixtures.a.brandId },
    data: { defaultLocale: originalLocale },
  });
  await platform?.creditReservation.deleteMany({ where: { workspaceId: fixtures.a.workspaceId } });
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('D-573 · an Arabic brand: formal Arabic in every prompt', () => {
  it('the Studio asks for formal Arabic and names no dialect, and the caption comes back Arabic', async () => {
    recorder.requests.length = 0;
    const result = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        new ContentStudioService({
          db,
          workspaceId: fixtures.a.workspaceId,
          gateway,
          policy: CONTENT_POLICY,
        }).generate({
          brandId: fixtures.a.brandId,
          brief: 'أعلن عن المجموعة الربيعية لتجار التجزئة المستقلين.',
          locale: 'AR',
          platformKeys: ['instagram'],
          idempotencyKey: `d573-ar-${randomUUID()}`,
          actorUserId: fixtures.a.userId,
          planKey: null,
          actorBrandScope: [],
          retention: { subscriptionActive: true },
        }),
      { prisma: app },
    );
    const prompt = recorder.requests.at(-1)?.prompt ?? '';
    expect(prompt).toContain('Language: Arabic.');
    expect(prompt).toContain(FORMAL_ARABIC_INSTRUCTION);
    expect(prompt).not.toMatch(/dialect:/i);
    expect(recorder.requests.at(-1)?.outputFormat).toBe('json');
    expect(result.variants[0]?.body).toBe(ARABIC_CAPTION);
  });

  it('Brand Brain chat answers in the brand’s language when the question does not decide it', async () => {
    recorder.requests.length = 0;
    await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        new BrandBrainChatService({
          db,
          workspaceId: fixtures.a.workspaceId,
          gateway,
          policy: { retentionDays: 30, maxContextItems: 12, maxContextChars: 12_000 },
        }).send({
          brandId: fixtures.a.brandId,
          message: 'من نخدم؟',
          idempotencyKey: `d573-chat-${randomUUID()}`,
          actorUserId: fixtures.a.userId,
          actorBrandScope: [],
          planKey: null,
          fallbackLocale: 'AR',
        }),
      { prisma: app },
    );
    const prompt = recorder.requests.at(-1)?.prompt ?? '';
    expect(prompt).toMatch(/language the customer wrote/);
    expect(prompt).toMatch(/answer in Arabic\./);
    expect(prompt).toContain(FORMAL_ARABIC_INSTRUCTION);
  });
});

describe('D-573 · a customer AI response carries no provider cost', () => {
  type Injected = { statusCode: number; body: string };
  type Server = {
    inject(options: Record<string, unknown>): Promise<Injected>;
    close(): Promise<unknown>;
    ready(): Promise<unknown>;
  };
  let server: Server;
  const captured: ActivatedConfig[] = [];

  beforeAll(async () => {
    const activate = async (domain: string, payload: Record<string, unknown>) => {
      const config = await captureConfig(platform, domain, { projected: false });
      captured.push(config);
      await config.activate(payload);
    };
    await activate('ai.providers', {
      providers: [
        {
          key: 'mock',
          name: 'Mock provider (development only)',
          baseUrl: 'https://mock.invalid',
          apiKeySecretRef: null,
          status: 'active',
          timeoutMs: 30_000,
          maxConcurrency: 8,
          noTrainingGuarantee: true,
          dataRetentionPolicy: 'zero_retention',
          privacyReviewRef: 'in-process mock adapter',
        },
      ],
    });
    await activate('ai.models', {
      models: [
        {
          key: 'mock-fast',
          providerKey: 'mock',
          displayName: 'Mock fast',
          modality: 'text',
          qualityTier: 'fast',
          status: 'beta',
          disableSwitch: false,
          inputCostPerUnitMicroMinor: 250_000,
          outputCostPerUnitMicroMinor: 1_000_000,
          costUnit: '1k_tokens',
          costCurrency: 'USD',
          qualityBenchmarkRef: null,
        },
      ],
    });
    await activate('ai.routing', { rules: [rule('copilot.chat')] });
    await activate('ai.credit-rules', {
      costs: [
        {
          taskKey: 'copilot.chat',
          modelKey: 'mock-fast',
          baseMilliCredits: 100,
          perUnitMilliCredits: 50,
          unit: '1k_tokens',
        },
      ],
    });
    vi.resetModules();
    const { buildServer } = await import('../../apps/api/src/server');
    server = (await buildServer()) as unknown as Server;
    await server.ready();
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    for (const config of captured.reverse()) await config.restore();
  });

  it('Brand Brain chat through the API: an answer, credits, and nothing about cost or provider', async () => {
    const token = `d573-${randomUUID()}`;
    await platform.customerSession.create({
      data: {
        userId: fixtures.a.userId,
        tokenHash: hashSessionToken(token),
        activeWorkspaceId: fixtures.a.workspaceId,
        expiresAt: new Date(Date.now() + 3_600_000),
        absoluteExpiresAt: new Date(Date.now() + 7_200_000),
      },
    });
    const response = await server.inject({
      method: 'POST',
      url: '/v1/brand-brain/chat',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: {
        brandId: fixtures.a.brandId,
        message: 'Who do we serve?',
        idempotencyKey: `d573-api-${randomUUID()}`,
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.body.toLowerCase();
    for (const forbidden of [
      'providercost',
      'micro',
      'costcurrency',
      'mock-fast',
      'mock.invalid',
      'apikey',
      'secretref',
    ]) {
      expect(body, forbidden).not.toContain(forbidden);
    }
    // The request really reached the gateway and recorded a provider cost.
    const row = await platform.aiRequest.findFirst({
      where: { workspaceId: fixtures.a.workspaceId, taskKey: 'copilot.chat', status: 'SUCCEEDED' },
      orderBy: { createdAt: 'desc' },
    });
    expect(row?.providerCostMicroMinor).toBeGreaterThan(0n);
  });
});
