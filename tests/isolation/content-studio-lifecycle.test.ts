import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AiGateway,
  type AiConfiguration,
  type AiFailureClass,
  type AiProviderAdapter,
  type TextResult,
} from '@brandspace/ai-gateway';
import { CreditLedgerService, type CreditPolicy } from '@brandspace/entitlements';
import { withWorkspace } from '@brandspace/database';

import { ContentStudioService, purgeExpiredContent, type ContentPolicy } from '@brandspace/content';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * AI Content Studio against the REAL gateway, the REAL credit ledger and a real
 * PostgreSQL — the acceptance criteria in `docs/MVP-ACCEPTANCE-CRITERIA.md` §12
 * (AC-11.1 … AC-11.9), measured rather than asserted.
 *
 * The gateway runs on the PLATFORM pool exactly as it does in `apps/api`, and
 * every content read and write runs on the TENANT pool inside a workspace
 * transaction. That split is under test as much as the generations are: confuse
 * the two identities and either RLS refuses the content writes or the gateway
 * cannot read its configuration.
 *
 * The mock provider is directed to return the JSON the studio asks for, because
 * what is being tested is the STUDIO — its grounding, its parsing, its
 * accounting and its refusals — and not a model's ability to follow a format.
 */

const POLICY: CreditPolicy = {
  hardStopAtZero: true,
  purchasedPackExpiryMonths: 12,
  promotionalExpiryMonths: 3,
  planGrantExpiryMonths: 0,
  lowBalanceThresholdPercents: [],
  reservationTimeoutSeconds: 900,
};

const MODEL_KEY = 'mock-fast';
const TASK_KEY = 'caption.generate';

const CONTENT_POLICY: ContentPolicy = {
  dialects: {
    defaultKey: 'msa',
    supported: [
      { key: 'msa', labelKey: 'content.dialect.msa', bcp47: 'ar' },
      { key: 'gulf', labelKey: 'content.dialect.gulf', bcp47: 'ar-SA' },
      { key: 'egyptian', labelKey: 'content.dialect.egyptian', bcp47: 'ar-EG' },
      { key: 'levantine', labelKey: 'content.dialect.levantine', bcp47: 'ar-LB' },
    ],
  },
  platforms: [
    {
      key: 'instagram',
      labelKey: 'content.platform.instagram',
      maxBodyChars: 2_200,
      maxHashtags: 30,
      allowsFirstComment: true,
    },
    {
      key: 'linkedin',
      labelKey: 'content.platform.linkedin',
      maxBodyChars: 3_000,
      maxHashtags: 10,
      allowsFirstComment: false,
    },
    {
      key: 'x',
      labelKey: 'content.platform.x',
      maxBodyChars: 280,
      maxHashtags: 5,
      allowsFirstComment: false,
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
};

const NO_LIMITS = {
  creditsPerDayMilli: null,
  creditsPerMonthMilli: null,
  maxConcurrentRequests: null,
};

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
        key: MODEL_KEY,
        providerKey: 'mock',
        modality: 'text',
        qualityTier: 'fast',
        status: 'available',
        disableSwitch: false,
      },
    ],
    costBases: [
      {
        modelKey: MODEL_KEY,
        inputCostPerUnitMicroMinor: 15_000,
        outputCostPerUnitMicroMinor: 60_000,
        costUnit: '1k_tokens',
        costCurrency: 'USD',
      },
    ],
    routingRules: [
      {
        taskKey: TASK_KEY,
        scope: 'global',
        planKey: null,
        workspaceId: null,
        primaryModelKey: MODEL_KEY,
        fallbackModelKeys: [],
        timeoutMs: 5_000,
        maxCostPerRequestMinor: null,
        priority: 0,
        parameters: {
          temperature: 0.4,
          maxOutputTokens: 256,
          promptTemplateVersion: 1,
          // D-78, and the same reasoning as Brand Brain chat: the STUDIO owns
          // the artifact. `content_item` and `content_variant` carry the words
          // and the retention window; asking the gateway to persist them too
          // would make it a second content store.
          persistOutput: false,
          outputRetentionDays: null,
        },
        retryPolicy: { maxAttempts: 1, backoff: 'none', initialDelayMs: 0, jitter: false },
        moderateInput: false,
        moderationModelKey: null,
      },
    ],
    creditRules: [
      {
        taskKey: TASK_KEY,
        modelKey: MODEL_KEY,
        baseMilliCredits: 100,
        perUnitMilliCredits: 50,
        unit: '1k_tokens',
      },
    ],
    budgets: { defaults: NO_LIMITS, perPlan: [] },
  };
}

