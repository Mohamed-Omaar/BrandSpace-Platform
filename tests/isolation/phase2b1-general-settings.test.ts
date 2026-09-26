import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import type { FeatureGate } from '../../apps/dashboard/src/server/multi-brand';
import {
  generalSettingsFrom,
  saveGeneralSettings,
} from '../../apps/dashboard/src/server/general-settings';
import { appRoleClient, platformRoleClient } from './fixtures';

/**
 * PROTOTYPE v94 PHASE 2B-1, ITEM 3 — SETTINGS → GENERAL (A9, D-330), AGAINST
 * REAL POSTGRESQL.
 *
 * The workspace's own fields change only that workspace; the sole brand's
 * industry and website change only with `brand.manage`, inside BrandScope and
 * with multi-brand off; and the database refuses a city outside Egypt and a
 * weekday that does not exist, whatever the application sends.
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

async function workspaceWithBrand(label: string): Promise<{
  workspaceId: string;
  brandId: string;
  ownerId: string;
}> {
  const id = crypto.randomUUID();
  const owner = await platform.user.create({
    data: {
      email: `p2b1-gs-${label}-${id.slice(0, 8)}@example.local`,
      name: 'General settings fixture',
      status: 'ACTIVE',
      timezone: 'UTC',
    },
  });
  await platform.workspace.create({
    data: {
      id,
      workspaceId: id,
      slug: `p2b1-gs-${id.slice(0, 12)}`,
      name: `General ${label}`,
      ownerUserId: owner.id,
      status: 'ACTIVE',
      country: 'US',
      defaultLocale: 'EN',
      timezone: 'UTC',
      currency: 'USD',
    },
  });
  const brand = await platform.brand.create({
    data: {
      workspaceId: id,
      slug: `p2b1-gs-${label}-${id.slice(0, 6)}`,
      name: `Brand ${label}`,
      status: 'ACTIVE',
      industry: 'Bakery',
      websiteUrl: 'https://before.example',
    },
    select: { id: true },
  });
  return { workspaceId: id, brandId: brand.id, ownerId: owner.id };
}

function inTenant<T>(workspaceId: string, fn: (db: TenantScopedClient) => Promise<T>): Promise<T> {
  return withWorkspace(workspaceId, fn, { prisma: app });
}

const OFF: FeatureGate = { can: async () => false };
const ON: FeatureGate = { can: async () => true };

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const EGYPT = {
  name: 'Cairo Bakery',
  defaultLocale: 'AR',
  country: 'EG',
  timezone: 'Africa/Cairo',
  city: 'EG-C',
  weekStartsOn: '6',
};

const MANAGER = ['workspace.update', 'brand.manage'];

describe('A9 · Settings → General saves the workspace, and only that workspace', () => {
  it('stores country, zone, city and week start, and audits the change', async () => {
    const mine = await workspaceWithBrand('mine');
    const theirs = await workspaceWithBrand('theirs');
    await inTenant(mine.workspaceId, (db) =>
      saveGeneralSettings(
        db,
        OFF,
        {
          workspaceId: mine.workspaceId,
          actorUserId: mine.ownerId,
          permissionKeys: MANAGER,
          brandScope: [],
        },
        generalSettingsFrom(form(EGYPT)),
      ),
    );
    const saved = await platform.workspace.findUniqueOrThrow({ where: { id: mine.workspaceId } });
    expect(saved).toMatchObject({
      name: 'Cairo Bakery',
      defaultLocale: 'AR',
      country: 'EG',
      timezone: 'Africa/Cairo',
      city: 'EG-C',
      weekStartsOn: 6,
    });
    const untouched = await platform.workspace.findUniqueOrThrow({
      where: { id: theirs.workspaceId },
    });
    expect(untouched).toMatchObject({ country: 'US', city: null, weekStartsOn: null });
    const audit = await platform.auditEvent.findFirst({
      where: { workspaceId: mine.workspaceId, action: 'workspace.settings.updated' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit?.after).toMatchObject({ country: 'EG', city: 'EG-C', weekStartsOn: 6 });
  });

  it('clears the city when the country is no longer Egypt', async () => {
    const fixture = await workspaceWithBrand('clear-city');
    const context = {
      workspaceId: fixture.workspaceId,
      actorUserId: fixture.ownerId,
      permissionKeys: MANAGER,
      brandScope: [],
    };
    await inTenant(fixture.workspaceId, (db) =>
      saveGeneralSettings(db, OFF, context, generalSettingsFrom(form(EGYPT))),
    );
    await inTenant(fixture.workspaceId, (db) =>
      saveGeneralSettings(
        db,
        OFF,
        context,
        generalSettingsFrom(
          form({ ...EGYPT, country: 'SA', timezone: 'Asia/Riyadh', city: 'EG-C' }),
        ),
      ),
    );
    expect(
      await platform.workspace.findUniqueOrThrow({
        where: { id: fixture.workspaceId },
        select: { country: true, city: true },
      }),
    ).toEqual({ country: 'SA', city: null });
  });

  it('the database refuses a city outside Egypt and a weekday that does not exist', async () => {
    const fixture = await workspaceWithBrand('checks');
    await expect(
      inTenant(fixture.workspaceId, (db) =>
        db.workspace.update({ where: { id: fixture.workspaceId }, data: { city: 'EG-C' } }),
      ),
    ).rejects.toThrow(/workspace_city_egypt_only/);
    await expect(
      inTenant(fixture.workspaceId, (db) =>
        db.workspace.update({ where: { id: fixture.workspaceId }, data: { weekStartsOn: 7 } }),
      ),
    ).rejects.toThrow(/workspace_week_starts_on_range/);
  });
});

describe("A9 · the sole brand's industry and website, from General", () => {
  it('saves them with brand.manage while multi-brand is off, and audits the brand', async () => {
    const fixture = await workspaceWithBrand('brand-ok');
    await inTenant(fixture.workspaceId, (db) =>
      saveGeneralSettings(
        db,
        OFF,
        {
          workspaceId: fixture.workspaceId,
          actorUserId: fixture.ownerId,
          permissionKeys: MANAGER,
          brandScope: [],
        },
        generalSettingsFrom(
          form({
            ...EGYPT,
            brandId: fixture.brandId,
            industry: 'food',
            websiteUrl: 'https://after.example',
          }),
        ),
      ),
    );
    expect(
      await platform.brand.findUniqueOrThrow({
        where: { id: fixture.brandId },
        select: { industry: true, websiteUrl: true },
      }),
    ).toEqual({ industry: 'food', websiteUrl: 'https://after.example' });
    const audit = await platform.auditEvent.findFirst({
      where: { workspaceId: fixture.workspaceId, action: 'brand.profile.updated' },
    });
    expect(audit?.before).toEqual({ industry: 'Bakery', websiteUrl: 'https://before.example' });
  });

  it('refuses without brand.manage, outside BrandScope, and with multi-brand on — and changes nothing', async () => {
    const fixture = await workspaceWithBrand('brand-refused');
    const input = generalSettingsFrom(
      form({ ...EGYPT, brandId: fixture.brandId, industry: 'x', websiteUrl: '' }),
    );
    const base = {
      workspaceId: fixture.workspaceId,
      actorUserId: fixture.ownerId,
      brandScope: [] as string[],
    };
    await expect(
      inTenant(fixture.workspaceId, (db) =>
        saveGeneralSettings(db, OFF, { ...base, permissionKeys: ['workspace.update'] }, input),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      inTenant(fixture.workspaceId, (db) =>
        saveGeneralSettings(
          db,
          OFF,
          { ...base, permissionKeys: MANAGER, brandScope: [crypto.randomUUID()] },
          input,
        ),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      inTenant(fixture.workspaceId, (db) =>
        saveGeneralSettings(db, ON, { ...base, permissionKeys: MANAGER }, input),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', publicDetails: { reason: 'MULTI_BRAND_ON' } });
    const row = await platform.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } });
    expect(row).toMatchObject({ country: 'US', city: null });
    expect(
      await platform.brand.findUniqueOrThrow({
        where: { id: fixture.brandId },
        select: { industry: true },
      }),
    ).toEqual({ industry: 'Bakery' });
  });

  it("another workspace's brand is not found, and neither side changes", async () => {
    const mine = await workspaceWithBrand('cross-mine');
    const theirs = await workspaceWithBrand('cross-theirs');
    await expect(
      inTenant(mine.workspaceId, (db) =>
        saveGeneralSettings(
          db,
          OFF,
          {
            workspaceId: mine.workspaceId,
            actorUserId: mine.ownerId,
            permissionKeys: MANAGER,
            brandScope: [],
          },
          generalSettingsFrom(
            form({ ...EGYPT, brandId: theirs.brandId, industry: 'stolen', websiteUrl: '' }),
          ),
        ),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // The transaction rolled back: the workspace half of the save did not land.
    expect(
      await platform.workspace.findUniqueOrThrow({
        where: { id: mine.workspaceId },
        select: { country: true },
      }),
    ).toEqual({ country: 'US' });
    expect(
      await platform.brand.findUniqueOrThrow({
        where: { id: theirs.brandId },
        select: { industry: true },
      }),
    ).toEqual({ industry: 'Bakery' });
  });
});
