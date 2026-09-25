import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotesService, type NoteActor } from '@brandspace/collaboration';
import { systemClock } from '@brandspace/shared';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * PHASE 6 FINAL · D-281 — NOTES ABOUT ASSETS, A DUE DATE, AND IMPORTANCE.
 *
 * An asset is a new subject a caller can NAME, so it gets the full treatment,
 * under the application role and RLS:
 *
 *   - another workspace's asset, an asset of a brand outside the reader's
 *     scope, a deleted asset and a fabricated id are refused identically;
 *   - a brand's own asset is discussed only within that brand (the service
 *     reads the brand from the asset, and a trigger refuses anything else);
 *   - a workspace-shared asset is discussed within a brand the reader names
 *     and may act on;
 *   - due dates and importance are the thread's, audited, and inside the same
 *     scope as every other thread operation.
 *
 * Every fixture it needs, it creates.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let otherBrandId: string;
let otherBrandAssetId: string;
let deletedAssetId: string;

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;

const service = (db: TenantScopedClient) =>
  new NotesService({ db, workspaceId: fixtures.a.workspaceId, clock: systemClock });

const actor = (overrides: Partial<NoteActor> = {}): NoteActor => ({
  userId: fixtures.a.userId,
  // Every role that reads content also triages notes (Q12, `notes.manage`).
  permissionKeys: ['content.read', 'notes.manage'],
  brandScope: [],
  ...overrides,
});