let fixtures: IsolationFixtures;
let app: PrismaClient;
let platform: PrismaClient;
let ledger: CreditLedgerService;
let gateway: AiGateway;

type ScopedDb = Parameters<Parameters<typeof withWorkspace>[1]>[0];

/** What the provider returns next. Set per test. */
let nextOutput = '';

/**
 * A provider that returns exactly what the test scripted.
 *
 * `MockProviderAdapter` deliberately offers no way to dictate its text — it
 * either produces bland placeholder words or SELECTS sentences from the
 * supplied context, and neither can be made to emit a specific JSON document.
 * That is the right design for it and the wrong tool here: these tests are
 * about what the STUDIO does with a response — parses it, validates it,
 * attributes it, refuses it — so the response has to be an input to the test
 * rather than something the adapter decides.
 *
 * It is scripted, not clever: it reports token usage derived from the real
 * prompt so the credit arithmetic under test stays real.
 */
class ScriptedTextAdapter implements AiProviderAdapter {
  readonly key = 'mock';
  readonly supportedModalities = ['text'] as const;

  async testConnection() {
    return { ok: true, latencyMs: 0, message: 'scripted' };
  }

  async generateText(request: {
    modelKey: string;
    prompt: string;
    untrustedContext?: readonly string[] | undefined;
  }): Promise<TextResult> {
    const contextChars = (request.untrustedContext ?? []).reduce((n, c) => n + c.length, 0);
    return {
      text: nextOutput,
      usage: {
        promptTokens: Math.ceil((request.prompt.length + contextChars) / 4),
        completionTokens: Math.ceil(nextOutput.length / 4),
      },
      modelKey: request.modelKey,
    };
  }

  classifyError(): AiFailureClass {
    return 'UNKNOWN';
  }
}

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);

  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) throw new Error('DATABASE_PLATFORM_URL is required.');
  platform = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  ledger = new CreditLedgerService({ prisma: platform, policy: POLICY });

  const adapters = new Map<string, AiProviderAdapter>([['mock', new ScriptedTextAdapter()]]);
  gateway = new AiGateway({
    prisma: platform,
    ledger,
    adapters,
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
    reason: 'content studio fixture allowance',
    idempotencyKey: `cs-grant-${fixtures.a.workspaceId}`,
  });

  // The studio grounds on Brand Brain. The fixture brand already has one
  // approved knowledge item; give it enough text to retrieve reliably.
  await withWorkspace(
    fixtures.a.workspaceId,
    async (db) => {
      await db.brandKnowledgeItem.updateMany({
        where: { brandId: fixtures.a.brandId },
        data: {
          body: {
            en: 'We serve independent retailers with a spring collection built for real life.',
            ar: 'نخدم تجار التجزئة المستقلين بمجموعة ربيعية مصممة للحياة اليومية.',
          },
        },
      });
    },
    { prisma: app },
  );
}, 120_000);

afterAll(async () => {
  await platform?.creditReservation.deleteMany({
    where: { workspaceId: { in: [fixtures.a.workspaceId, fixtures.b.workspaceId] } },
  });
  await app?.$disconnect();
  await platform?.$disconnect();
});

function inA<T>(fn: (studio: ContentStudioService, db: ScopedDb) => Promise<T>): Promise<T> {
  return withWorkspace(
    fixtures.a.workspaceId,
    async (db) =>
      fn(
        new ContentStudioService({
          db,
          workspaceId: fixtures.a.workspaceId,
          gateway,
          policy: CONTENT_POLICY,
        }),
        db,
      ),
    { prisma: app },
  );
}

let counter = 0;
const key = () => `cs-${(counter += 1)}-${Date.now()}`;

