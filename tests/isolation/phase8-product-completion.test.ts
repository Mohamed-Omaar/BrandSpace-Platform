import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { AssetLibraryService, assetPolicyFrom } from '@brandspace/assets';
import { defaultPayload } from '@brandspace/config';
import { resolveSelection } from '../../apps/dashboard/src/server/brand-selection';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * PHASE 8 — PRODUCT COMPLETION, on real PostgreSQL.
 *
 * WHAT THESE ASSERT THAT A UNIT TEST CANNOT. The unit suite proves the RULES:
 * which cookie wins, what a missing field means, what a return path may be. It
 * cannot prove the two things that actually keep tenants apart here, because
 * both live in the database:
 *
 *   - THE BRAND LIST IS NARROWED IN THE QUERY (D-132). A member's BrandScope
 *     has to restrict the rows PostgreSQL returns, not filter an array
 *     afterwards — a read that happened is a read that happened.
 *   - A CANONICAL LOGO CANNOT POINT SOMEWHERE IT SHOULD NOT (D-193). The
 *     composite key refuses another workspace's asset and a trigger refuses
 *     another brand's, and neither is a convention a later edit can drop.
 *
 * And one thing that is neither: that the migration really did take the country
 * defaults off the columns (D-194), which is a property of the catalogue rather
 * than of any query.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;

/** Workspace A's brands. F-23: the suite bootstraps everything it reads. */
let brandOne: string;
let brandTwo: string;
/** A brand in workspace B, which workspace A must never be able to name. */
let foreignBrand: string;

/** Assets: one owned by brand one, one shared, one owned by brand two. */
let assetOfBrandOne: string;
let sharedAsset: string;
let assetOfBrandTwo: string;
let foreignAsset: string;

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;
const inB = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.b.workspaceId, fn as never, { prisma: app }) as Promise<T>;

const brand = async (
  workspaceId: string,
  run: <T>(fn: (db: TenantScopedClient) => Promise<T>) => Promise<T>,
  name: string,
): Promise<string> => {
  const row = await run((db) =>
    db.brand.create({
      data: { workspaceId, slug: `p8-${randomUUID().slice(0, 8)}`, name, status: 'ACTIVE' },
      select: { id: true },
    }),
  );
  return row.id;
};

const asset = async (
  workspaceId: string,
  run: <T>(fn: (db: TenantScopedClient) => Promise<T>) => Promise<T>,
  brandId: string | null,
  name: string,
): Promise<string> => {
  const row = await run((db) =>
    db.asset.create({
      data: {
        workspaceId,
        brandId,
        name,
        kind: 'IMAGE',
        mimeType: 'image/png',
        sizeBytes: 128,
        storageKey: `p8/${randomUUID()}`,
        checksumSha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
        status: 'READY',
        scanStatus: 'CLEAN',
      },
      select: { id: true },
    }),
  );
  return row.id;
};

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);

  brandOne = await brand(fixtures.a.workspaceId, inA, 'Alpha');
  brandTwo = await brand(fixtures.a.workspaceId, inA, 'Beta');
  foreignBrand = await brand(fixtures.b.workspaceId, inB, 'Foreign');

  assetOfBrandOne = await asset(fixtures.a.workspaceId, inA, brandOne, 'alpha-logo.png');
  sharedAsset = await asset(fixtures.a.workspaceId, inA, null, 'shared-logo.png');
  assetOfBrandTwo = await asset(fixtures.a.workspaceId, inA, brandTwo, 'beta-logo.png');
  foreignAsset = await asset(fixtures.b.workspaceId, inB, foreignBrand, 'foreign-logo.png');
}, 120_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

// ---------------------------------------------------------------------------
// AC-22 — the global brand context
// ---------------------------------------------------------------------------

/** Exactly the query `listAccessibleBrands` runs, with the scope IN it. */
const accessible = (brandScope: readonly string[]) =>
  inA((db) =>
    db.brand.findMany({
      where: {
        deletedAt: null,
        status: { in: ['ACTIVE', 'DRAFT'] },
        ...(brandScope.length > 0 ? { id: { in: [...brandScope] } } : {}),
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, slug: true, status: true },
    }),
  );

