import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import { UsageService } from '@brandspace/entitlements';
import { ConfigurationService, type ConfigActor } from '@brandspace/config';
import {
  BrandIngestionService,
  BrandKnowledgeService,
  ExtractorRegistry,
  InMemoryObjectStore,
  PlainTextExtractor,
  TenantBrandBrainPolicySource,
  resolveBrandBrainPolicy,
} from '@brandspace/brand-brain';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * BRAND BRAIN POLICY IS CONFIGURATION, AND THIS PROVES IT END TO END.
 *
 * The Phase 5A delivery hard-coded every one of these numbers in two places —
 * `apps/api` and `apps/dashboard` — under comments saying they mirrored the
 * `brand-brain` configuration schema. Nothing tested the claim, and it was the
 * kind of defect that never shows up as a failure: an owner changes the
 * retention window in Platform Admin, everything keeps working, and the chat
 * notice goes on promising ninety days (CLAUDE.md §2.2).
 *
 * So the test is deliberately shaped as the OWNER'S ACTION and its consequences:
 * activate a version that sets values nothing in the codebase contains, then
 * assert that the platform side, the tenant side, and the three services that
 * consume the policy all behave differently as a result — with no source edit,
 * no restart and no argument passed by the test.
 */

const ENVIRONMENT = 'DEVELOPMENT';

/*
 * Values chosen so that a passing test cannot be explained by a default.
 * `grep -r` finds none of them in the source tree.
 */
const RETENTION_DAYS = 17;
const REVIEW_INTERVAL_DAYS = 5;
const MAX_FILE_BYTES = 512;
const MAX_DOCUMENTS = 3;
const STUCK_AFTER_SECONDS = 111;
const CHUNK_TARGET = 275;
const CONFIDENCE_FLOOR = 615;

let fixtures: IsolationFixtures;
let app: PrismaClient;
let platform: PrismaClient;
let configuration: ConfigurationService;

let ACTOR: ConfigActor;

const ACTOR_TEMPLATE = {
  roleKey: 'platform_owner',
  mfaVerified: true,
  permissionKeys: [
    'platform.configuration.read',
    'platform.configuration.manage',
    'platform.configuration.activate',
  ],
} as const;

type ScopedDb = Parameters<Parameters<typeof withWorkspace>[1]>[0];

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  // The fixtures' own platform user, so the audit row the service writes has a
  // real actor to point at rather than an invented id.
  ACTOR = { platformUserId: fixtures.platformUserId, ...ACTOR_TEMPLATE };
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

beforeEach(() => {
  // A fresh service per test, so the 30-second read cache inside it cannot make
  // one test observe another's activation.
  configuration = new ConfigurationService({ prisma: platform, cacheTtlMs: 0 });
});

/** Activate a `brand-brain` version carrying the values above. */
async function activatePolicy(overrides: Record<string, unknown> = {}): Promise<void> {
  const payload = {
    upload: {
      allowedMimeTypes: ['text/plain', 'text/markdown'],
      maxFileBytes: MAX_FILE_BYTES,
      maxDocumentsPerBrand: MAX_DOCUMENTS,
    },
    ingestion: {
      maxAttempts: 2,
      retryBackoffSeconds: 30,
      stuckAfterSeconds: STUCK_AFTER_SECONDS,
      chunkTargetChars: CHUNK_TARGET,
      chunkOverlapChars: 25,
      maxChunksPerDocument: 40,
    },
    knowledge: {
      reviewIntervalDays: REVIEW_INTERVAL_DAYS,
      minimumCandidateConfidenceMilli: CONFIDENCE_FLOOR,
    },
    chat: {
      retentionDays: RETENTION_DAYS,
      maxContextItems: 3,
      maxContextChunks: 2,
      maxContextChars: 900,
    },
    ...overrides,
  };

  const draft = await configuration.createDraft(
    ACTOR,
    'brand-brain',
    ENVIRONMENT,
    'Isolation test: prove the policy is read rather than restated.',
    payload,
  );
  await configuration.validateDraft(ACTOR, draft.id);
  await configuration.activate(ACTOR, draft.id, { acknowledgeHighImpact: true });
}

async function inA<T>(fn: (db: ScopedDb) => Promise<T>): Promise<T> {
  return withWorkspace(fixtures.a.workspaceId, fn, { prisma: app });
}