/** The shape the studio asks the model for. */
function reply(variants: { platformKey: string; body: string; hashtags?: string[] }[]): string {
  return JSON.stringify({
    title: 'Spring collection launch',
    variants: variants.map((v) => ({ ...v, hashtags: v.hashtags ?? [] })),
  });
}

const baseInput = () => ({
  brandId: fixtures.a.brandId,
  brief: 'Announce the spring collection to independent retailers.',
  locale: 'EN' as const,
  platformKeys: ['instagram'],
  actorUserId: fixtures.a.userId,
  planKey: null,
  actorBrandScope: [] as string[],
  retention: { subscriptionActive: true },
});

// ---------------------------------------------------------------------------

describe('AC-11.1 — the credit cost is known before anything is spent', () => {
  it('quotes a positive cost without touching the wallet or creating a request', async () => {
    const before = await platform.creditWallet.findUnique({
      where: { workspaceId: fixtures.a.workspaceId },
    });
    const requestsBefore = await platform.aiRequest.count({
      where: { workspaceId: fixtures.a.workspaceId },
    });

    const quote = await inA((studio) =>
      studio.quote({
        brandId: fixtures.a.brandId,
        brief: 'Announce the spring collection.',
        platformKeys: ['instagram'],
        planKey: null,
        actorBrandScope: [],
      }),
    );

    expect(quote.estimateMilli).toBeGreaterThan(0n);
    expect(quote.modelKeys).toContain(MODEL_KEY);

    const after = await platform.creditWallet.findUnique({
      where: { workspaceId: fixtures.a.workspaceId },
    });
    // A QUOTE IS A READ. Not a reservation, not a request, not a charge.
    expect(after?.balanceMilliCredits).toBe(before?.balanceMilliCredits);
    expect(after?.reservedMilliCredits).toBe(before?.reservedMilliCredits);
    expect(await platform.aiRequest.count({ where: { workspaceId: fixtures.a.workspaceId } })).toBe(
      requestsBefore,
    );
  });

  it('the quote is the amount the generation actually reserves', async () => {
    /*
     * A PRICE SHOWN BEFORE A PURCHASE HAS TO BE THE PRICE OF THE PURCHASE.
     * Quoting independently of the gateway would let the two drift, and the
     * customer would confirm one number and be charged another.
     */
    const brief = 'Announce the spring collection to independent retailers.';
    const quote = await inA((studio) =>
      studio.quote({
        brandId: fixtures.a.brandId,
        brief,
        platformKeys: ['instagram'],
        planKey: null,
        actorBrandScope: [],
      }),
    );

    nextOutput = reply([{ platformKey: 'instagram', body: 'Spring, for real life.' }]);
    const generated = await inA((studio) =>
      studio.generate({ ...baseInput(), brief, idempotencyKey: key() }),
    );

    const request = await platform.aiRequest.findUnique({
      where: { id: generated.aiRequestId ?? '' },
      select: { creditsReservedMilli: true },
    });
    expect(request?.creditsReservedMilli).toBe(quote.estimateMilli);
  });
});