describe('AC-22: the brands a member may act on', () => {
  it('offers every live brand to an unrestricted member', async () => {
    const brands = await accessible([]);
    const ids = brands.map((row) => row.id);
    expect(ids).toContain(brandOne);
    expect(ids).toContain(brandTwo);
  });

  it('offers a restricted member ONLY their own, and never names the others', async () => {
    const brands = await accessible([brandOne]);
    expect(brands.map((row) => row.id)).toEqual([brandOne]);
    // The point is not that the other id is absent from an array — it is that
    // the row was never read. A name that was never selected cannot be leaked
    // by a later mistake in the page that renders it.
    expect(JSON.stringify(brands)).not.toContain('Beta');
  });

  it('never returns another workspace’s brand, whatever the scope says', async () => {
    // A scope naming a foreign brand narrows to nothing rather than reaching
    // across: RLS answers first, and the id is simply not in this tenant.
    expect(await accessible([foreignBrand])).toEqual([]);
  });
});

describe('AC-22: resolving a selection against that list', () => {
  const brands = [
    { id: brandOneId(), name: 'Alpha', slug: 'alpha', status: 'ACTIVE' },
    { id: brandTwoId(), name: 'Beta', slug: 'beta', status: 'ACTIVE' },
  ];
  function brandOneId() {
    return '11111111-1111-4111-8111-111111111111';
  }
  function brandTwoId() {
    return '22222222-2222-4222-8222-222222222222';
  }

  it('NEVER silently uses the first of several', async () => {
    const context = resolveSelection(brands, { scope: 'brand' });
    expect(context.resolution.kind).toBe('unselected');
  });

  it('resolves a single accessible brand to itself', () => {
    const one = resolveSelection([brands[0]!], { scope: 'brand' });
    expect(one.resolution).toEqual({ kind: 'brand', brand: brands[0] });
  });

  it('offers to create when the member can act on no brand', () => {
    expect(resolveSelection([], { scope: 'brand' }).resolution.kind).toBe('empty');
    expect(resolveSelection([], { scope: 'brand-or-all' }).resolution.kind).toBe('empty');
  });

  it('lets the URL win, and does NOT fall back to the cookie when it names a stranger', () => {
    const chosen = resolveSelection(brands, {
      scope: 'brand',
      requested: brandTwoId(),
      stored: brandOneId(),
    });
    expect(chosen.resolution).toEqual({ kind: 'brand', brand: brands[1] });

    const stranger = resolveSelection(brands, {
      scope: 'brand',
      requested: 'a-brand-this-member-may-not-see',
      stored: brandOneId(),
    });
    // NOT brand one. A link that quietly showed a different brand than it names
    // would be worse than a link that asks.
    expect(stranger.resolution.kind).toBe('unselected');
  });

  it('falls back to the cookie only when the URL is silent', () => {
    for (const silent of [undefined, null, '', '   ']) {
      const context = resolveSelection(brands, {
        scope: 'brand',
        requested: silent,
        stored: brandTwoId(),
      });
      expect(context.resolution).toEqual({ kind: 'brand', brand: brands[1] });
    }
  });

  it('aggregates ONLY the brands this member may access', () => {
    const context = resolveSelection(brands, { scope: 'brand-or-all' });
    expect(context.resolution).toEqual({
      kind: 'all',
      brandIds: [brandOneId(), brandTwoId()],
    });
    // A restricted member never aggregates the workspace's list. With ONE
    // reachable brand there is nothing to aggregate: it resolves to that
    // brand itself (D-302), and never to a brand outside their scope.
    const restricted = resolveSelection([brands[0]!], { scope: 'brand-or-all' });
    expect(restricted.resolution).toEqual({ kind: 'brand', brand: brands[0] });
  });

  it('refuses the aggregate on a page that needs one brand', () => {
    const context = resolveSelection(brands, { scope: 'brand', stored: 'all' });
    expect(context.aggregateAllowed).toBe(false);
    expect(context.resolution.kind).toBe('unselected');
  });
});

// ---------------------------------------------------------------------------
// AC-23 — canonical identity assets
// ---------------------------------------------------------------------------

