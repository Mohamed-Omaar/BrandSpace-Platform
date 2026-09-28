import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AssetDownloadService,
  AssetLibraryService,
  AssetProcessingService,
  AssetUploadService,
  BrandFontService,
  MockVirusScanner,
  assetPolicyFrom,
  type AssetActor,
  type AssetPolicy,
} from '@brandspace/assets';
import { defaultPayload, parseConfigPayload } from '@brandspace/config';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { UsageService, measureStorageBreakdown } from '@brandspace/entitlements';
import { DownloadGrantIssuer, InMemoryObjectStore } from '@brandspace/storage';
import { WORKSPACE_PERMISSIONS } from '@brandspace/shared';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * PHASE 2C-2 (item 3, M3) — UPLOADED BRAND FONTS, against real PostgreSQL.
 *
 * `brand_font` is tenant-owned and brand-scoped; its FILE is an ordinary FONT
 * asset through the one upload path. These tests pin:
 *   - RLS and brand scope, and that a font grant minted in workspace A is
 *     useless in workspace B;
 *   - at most four ACTIVE fonts per brand and language, under the brand-row
 *     lock — including two concurrent uploads when the brand has NO font yet;
 *   - Replace keeps one logical font (no second quota position) and archives
 *     the previous file only when nothing else uses it (owner decision A);
 *   - storage: the existing meter, exactly — charged on upload, never refunded
 *     by archive, nothing font-specific;
 *   - permissions compose: `brand.manage` never stands in for an asset key.
 */

let fixtures: IsolationFixtures;
let app: PrismaClient;
let platform: PrismaClient;
let secondBrandId: string;

const scanner = new MockVirusScanner();
const SIGNING_KEY = 'isolation-test-font-grant-key-not-a-secret';
const store = new InMemoryObjectStore();
const ALL: readonly string[] = WORKSPACE_PERMISSIONS.map((p) => p.key);

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  secondBrandId = (
    await platform.brand.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        slug: `fonts-second-${Date.now()}`,
        name: 'Second Brand',
        defaultLocale: 'EN',
        status: 'ACTIVE',
      },
    })
  ).id;
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

function actor(overrides: Partial<AssetActor> = {}): AssetActor {
  return { userId: fixtures.a.userId, permissionKeys: ALL, brandScope: [], ...overrides };
}

function policyWith(overrides: Record<string, unknown> = {}): AssetPolicy {
  return assetPolicyFrom(
    Object.keys(overrides).length === 0
      ? defaultPayload('assets')
      : parseConfigPayload('assets', overrides),
  );
}

interface Harness {
  readonly db: TenantScopedClient;
  readonly upload: AssetUploadService;
  readonly library: AssetLibraryService;
  readonly processing: AssetProcessingService;
  readonly fonts: BrandFontService;
}

async function inWs<T>(
  fn: (h: Harness) => Promise<T>,
  options: { workspaceId?: string; policy?: AssetPolicy } = {},
): Promise<T> {
  const workspaceId = options.workspaceId ?? fixtures.a.workspaceId;
  const policy = options.policy ?? policyWith();
  return withWorkspace(
    workspaceId,
    async (db) => {
      const usage = new UsageService({ prisma: db as unknown as PrismaClient });
      const library = new AssetLibraryService({ db, workspaceId, policy });
      const download = new AssetDownloadService({
        db,
        workspaceId,
        policy,
        issuer: new DownloadGrantIssuer({ signingKey: SIGNING_KEY }),
      });
      return fn({
        db,
        upload: new AssetUploadService({
          db,
          workspaceId,
          policy,
          store,
          usage,
          storageLimitGb: null,
        }),
        library,
        processing: new AssetProcessingService({ db, workspaceId, policy, store, scanner }),
        fonts: new BrandFontService({ db, workspaceId, policy, library, download }),
      });
    },
    { prisma: app },
  );
}

/** TrueType bytes: the 00 01 00 00 version tag, then a unique body. */
function ttf(): Uint8Array {
  return new Uint8Array([0x00, 0x01, 0x00, 0x00, ...new TextEncoder().encode(randomUUID())]);
}