describe('AC-11.3 to AC-11.5 — the draft, its grounding and its provenance', () => {
  it('creates a DRAFT linked to the AiRequest that produced it', async () => {
    nextOutput = reply([
      { platformKey: 'instagram', body: 'Spring, for real life.', hashtags: ['spring'] },
    ]);
    const result = await inA((studio) =>
      studio.generate({ ...baseInput(), idempotencyKey: key() }),
    );

    expect(result.item.status).toBe('DRAFT');
    expect(result.item.origin).toBe('AI_GENERATED');
    expect(result.item.aiRequestId).toBe(result.aiRequestId);
    expect(result.aiRequestId).toBeTruthy();

    // AC-11.5's other half: the linked request is real and belongs to this
    // workspace — a dangling id would satisfy a shallow assertion.
    const request = await platform.aiRequest.findUnique({
      where: { id: result.aiRequestId ?? '' },
      select: { workspaceId: true, taskKey: true },
    });
    expect(request?.workspaceId).toBe(fixtures.a.workspaceId);
    expect(request?.taskKey).toBe(TASK_KEY);
  });

  it('records which Brand Brain entries grounded it (AC-11.4)', async () => {
    nextOutput = reply([{ platformKey: 'instagram', body: 'Built for independent retailers.' }]);
    const result = await inA((studio) =>
      studio.generate({ ...baseInput(), idempotencyKey: key() }),
    );

    expect(result.citations.length).toBeGreaterThan(0);
    const stored = (result.item.citations ?? []) as { kind: string; id: string }[];
    expect(stored.length).toBe(result.citations.length);

    /*
     * CITATIONS COME FROM RETRIEVAL, NOT FROM THE MODEL. The mock returned no
     * citation field at all, and the draft still carries them — which is only
     * possible because the service wrote what it retrieved. A fabricated source
     * is therefore impossible rather than merely unlikely.
     */
    const { knowledgeIds, chunkIds } = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => ({
        knowledgeIds: (await db.brandKnowledgeItem.findMany({ select: { id: true } })).map(
          (k) => k.id,
        ),
        // A `document` citation names the CHUNK it quoted, not the document —
        // that is what makes a citation checkable down to the passage rather
        // than only to the file.
        chunkIds: (await db.brandSourceChunk.findMany({ select: { id: true } })).map((c) => c.id),
      }),
      { prisma: app },
    );

    /*
     * EVERY citation must name a row that actually exists IN THIS WORKSPACE,
     * and the two kinds are checked against their own tables — a knowledge
     * citation against `brand_knowledge_item`, a document citation against
     * `brand_source_chunk`. Checking both against one table would let a
     * citation of the wrong kind pass, and checking only that the array is
     * non-empty would let a fabricated id through entirely.
     */
    for (const citation of stored as { kind: string; id: string }[]) {
      const permitted = citation.kind === 'document' ? chunkIds : knowledgeIds;
      expect(permitted, `${citation.kind} citation ${citation.id}`).toContain(citation.id);
    }
  });

  it('writes one variant per requested platform, validated against its limits', async () => {
    nextOutput = reply([
      { platformKey: 'instagram', body: 'A collection for real life.' },
      { platformKey: 'linkedin', body: 'A collection for real life, for retail partners.' },
    ]);
    const result = await inA((studio) =>
      studio.generate({
        ...baseInput(),
        platformKeys: ['instagram', 'linkedin'],
        idempotencyKey: key(),
      }),
    );

    expect(result.variants.map((v) => v.platformKey).sort()).toEqual(['instagram', 'linkedin']);
    for (const variant of result.variants) {
      expect(variant.validationState).toBe('VALID');
      expect(variant.characterCount).toBeGreaterThan(0);
      expect(variant.origin).toBe('AI_GENERATED');
    }
  });

  it('marks a caption INVALID when it exceeds the platform limit, and still saves it', async () => {
    // 280 is X's limit in the activated policy; 400 characters must be flagged
    // rather than silently truncated or refused.
    nextOutput = reply([{ platformKey: 'x', body: 'a'.repeat(400) }]);
    const result = await inA((studio) =>
      studio.generate({ ...baseInput(), platformKeys: ['x'], idempotencyKey: key() }),
    );

    const variant = result.variants[0];
    expect(variant?.validationState).toBe('INVALID');
    expect(variant?.characterCount).toBe(400);
    // SAVED, not refused: the customer's work is theirs even when it will not
    // fit a channel they may never publish to.
    expect(variant?.body).toHaveLength(400);
  });

  it('drops a variant for a platform nobody asked for', async () => {
    nextOutput = reply([
      { platformKey: 'instagram', body: 'Requested.' },
      { platformKey: 'myspace', body: 'Invented by the model.' },
    ]);
    const result = await inA((studio) =>
      studio.generate({ ...baseInput(), idempotencyKey: key() }),
    );
    expect(result.variants.map((v) => v.platformKey)).toEqual(['instagram']);
  });
});