async function refusal(run: (svc: NotesService) => Promise<unknown>) {
  try {
    await inA((db) => run(service(db)));
  } catch (error: unknown) {
    const shaped = error as { code?: string; message?: string };
    return { code: shaped.code ?? 'NOT_AN_APP_ERROR', message: shaped.message ?? '' };
  }
  throw new Error('expected a refusal');
}

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  const suffix = randomUUID().slice(0, 8);
  otherBrandId = (
    await platform.brand.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        name: `Other ${suffix}`,
        slug: `other-${suffix}`,
        status: 'ACTIVE',
        defaultLocale: 'EN',
        supportedLocales: ['EN'],
      },
      select: { id: true },
    })
  ).id;
  const asset = (brandId: string | null, name: string, deletedAt: Date | null = null) =>
    platform.asset
      .create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId,
          name,
          kind: 'IMAGE',
          mimeType: 'image/png',
          sizeBytes: 10,
          storageKey: `ws/${fixtures.a.workspaceId}/notes/${randomUUID()}`,
          checksumSha256: `notes-${randomUUID()}`,
          scanStatus: 'CLEAN',
          status: 'READY',
          currentVersion: 1,
          uploadedByUserId: fixtures.a.userId,
          deletedAt,
        },
        select: { id: true },
      })
      .then((row) => row.id);
  otherBrandAssetId = await asset(otherBrandId, 'other-brand.png');
  deletedAssetId = await asset(fixtures.a.brandId, 'gone.png', new Date());
}, 90_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('D-281 · a note about an asset', () => {
  it('a brand’s own asset: the thread belongs to the asset’s brand, and lists there', async () => {
    const { threadId } = await inA((db) =>
      service(db).startThread({
        actor: actor(),
        subject: { type: 'ASSET', assetId: fixtures.a.assetId, brandId: fixtures.a.brandId },
        body: 'Is this the final crop?',
      }),
    );
    const row = await inA((db) => db.noteThread.findUniqueOrThrow({ where: { id: threadId } }));
    expect(row).toMatchObject({
      subjectType: 'ASSET',
      assetId: fixtures.a.assetId,
      brandId: fixtures.a.brandId,
      contentItemId: null,
      campaignId: null,
    });
    const threads = await inA((db) =>
      service(db).threadsFor(
        { type: 'ASSET', assetId: fixtures.a.assetId, brandId: fixtures.a.brandId },
        actor(),
      ),
    );
    expect(threads.map((thread) => thread.id)).toContain(threadId);

    const inbox = await inA((db) => service(db).inbox(actor()));
    const entry = [...inbox.forYou, ...inbox.open].find((e) => e.threadId === threadId);
    expect(entry).toMatchObject({ subjectType: 'ASSET', assetId: fixtures.a.assetId });
    expect(entry?.subjectTitle).toBe('hero-shot.png');
  });

  it('a shared asset is discussed within the brand the reader names', async () => {
    const { threadId } = await inA((db) =>
      service(db).startThread({
        actor: actor(),
        subject: { type: 'ASSET', assetId: fixtures.a.workspaceAssetId, brandId: otherBrandId },
        body: 'Can we use this for the other brand too?',
      }),
    );
    const row = await inA((db) => db.noteThread.findUniqueOrThrow({ where: { id: threadId } }));
    expect(row.brandId).toBe(otherBrandId);
  });

  it('foreign, out-of-scope, mismatched, deleted and fabricated assets are refused identically', async () => {
    const start = (assetId: string, brandId: string, scope: readonly string[] = []) =>
      refusal((svc) =>
        svc.startThread({
          actor: actor({ brandScope: scope }),
          subject: { type: 'ASSET', assetId, brandId },
          body: 'x',
        }),
      );
    const before = await inA((db) => db.noteThread.count());
    const refusals = [
      await start(fixtures.b.assetId, fixtures.a.brandId),
      await start(otherBrandAssetId, fixtures.a.brandId),
      await start(otherBrandAssetId, otherBrandId, [fixtures.a.brandId]),
      await start(fixtures.a.workspaceAssetId, otherBrandId, [fixtures.a.brandId]),
      await start(deletedAssetId, fixtures.a.brandId),
      await start(randomUUID(), fixtures.a.brandId),
    ];
    for (const refused of refusals) {
      expect(refused.code).toBe('NOT_FOUND');
      expect(refused.message).toBe(refusals[0]?.message);
    }
    expect(await inA((db) => db.noteThread.count())).toBe(before);
  });

  it('the database itself refuses an asset thread in the wrong brand, or half a subject', async () => {
    const base = {
      workspaceId: fixtures.a.workspaceId,
      subjectType: 'ASSET' as const,
      status: 'OPEN' as const,
      createdByUserId: fixtures.a.userId,
    };
    // Another brand's asset, filed under this brand: the trigger refuses.
    await expect(
      inA((db) =>
        db.noteThread.create({
          data: { ...base, brandId: fixtures.a.brandId, assetId: otherBrandAssetId },
        }),
      ),
    ).rejects.toThrow();
    // An ASSET subject with no asset: the CHECK refuses.
    await expect(
      inA((db) =>
        db.noteThread.create({ data: { ...base, brandId: fixtures.a.brandId, assetId: null } }),
      ),
    ).rejects.toThrow();
    // Another workspace's asset: the composite foreign key refuses.
    await expect(
      inA((db) =>
        db.noteThread.create({
          data: { ...base, brandId: fixtures.a.brandId, assetId: fixtures.b.assetId },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('D-281 · due date and importance', () => {
  it('are set on the thread, audited, and sort Important first', async () => {
    const subject = { type: 'CONTENT_ITEM' as const, contentItemId: fixtures.a.contentItemId };
    const first = await inA((db) =>
      service(db).startThread({ actor: actor(), subject, body: 'first' }),
    );
    const second = await inA((db) =>
      service(db).startThread({ actor: actor(), subject, body: 'second' }),
    );
    const due = new Date('2026-10-01T23:59:59.000Z');
    await inA((db) => service(db).setDue({ actor: actor(), threadId: first.threadId, dueAt: due }));
    await inA((db) =>
      service(db).setImportance({
        actor: actor(),
        threadId: first.threadId,
        importance: 'IMPORTANT',
      }),
    );

    const threads = await inA((db) => service(db).threadsFor(subject, actor()));
    const flagged = threads.find((thread) => thread.id === first.threadId);
    expect(flagged).toMatchObject({ importance: 'IMPORTANT', dueAt: due });
    expect(threads[0]?.id).toBe(first.threadId);
    expect(threads.find((thread) => thread.id === second.threadId)?.importance).toBe('NORMAL');

    const audits = await inA((db) =>
      db.auditEvent.findMany({
        where: { resourceId: first.threadId, action: { startsWith: 'customer.note.' } },
        select: { action: true },
      }),
    );
    expect(audits.map((row) => row.action)).toEqual(
      expect.arrayContaining(['customer.note.due_set', 'customer.note.importance_set']),
    );

    // Cleared again.
    await inA((db) =>
      service(db).setDue({ actor: actor(), threadId: first.threadId, dueAt: null }),
    );
    const cleared = await inA((db) =>
      db.noteThread.findUniqueOrThrow({ where: { id: first.threadId } }),
    );
    expect(cleared.dueAt).toBeNull();
  });

  it('another workspace’s thread, and one outside the reader’s scope, cannot be touched', async () => {
    const { threadId } = await withWorkspace(
      fixtures.b.workspaceId,
      (db) =>
        new NotesService({
          db,
          workspaceId: fixtures.b.workspaceId,
          clock: systemClock,
        }).startThread({
          actor: { userId: fixtures.b.userId, permissionKeys: ['content.read'], brandScope: [] },
          subject: { type: 'CONTENT_ITEM', contentItemId: fixtures.b.contentItemId },
          body: 'B only',
        }),
      { prisma: app },
    );
    const foreign = await refusal((svc) =>
      svc.setImportance({ actor: actor(), threadId, importance: 'IMPORTANT' }),
    );
    expect(foreign.code).toBe('NOT_FOUND');

    const own = await inA((db) =>
      service(db).startThread({
        actor: actor(),
        subject: { type: 'CONTENT_ITEM', contentItemId: fixtures.a.contentItemId },
        body: 'scoped',
      }),
    );
    const outOfScope = await refusal((svc) =>
      svc.setDue({
        actor: actor({ brandScope: [otherBrandId] }),
        threadId: own.threadId,
        dueAt: new Date(),
      }),
    );
    expect(outOfScope).toEqual(foreign);
  });
});
