import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { PublishMediaResolver } from '@brandspace/assets';
import { ContentMediaResolver } from '@brandspace/content';
import { InMemoryObjectStore } from '@brandspace/storage';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * PHASE 6 FINAL · D-286 — EXPIRED RIGHTS MAY NOT BE ATTACHED OR PUBLISHED.
 *
 * `asset.rightsExpiryAt` is the date the licence ends. The ONE publishability
 * predicate both callers share now refuses a file whose rights have lapsed —
 * the composer when an author attaches it, and the pipeline just before a
 * provider would receive it. Both are asked here, with a fixed clock either
 * side of the date, so the rule is proven rather than assumed.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;
let brandId: string;
let lapsing: string;
let open: string;

const EXPIRY = new Date('2030-06-01T00:00:00.000Z');
const before = { now: () => new Date('2030-05-31T23:59:00.000Z') };
const after = { now: () => new Date('2030-06-01T00:01:00.000Z') };

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;

async function asset(overrides: Record<string, unknown>): Promise<string> {
  return (
    await inA((db) =>
      db.asset.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId,
          name: `rights-${randomUUID().slice(0, 6)}.png`,
          kind: 'IMAGE',
          mimeType: 'image/png',
          sizeBytes: 2_048,
          storageKey: `p6r/${randomUUID()}`,
          checksumSha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
          status: 'READY',
          scanStatus: 'CLEAN',
          ...overrides,
        } as never,
        select: { id: true },
      }),
    )
  ).id;
}

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
  brandId = fixtures.a.brandId;
  lapsing = await asset({ license: 'Stock licence #4411', rightsExpiryAt: EXPIRY });
  open = await asset({});
}, 90_000);

afterAll(async () => {
  await app?.$disconnect();
});

describe('D-286 · the composer', () => {
  const resolve = (ids: string[], clock: { now(): Date }) =>
    inA((db) =>
      new ContentMediaResolver({ db, workspaceId: fixtures.a.workspaceId, clock }).resolve({
        assetIds: ids,
        brandId,
        brandScope: [],
      }),
    );

  it('attaches a licensed file before its rights end', async () => {
    expect((await resolve([lapsing], before)).map((row) => row.id)).toEqual([lapsing]);
  });

  it('refuses it the minute they have ended — the same answer as a missing file', async () => {
    await expect(resolve([lapsing], after)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a file with no recorded limit is unaffected', async () => {
    expect((await resolve([open], after)).map((row) => row.id)).toEqual([open]);
  });
});

describe('D-286 · the publish pipeline', () => {
  it('refuses to hand a provider a file whose rights ended after it was scheduled', async () => {
    const store = new InMemoryObjectStore();
    const run = (clock: { now(): Date }) =>
      inA((db) =>
        new PublishMediaResolver({
          db,
          workspaceId: fixtures.a.workspaceId,
          store,
          clock,
        }).resolve({ brandId, assetIds: [lapsing], brandScope: [] }),
      );
    await expect(run(after)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
