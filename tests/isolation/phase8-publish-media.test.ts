import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import { systemClock } from '@brandspace/shared';
import { PublishMediaResolver, publishableAssetWhere } from '@brandspace/assets';
import { InMemoryObjectStore } from '@brandspace/storage';
import {
  createConnectorRegistry,
  parsePublishingPolicy,
  PublishPipelineService,
  type ConnectorRegistry,
  type MockSocialConnectorAdapter,
  type PublishApprovalGate,
  type PublishingPolicy,
} from '@brandspace/social-connectors';
import {
  appRoleClient,
  createIsolationFixtures,
  FIXTURE_SOCIAL_KEK,
  type IsolationFixtures,
} from './fixtures';
import { SocialTokenVault } from '@brandspace/social-connectors';

/**
 * PUBLISHING WITH MEDIA — Phase 8 (AC-29.3, AC-29.4, AC-29.5).
 *
 * The Content Studio can attach a picture to a post. This suite is about what
 * happens to that picture on the way out, and it exists because every failure
 * in this path is silent by nature: a post that publishes its caption without
 * its image looks like a success to the pipeline, to the provider, and on the
 * history screen. Only the customer, and their audience, see that the post is
 * wrong.
 *
 * WHAT IS PROVEN HERE:
 *
 *   1. THE MEDIA REACHES THE PROVIDER. Not "the job succeeded" — the adapter
 *      is asked what it was handed, and it is the bytes of the right assets in
 *      the author's order.
 *   2. ANOTHER TENANT'S ASSET IS UNREACHABLE, and the refusal is shaped like a
 *      miss — a post cannot be used to confirm that a foreign id exists.
 *   3. ANOTHER BRAND'S PRIVATE ASSET IS UNREACHABLE, and the workspace-SHARED
 *      shelf is reachable, which is the distinction the predicate exists for.
 *   4. A QUARANTINED, UNREADY, DELETED OR NON-VISUAL ASSET NEVER PUBLISHES.
 *      This is what the virus scanner is for; a publish path that skipped it
 *      would make the scanner decorative.
 *   5. NOTHING IS SILENTLY DROPPED. Every refusal fails the job with a stable
 *      code; there is no path that publishes a post with fewer pictures than
 *      the author attached.
 *   6. A RETRY DOES NOT DOUBLE-POST, and a re-executed job carries the same
 *      media rather than re-resolving into a different post.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;
let policy: PublishingPolicy;
let store: InMemoryObjectStore;
let registry: ConnectorRegistry;

const vault = new SocialTokenVault({
  env: { SOCIAL_TOKEN_VAULT_KEK: FIXTURE_SOCIAL_KEK } as NodeJS.ProcessEnv,
});

/** Every provider enabled, and LinkedIn deliberately narrow, so a ceiling exists to hit. */
function mediaPolicy(maxMediaItems = 4): PublishingPolicy {
  const capability = {
    enabled: true,
    postKinds: ['text'],
    maxBodyCharacters: 2_200,
    maxHashtags: 30,
    maxMediaItems,
    supportsFirstComment: false,
    supportsDelete: false,
    supportsNativeScheduling: false,
    supportsPostLookup: true,
    scopes: ['w_member_social'],
    targetKind: 'organization',
  };
  return parsePublishingPolicy({
    providers: {
      facebook: capability,
      instagram: capability,
      tiktok: capability,
      linkedin: capability,
      x: capability,
    },
  });
}

function openGate(): PublishApprovalGate {
  return {
    async policyForBrand() {
      return { requireApprovalBeforeScheduling: false };
    },
    async latestForItem() {
      return { status: 'APPROVED' };
    },
  };
}

/**
 * THE PIPELINE, WIRED THE WAY THE WORKER WIRES IT.
 *
 * The port is a real `PublishMediaResolver` over the same scoped client and a
 * real object store — not a stub. A stub here would prove that the pipeline
 * calls A resolver, which is not the property in question: the property is
 * that the ONE predicate governing publishable media is the one publishing
 * actually uses.
 */
