import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { assertUsableLogo } from '../../apps/dashboard/src/server/brand-profile-save';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * PHASE 2C-2, OWNER DECISION D — A BRAND LOGO MUST BE A USABLE IMAGE, checked
 * on the server for both logo columns. A crafted request naming a font, an
 * unready, unclean or archived asset, or another brand's asset is refused; the
 * brand's own ready, clean image and a shared one are accepted.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let otherBrandId: string;

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;

async function asset(input: {
  brandId: string | null;
  kind?: 'IMAGE' | 'FONT';
  status?: 'READY' | 'PROCESSING' | 'ARCHIVED';
  scanStatus?: 'CLEAN' | 'PENDING' | 'INFECTED';
  archived?: boolean;
  workspaceId?: string;
}): Promise<string> {
  const workspaceId = input.workspaceId ?? fixtures.a.workspaceId;
  const id = randomUUID();
  await platform.asset.create({
    data: {
      id,
      workspaceId,
      brandId: input.brandId,
      name: input.kind === 'FONT' ? 'Brand.ttf' : 'logo.png',
      kind: input.kind ?? 'IMAGE',
      mimeType: input.kind === 'FONT' ? 'font/ttf' : 'image/png',
      sizeBytes: 1_024,
      storageKey: `ws/${workspaceId}/asset/${id}/v1`,
      checksumSha256: `logo-check-${id}`,
      scanStatus: input.scanStatus ?? 'CLEAN',
      status: input.status ?? 'READY',
      currentVersion: 1,
      ...(input.archived ? { archivedAt: new Date() } : {}),
    },
  });
  return id;
}

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  otherBrandId = (
    await platform.brand.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        slug: `logo-check-${Date.now()}`,
        name: 'Other Brand',
        defaultLocale: 'EN',
        status: 'ACTIVE',
      },
    })
  ).id;
});

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

const check = (assetId: string) => inA((db) => assertUsableLogo(db, fixtures.a.brandId, assetId));

describe('owner decision D — the logo is checked on the server', () => {
  it('accepts the brand’s own ready, clean image, and a shared one', async () => {
    await expect(check(await asset({ brandId: fixtures.a.brandId }))).resolves.toBeUndefined();
    await expect(check(await asset({ brandId: null }))).resolves.toBeUndefined();
  });

  it('refuses a FONT asset', async () => {
    await expect(
      check(await asset({ brandId: fixtures.a.brandId, kind: 'FONT' })),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('refuses an image that is not READY, or not CLEAN', async () => {
    await expect(
      check(
        await asset({ brandId: fixtures.a.brandId, status: 'PROCESSING', scanStatus: 'PENDING' }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      check(await asset({ brandId: fixtures.a.brandId, scanStatus: 'INFECTED' })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses an archived image', async () => {
    await expect(
      check(await asset({ brandId: fixtures.a.brandId, status: 'ARCHIVED', archived: true })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses another brand’s image, and another workspace’s', async () => {
    await expect(check(await asset({ brandId: otherBrandId }))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const foreign = await asset({
      brandId: fixtures.b.brandId,
      workspaceId: fixtures.b.workspaceId,
    });
    await expect(check(foreign)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('Settings → Brand runs the check for BOTH logo columns whenever one changes', () => {
    const action = readFileSync(
      path.resolve(
        import.meta.dirname,
        '../../apps/dashboard/src/app/[locale]/settings/brand/actions.ts',
      ),
      'utf8',
    );
    expect(action).toMatch(/\['primaryLogoAssetId', 'secondaryLogoAssetId'\] as const/);
    expect(action).toMatch(/assertUsableLogo\(db, brandId, next\)/);
  });
});
