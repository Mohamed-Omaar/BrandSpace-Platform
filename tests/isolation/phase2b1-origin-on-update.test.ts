import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { BrandKnowledgeService, type StalenessPolicy } from '@brandspace/brand-brain';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * PHASE 2B-1 REVIEW, BLOCKER 0 (D-335) — AN UPDATE RECORDS ITS OWN ORIGIN,
 * AGAINST REAL POSTGRESQL.
 *
 * Every allowed write leaves the item AND its new version row with the
 * effective origin of that write, so precedence always judges the text the row
 * holds now. Lower-authority input (SETUP or DOCUMENT) never replaces HUMAN
 * knowledge: it is refused, and the refused write changes nothing.
 */

let fixtures: IsolationFixtures;
let app: PrismaClient;
const POLICY: StalenessPolicy = { reviewIntervalDays: 90 };

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 120_000);

afterAll(async () => {
  await app?.$disconnect();
});

function inA<T>(
  fn: (svc: BrandKnowledgeService, db: TenantScopedClient) => Promise<T>,
): Promise<T> {
  return withWorkspace(
    fixtures.a.workspaceId,
    async (db) => fn(new BrandKnowledgeService({ db, workspaceId: fixtures.a.workspaceId }), db),
    { prisma: app },
  );
}

const actor = () => ({
  userId: fixtures.a.userId,
  permissionKeys: [] as string[],
  brandScope: [] as string[],
});

let sequence = 0;
const uniqueKey = (stem: string) => `${stem}.b0.${(sequence += 1)}`;

function documentCandidate(db: TenantScopedClient, itemKey: string, body: string) {
  return db.brandKnowledgeCandidate.create({
    data: {
      workspaceId: fixtures.a.workspaceId,
      brandId: fixtures.a.brandId,
      sourceDocumentId: fixtures.a.sourceDocumentId,
      area: 'AUDIENCE',
      itemKey,
      extractedTitle: { en: 'Extracted' },
      extractedBody: { en: body },
      confidenceMilli: 700,
      evidence: [{ chunkId: fixtures.a.sourceChunkId, locator: 'page 1' }],
    },
  });
}

/** Accept a document candidate for `key`, from Brand Brain or from Setup Review. */
function accept(db: TenantScopedClient, svc: BrandKnowledgeService, key: string, inSetup: boolean) {
  return documentCandidate(db, key, `text ${sequence}`).then((row) =>
    svc.reviewCandidate({
      candidateId: row.id,
      decision: 'accept',
      actor: actor(),
      policy: POLICY,
      acceptedInSetup: inSetup,
    }),
  );
}

async function state(db: TenantScopedClient, itemId: string) {
  const item = await db.brandKnowledgeItem.findUniqueOrThrow({
    where: { id: itemId },
    select: { origin: true, version: true, title: true, body: true },
  });
  const versions = await db.brandKnowledgeVersion.findMany({
    where: { knowledgeItemId: itemId },
    orderBy: { version: 'asc' },
    select: { version: true, origin: true, body: true },
  });
  return { item, versions };
}

describe('Blocker 0 · an update writes its effective origin to the item and the version', () => {
  it('DOCUMENT → accepted on Setup Review → SETUP, on the item and the new version', async () => {
    const key = uniqueKey('audience.doc-to-setup');
    const result = await inA(async (svc, db) => {
      const first = await accept(db, svc, key, false);
      await accept(db, svc, key, true);
      return state(db, first.itemId ?? '');
    });
    expect(result.item).toMatchObject({ origin: 'SETUP', version: 2 });
    expect(result.versions.map((v) => [v.version, v.origin])).toEqual([
      [1, 'DOCUMENT'],
      [2, 'SETUP'],
    ]);
  });

  it('SETUP → SETUP stores SETUP on the item and the new version', async () => {
    const key = uniqueKey('audience.setup-to-setup');
    const result = await inA(async (svc, db) => {
      const first = await accept(db, svc, key, true);
      await accept(db, svc, key, true);
      return state(db, first.itemId ?? '');
    });
    expect(result.item).toMatchObject({ origin: 'SETUP', version: 2 });
    expect(result.versions.map((v) => v.origin)).toEqual(['SETUP', 'SETUP']);
  });

  it('SETUP → HUMAN edit is allowed and makes the item and its version HUMAN; a later DOCUMENT is refused', async () => {
    const key = uniqueKey('audience.setup-to-human');
    const itemId = await inA(async (svc, db) => {
      const first = await accept(db, svc, key, true);
      await svc.updateItem({
        itemId: first.itemId ?? '',
        title: { en: 'Ours' },
        body: { en: 'Written by a person' },
        actor: actor(),
        policy: POLICY,
      });
      return first.itemId ?? '';
    });
    const edited = await inA((_svc, db) => state(db, itemId));
    expect(edited.item).toMatchObject({ origin: 'HUMAN', version: 2 });
    expect(edited.versions.map((v) => v.origin)).toEqual(['SETUP', 'HUMAN']);

    // A later document for the same key must not replace what the person wrote.
    await expect(inA((svc, db) => accept(db, svc, key, false))).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(await inA((_svc, db) => state(db, itemId))).toEqual(edited);
  });

  it('a SETUP or DOCUMENT update of a HUMAN item is refused and changes nothing', async () => {
    const key = uniqueKey('audience.human');
    const itemId = await inA(async (svc) => {
      const created = await svc.createItem({
        brandId: fixtures.a.brandId,
        area: 'AUDIENCE',
        itemKey: key,
        title: { en: 'Founders' },
        body: { en: 'Stated by a person' },
        actor: actor(),
        policy: POLICY,
      });
      return created.id;
    });
    const before = await inA((_svc, db) => state(db, itemId));
    expect(before.item.origin).toBe('HUMAN');

    for (const incomingOrigin of ['SETUP', 'DOCUMENT'] as const) {
      await expect(
        inA((svc) =>
          svc.updateItem({
            itemId,
            title: { en: 'Replaced' },
            body: { en: `By ${incomingOrigin}` },
            actor: actor(),
            policy: POLICY,
            incomingOrigin,
          }),
        ),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    }
    for (const inSetup of [true, false]) {
      await expect(inA((svc, db) => accept(db, svc, key, inSetup))).rejects.toMatchObject({
        code: 'CONFLICT',
      });
    }
    expect(await inA((_svc, db) => state(db, itemId))).toEqual(before);
  });

  it('every version row carries the origin of the item version it represents', async () => {
    const key = uniqueKey('audience.history');
    const history = await inA(async (svc, db) => {
      const first = await accept(db, svc, key, false); // v1 DOCUMENT
      const itemId = first.itemId ?? '';
      await accept(db, svc, key, true); // v2 SETUP
      await accept(db, svc, key, false); // v3 DOCUMENT
      await svc.updateItem({
        itemId,
        title: { en: 'Edited' },
        body: { en: 'By a person' },
        actor: actor(),
        policy: POLICY,
      }); // v4 HUMAN
      return state(db, itemId);
    });
    expect(history.versions.map((v) => v.origin)).toEqual([
      'DOCUMENT',
      'SETUP',
      'DOCUMENT',
      'HUMAN',
    ]);
    const latest = history.versions.at(-1);
    expect(latest?.version).toBe(history.item.version);
    expect(latest?.origin).toBe(history.item.origin);
    expect(latest?.body).toEqual(history.item.body);
  });
});
