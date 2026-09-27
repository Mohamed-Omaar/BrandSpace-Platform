import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import {
  EntitlementService,
  MULTI_BRAND_FEATURE,
  type CatalogueSource,
} from '@brandspace/entitlements';
import {
  assertMayCreateAnotherBrand,
  readAccessibleBrands,
  type FeatureGate,
} from '../../apps/dashboard/src/server/multi-brand';
import { appRoleClient, platformRoleClient } from './fixtures';

/**
 * PROTOTYPE v94 PHASE 2B-1, ITEM 1 — MULTI-BRAND OFF (Q2b, D-327), AGAINST
 * REAL POSTGRESQL.
 *
 * One workspace = one business = one brand: the server refuses a second
 * brand, and a member acts on the workspace's oldest brand they may see
 * (BrandScope still decides which). With the flag on for ONE workspace, only
 * that workspace gets several — and nothing is ever deleted either way.
 */

let app: PrismaClient;
let platform: PrismaClient;

beforeAll(() => {
  app = appRoleClient();
  platform = platformRoleClient();
});

afterAll(async () => {
  await app.$disconnect();
  await platform.$disconnect();
});

async function emptyWorkspace(label: string): Promise<string> {
  const id = crypto.randomUUID();
  const owner = await platform.user.create({
    data: {
      email: `p2b1-mb-${label}-${id.slice(0, 8)}@example.local`,
      name: 'Multi-brand fixture',
      status: 'ACTIVE',
      timezone: 'UTC',
    },
  });
  await platform.workspace.create({
    data: {
      id,
      workspaceId: id,
      slug: `p2b1-mb-${id.slice(0, 12)}`,
      name: 'Multi-brand fixture',
      ownerUserId: owner.id,
      status: 'ACTIVE',
      country: 'EG',
      defaultLocale: 'EN',
      timezone: 'Africa/Cairo',
      currency: 'USD',
    },
  });
  return id;
}

/** A catalogue the test controls, standing in for activated configuration. */
class StubCatalogue implements CatalogueSource {
  constructor(private readonly documents: Record<string, Record<string, unknown>>) {}
  async load(domain: string): Promise<Record<string, unknown>> {
    return this.documents[domain] ?? {};
  }
  async versionId(): Promise<string | null> {
    return null;
  }
}

async function tenantWorkspace(label: string): Promise<{ workspaceId: string; brands: string[] }> {
  const created = { workspaceId: await emptyWorkspace(label) };
  const brands: string[] = [];
  for (const [index, name] of ['Older', 'Newer'].entries()) {
    const brand = await platform.brand.create({
      data: {
        workspaceId: created.workspaceId,
        slug: `p2b1-${label}-${index}-${crypto.randomUUID().slice(0, 6)}`,
        name: `${name} ${label}`,
        status: 'ACTIVE',
        createdAt: new Date(Date.UTC(2026, 0, 1 + index)),
      },
      select: { id: true },
    });
    brands.push(brand.id);
  }
  return { workspaceId: created.workspaceId, brands };
}

function inTenant<T>(workspaceId: string, fn: (db: TenantScopedClient) => Promise<T>): Promise<T> {
  return withWorkspace(workspaceId, fn, { prisma: app });
}

const OFF: FeatureGate = { can: async () => false };
const ON: FeatureGate = { can: async () => true };

describe('Q2b · multi-brand off: one workspace, one brand', () => {
  it('the server refuses a second brand while the flag is off, and allows it when on', async () => {
    const fixture = await tenantWorkspace('refuse');
    await expect(
      inTenant(fixture.workspaceId, (db) =>
        assertMayCreateAnotherBrand(db as never, OFF, fixture.workspaceId),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', publicDetails: { reason: 'MULTI_BRAND_OFF' } });
    await expect(
      inTenant(fixture.workspaceId, (db) =>
        assertMayCreateAnotherBrand(db as never, ON, fixture.workspaceId),
      ),
    ).resolves.toBeUndefined();
  });

  it('the FIRST brand is always allowed', async () => {
    const created = { workspaceId: await emptyWorkspace('first-brand') };
    await expect(
      inTenant(created.workspaceId, (db) =>
        assertMayCreateAnotherBrand(db as never, OFF, created.workspaceId),
      ),
    ).resolves.toBeUndefined();
  });

  it('a member acts on the oldest brand they may see; switching comes back with the flag', async () => {
    const fixture = await tenantWorkspace('list');
    const [older, newer] = fixture.brands;
    const off = await inTenant(fixture.workspaceId, (db) =>
      readAccessibleBrands(db as never, OFF, fixture.workspaceId, []),
    );
    expect(off.map((brand) => brand.id)).toEqual([older]);

    // BrandScope still decides: scoped to the newer brand, that is the one.
    const scoped = await inTenant(fixture.workspaceId, (db) =>
      readAccessibleBrands(db as never, OFF, fixture.workspaceId, [newer ?? '']),
    );
    expect(scoped.map((brand) => brand.id)).toEqual([newer]);

    const on = await inTenant(fixture.workspaceId, (db) =>
      readAccessibleBrands(db as never, ON, fixture.workspaceId, []),
    );
    expect(new Set(on.map((brand) => brand.id))).toEqual(new Set([older, newer]));
    // Nothing was removed: both brands are still live.
    expect(
      await platform.brand.count({ where: { workspaceId: fixture.workspaceId, deletedAt: null } }),
    ).toBe(2);
  });

  it('the flag fails closed when unregistered, and a workspace rule turns it on for that workspace only', async () => {
    const a = await tenantWorkspace('flag-a');
    const b = await tenantWorkspace('flag-b');
    const engine = (documents: Record<string, Record<string, unknown>>) =>
      new EntitlementService({
        prisma: platform as never,
        catalogueSource: new StubCatalogue(documents),
        environment: 'DEVELOPMENT',
      });

    const unregistered = engine({});
    expect(await unregistered.can(a.workspaceId, MULTI_BRAND_FEATURE)).toBe(false);

    const targeted = engine({
      entitlements: {
        features: [
          {
            key: MULTI_BRAND_FEATURE,
            name: { en: 'Several brands', ar: 'عدة علامات' },
            category: 'workspace',
            valueType: 'boolean',
            defaultValue: false,
            enumValues: [],
            dependsOn: [],
            status: 'active',
          },
        ],
      },
      'feature-flags': {
        flags: [
          {
            featureKey: MULTI_BRAND_FEATURE,
            killSwitch: false,
            globalEnabled: false,
            enabledForPlans: [],
            enabledForWorkspaces: [a.workspaceId],
            disabledForWorkspaces: [],
            betaGroups: [],
            countries: [],
            activeFrom: null,
            activeUntil: null,
            percentageRollout: null,
          },
        ],
      },
    });
    expect(await targeted.can(a.workspaceId, MULTI_BRAND_FEATURE)).toBe(true);
    expect(await targeted.can(b.workspaceId, MULTI_BRAND_FEATURE)).toBe(false);
  });
});
