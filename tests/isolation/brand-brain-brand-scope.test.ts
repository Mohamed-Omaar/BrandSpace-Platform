import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import { assertBrandInScope, brandInScope, brandScopeFilter } from '@brandspace/shared';
import {
  BrandIngestionService,
  BrandKnowledgeService,
  ExtractorRegistry,
  InMemoryObjectStore,
  PlainTextExtractor,
  type ExtractionLimits,
  type IngestionPolicy,
} from '@brandspace/brand-brain';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * `Membership.brandScope`, enforced — F-74 closed.
 *
 * WHAT THE GAP WAS. docs/SECURITY.md §4.2 defines brand-scope resolution as
 * "membership role AND brand in `brandScope`". Phase 5A introduced the first
 * brand-scoped resources and no code path consulted the field, so a member
 * could name any `brandId` in their own workspace and reach it. Not exploitable
 * at the time — nothing sets the field, so it is empty for every membership in
 * existence — and a real privilege escalation the day a scope-setting screen
 * ships, with nothing failing to announce it.
 *
 * WHY A SECOND BRAND IN THE SAME WORKSPACE. This is not tenant isolation and
 * the existing suite does not cover it: RLS already makes another WORKSPACE's
 * brands invisible, and that boundary is tested elsewhere. The question here is
 * the finer grain INSIDE one workspace, where both brands are legitimately the
 * tenant's and the database will happily return either.
 *
 * The real service, the real database, the real RLS context throughout.
 */

let fixtures: IsolationFixtures;
let app: PrismaClient;
/** A second brand in workspace A, which the scoped member may NOT touch. */
let otherBrandId: string;

type ScopedDb = Parameters<Parameters<typeof withWorkspace>[1]>[0];

const POLICY = { reviewIntervalDays: 180 };

const LIMITS: ExtractionLimits = {
  maxPages: 10,
  maxTextChars: 50_000,
  maxArchiveEntries: 64,
  maxArchiveBytes: 4 * 1024 * 1024,
  maxCompressionRatio: 200,
  timeoutMs: 20_000,
};

const UPLOAD_POLICY: IngestionPolicy = {
  allowedMimeTypes: ['text/plain'],
  maxFileBytes: 1024 * 1024,
  maxDocumentsPerBrand: 50,
  maxAttempts: 3,
  retryBackoffSeconds: 60,
  chunkTargetChars: 300,
  chunkOverlapChars: 50,
  maxChunksPerDocument: 50,
  minimumCandidateConfidenceMilli: 400,
};

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);

  otherBrandId = await withWorkspace(
    fixtures.a.workspaceId,
    async (db) => {
      const brand = await db.brand.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          name: 'Second Brand',
          slug: `second-brand-${crypto.randomUUID().slice(0, 8)}`,
          status: 'ACTIVE',
        },
      });
      return brand.id;
    },
    { prisma: app },
  );
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

async function inA<T>(fn: (db: ScopedDb) => Promise<T>): Promise<T> {
  return withWorkspace(fixtures.a.workspaceId, fn, { prisma: app });
}

/** A member restricted to the fixture brand, and nothing else. */
const scoped = () => ({
  userId: fixtures.a.userId,
  permissionKeys: ['brand_brain.edit', 'brand_brain.review', 'brand_brain.upload'],
  brandScope: [fixtures.a.brandId],
});

/** A member with no restriction, which is every membership today. */
const unrestricted = () => ({ ...scoped(), brandScope: [] as string[] });

let counter = 0;
const key = (stem: string) => `${stem}.${(counter += 1)}.${Date.now()}`;

describe('the rule itself', () => {
  it('an EMPTY scope is unrestricted, which is what the schema says', () => {
    // The default has to be permissive: the field is empty for every membership
    // that exists, so a deny-by-default reading would lock every customer out
    // of their own brands.
    expect(brandInScope([], 'any-brand')).toBe(true);
    expect(brandInScope(null, 'any-brand')).toBe(true);
    expect(brandInScope(undefined, 'any-brand')).toBe(true);
  });

  it('a non-empty scope restricts to exactly its members', () => {
    expect(brandInScope(['a'], 'a')).toBe(true);
    expect(brandInScope(['a'], 'b')).toBe(false);
    expect(brandInScope(['a', 'b'], 'b')).toBe(true);
  });

  it('refuses with NOT_FOUND, never with FORBIDDEN', () => {
    // "Forbidden" would confirm the brand exists, which tells a member
    // restricted to one brand how many others their colleagues have.
    expect(() => assertBrandInScope(['a'], 'b')).toThrowError(
      expect.objectContaining({ code: 'NOT_FOUND' }) as unknown as Error,
    );
  });

  it('contributes no filter when unrestricted, and an id filter when not', () => {
    expect(brandScopeFilter([])).toEqual({});
    expect(brandScopeFilter(['a', 'b'])).toEqual({ id: { in: ['a', 'b'] } });
  });
});

