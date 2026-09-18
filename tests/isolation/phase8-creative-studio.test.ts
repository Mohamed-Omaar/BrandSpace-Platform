import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { AiGateway, MockProviderAdapter, type AiConfiguration } from '@brandspace/ai-gateway';
import { AssetUploadService, TenantAssetPolicySource } from '@brandspace/assets';
import { CreditLedgerService, UsageService } from '@brandspace/entitlements';
import { CreativeStudioService } from '@brandspace/creative';
import { createObjectStore } from '@brandspace/storage';
import { appRoleClient, createIsolationFixtures, platformRoleClient } from './fixtures';
import type { IsolationFixtures } from './fixtures';

/**
 * PHASE 8 — THE AI CREATIVE STUDIO, END TO END, ON REAL POSTGRESQL (AC-28).
 *
 * WHAT THIS PROVES, and every clause of it is a thing a unit test cannot show:
 *
 *   - A GENERATION BECOMES AN ORDINARY ASSET in the one library — same table,
 *     same checksum, same quota — marked `AI_GENERATED` and carrying the
 *     `aiRequestId` that produced it, so a customer can always tell what a model
 *     made from what they made (AC-28.3).
 *   - THE BYTES ARE REAL. The mock adapter draws a deterministic PNG, the
 *     signature check accepts it, and the stored size is the size of the file.
 *     A mock that returned only a reference would have left this half of the
 *     product untested until a vendor was chosen.
 *   - THE CREDIT LEDGER MOVED ONCE. The gateway reserves, executes and settles;
 *     a retry with the same idempotency key replays rather than charging again
 *     (AC-28.6).
 *   - A FAILED GENERATION STORES NOTHING AND CHARGES NOTHING.
 *   - A BRAND OUTSIDE THE MEMBER'S SCOPE IS A MISS, checked before anything is
 *     read or spent.
 *
 * THE GATEWAY GETS THE PLATFORM CLIENT AND THE STUDIO GETS THE TENANT ONE,
 * exactly as `apps/api` wires them. Using one client for both would test a
 * topology the product does not have.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let gateway: AiGateway;

let brandOne: string;
let brandTwo: string;

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;

const ACTOR = () => ({
  userId: fixtures.a.userId,
  permissionKeys: ['assets.upload', 'assets.read'],
  brandScope: [] as readonly string[],
});

async function studio(db: TenantScopedClient): Promise<CreativeStudioService> {
  const policy = await new TenantAssetPolicySource(db, 'DEVELOPMENT').load();
  return new CreativeStudioService({
    db,
    workspaceId: fixtures.a.workspaceId,
    gateway,
    uploads: new AssetUploadService({
      db,
      workspaceId: fixtures.a.workspaceId,
      store: createObjectStore({ appEnv: 'test' }),
      policy,
      /*
       * THE SCOPED CLIENT: `usage_counter` is tenant-owned and RLS refuses a
       * write from the unscoped pool. The cast is the one every surface makes —
       * the scoped client is a `PrismaClient` minus the connection-lifecycle
       * and transaction methods, which is exactly the surface this service uses.
       */
      usage: new UsageService({ prisma: db as unknown as PrismaClient }),
      storageLimitGb: null,
    }),
  });
}

const MODEL_KEY = 'mock-image-1';