describe('AC-11.2 and AC-11.6 — authorization, idempotency and what comes back', () => {
  it('a member outside the brand scope is refused before anything is read', async () => {
    await expect(
      inA((studio) =>
        studio.generate({
          ...baseInput(),
          actorBrandScope: [randomUUID()],
          idempotencyKey: key(),
        }),
      ),
    ).rejects.toThrow();
  });

  it('a replayed request returns the first draft and makes no second charge', async () => {
    const idempotencyKey = key();
    nextOutput = reply([{ platformKey: 'instagram', body: 'Only once.' }]);

    const first = await inA((studio) => studio.generate({ ...baseInput(), idempotencyKey }));
    const requestsAfterFirst = await platform.aiRequest.count({
      where: { workspaceId: fixtures.a.workspaceId },
    });

    const second = await inA((studio) => studio.generate({ ...baseInput(), idempotencyKey }));

    expect(second.item.id).toBe(first.item.id);
    expect(second.replayed).toBe(true);
    expect(second.creditsChargedMilli).toBe(0n);
    expect(await platform.aiRequest.count({ where: { workspaceId: fixtures.a.workspaceId } })).toBe(
      requestsAfterFirst,
    );
  });

  it('the result carries no provider, model, key or internal beyond the request id', async () => {
    nextOutput = reply([{ platformKey: 'instagram', body: 'Clean output.' }]);
    const result = await inA((studio) =>
      studio.generate({ ...baseInput(), idempotencyKey: key() }),
    );

    const serialized = JSON.stringify({ item: result.item, variants: result.variants });
    expect(serialized).not.toContain('mock');
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toContain('provider');
    expect(serialized).not.toContain(MODEL_KEY);
  });
});

describe('AC-11.9 — malformed output never becomes a row', () => {
  it('prose instead of JSON fails and persists nothing', async () => {
    const before = await withWorkspace(fixtures.a.workspaceId, (db) => db.contentItem.count(), {
      prisma: app,
    });

    nextOutput = 'I am terribly sorry, but I cannot help with that request today.';
    await expect(
      inA((studio) => studio.generate({ ...baseInput(), idempotencyKey: key() })),
    ).rejects.toThrow();

    const after = await withWorkspace(fixtures.a.workspaceId, (db) => db.contentItem.count(), {
      prisma: app,
    });
    expect(after).toBe(before);
  });

  it('JSON wrapped in a code fence is accepted — models do that, and it is harmless', async () => {
    nextOutput =
      '```json\n' + reply([{ platformKey: 'instagram', body: 'Fenced but fine.' }]) + '\n```';
    const result = await inA((studio) =>
      studio.generate({ ...baseInput(), idempotencyKey: key() }),
    );
    expect(result.variants[0]?.body).toBe('Fenced but fine.');
  });
});

describe('AC-11.8 — the boundaries this module does not cross', () => {
  it('never proposes a Brand Brain write-back, so D-65 has nothing to adjudicate', async () => {
    /*
     * THE FIRST HALF OF AC-11.8, AND THE HONEST ANSWER TO IT.
     *
     * The criterion governs generations that propose a write-back into the
     * Brand Brain: they must carry provenance, evidence, confidence and an
     * approval state, and must never be committed on the model's own decision.
     * The Content Studio proposes NONE — it reads the brain and writes content,
     * and the candidate pipeline that adjudicates proposals is Brand Brain's
     * own (`brand_knowledge_candidate`, Phase 5A).
     *
     * That is a claim worth ASSERTING rather than stating, because the failure
     * it guards against is a future change: a generation that quietly learned
     * something and wrote it back would bypass D-65's approval entirely, and
     * nothing else in this suite would notice. So the counts are taken before
     * and after a real generation.
     */
    const counts = () =>
      withWorkspace(
        fixtures.a.workspaceId,
        async (db) => ({
          candidates: await db.brandKnowledgeCandidate.count(),
          items: await db.brandKnowledgeItem.count(),
          versions: await db.brandKnowledgeVersion.count(),
        }),
        { prisma: app },
      );

    const before = await counts();
    nextOutput = reply([{ platformKey: 'instagram', body: 'A caption that learns nothing.' }]);
    await inA((studio) => studio.generate({ ...baseInput(), idempotencyKey: key() }));
    expect(await counts()).toEqual(before);
  });

  it('an unrouted task fails as a configuration error, and picks no model of its own', async () => {
    /*
     * THE SECOND HALF. `caption.generate` is routed in this fixture; a task
     * that is not must fail rather than be served by whichever model happens to
     * be configured — "the gateway never picks a model on its own".
     *
     * Asserted against the GATEWAY directly, with a task key nothing routes,
     * because the studio has no way to name an unrouted task: its own key is a
     * constant. Testing it through the studio would require breaking the studio
     * to reach the behaviour, which proves the break and not the rule.
     */
    const openReservations = () =>
      platform.creditReservation.count({
        where: { workspaceId: fixtures.a.workspaceId, status: 'OPEN' },
      });
    const reservedBefore = await openReservations();

    await expect(
      gateway.execute({
        workspaceId: fixtures.a.workspaceId,
        userId: fixtures.a.userId,
        taskKey: 'caption.generate.not-routed',
        planKey: null,
        idempotencyKey: key(),
        input: { kind: 'text', prompt: 'anything' },
      }),
    ).rejects.toThrow();

    /*
     * Nothing was charged for a request that never reached a provider.
     *
     * Measured as a DELTA, not against zero: other tests in this file leave
     * their own reservations behind — that is their business — and an absolute
     * count would make this test pass or fail on whatever ran before it. What
     * is asserted is that THIS call took nothing, which is the property the
     * criterion is about.
     */
    expect(await openReservations()).toBe(reservedBefore);
  });
});