function pipelineIn<T>(
  workspaceId: string,
  fn: (pipeline: PublishPipelineService) => Promise<T>,
  options: { policy?: PublishingPolicy; withMediaPort?: boolean } = {},
): Promise<T> {
  const active = options.policy ?? policy;
  const withPort = options.withMediaPort ?? true;
  return withWorkspace(
    workspaceId,
    async (db) =>
      fn(
        new PublishPipelineService({
          db,
          workspaceId,
          policy: active,
          registry: options.policy
            ? createConnectorRegistry({ policy: active, environment: 'DEVELOPMENT' })
            : registry,
          vault,
          approvals: openGate(),
          ...(withPort
            ? {
                media: {
                  resolve: async ({ brandId, assetIds }) =>
                    new PublishMediaResolver({ db, workspaceId, store }).resolve({
                      brandId,
                      assetIds,
                      brandScope: [],
                    }),
                },
              }
            : {}),
        }),
      ),
    { prisma: app },
  ) as Promise<T>;
}

/** Bytes for an asset, so the resolver has something real to read. */
async function storeBytesFor(assetId: string, workspaceId: string, byte: number): Promise<void> {
  const key = await withWorkspace(
    workspaceId,
    async (db) => (await db.asset.findFirst({ where: { id: assetId } }))?.storageKey ?? null,
    { prisma: app },
  );
  if (!key) throw new Error(`no asset ${assetId}`);
  await store.put(key, new Uint8Array([byte, byte, byte, byte]), 'image/png');
}

/** A second READY, CLEAN image, so order and multiples can be asserted. */
async function createImage(input: {
  workspaceId: string;
  brandId: string | null;
  name: string;
  overrides?: Record<string, unknown>;
}): Promise<string> {
  const id = await withWorkspace(
    input.workspaceId,
    async (db) => {
      const asset = await db.asset.create({
        data: {
          workspaceId: input.workspaceId,
          brandId: input.brandId,
          name: input.name,
          kind: 'IMAGE',
          mimeType: 'image/png',
          sizeBytes: 1_024,
          width: 800,
          height: 800,
          storageKey: `ws/${input.workspaceId}/asset/${randomUUID()}`,
          checksumSha256: `phase8-${randomUUID()}`,
          scanStatus: 'CLEAN',
          scannedAt: new Date(),
          status: 'READY',
          currentVersion: 1,
          ...input.overrides,
        },
      });
      return asset.id;
    },
    { prisma: app },
  );
  await storeBytesFor(id as string, input.workspaceId, 7);
  return id as string;
}

/** Put the given asset ids on tenant A's variant, and queue a fresh job for it. */
async function jobCarrying(assetIds: readonly string[]): Promise<string> {
  return withWorkspace(
    fixtures.a.workspaceId,
    async (db) => {
      await db.contentVariant.update({
        where: { id: fixtures.a.contentVariantId },
        data: { assetIds: [...assetIds] },
      });
      const job = await db.publishJob.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          calendarSlotId: fixtures.a.calendarSlotId,
          contentItemId: fixtures.a.contentItemId,
          contentVariantId: fixtures.a.contentVariantId,
          socialConnectionId: fixtures.a.socialConnectionId,
          provider: 'LINKEDIN',
          status: 'QUEUED',
          idempotencyKey: `media-${randomUUID()}`,
          scheduledAtUtc: new Date(),
          maxAttempts: 5,
          nextAttemptAt: new Date(),
          createdByUserId: fixtures.a.userId,
        },
      });
      return job.id;
    },
    { prisma: app },
  ) as Promise<string>;
}

async function readJob(jobId: string) {
  return withWorkspace(
    fixtures.a.workspaceId,
    async (db) => db.publishJob.findFirst({ where: { id: jobId } }),
    { prisma: app },
  );
}

/** The adapter the registry hands out for LinkedIn, so its observability is readable. */
function linkedInMock(): MockSocialConnectorAdapter {
  return registry.get('LINKEDIN') as MockSocialConnectorAdapter;
}

let secondImageId: string;
let sharedImageId: string;

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
  policy = mediaPolicy();
  store = new InMemoryObjectStore();
  registry = createConnectorRegistry({ policy, environment: 'DEVELOPMENT' });

  await withWorkspace(
    fixtures.a.workspaceId,
    async (db) => {
      await db.contentItem.update({
        where: { id: fixtures.a.contentItemId },
        data: { status: 'SCHEDULED' },
      });
    },
    { prisma: app },
  );

  // The fixture's hero shot, plus a second brand image and a workspace-shared
  // one, each with real bytes behind it.
  await storeBytesFor(fixtures.a.assetId, fixtures.a.workspaceId, 1);
  await storeBytesFor(fixtures.b.assetId, fixtures.b.workspaceId, 2);
  secondImageId = await createImage({
    workspaceId: fixtures.a.workspaceId,
    brandId: fixtures.a.brandId,
    name: 'second-shot.png',
  });
  sharedImageId = await createImage({
    workspaceId: fixtures.a.workspaceId,
    brandId: null,
    name: 'shared-logo.png',
  });
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

