import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AiGateway, type AiConfiguration, type AiProviderAdapter } from '@brandspace/ai-gateway';
import { CreditLedgerService, type CreditPolicy } from '@brandspace/entitlements';
import {
  OutboxEmailProvider,
  UnconfiguredEmailProvider,
  createEmailProvider,
} from '@brandspace/auth';
import { SecretService } from '@brandspace/secrets';
import { appRoleClient } from './fixtures';

/**
 * PRODUCTION-MODE NEGATIVE TESTS - Phase 10 section 28.
 *
 * WHAT MAKES THESE EXIT GATES rather than coverage: every one asserts that
 * something REFUSES, and each refusal replaces a specific way the platform
 * could come up looking healthy while being wrong.
 *
 * AND WHY THEY RUN AGAINST REAL POSTGRESQL. The interesting half is not
 * whether the function throws - a unit test settles that, and one does. It is
 * what happens to the LEDGER when it throws: a request that fails closed must
 * release its reservation and charge nothing, and that is a property of rows in
 * a database, not of a mock.
 */

const POLICY: CreditPolicy = {
  hardStopAtZero: true,
  purchasedPackExpiryMonths: 12,
  promotionalExpiryMonths: 3,
  planGrantExpiryMonths: 0,
  lowBalanceThresholdPercents: [],
  reservationTimeoutSeconds: 900,
};

const TASK_KEY = 'caption.generate';
const MODEL = 'unreachable-model';

let platform: PrismaClient;
let app: PrismaClient;
let ledger: CreditLedgerService;
const CREATED_WORKSPACE_IDS: string[] = [];

/**
 * A configuration that routes correctly to a model whose provider has NO
 * ADAPTER - which is exactly the shape of a production deployment that has not
 * configured an AI provider yet.
 */