describe('an activated configuration version reaches the tenant side', () => {
  it('the projection carries what the owner activated, read on the TENANT role', async () => {
    await activatePolicy();

    const policy = await inA(async (db) =>
      new TenantBrandBrainPolicySource(db as never, ENVIRONMENT).load(),
    );

    expect(policy.chat.retentionDays).toBe(RETENTION_DAYS);
    expect(policy.staleness.reviewIntervalDays).toBe(REVIEW_INTERVAL_DAYS);
    expect(policy.ingestion.maxFileBytes).toBe(MAX_FILE_BYTES);
    expect(policy.ingestion.maxDocumentsPerBrand).toBe(MAX_DOCUMENTS);
    expect(policy.ingestion.chunkTargetChars).toBe(CHUNK_TARGET);
    expect(policy.ingestion.minimumCandidateConfidenceMilli).toBe(CONFIDENCE_FLOOR);
    expect(policy.stuckAfterSeconds).toBe(STUCK_AFTER_SECONDS);
  });

  it('the platform side reads the SAME document, so the two cannot disagree', async () => {
    await activatePolicy();

    const [tenantSide, platformSide] = await Promise.all([
      inA(async (db) => new TenantBrandBrainPolicySource(db as never, ENVIRONMENT).load()),
      resolveBrandBrainPolicy(configuration, ENVIRONMENT),
    ]);

    // `apps/api` resolves chat policy the platform way and the dashboard
    // resolves it the tenant way. Phase 5A had them as two literal objects that
    // happened to agree; this asserts they are one document.
    expect(tenantSide).toEqual(platformSide);
  });

  it('a SECOND activation changes the answer, with nothing in the code touched', async () => {
    await activatePolicy();
    const before = await inA(async (db) =>
      new TenantBrandBrainPolicySource(db as never, ENVIRONMENT).load(),
    );
    expect(before.chat.retentionDays).toBe(RETENTION_DAYS);

    await activatePolicy({
      chat: {
        retentionDays: 1,
        maxContextItems: 3,
        maxContextChunks: 2,
        maxContextChars: 900,
      },
    });

    const after = await inA(async (db) =>
      new TenantBrandBrainPolicySource(db as never, ENVIRONMENT).load(),
    );
    expect(after.chat.retentionDays).toBe(1);
  });

  it('the tenant role cannot read the configuration table itself', async () => {
    await activatePolicy();

    /*
     * THE OTHER HALF OF THE RULE. The projection exists so the customer surface
     * never touches `configuration_version` — which carries every domain,
     * including `ai.*` routing and `integrations.*` — and this asserts the
     * database refuses it rather than trusting that no one wrote the query.
     */
    await expect(
      inA(async (db) => db.$queryRawUnsafe('SELECT 1 FROM "configuration_version" LIMIT 1')),
    ).rejects.toThrow(/permission denied/i);
  });

  it('the catalogue refuses a domain the CHECK does not admit', async () => {
    // The constraint is the guarantee that a future caller cannot project an
    // `ai.*` or `integrations.*` payload where a customer can read it.
    await expect(
      platform.$executeRawUnsafe(
        `INSERT INTO "entitlement_catalogue_snapshot" ("domain","environment","payload","sourceVersionId","updatedAt")
         VALUES ('ai.routing', 'DEVELOPMENT', '{}'::jsonb, gen_random_uuid(), now())`,
      ),
    ).rejects.toThrow(/allowed_domains/i);
  });
});

describe('the configured policy changes what the services actually do', () => {
  it('the review interval decides when knowledge falls due', async () => {
    await activatePolicy();

    const itemKey = `policy-review-${Date.now()}`;
    const reviewDueAt = await inA(async (db) => {
      const policy = await new TenantBrandBrainPolicySource(db as never, ENVIRONMENT).load();
      const knowledge = new BrandKnowledgeService({
        db: db as never,
        workspaceId: fixtures.a.workspaceId,
      });
      const item = await knowledge.createItem({
        brandId: fixtures.a.brandId,
        area: 'IDENTITY',
        itemKey,
        title: { en: 'Positioning' },
        body: { en: 'We help independent retailers compete.' },
        actor: {
          userId: fixtures.a.userId,
          permissionKeys: ['brand_brain.edit'],
          brandScope: [],
        },
        policy: policy.staleness,
      });
      return item.reviewDueAt;
    });

    const days = Math.round((reviewDueAt!.getTime() - Date.now()) / 86_400_000);
    // Five, because an owner said five. The schema's default is 180.
    expect(days).toBe(REVIEW_INTERVAL_DAYS);
  });

  it('the upload ceiling refuses a file the previous ceiling would have taken', async () => {
    await activatePolicy();

    const store = new InMemoryObjectStore();
    // Comfortably under the 25 MB schema default, comfortably over the 512 the
    // owner activated. Under the old hard-coded policy this upload succeeded.
    const bytes = Buffer.alloc(2_048, 0x61);

    await expect(
      inA(async (db) => {
        const policy = await new TenantBrandBrainPolicySource(db as never, ENVIRONMENT).load();
        const ingestion = new BrandIngestionService({
          db: db as never,
          workspaceId: fixtures.a.workspaceId,
          // B-8 — uploads charge the workspace storage quota; unlimited here.
          storage: {
            usage: new UsageService({ prisma: db as unknown as PrismaClient }),
            limitGb: null,
          },
          store,
          policy: policy.ingestion,
          // The CONFIGURED limits, so this too would change with an activation.
          extractors: new ExtractorRegistry([new PlainTextExtractor(policy.extraction)]),
        });
        return ingestion.upload({
          brandId: fixtures.a.brandId,
          fileName: 'too-large.txt',
          mimeType: 'text/plain',
          bytes,
          idempotencyKey: `policy-too-large-${Date.now()}`,
          actorUserId: fixtures.a.userId,
          // Unrestricted, which is what every membership carries today (F-74).
          actorBrandScope: [],
        });
      }),
    ).rejects.toThrow();
  });

  it('the allowed media types are the activated list, not a list in the source', async () => {
    await activatePolicy();

    const policy = await inA(async (db) =>
      new TenantBrandBrainPolicySource(db as never, ENVIRONMENT).load(),
    );

    // The activated list omits PDF; the schema default includes it. A source
    // that still carried its own copy would report the default here.
    expect(policy.ingestion.allowedMimeTypes).toEqual(['text/plain', 'text/markdown']);
    expect(policy.ingestion.allowedMimeTypes).not.toContain('application/pdf');
  });
});