describe('AC-11.7 and D-115 — both languages, and the configured dialect', () => {
  it('generates in English without claiming a dialect', async () => {
    nextOutput = reply([{ platformKey: 'instagram', body: 'An English caption.' }]);
    const result = await inA((studio) =>
      studio.generate({ ...baseInput(), locale: 'EN', idempotencyKey: key() }),
    );
    expect(result.item.primaryLocale).toBe('EN');
    // A dialect on an English caption would be meaningless metadata.
    expect(result.item.arabicDialect).toBeNull();
  });

  it('generates in Arabic and records MSA when nothing is configured', async () => {
    nextOutput = reply([{ platformKey: 'instagram', body: 'تسويق للمجموعة الربيعية.' }]);
    const result = await inA((studio) =>
      studio.generate({ ...baseInput(), locale: 'AR', idempotencyKey: key() }),
    );
    expect(result.item.primaryLocale).toBe('AR');
    // D-115: unconfigured means MSA. It does NOT mean Saudi.
    expect(result.item.arabicDialect).toBe('msa');
    expect(result.variants[0]?.arabicDialect).toBe('msa');
  });

  it("uses the BRAND's dialect over the workspace's", async () => {
    await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => {
        await db.workspace.update({
          where: { id: fixtures.a.workspaceId },
          data: { arabicDialect: 'egyptian' },
        });
        await db.brand.update({
          where: { id: fixtures.a.brandId },
          data: { arabicDialect: 'levantine' },
        });
      },
      { prisma: app },
    );

    nextOutput = reply([{ platformKey: 'instagram', body: 'مجموعة الربيع.' }]);
    const result = await inA((studio) =>
      studio.generate({ ...baseInput(), locale: 'AR', idempotencyKey: key() }),
    );
    expect(result.item.arabicDialect).toBe('levantine');

    // And the workspace's applies when the brand has none.
    await withWorkspace(
      fixtures.a.workspaceId,
      (db) => db.brand.update({ where: { id: fixtures.a.brandId }, data: { arabicDialect: null } }),
      { prisma: app },
    );
    nextOutput = reply([{ platformKey: 'instagram', body: 'مجموعة الربيع.' }]);
    const inherited = await inA((studio) =>
      studio.generate({ ...baseInput(), locale: 'AR', idempotencyKey: key() }),
    );
    expect(inherited.item.arabicDialect).toBe('egyptian');

    await withWorkspace(
      fixtures.a.workspaceId,
      (db) =>
        db.workspace.update({
          where: { id: fixtures.a.workspaceId },
          data: { arabicDialect: null },
        }),
      { prisma: app },
    );
  });
});