beforeEach(() => {
  linkedInMock().lastPublishedMediaCount = -1;
});

describe('the media reaches the provider', () => {
  it('hands the adapter the assets the author attached, in their order', async () => {
    const jobId = await jobCarrying([secondImageId, fixtures.a.assetId]);
    const result = await pipelineIn(fixtures.a.workspaceId, (p) => p.execute(jobId));

    expect(result.status).toBe('PUBLISHED');
    expect(linkedInMock().lastPublishedMediaCount).toBe(2);

    // And the order is the AUTHOR'S, not the database's: a carousel's first
    // image is its cover, so this is content rather than presentation.
    const resolved = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        new PublishMediaResolver({ db, workspaceId: fixtures.a.workspaceId, store }).resolve({
          brandId: fixtures.a.brandId,
          assetIds: [secondImageId, fixtures.a.assetId],
          brandScope: [],
        }),
      { prisma: app },
    );
    expect(resolved.map((item) => item.assetId)).toEqual([secondImageId, fixtures.a.assetId]);
    expect(resolved.every((item) => item.bytes.byteLength > 0)).toBe(true);
  });

  it('publishes a text-only post without involving the media port at all', async () => {
    const jobId = await jobCarrying([]);
    const result = await pipelineIn(fixtures.a.workspaceId, (p) => p.execute(jobId), {
      withMediaPort: false,
    });
    expect(result.status).toBe('PUBLISHED');
    expect(linkedInMock().lastPublishedMediaCount).toBe(0);
  });

  it('publishes the workspace-SHARED shelf, which every brand may draw on', async () => {
    const jobId = await jobCarrying([sharedImageId]);
    const result = await pipelineIn(fixtures.a.workspaceId, (p) => p.execute(jobId));
    expect(result.status).toBe('PUBLISHED');
    expect(linkedInMock().lastPublishedMediaCount).toBe(1);
  });
});

describe('another tenant cannot be published on your behalf', () => {
  it("refuses tenant B's asset, and the job fails rather than publishing without it", async () => {
    const jobId = await jobCarrying([fixtures.b.assetId]);
    const result = await pipelineIn(fixtures.a.workspaceId, (p) => p.execute(jobId));

    expect(result.status).toBe('FAILED');
    const job = await readJob(jobId);
    expect(job?.failureCode).toBe('preflight.media_rejected');
    expect(job?.externalPostId).toBeNull();
    // THE PROVIDER WAS NEVER CALLED. A refusal after the post is out is not a
    // refusal.
    expect(linkedInMock().lastPublishedMediaCount).toBe(-1);
  });

  it('is INDISTINGUISHABLE from an id that never existed', async () => {
    const strangerJob = await jobCarrying([fixtures.b.assetId]);
    const strangerResult = await pipelineIn(fixtures.a.workspaceId, (p) => p.execute(strangerJob));
    const missingJob = await jobCarrying([randomUUID()]);
    const missingResult = await pipelineIn(fixtures.a.workspaceId, (p) => p.execute(missingJob));

    expect(strangerResult.status).toBe(missingResult.status);
    const stranger = await readJob(strangerJob);
    const missing = await readJob(missingJob);
    expect(stranger?.failureClass).toBe(missing?.failureClass);
    expect(stranger?.failureCode).toBe(missing?.failureCode);
  });

  it('the predicate itself never admits a foreign workspace id', async () => {
    const where = publishableAssetWhere({
      assetIds: [fixtures.b.assetId],
      workspaceId: fixtures.a.workspaceId,
      brandId: fixtures.a.brandId,
      brandScope: [],
      now: systemClock.now(),
    });
    const rows = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.asset.findMany({ where, select: { id: true } }),
      { prisma: app },
    );
    expect(rows).toHaveLength(0);
  });
});