/** Initiate + complete inside the caller's transaction — the `upload` callback. */
function uploader(
  h: Harness,
  input: { brandId: string; bytes?: Uint8Array; a?: AssetActor; mimeType?: string },
  jobs: string[],
) {
  return async () => {
    const bytes = input.bytes ?? ttf();
    const started = await h.upload.initiate({
      brandId: input.brandId,
      folderId: null,
      fileName: 'Brand.ttf',
      mimeType: input.mimeType ?? 'font/ttf',
      sizeBytes: bytes.byteLength,
      idempotencyKey: `font-${randomUUID()}`,
      actor: input.a ?? actor(),
    });
    const completed = await h.upload.complete({
      sessionId: started.session.id,
      bytes,
      actor: input.a ?? actor(),
    });
    if (completed.job) jobs.push(completed.job.id);
    return { assetId: completed.asset.id };
  };
}

/** Add a font and process its file to READY + CLEAN. */
async function addFont(input: {
  brandId?: string;
  language?: 'en' | 'ar';
  name?: string;
  policy?: AssetPolicy;
  bytes?: Uint8Array;
}): Promise<{ brandFontId: string; assetId: string }> {
  const jobs: string[] = [];
  const added = await inWs(
    (h) =>
      h.fonts.add({
        brandId: input.brandId ?? fixtures.a.brandId,
        language: input.language ?? 'en',
        displayName: input.name ?? 'Brand Sans',
        actor: actor(),
        upload: uploader(
          h,
          {
            brandId: input.brandId ?? fixtures.a.brandId,
            ...(input.bytes ? { bytes: input.bytes } : {}),
          },
          jobs,
        ),
      }),
    input.policy ? { policy: input.policy } : {},
  );
  for (const job of jobs) await inWs((h) => h.processing.process(job));
  return added;
}

async function activeCount(brandId: string, language: 'EN' | 'AR'): Promise<number> {
  return platform.brandFont.count({ where: { brandId, language, archivedAt: null } });
}

async function freshBrand(label: string): Promise<string> {
  return (
    await platform.brand.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        slug: `fonts-${label}-${randomUUID().slice(0, 8)}`,
        name: `Fonts ${label}`,
        defaultLocale: 'EN',
        status: 'ACTIVE',
      },
    })
  ).id;
}