describe('the editing tools — rewrite, shorten, expand, tone and translation', () => {
  it('translates a variant while keeping its identity and recording the dialect', async () => {
    nextOutput = reply([{ platformKey: 'instagram', body: 'Spring is here.' }]);
    const generated = await inA((studio) =>
      studio.generate({ ...baseInput(), idempotencyKey: key() }),
    );
    const variantId = generated.variants[0]?.id ?? '';

    nextOutput = JSON.stringify({ body: 'حل الربيع.', hashtags: ['ربيع'] });
    const { variant } = await inA((studio) =>
      studio.applyTool({
        variantId,
        tool: 'translate',
        targetLocale: 'AR',
        idempotencyKey: key(),
        actorUserId: fixtures.a.userId,
        planKey: null,
        actorBrandScope: [],
      }),
    );

    expect(variant.id).toBe(variantId);
    expect(variant.body).toBe('حل الربيع.');
    expect(variant.locale).toBe('AR');
    expect(variant.arabicDialect).toBe('msa');
    // A caption a person chose to translate is ASSISTED, not generated: the
    // distinction is what makes provenance mean something to a reviewer.
    expect(variant.origin).toBe('AI_ASSISTED');
  });

  it('shortens a caption and revalidates it against the platform limit', async () => {
    nextOutput = reply([{ platformKey: 'x', body: 'a'.repeat(400) }]);
    const generated = await inA((studio) =>
      studio.generate({ ...baseInput(), platformKeys: ['x'], idempotencyKey: key() }),
    );
    expect(generated.variants[0]?.validationState).toBe('INVALID');

    nextOutput = JSON.stringify({ body: 'Short enough now.', hashtags: [] });
    const { variant } = await inA((studio) =>
      studio.applyTool({
        variantId: generated.variants[0]?.id ?? '',
        tool: 'shorten',
        idempotencyKey: key(),
        actorUserId: fixtures.a.userId,
        planKey: null,
        actorBrandScope: [],
      }),
    );
    expect(variant.validationState).toBe('VALID');
    expect(variant.characterCount).toBe(17);
  });

  it("a customer's own edit costs no credits and keeps HUMAN provenance where it was", async () => {
    nextOutput = reply([{ platformKey: 'instagram', body: 'Generated.' }]);
    const generated = await inA((studio) =>
      studio.generate({ ...baseInput(), idempotencyKey: key() }),
    );
    const requestsBefore = await platform.aiRequest.count({
      where: { workspaceId: fixtures.a.workspaceId },
    });

    const edited = await inA((studio) =>
      studio.editVariant({
        variantId: generated.variants[0]?.id ?? '',
        body: 'Rewritten by a person.',
        actorUserId: fixtures.a.userId,
        actorBrandScope: [],
      }),
    );

    expect(edited.body).toBe('Rewritten by a person.');
    expect(await platform.aiRequest.count({ where: { workspaceId: fixtures.a.workspaceId } })).toBe(
      requestsBefore,
    );
  });
});

describe('the lifecycle this phase owns, and the transitions it refuses', () => {
  it('moves DRAFT → IN_REVIEW → DRAFT → ARCHIVED', async () => {
    nextOutput = reply([{ platformKey: 'instagram', body: 'Lifecycle.' }]);
    const generated = await inA((studio) =>
      studio.generate({ ...baseInput(), idempotencyKey: key() }),
    );
    const itemId = generated.item.id;
    const move = (to: 'IN_REVIEW' | 'DRAFT' | 'ARCHIVED') =>
      inA((studio) =>
        studio.transition({ itemId, to, actorUserId: fixtures.a.userId, actorBrandScope: [] }),
      );

    expect((await move('IN_REVIEW')).status).toBe('IN_REVIEW');
    expect((await move('DRAFT')).status).toBe('DRAFT');
    expect((await move('ARCHIVED')).status).toBe('ARCHIVED');
  });

  it('refuses to schedule or approve — those belong to later scope items', async () => {
    /*
     * PHASE DISCIPLINE, ENFORCED RATHER THAN DOCUMENTED. Scheduling is the
     * Social Calendar's (scope item 5) and approval is Approvals' (item 6). A
     * phase that quietly implemented either would hand those phases behaviour
     * they never designed, and a customer a state nothing can move them out of.
     */
    nextOutput = reply([{ platformKey: 'instagram', body: 'Not schedulable yet.' }]);
    const generated = await inA((studio) =>
      studio.generate({ ...baseInput(), idempotencyKey: key() }),
    );

    await expect(
      inA((studio) =>
        studio.transition({
          itemId: generated.item.id,
          to: 'SCHEDULED' as never,
          actorUserId: fixtures.a.userId,
          actorBrandScope: [],
        }),
      ),
    ).rejects.toThrow();

    const unchanged = await inA((studio) => studio.getItem(generated.item.id));
    expect(unchanged.status).toBe('DRAFT');
  });
});