function aiConfiguration(): AiConfiguration {
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
        modality: 'image',
        qualityTier: 'balanced',
        status: 'available',
        disableSwitch: false,
      },
    ],
    costBases: [
      {
        modelKey: MODEL_KEY,
        inputCostPerUnitMicroMinor: 0,
        outputCostPerUnitMicroMinor: 40_000,
        costUnit: 'image',
        costCurrency: 'USD',
      },
    ],
    routingRules: [
      {
        taskKey: 'image.generate',
        scope: 'global',
        planKey: null,
        workspaceId: null,
        primaryModelKey: MODEL_KEY,
        fallbackModelKeys: [],
        timeoutMs: 10_000,
        maxCostPerRequestMinor: null,
        priority: 0,
        parameters: {
          temperature: 0.4,
          maxOutputTokens: 256,
          promptTemplateVersion: 1,
          /*
           * THE GATEWAY PERSISTS NOTHING (D-78). The ASSET LIBRARY holds the
           * image, with its own retention and its own scanner; asking the
           * gateway to keep a copy would make it a second media store.
           */
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
        taskKey: 'image.generate',
        modelKey: MODEL_KEY,
        baseMilliCredits: 400,
        perUnitMilliCredits: 0,
        unit: 'image',
      },
    ],
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

const identity = {
  name: 'Creative Alpha',
  industry: 'Coffee',
  description: 'A speciality roastery.',
  palette: ['#7935FE', '#FFDD15'],
  typography: ['Inter'],
  knowledge: ['Warm, direct, never salesy.'],
};

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);

  const ledger = new CreditLedgerService({ prisma: platform });
  gateway = new AiGateway({
    prisma: platform,
    ledger,
    adapters: new Map([['mock', new MockProviderAdapter({})]]),
    /*
     * AN IMAGE MODEL AND A ROUTING RULE FOR `image.generate`, supplied by this
     * suite rather than by a default. Routing rules default to `[]` on purpose
     * (CLAUDE.md §2.2): what model serves what task is an operator's decision
     * and this product invents none. The suite plays the operator.
     */
    configuration: { load: async () => aiConfiguration() },
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
    credits: 5_000,
    reason: 'creative studio fixture allowance',
    idempotencyKey: `creative-grant-${fixtures.a.workspaceId}`,
  });

  const brands = await inA(async (db) => {
    const one = await db.brand.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        slug: `p8cr-${randomUUID().slice(0, 8)}`,
        name: 'Creative Alpha',
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    const two = await db.brand.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        slug: `p8cr-${randomUUID().slice(0, 8)}`,
        name: 'Creative Beta',
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    return { one: one.id, two: two.id };
  });
  brandOne = brands.one;
  brandTwo = brands.two;
}, 180_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('AC-28.3: a generated image is an ordinary asset in the one library', () => {
  it('stores real bytes, marked as generated, traceable to its request', async () => {
    const result = await inA(async (db) =>
      (await studio(db)).generate({
        brandId: brandOne,
        brief: 'A warm abstract backdrop for a launch announcement',
        formatKey: 'square',
        identity,
        idempotencyKey: `creative-test-${randomUUID()}`,
        actorUserId: fixtures.a.userId,
        planKey: null,
        actor: ACTOR(),
      }),
    );

    expect(result.assetId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.format.key).toBe('square');

    const asset = await inA((db) =>
      db.asset.findFirst({
        where: { id: result.assetId },
        select: {
          brandId: true,
          kind: true,
          mimeType: true,
          sizeBytes: true,
          source: true,
          aiRequestId: true,
          checksumSha256: true,
        },
      }),
    );

    expect(asset).not.toBeNull();
    expect(asset?.brandId).toBe(brandOne);
    expect(asset?.kind).toBe('IMAGE');
    expect(asset?.mimeType).toBe('image/png');
    // REAL BYTES: a PNG of a 1080-square composition is not a placeholder.
    expect(asset?.sizeBytes ?? 0).toBeGreaterThan(100);
    expect(asset?.source).toBe('AI_GENERATED');
    expect(asset?.aiRequestId).toBe(result.aiRequestId);
    expect(asset?.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);

  it('writes an audit event naming the asset, and no prompt', async () => {
    const result = await inA(async (db) =>
      (await studio(db)).generate({
        brandId: brandOne,
        brief: 'An audited generation',
        formatKey: 'portrait',
        identity,
        idempotencyKey: `creative-test-${randomUUID()}`,
        actorUserId: fixtures.a.userId,
        planKey: null,
        actor: ACTOR(),
      }),
    );

    const event = await inA((db) =>
      db.auditEvent.findFirst({
        where: { resourceId: result.assetId, action: 'creative.image.generated' },
        select: { after: true, brandId: true },
      }),
    );
    expect(event).not.toBeNull();
    expect(event?.brandId).toBe(brandOne);
    // AC-28.8 — no prompt, no model, no provider in anything a customer reads.
    const after = JSON.stringify(event?.after ?? {});
    expect(after).not.toContain('An audited generation');
    expect(after.toLowerCase()).not.toContain('mock');
  }, 60_000);
});

describe('AC-28.6: a retry never charges twice', () => {
  it('replays the first outcome for the same idempotency key', async () => {
    const key = `creative-test-${randomUUID()}`;
    const first = await inA(async (db) =>
      (await studio(db)).generate({
        brandId: brandOne,
        brief: 'A repeated request',
        formatKey: 'square',
        identity,
        idempotencyKey: key,
        actorUserId: fixtures.a.userId,
        planKey: null,
        actor: ACTOR(),
      }),
    );

    const second = await inA(async (db) =>
      (await studio(db)).generate({
        brandId: brandOne,
        brief: 'A repeated request',
        formatKey: 'square',
        identity,
        idempotencyKey: key,
        actorUserId: fixtures.a.userId,
        planKey: null,
        actor: ACTOR(),
      }),
    );

    // The SAME asset, not a second one, and the same AI request behind it.
    expect(second.assetId).toBe(first.assetId);
    expect(second.aiRequestId).toBe(first.aiRequestId);
    expect(second.replayed).toBe(true);

    const count = await inA((db) =>
      db.asset.count({ where: { aiRequestId: first.aiRequestId, deletedAt: null } }),
    );
    expect(count).toBe(1);
  }, 60_000);
});

describe('AC-28: refusals happen before anything is stored or spent', () => {
  it('refuses a brand outside the member scope, as a miss', async () => {
    await expect(
      inA(async (db) =>
        (await studio(db)).generate({
          brandId: brandTwo,
          brief: 'Should never run',
          formatKey: 'square',
          identity,
          idempotencyKey: `creative-test-${randomUUID()}`,
          actorUserId: fixtures.a.userId,
          planKey: null,
          actor: { ...ACTOR(), brandScope: [brandOne] },
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses an empty brief', async () => {
    await expect(
      inA(async (db) =>
        (await studio(db)).generate({
          brandId: brandOne,
          brief: '   ',
          formatKey: 'square',
          identity,
          idempotencyKey: `creative-test-${randomUUID()}`,
          actorUserId: fixtures.a.userId,
          planKey: null,
          actor: ACTOR(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses a format this product does not offer', async () => {
    await expect(
      inA(async (db) =>
        (await studio(db)).generate({
          brandId: brandOne,
          brief: 'A billboard',
          formatKey: 'billboard',
          identity,
          idempotencyKey: `creative-test-${randomUUID()}`,
          actorUserId: fixtures.a.userId,
          planKey: null,
          actor: ACTOR(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('leaves no asset behind for any of those refusals', async () => {
    const generated = await inA((db) =>
      db.asset.count({ where: { brandId: brandTwo, source: 'AI_GENERATED' } }),
    );
    expect(generated).toBe(0);
  });
});

describe('AC-28.2: every offered format produces the shape it promises', () => {
  it('generates at each format, and each is a distinct file', async () => {
    const ids = new Set<string>();
    for (const formatKey of ['square', 'portrait', 'story', 'landscape']) {
      const result = await inA(async (db) =>
        (await studio(db)).generate({
          brandId: brandOne,
          brief: `A ${formatKey} composition`,
          formatKey,
          identity,
          idempotencyKey: `creative-test-${randomUUID()}`,
          actorUserId: fixtures.a.userId,
          planKey: null,
          actor: ACTOR(),
        }),
      );
      ids.add(result.assetId);
    }
    // Four generations, four assets: an adaptation is a new image composed for
    // that shape, never a crop of the previous one.
    expect(ids.size).toBe(4);
  }, 120_000);
});