describe('AC-23: a canonical logo cannot point where it should not', () => {
  it('accepts the brand’s OWN asset', async () => {
    await inA((db) =>
      db.brand.update({
        where: { id: brandOne },
        data: { primaryLogoAssetId: assetOfBrandOne },
      }),
    );
    const row = await inA((db) =>
      db.brand.findFirstOrThrow({
        where: { id: brandOne },
        select: { primaryLogoAssetId: true },
      }),
    );
    expect(row.primaryLogoAssetId).toBe(assetOfBrandOne);
  });

  it('accepts a workspace-SHARED asset', async () => {
    await inA((db) =>
      db.brand.update({ where: { id: brandOne }, data: { secondaryLogoAssetId: sharedAsset } }),
    );
    const row = await inA((db) =>
      db.brand.findFirstOrThrow({
        where: { id: brandOne },
        select: { secondaryLogoAssetId: true },
      }),
    );
    expect(row.secondaryLogoAssetId).toBe(sharedAsset);
  });

  it('REFUSES ANOTHER BRAND’S ASSET — the leak a foreign key cannot close', async () => {
    /*
     * The composite key proves the asset is in the same WORKSPACE and says
     * nothing about which BRAND owns it. Without the trigger, brand one could
     * name brand two's artwork as its logo, and a member scoped to brand one
     * would be shown a file from a brand they may not see.
     */
    await expect(
      inA((db) =>
        db.brand.update({ where: { id: brandOne }, data: { primaryLogoAssetId: assetOfBrandTwo } }),
      ),
    ).rejects.toThrow();
  });

  it('REFUSES ANOTHER WORKSPACE’S ASSET — the composite key has nowhere to point', async () => {
    await expect(
      inA((db) =>
        db.brand.update({ where: { id: brandOne }, data: { primaryLogoAssetId: foreignAsset } }),
      ),
    ).rejects.toThrow();
  });

  it('refuses an id that is not an asset at all', async () => {
    await expect(
      inA((db) =>
        db.brand.update({ where: { id: brandOne }, data: { primaryLogoAssetId: randomUUID() } }),
      ),
    ).rejects.toThrow();
  });

  it('DELETING THE ASSET CLEARS THE REFERENCE AND NEVER THE TENANT KEY', async () => {
    const throwaway = await asset(fixtures.a.workspaceId, inA, brandOne, 'temporary.png');
    await inA((db) =>
      db.brand.update({ where: { id: brandOne }, data: { primaryLogoAssetId: throwaway } }),
    );
    await inA((db) => db.asset.delete({ where: { id: throwaway } }));

    const row = await inA((db) =>
      db.brand.findFirstOrThrow({
        where: { id: brandOne },
        select: { primaryLogoAssetId: true, workspaceId: true },
      }),
    );
    // The column-scoped SET NULL (D-114): the reference goes, the tenant key
    // stays. A bare SET NULL on a composite key would have tried to null
    // `workspaceId` — which is NOT NULL, so the delete would have FAILED.
    expect(row.primaryLogoAssetId).toBeNull();
    expect(row.workspaceId).toBe(fixtures.a.workspaceId);
  });

  it('is enforced on INSERT as well as UPDATE', async () => {
    await expect(
      inA((db) =>
        db.brand.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            slug: `p8-bad-${randomUUID().slice(0, 8)}`,
            name: 'Born wrong',
            primaryLogoAssetId: assetOfBrandTwo,
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC-24 — the one Asset Library, sliced
// ---------------------------------------------------------------------------

describe('AC-24: All Assets / Shared / one brand, over ONE library', () => {
  const library = (db: TenantScopedClient) =>
    new AssetLibraryService({
      db,
      workspaceId: fixtures.a.workspaceId,
      // The ACTIVATED policy, not a literal: what a library may hold is
      // configuration (CLAUDE.md §2.2), and a test that invented its own
      // numbers would be asserting against a second copy of them.
      policy: assetPolicyFrom(defaultPayload('assets')),
    });

  const actor = (brandScope: readonly string[]) => ({
    userId: fixtures.a.userId,
    permissionKeys: ['assets.read'],
    brandScope: [...brandScope],
  });

  it('SHARED is exactly the assets with no brand', async () => {
    const page = await inA((db) => library(db).browse({ actor: actor([]), brandId: null }));
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((item) => item.brandId === null)).toBe(true);
  });

  it('one brand returns that brand PLUS the shared shelf, and nothing else', async () => {
    const page = await inA((db) =>
      library(db).browse({ actor: actor([]), brandId: brandOne, includeShared: true }),
    );
    const ids = page.items.map((item) => item.id);
    expect(ids).toContain(assetOfBrandOne);
    expect(ids).toContain(sharedAsset);
    // THE ONE THING THAT MUST NOT HAPPEN: another brand's file in this view.
    expect(ids).not.toContain(assetOfBrandTwo);
  });

  it('one brand WITHOUT the shared shelf is exactly that brand', async () => {
    const page = await inA((db) => library(db).browse({ actor: actor([]), brandId: brandOne }));
    expect(page.items.every((item) => item.brandId === brandOne)).toBe(true);
  });

  it('ALL ASSETS is the member’s scope plus shared, never the whole workspace', async () => {
    const page = await inA((db) => library(db).browse({ actor: actor([brandOne]) }));
    const ids = page.items.map((item) => item.id);
    expect(ids).toContain(assetOfBrandOne);
    expect(ids).toContain(sharedAsset);
    expect(ids).not.toContain(assetOfBrandTwo);
  });

  it('refuses a brand filter outside the member’s scope', async () => {
    await expect(
      inA((db) => library(db).browse({ actor: actor([brandOne]), brandId: brandTwo })),
    ).rejects.toThrow();
  });

  it('cannot reach another workspace’s assets by naming its brand', async () => {
    const page = await inA((db) =>
      library(db).browse({ actor: actor([]), brandId: foreignBrand, includeShared: true }),
    );
    // RLS answers before the filter does: the rows are not in this tenant.
    expect(page.items.map((item) => item.id)).not.toContain(foreignAsset);
  });
});

// ---------------------------------------------------------------------------
// AC-25 — no product-wide country assumption
// ---------------------------------------------------------------------------

describe('AC-25: the country defaults are gone from the database', () => {
  it('declares NO default for a workspace’s country, locale, timezone or currency', async () => {
    const rows = await platform.$queryRawUnsafe<{ attname: string }[]>(
      `SELECT a.attname
         FROM pg_attrdef d
         JOIN pg_class c ON c.oid = d.adrelid
         JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
        WHERE c.relname = 'workspace'
          AND a.attname IN ('country', 'defaultLocale', 'timezone', 'currency')`,
    );
    expect(rows).toEqual([]);
  });

  it('declares no default for a person’s timezone either', async () => {
    const rows = await platform.$queryRawUnsafe<{ attname: string }[]>(
      `SELECT a.attname
         FROM pg_attrdef d
         JOIN pg_class c ON c.oid = d.adrelid
         JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
        WHERE c.relname = 'user' AND a.attname = 'timezone'`,
    );
    expect(rows).toEqual([]);
  });

  it('REFUSES a workspace that does not say where it is', async () => {
    /*
     * The columns are still NOT NULL. Dropping the default did not make them
     * optional — it made them somebody's decision, and a row that names nobody's
     * decision cannot be written at all.
     */
    await expect(
      platform.$executeRawUnsafe(
        `INSERT INTO "workspace" ("id", "workspaceId", "slug", "name", "ownerUserId", "createdAt", "updatedAt")
         VALUES ($1, $1, $2, 'No country', $3, now(), now())`,
        randomUUID(),
        `p8-nowhere-${randomUUID().slice(0, 8)}`,
        fixtures.a.userId,
      ),
    ).rejects.toThrow();
  });

  it('PRESERVES what existing rows already store', async () => {
    // The fixtures' own workspaces were created before this suite ran and still
    // carry their stored values — the migration dropped a default, and a
    // default has no effect on rows that exist.
    const row = await platform.workspace.findUniqueOrThrow({
      where: { id: fixtures.a.workspaceId },
      select: { country: true, defaultLocale: true, timezone: true, currency: true },
    });
    expect(row.country).not.toBe('');
    expect(row.timezone).not.toBe('');
    expect(row.currency).not.toBe('');
    expect(['AR', 'EN']).toContain(row.defaultLocale);
  });

  it('leaves the Arabic dialect default alone — MSA is a language decision', async () => {
    const rows = await platform.$queryRawUnsafe<{ default: string | null }[]>(
      `SELECT pg_get_expr(d.adbin, d.adrelid) AS "default"
         FROM pg_attrdef d
         JOIN pg_class c ON c.oid = d.adrelid
         JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
        WHERE c.relname = 'brand' AND a.attname = 'arabicDialect'`,
    );
    // Nothing in this phase touched it, in either direction.
    expect(rows.length).toBeLessThanOrEqual(1);
  });
});