describe('brand_font — tenant isolation (RLS) and brand scope', () => {
  it('another workspace cannot read, list or write a font', async () => {
    const brandId = await freshBrand('case');
    const { brandFontId } = await addFont({ brandId, name: 'Private Sans' });

    const fromB = await inWs(
      async (h) => ({
        one: await h.db.brandFont.findFirst({ where: { id: brandFontId } }),
        all: await h.db.brandFont.findMany({ select: { id: true } }),
      }),
      { workspaceId: fixtures.b.workspaceId },
    );
    expect(fromB.one).toBeNull();
    expect(fromB.all.map((row) => row.id)).not.toContain(brandFontId);

    // A write naming workspace A, from inside B, is refused by the policy.
    await expect(
      inWs(
        (h) =>
          h.db.brandFont.update({ where: { id: brandFontId }, data: { displayName: 'Stolen' } }),
        { workspaceId: fixtures.b.workspaceId },
      ),
    ).rejects.toThrow();
    // And B's service sees nothing to rename.
    await expect(
      inWs((h) => h.fonts.rename({ brandFontId, displayName: 'Stolen', actor: actor() }), {
        workspaceId: fixtures.b.workspaceId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a member scoped to another brand cannot rename, remove, list or load it', async () => {
    const brandId = await freshBrand('case');
    const { brandFontId } = await addFont({ brandId, name: 'Scoped Sans' });
    const scoped = actor({ brandScope: [secondBrandId] });
    await expect(
      inWs((h) => h.fonts.rename({ brandFontId, displayName: 'X', actor: scoped })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(inWs((h) => h.fonts.remove({ brandFontId, actor: scoped }))).rejects.toMatchObject(
      {
        code: 'NOT_FOUND',
      },
    );
    await expect(inWs((h) => h.fonts.list(brandId, scoped))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const readable = await inWs((h) =>
      h.fonts.readable({
        brandId: brandId,
        actor: scoped,
        urlFor: (t) => `/en/assets/font/${t}`,
      }),
    );
    expect(readable).toEqual([]);
  });

  it('a font grant minted in workspace A is refused in workspace B', async () => {
    const brandId = await freshBrand('case');
    await addFont({ brandId, name: 'Granted Sans' });
    const readable = await inWs((h) =>
      h.fonts.readable({ brandId: brandId, actor: actor(), urlFor: (t) => t }),
    );
    const token = readable[0]?.url;
    expect(token).toBeTruthy();
    const issuer = new DownloadGrantIssuer({ signingKey: SIGNING_KEY });
    expect(issuer.redeem(token!, fixtures.a.workspaceId).contentType).toBe('font/ttf');
    expect(() => issuer.redeem(token!, fixtures.b.workspaceId)).toThrow();
  });

  it('the database refuses a font row whose file is not a FONT asset of that brand', async () => {
    await expect(
      platform.brandFont.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          assetId: fixtures.a.assetId, // an IMAGE
          language: 'EN',
          displayName: 'Not a font',
        },
      }),
    ).rejects.toThrow();
  });
});

describe('at most four ACTIVE fonts per brand and language', () => {
  it('refuses a fifth, counts languages apart, and frees a place on remove', async () => {
    const brandId = await freshBrand('limit');
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1)
      ids.push((await addFont({ brandId, name: `En ${i}` })).brandFontId);
    await expect(addFont({ brandId, name: 'Fifth' })).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
    expect(await activeCount(brandId, 'EN')).toBe(4);
    // Arabic is its own four.
    await addFont({ brandId, language: 'ar', name: 'Ar 1' });
    expect(await activeCount(brandId, 'AR')).toBe(1);
    // An archived (removed) font no longer counts.
    await inWs((h) => h.fonts.remove({ brandFontId: ids[0]!, actor: actor() }));
    await addFont({ brandId, name: 'Fifth, after a removal' });
    expect(await activeCount(brandId, 'EN')).toBe(4);
  });

  it('two concurrent uploads cannot make a fifth active font', async () => {
    const brandId = await freshBrand('race4');
    for (let i = 0; i < 3; i += 1) await addFont({ brandId, name: `Race ${i}` });
    const results = await Promise.allSettled([
      addFont({ brandId, name: 'Racer A' }),
      addFont({ brandId, name: 'Racer B' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await activeCount(brandId, 'EN')).toBe(4);
  });

  it('with NO font yet, two concurrent first uploads still queue on the brand row', async () => {
    // A limit of one makes the zero-font race decisive: without a lock on a row
    // that exists before any font does, both would see zero and both insert.
    const policy = policyWith({ brandFonts: { maxUploadedPerLanguage: 1 } });
    const brandId = await freshBrand('race0');
    const results = await Promise.allSettled([
      addFont({ brandId, name: 'First A', policy }),
      addFont({ brandId, name: 'First B', policy }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(await activeCount(brandId, 'EN')).toBe(1);
  });
});

describe('replace — one logical font; the previous file archived only when unused (decision A)', () => {
  async function replace(brandFontId: string, brandId: string) {
    const jobs: string[] = [];
    const out = await inWs((h) =>
      h.fonts.replace({
        brandFontId,
        actor: actor(),
        upload: uploader(h, { brandId }, jobs),
      }),
    );
    for (const job of jobs) await inWs((h) => h.processing.process(job));
    return out;
  }

  it('does not take a second quota position, and archives the exclusively-owned previous file', async () => {
    const brandId = await freshBrand('replace');
    const fonts: { brandFontId: string; assetId: string }[] = [];
    for (let i = 0; i < 4; i += 1) fonts.push(await addFont({ brandId, name: `R ${i}` }));
    const jobs: string[] = [];
    const out = await inWs((h) =>
      h.fonts.replace({
        brandFontId: fonts[0]!.brandFontId,
        actor: actor(),
        upload: uploader(h, { brandId }, jobs),
      }),
    );
    expect(out.previous).toBe('archived');
    expect(await activeCount(brandId, 'EN')).toBe(4);
    const row = await platform.brandFont.findUniqueOrThrow({
      where: { id: fonts[0]!.brandFontId },
    });
    expect(row.assetId).toBe(out.assetId);
    expect(row.archivedAt).toBeNull();
    const previous = await platform.asset.findUniqueOrThrow({ where: { id: fonts[0]!.assetId } });
    expect(previous.status).toBe('ARCHIVED');
  });

  it('keeps the previous file when it is one of the brand’s logos', async () => {
    const brandId = await freshBrand('case');
    const font = await addFont({ brandId, name: 'Logo-bound' });
    // Set directly, as data from before the logo check could be.
    await platform.brand.update({
      where: { id: brandId },
      data: { secondaryLogoAssetId: font.assetId },
    });
    try {
      const out = await replace(font.brandFontId, brandId);
      expect(out.previous).toBe('kept');
      const previous = await platform.asset.findUniqueOrThrow({ where: { id: font.assetId } });
      expect(previous.status).toBe('READY');
    } finally {
      await platform.brand.update({
        where: { id: brandId },
        data: { secondaryLogoAssetId: null },
      });
    }
  });

  it('skips a previous file that is already archived', async () => {
    const brandId = await freshBrand('case');
    const font = await addFont({ brandId, name: 'Already archived' });
    await inWs((h) => h.library.archive(font.assetId, actor()));
    const out = await replace(font.brandFontId, brandId);
    expect(out.previous).toBe('already_archived');
  });

  it('a note thread about the previous file does not block its archive, and survives it', async () => {
    const brandId = await freshBrand('case');
    const font = await addFont({ brandId, name: 'Discussed' });
    const thread = await platform.noteThread.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId: brandId,
        subjectType: 'ASSET',
        assetId: font.assetId,
        createdByUserId: fixtures.a.userId,
      },
    });
    const out = await replace(font.brandFontId, brandId);
    expect(out.previous).toBe('archived');
    expect(await platform.noteThread.findUnique({ where: { id: thread.id } })).not.toBeNull();
  });

  it('two active fonts can never share one file, so "another active font" cannot be bypassed', async () => {
    const brandId = await freshBrand('case');
    const font = await addFont({ brandId, name: 'Unique file' });
    await expect(
      platform.brandFont.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: brandId,
          assetId: font.assetId,
          language: 'EN',
          displayName: 'Same file again',
        },
      }),
    ).rejects.toThrow();
  });
});

describe('remove, storage and the existing meter', () => {
  const counter = (h: Harness) =>
    h.db.usageCounter.findFirst({
      where: { featureKey: 'limit.storage_gb' },
      select: { usedBytes: true },
    });

  it('charges the file exactly on upload; archive (remove, replace) refunds nothing', async () => {
    const brandId = await freshBrand('case');
    const bytes = ttf();
    const before = BigInt((await inWs(counter))?.usedBytes ?? 0);
    const font = await addFont({ brandId, name: 'Metered', bytes });
    const afterAdd = BigInt((await inWs(counter))?.usedBytes ?? 0);
    expect(afterAdd - before).toBe(BigInt(bytes.byteLength));

    await inWs((h) => h.fonts.remove({ brandFontId: font.brandFontId, actor: actor() }));
    const afterRemove = BigInt((await inWs(counter))?.usedBytes ?? 0);
    expect(afterRemove).toBe(afterAdd);
    const row = await platform.brandFont.findUniqueOrThrow({ where: { id: font.brandFontId } });
    expect(row.archivedAt).not.toBeNull();
    expect((await platform.asset.findUniqueOrThrow({ where: { id: font.assetId } })).status).toBe(
      'ARCHIVED',
    );
  });

  it('the stored-bytes measure counts FONT assets, archived ones included, with no SQL change', async () => {
    const breakdown = await inWs((h) => measureStorageBreakdown(h.db, fixtures.a.workspaceId));
    const fonts = breakdown.filter((row) => row.category === 'ASSET' && row.kind === 'FONT');
    const total = fonts.reduce((sum, row) => sum + row.bytes, 0n);
    const expected = await platform.$queryRaw<{ bytes: bigint }[]>`
      SELECT COALESCE(SUM(v."sizeBytes"), 0)::bigint AS bytes FROM (
        SELECT DISTINCT ON (av."assetId", av."storageKey") av."sizeBytes"
          FROM "asset_version" av JOIN "asset" a ON a."id" = av."assetId"
         WHERE a."workspaceId" = ${fixtures.a.workspaceId}::uuid
           AND a."kind"::text = 'FONT' AND a."storageKey" <> ''
      ) v`;
    expect(total).toBe(BigInt(expected[0]!.bytes));
    expect(total > 0n).toBe(true);
  });

  it('a refused font file stores and charges nothing, and creates no font', async () => {
    const brandId = await freshBrand('case');
    const before = BigInt((await inWs(counter))?.usedBytes ?? 0);
    const fontsBefore = await platform.brandFont.count({ where: { brandId: brandId } });
    // A font COLLECTION declared as TrueType: refused at `complete`.
    const collection = new Uint8Array([0x74, 0x74, 0x63, 0x66, 1, 2, 3, 4, 5, 6]);
    await expect(
      inWs((h) =>
        h.fonts.add({
          brandId: brandId,
          language: 'en',
          displayName: 'Collection',
          actor: actor(),
          upload: uploader(h, { brandId: brandId, bytes: collection }, []),
        }),
      ),
    ).rejects.toThrow();
    expect(BigInt((await inWs(counter))?.usedBytes ?? 0)).toBe(before);
    expect(await platform.brandFont.count({ where: { brandId: brandId } })).toBe(fontsBefore);
  });
});

describe('permissions compose — brand.manage never stands in for an asset key', () => {
  it('without brand.manage, nothing can be managed', async () => {
    const brandId = await freshBrand('case');
    const noManage = actor({ permissionKeys: ALL.filter((key) => key !== 'brand.manage') });
    await expect(
      inWs((h) =>
        h.fonts.add({
          brandId: brandId,
          language: 'en',
          displayName: 'Nope',
          actor: noManage,
          upload: uploader(h, { brandId: brandId, a: noManage }, []),
        }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const font = await addFont({ brandId, name: 'Managed elsewhere' });
    await expect(
      inWs((h) =>
        h.fonts.rename({ brandFontId: font.brandFontId, displayName: 'X', actor: noManage }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      inWs((h) => h.fonts.remove({ brandFontId: font.brandFontId, actor: noManage })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('with brand.manage but without assets.upload, the upload service refuses and nothing is created', async () => {
    const brandId = await freshBrand('noupload');
    const noUpload = actor({ permissionKeys: ALL.filter((key) => key !== 'assets.upload') });
    await expect(
      inWs((h) =>
        h.fonts.add({
          brandId,
          language: 'en',
          displayName: 'Nope',
          actor: noUpload,
          upload: uploader(h, { brandId, a: noUpload }, []),
        }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await platform.brandFont.count({ where: { brandId } })).toBe(0);
  });

  it('with brand.manage but without assets.archive, Remove is refused and the font stays', async () => {
    const brandId = await freshBrand('case');
    const font = await addFont({ brandId, name: 'Stays' });
    const noArchive = actor({ permissionKeys: ALL.filter((key) => key !== 'assets.archive') });
    await expect(
      inWs((h) => h.fonts.remove({ brandFontId: font.brandFontId, actor: noArchive })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const row = await platform.brandFont.findUniqueOrThrow({ where: { id: font.brandFontId } });
    expect(row.archivedAt).toBeNull();
  });

  it('serving needs assets.read AND brand.read; without either, a reader gets none (and falls back)', async () => {
    const brandId = await freshBrand('case');
    await addFont({ brandId, name: 'Readable' });
    const read = (a: AssetActor) =>
      inWs((h) => h.fonts.readable({ brandId: brandId, actor: a, urlFor: (t) => t }));
    expect((await read(actor())).length).toBeGreaterThan(0);
    expect(await read(actor({ permissionKeys: ALL.filter((k) => k !== 'assets.read') }))).toEqual(
      [],
    );
    expect(await read(actor({ permissionKeys: ALL.filter((k) => k !== 'brand.read') }))).toEqual(
      [],
    );
  });

  it('only a READY + CLEAN file is ever granted', async () => {
    const brandId = await freshBrand('unready');
    // Added but never processed: the file is PROCESSING / PENDING.
    await inWs((h) =>
      h.fonts.add({
        brandId,
        language: 'en',
        displayName: 'Unready',
        actor: actor(),
        upload: uploader(h, { brandId }, []),
      }),
    );
    const readable = await inWs((h) =>
      h.fonts.readable({ brandId, actor: actor(), urlFor: (t) => t }),
    );
    expect(readable).toEqual([]);
    const listed = await inWs((h) => h.fonts.list(brandId, actor()));
    expect(listed.map((font) => font.status)).toEqual(['processing']);
  });
});