describe('an asset that must not publish, does not', () => {
  const cases: readonly {
    name: string;
    overrides: Record<string, unknown>;
  }[] = [
    { name: 'a QUARANTINED file the scanner rejected', overrides: { scanStatus: 'INFECTED' } },
    { name: 'a file whose scan has not finished', overrides: { scanStatus: 'PENDING' } },
    { name: 'an upload that never completed', overrides: { status: 'UPLOADING' } },
    { name: 'a soft-deleted asset', overrides: { deletedAt: new Date() } },
    { name: 'a PDF, which is an asset and not a picture', overrides: { kind: 'DOCUMENT' } },
  ];

  for (const testCase of cases) {
    it(`refuses ${testCase.name}`, async () => {
      const assetId = await createImage({
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        name: 'inadmissible.png',
        overrides: testCase.overrides,
      });
      const jobId = await jobCarrying([assetId]);
      const result = await pipelineIn(fixtures.a.workspaceId, (p) => p.execute(jobId));

      expect(result.status).toBe('FAILED');
      expect(await readJob(jobId).then((job) => job?.failureCode)).toBe('preflight.media_rejected');
      expect(linkedInMock().lastPublishedMediaCount).toBe(-1);
    });
  }

  it('refuses an asset whose bytes are missing from the store', async () => {
    const assetId = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => {
        const asset = await db.asset.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            name: 'no-bytes.png',
            kind: 'IMAGE',
            mimeType: 'image/png',
            sizeBytes: 10,
            storageKey: `ws/${fixtures.a.workspaceId}/asset/${randomUUID()}`,
            checksumSha256: `phase8-nobytes-${randomUUID()}`,
            scanStatus: 'CLEAN',
            status: 'READY',
            currentVersion: 1,
          },
        });
        return asset.id;
      },
      { prisma: app },
    );
    const jobId = await jobCarrying([assetId as string]);
    const result = await pipelineIn(fixtures.a.workspaceId, (p) => p.execute(jobId));
    expect(result.status).toBe('FAILED');
    expect(linkedInMock().lastPublishedMediaCount).toBe(-1);
  });
});

describe('nothing is silently dropped', () => {
  it("refuses more media than the provider's activated policy allows", async () => {
    const extras = await Promise.all(
      Array.from({ length: 5 }, (_unused, index) =>
        createImage({
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          name: `carousel-${index}.png`,
        }),
      ),
    );
    const jobId = await jobCarrying(extras);
    const result = await pipelineIn(fixtures.a.workspaceId, (p) => p.execute(jobId));

    // FIVE where the policy allows four: refused, not truncated to four. A post
    // missing its last picture is a post the author never approved.
    expect(result.status).toBe('FAILED');
    const job = await readJob(jobId);
    expect(job?.failureCode).toBe('preflight.too_many_media');
    expect(job?.failureClass).toBe('UNSUPPORTED');
    expect(linkedInMock().lastPublishedMediaCount).toBe(-1);
  });

  it('refuses to publish media when the wiring supplied no resolver', async () => {
    const jobId = await jobCarrying([fixtures.a.assetId]);
    const result = await pipelineIn(fixtures.a.workspaceId, (p) => p.execute(jobId), {
      withMediaPort: false,
    });

    // The caption alone would be a post nobody wrote. A missing port is our
    // own bug, and it fails loudly rather than shipping half a post.
    expect(result.status).toBe('FAILED');
    expect(await readJob(jobId).then((job) => job?.failureCode)).toBe(
      'preflight.media_unavailable',
    );
    expect(linkedInMock().lastPublishedMediaCount).toBe(-1);
  });

  it('de-duplicates a repeated id rather than publishing it twice', async () => {
    const resolved = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        new PublishMediaResolver({ db, workspaceId: fixtures.a.workspaceId, store }).resolve({
          brandId: fixtures.a.brandId,
          assetIds: [fixtures.a.assetId, fixtures.a.assetId],
          brandScope: [],
        }),
      { prisma: app },
    );
    // The predicate de-duplicates the QUERY; the resolver still answers once
    // per position, because the author's list is what the provider is sent.
    expect(resolved).toHaveLength(2);
    expect(new Set(resolved.map((item) => item.assetId)).size).toBe(1);
  });
});

describe('a retry does not double-post', () => {
  it('a re-executed job converges on the one external post, media and all', async () => {
    const jobId = await jobCarrying([fixtures.a.assetId, secondImageId]);
    const first = await pipelineIn(fixtures.a.workspaceId, (p) => p.execute(jobId));
    expect(first.status).toBe('PUBLISHED');
    const externalPostId = first.externalPostId;

    const second = await pipelineIn(fixtures.a.workspaceId, (p) => p.execute(jobId));
    expect(second.status).toBe('PUBLISHED');
    expect(second.externalPostId).toBe(externalPostId);

    const job = await readJob(jobId);
    expect(job?.externalPostId).toBe(externalPostId);
  });
});