function configuration(): AiConfiguration {
  return {
    providers: [
      {
        key: 'nobody',
        baseUrl: 'https://unconfigured.invalid',
        apiKeySecretRef: null,
        status: 'active',
        timeoutMs: 5_000,
      },
    ],
    models: [
      {
        key: MODEL,
        providerKey: 'nobody',
        modality: 'text',
        qualityTier: 'balanced',
        status: 'available',
        disableSwitch: false,
      },
    ],
    costBases: [],
    routingRules: [
      {
        taskKey: TASK_KEY,
        scope: 'global',
        planKey: null,
        workspaceId: null,
        primaryModelKey: MODEL,
        fallbackModelKeys: [],
        timeoutMs: 5_000,
        maxCostPerRequestMinor: null,
        priority: 0,
        parameters: {
          temperature: 0.7,
          maxOutputTokens: 64,
          promptTemplateVersion: 1,
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
        modelKey: MODEL,
        baseMilliCredits: 100,
        perUnitMilliCredits: 50,
        unit: '1k_tokens',
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

function unconfiguredGateway(): AiGateway {
  return new AiGateway({
    prisma: platform,
    ledger,
    // EMPTY. This is the whole point of the suite.
    adapters: new Map<string, AiProviderAdapter>(),
    configuration: { load: async () => configuration() },
    credentials: { resolve: async () => null },
    environment: 'PRODUCTION',
    random: () => 0.5,
  });
}

async function freshWorkspace(credits: number): Promise<string> {
  const run = crypto.randomUUID();
  const user = await platform.user.create({
    data: {
      email: `prod-${run}@example.local`,
      name: 'Production Negative Fixture',
      status: 'ACTIVE',
      timezone: 'UTC',
    },
  });
  const workspace = await platform.workspace.create({
    data: {
      country: 'US',
      defaultLocale: 'EN',
      timezone: 'UTC',
      currency: 'USD',
      id: run,
      workspaceId: run,
      slug: `prod-${run.slice(0, 12)}`,
      name: 'Production Negative Fixture',
      ownerUserId: user.id,
      status: 'ACTIVE',
    },
  });
  await platform.creditWallet.create({ data: { workspaceId: workspace.id } });
  CREATED_WORKSPACE_IDS.push(workspace.id);
  await ledger.grant({
    workspaceId: workspace.id,
    source: 'PLAN_GRANT',
    credits,
    reason: 'production-negative fixture allowance',
    idempotencyKey: `prod-grant-${run}`,
  });
  return workspace.id;
}

beforeAll(async () => {
  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) throw new Error('DATABASE_PLATFORM_URL is required.');
  platform = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  app = appRoleClient();
  ledger = new CreditLedgerService({ prisma: platform, policy: POLICY });
}, 90_000);

afterAll(async () => {
  if (platform && CREATED_WORKSPACE_IDS.length > 0) {
    await platform.aiRequest.deleteMany({
      where: {
        workspaceId: { in: CREATED_WORKSPACE_IDS },
        status: { in: ['PENDING', 'RESERVED', 'RUNNING'] },
      },
    });
    await platform.creditReservation.deleteMany({
      where: { workspaceId: { in: CREATED_WORKSPACE_IDS } },
    });
  }
  await platform?.$disconnect();
  await app?.$disconnect();
});

describe('AI with no provider configured fails closed and charges nothing', () => {
  it('refuses the request, releases the reservation and leaves the balance untouched', async () => {
    /*
     * THE SHAPE OF AN UNCONFIGURED PRODUCTION DEPLOYMENT. Phase 10 removed the
     * mock adapter from production registration, so the registry is empty and
     * the chain finds nothing to call. What must NOT happen is the expensive
     * failure: a reservation held open, or credits taken for work nobody did.
     */
    const gateway = unconfiguredGateway();
    const workspaceId = await freshWorkspace(10);
    const before = await platform.creditWallet.findUniqueOrThrow({ where: { workspaceId } });

    const result = await gateway.execute({
      workspaceId,
      userId: null,
      taskKey: TASK_KEY,
      planKey: null,
      idempotencyKey: `prod-${crypto.randomUUID()}`,
      input: { kind: 'text', prompt: 'Write a launch announcement.' },
    });

    expect(result.status).toBe('FAILED');

    const after = await platform.creditWallet.findUniqueOrThrow({ where: { workspaceId } });
    // Not a penny, and not a held reservation either.
    expect(after.balanceMilliCredits).toBe(before.balanceMilliCredits);
    expect(after.reservedMilliCredits).toBe(0n);

    // And no ledger row: a failed provider request never results in a
    // deduction (CLAUDE.md section 2.4).
    expect(await platform.aiUsageLedger.count({ where: { workspaceId } })).toBe(0);
  }, 60_000);

  it('produces no output, so nothing can be mistaken for a generated answer', async () => {
    const gateway = unconfiguredGateway();
    const workspaceId = await freshWorkspace(10);
    const result = await gateway.execute({
      workspaceId,
      userId: null,
      taskKey: TASK_KEY,
      planKey: null,
      idempotencyKey: `prod-${crypto.randomUUID()}`,
      input: { kind: 'text', prompt: 'Write something.' },
    });
    expect(result.status).toBe('FAILED');
    expect(result.output).toBeNull();
  }, 60_000);
});

describe('the email boundary', () => {
  const previousAppEnv = process.env['APP_ENV'];

  afterAll(() => {
    if (previousAppEnv === undefined) delete process.env['APP_ENV'];
    else process.env['APP_ENV'] = previousAppEnv;
  });

  it('records a message outside production, which is what a test needs', async () => {
    const provider = new OutboxEmailProvider(platform);
    const { messageId } = await provider.send({
      to: 'someone@example.local',
      templateKey: 'auth.email_verification',
      locale: 'EN',
    });
    const row = await platform.emailMessage.findUnique({ where: { id: messageId } });
    expect(row?.status).toBe('SENT');
    await platform.emailMessage.delete({ where: { id: messageId } });
  });

  it('refuses to exist in production rather than reporting mail as sent', () => {
    /*
     * The outbox writes SENT and delivers nothing - correct for development and
     * a lie in production, where a customer who never receives a verification
     * link cannot finish signing up.
     */
    process.env['APP_ENV'] = 'production';
    try {
      expect(() => new OutboxEmailProvider(platform)).toThrow(/development double/i);
      // And the factory REVERSES its default rather than falling back to it.
      expect(createEmailProvider(platform)).toBeInstanceOf(UnconfiguredEmailProvider);
    } finally {
      if (previousAppEnv === undefined) delete process.env['APP_ENV'];
      else process.env['APP_ENV'] = previousAppEnv;
    }
  });

  it('fails LOUDLY at the call site when nothing is configured', async () => {
    await expect(
      new UnconfiguredEmailProvider('nobody').send({
        to: 'someone@example.local',
        templateKey: 'auth.email_verification',
        locale: 'EN',
      }),
    ).rejects.toThrow(/nothing was sent/i);
  });
});

describe('a stored secret never comes back', () => {
  it('returns masked metadata on write and offers no read path at all', async () => {
    /*
     * Section 28's rule, against the real vault. `createSecret` returns
     * metadata; the service has no reveal operation, and `resolveSecret` is
     * reachable only from an integration adapter immediately before handing the
     * value to a provider. What a screen or an API can obtain is this shape.
     */
    const secrets = new SecretService({ prisma: platform });
    const actor = {
      platformUserId: (await platform.platformUser.findFirstOrThrow()).id,
      roleKey: 'platform_owner',
      mfaVerified: true,
      permissionKeys: ['platform.secret.manage', 'platform.secret.read'],
    };
    const ref = `other/phase10-probe/development/value-${crypto.randomUUID()}`;
    const value = `super-secret-${crypto.randomUUID()}`;

    const metadata = await secrets.createSecret(actor, {
      ref,
      name: 'Phase 10 probe',
      category: 'other',
      environment: 'DEVELOPMENT',
      value,
    });

    expect(JSON.stringify(metadata)).not.toContain(value);
    /*
     * AT MOST THE LAST FOUR CHARACTERS OF THE VALUE, which is what an operator
     * needs to confirm they pasted the right thing. The hint is written as
     * `...abcd`, so the assertion is on how much of the VALUE it reveals rather
     * than on the string's own length.
     */
    const hint = metadata.maskedHint ?? '';
    const revealed = hint.replace(/^[^A-Za-z0-9]+/, '');
    expect(revealed.length).toBeLessThanOrEqual(4);
    expect(value.endsWith(revealed)).toBe(true);
    expect(metadata.fingerprint).toBeTruthy();
    // The fingerprint is a DIGEST, not a prefix: it must not reveal the value.
    expect(metadata.fingerprint ?? '').not.toContain(value.slice(0, 8));

    // Nothing in the listing carries it either.
    const page = await secrets.listSecrets(actor, { environment: 'DEVELOPMENT', pageSize: 100 });
    expect(JSON.stringify(page)).not.toContain(value);

    /*
     * CLEAN UP THIS RUN'S OWN ROW. F-53: neither suite used to remove what it
     * created, and a long-lived local database drifted until an admin listing
     * timed out. `secretRecordId` rather than a nested filter, which the
     * relation does not expose.
     */
    const record = await platform.secretRecord.findFirst({ where: { ref } });
    if (record) {
      await platform.secretVersion.deleteMany({ where: { secretRecordId: record.id } });
      await platform.secretRecord.delete({ where: { id: record.id } });
    }
  }, 60_000);
});

describe('ordinary workspace members cannot reach platform state', () => {
  it('refuses the tenant role the health table, the secrets and the configuration', async () => {
    await expect(app.integrationHealthCheck.findMany()).rejects.toThrow(/permission denied/i);
    await expect(app.secretRecord.findMany()).rejects.toThrow(/permission denied/i);
    await expect(app.configurationVersion.findMany()).rejects.toThrow(/permission denied/i);
  });
});