describe('knowledge writes respect the scope', () => {
  it('a scoped member may create in their own brand', async () => {
    const created = await inA(async (db) =>
      new BrandKnowledgeService({ db, workspaceId: fixtures.a.workspaceId }).createItem({
        brandId: fixtures.a.brandId,
        area: 'IDENTITY',
        itemKey: key('scope.allowed'),
        title: { en: 'Positioning' },
        body: { en: 'We serve independent retailers.' },
        actor: scoped(),
        policy: POLICY,
      }),
    );
    expect(created.brandId).toBe(fixtures.a.brandId);
  });

  it('and may NOT create in another brand of the same workspace', async () => {
    await expect(
      inA(async (db) =>
        new BrandKnowledgeService({ db, workspaceId: fixtures.a.workspaceId }).createItem({
          brandId: otherBrandId,
          area: 'IDENTITY',
          itemKey: key('scope.refused'),
          title: { en: 'Positioning' },
          body: { en: 'Someone else’s brand.' },
          actor: scoped(),
          policy: POLICY,
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('WRITES NOTHING when it refuses', async () => {
    const before = await inA(async (db) =>
      db.brandKnowledgeItem.count({ where: { brandId: otherBrandId } }),
    );
    await inA(async (db) =>
      new BrandKnowledgeService({ db, workspaceId: fixtures.a.workspaceId })
        .createItem({
          brandId: otherBrandId,
          area: 'OFFERS',
          itemKey: key('scope.norow'),
          title: { en: 'Offer' },
          body: { en: 'Should never exist.' },
          actor: scoped(),
          policy: POLICY,
        })
        .catch(() => null),
    );
    const after = await inA(async (db) =>
      db.brandKnowledgeItem.count({ where: { brandId: otherBrandId } }),
    );
    // The check runs before the insert, so a refusal leaves no row and no
    // audit event behind.
    expect(after).toBe(before);
  });

  it('refuses to EDIT an item belonging to an out-of-scope brand', async () => {
    // Reached by item id rather than by brand id — the path that would have
    // slipped past a check written only where a `brandId` is a parameter.
    const item = await inA(async (db) =>
      new BrandKnowledgeService({ db, workspaceId: fixtures.a.workspaceId }).createItem({
        brandId: otherBrandId,
        area: 'IDENTITY',
        itemKey: key('scope.edit'),
        title: { en: 'Other brand positioning' },
        body: { en: 'Belongs to the other brand.' },
        actor: unrestricted(),
        policy: POLICY,
      }),
    );

    await expect(
      inA(async (db) =>
        new BrandKnowledgeService({ db, workspaceId: fixtures.a.workspaceId }).updateItem({
          itemId: item.id,
          title: { en: 'Edited' },
          body: { en: 'Edited by someone out of scope.' },
          actor: scoped(),
          policy: POLICY,
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const unchanged = await inA(async (db) =>
      db.brandKnowledgeItem.findUniqueOrThrow({ where: { id: item.id } }),
    );
    expect(unchanged.version).toBe(1);
  });

  it('refuses to ARCHIVE an item belonging to an out-of-scope brand', async () => {
    const item = await inA(async (db) =>
      new BrandKnowledgeService({ db, workspaceId: fixtures.a.workspaceId }).createItem({
        brandId: otherBrandId,
        area: 'OFFERS',
        itemKey: key('scope.archive'),
        title: { en: 'Other brand offer' },
        body: { en: 'Belongs to the other brand.' },
        actor: unrestricted(),
        policy: POLICY,
      }),
    );

    await expect(
      inA(async (db) =>
        new BrandKnowledgeService({ db, workspaceId: fixtures.a.workspaceId }).archiveItem({
          itemId: item.id,
          actor: scoped(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const survivor = await inA(async (db) =>
      db.brandKnowledgeItem.findUniqueOrThrow({ where: { id: item.id } }),
    );
    expect(survivor.status).toBe('ACTIVE');
  });
});

describe('uploads respect the scope', () => {
  it('refuses an upload to an out-of-scope brand, and stores nothing', async () => {
    const store = new InMemoryObjectStore();

    await expect(
      inA(async (db) =>
        new BrandIngestionService({
          db,
          workspaceId: fixtures.a.workspaceId,
          store,
          policy: UPLOAD_POLICY,
          extractors: new ExtractorRegistry([new PlainTextExtractor(LIMITS)]),
        }).upload({
          brandId: otherBrandId,
          fileName: 'notes.txt',
          mimeType: 'text/plain',
          bytes: new TextEncoder().encode('Our mission is to serve retailers.'),
          idempotencyKey: key('scope.upload'),
          actorUserId: fixtures.a.userId,
          actorBrandScope: [fixtures.a.brandId],
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // The check runs before validation, before the checksum and before the
    // object write — so a refusal leaves no orphaned object behind either.
    expect(store.size).toBe(0);
    const documents = await inA(async (db) =>
      db.brandSourceDocument.count({ where: { brandId: otherBrandId } }),
    );
    expect(documents).toBe(0);
  });

  it('allows an upload to the member’s own brand', async () => {
    const store = new InMemoryObjectStore();
    const { document } = await inA(async (db) =>
      new BrandIngestionService({
        db,
        workspaceId: fixtures.a.workspaceId,
        store,
        policy: UPLOAD_POLICY,
        extractors: new ExtractorRegistry([new PlainTextExtractor(LIMITS)]),
      }).upload({
        brandId: fixtures.a.brandId,
        fileName: 'notes.txt',
        mimeType: 'text/plain',
        bytes: new TextEncoder().encode(`Our mission is ${key('scope.ok')}.`),
        idempotencyKey: key('scope.upload.ok'),
        actorUserId: fixtures.a.userId,
        actorBrandScope: [fixtures.a.brandId],
      }),
    );
    expect(document.brandId).toBe(fixtures.a.brandId);
  });
});

describe('an unrestricted member is unaffected', () => {
  it('reaches every brand in the workspace, which is today’s behaviour', async () => {
    // The regression that would matter most: every membership in existence has
    // an empty scope, so enforcing the rule must change nothing for them.
    const created = await inA(async (db) =>
      new BrandKnowledgeService({ db, workspaceId: fixtures.a.workspaceId }).createItem({
        brandId: otherBrandId,
        area: 'IDENTITY',
        itemKey: key('scope.unrestricted'),
        title: { en: 'Positioning' },
        body: { en: 'An unrestricted member may write here.' },
        actor: unrestricted(),
        policy: POLICY,
      }),
    );
    expect(created.brandId).toBe(otherBrandId);
  });
});