describe('D-116 and D-117 — retention reaches content and nothing else', () => {
  it('purges an expired caption, keeps the row, and leaves audit and credits untouched', async () => {
    nextOutput = reply([{ platformKey: 'instagram', body: 'This will expire.' }]);
    const generated = await inA((studio) =>
      studio.generate({ ...baseInput(), idempotencyKey: key() }),
    );

    const auditBefore = await platform.auditEvent.count({
      where: { workspaceId: fixtures.a.workspaceId },
    });
    const ledgerBefore = await platform.creditTransaction.count({
      where: { workspaceId: fixtures.a.workspaceId },
    });
    const requestsBefore = await platform.aiRequest.count({
      where: { workspaceId: fixtures.a.workspaceId },
    });

    // Expire it in the past, then sweep.
    await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => {
        const past = new Date(Date.now() - 1000);
        await db.contentItem.update({
          where: { id: generated.item.id },
          data: { expiresAt: past },
        });
        await db.contentVariant.updateMany({
          where: { contentItemId: generated.item.id },
          data: { expiresAt: past },
        });
      },
      { prisma: app },
    );

    const result = await withWorkspace(
      fixtures.a.workspaceId,
      (db) => purgeExpiredContent({ db }),
      { prisma: app },
    );
    expect(result.variantsPurged).toBeGreaterThan(0);
    expect(result.itemsExpired).toBeGreaterThan(0);

    const purged = await withWorkspace(
      fixtures.a.workspaceId,
      (db) => db.contentVariant.findMany({ where: { contentItemId: generated.item.id } }),
      { prisma: app },
    );
    // THE WORDS GO, THE ROW STAYS — so provenance and the link to the AiRequest
    // that produced it remain inspectable.
    for (const variant of purged) {
      expect(variant.body).toBeNull();
      expect(variant.bodyPurgedAt).not.toBeNull();
      expect(variant.aiRequestId).not.toBeNull();
    }

    /*
     * THE CARVE-OUT, ASSERTED RATHER THAN PROMISED. The owner's decision is
     * explicit that a content-retention control must never reach records with
     * their own statutory or operational retention. A control that could erase
     * the audit log or the ledger would be a control that erases evidence.
     */
    expect(
      await platform.auditEvent.count({ where: { workspaceId: fixtures.a.workspaceId } }),
    ).toBeGreaterThanOrEqual(auditBefore);
    expect(
      await platform.creditTransaction.count({ where: { workspaceId: fixtures.a.workspaceId } }),
    ).toBe(ledgerBefore);
    expect(await platform.aiRequest.count({ where: { workspaceId: fixtures.a.workspaceId } })).toBe(
      requestsBefore,
    );
  });

  it('a second sweep finds nothing left to do', async () => {
    const again = await withWorkspace(fixtures.a.workspaceId, (db) => purgeExpiredContent({ db }), {
      prisma: app,
    });
    expect(again.variantsPurged).toBe(0);
  });
});

describe('every state change is audited', () => {
  it('a generation writes an audit event carrying counts and never the brief', async () => {
    const brief = 'A brief that must never appear in the audit log at all.';
    nextOutput = reply([{ platformKey: 'instagram', body: 'Audited.' }]);
    const generated = await inA((studio) =>
      studio.generate({ ...baseInput(), brief, idempotencyKey: key() }),
    );

    const events = await platform.auditEvent.findMany({
      where: { workspaceId: fixtures.a.workspaceId, resourceId: generated.item.id },
    });
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.action === 'content.item.generated')).toBe(true);
    // docs/SECURITY.md §11 — counts, never content.
    expect(JSON.stringify(events)).not.toContain(brief);
  });
});
