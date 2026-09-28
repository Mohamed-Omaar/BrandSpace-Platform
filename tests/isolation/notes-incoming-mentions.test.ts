import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotesService, type NoteActor } from '@brandspace/collaboration';
import { systemClock } from '@brandspace/shared';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { appRoleClient, ensureWorkspaceRbac } from './fixtures';

/**
 * MO10 (Phase 2B-2b, owner option A) — INCOMING MENTIONS, AGAINST REAL
 * POSTGRESQL.
 *
 *   1. The sender of a mention is the mentioning note's author, and a person
 *      naming themselves is never a mention to them: not counted, not
 *      "mentioned" in the inbox, never incoming.
 *   2. The bell's "who" is the note that mentioned the reader, not the
 *      thread's latest note.
 *   3. `incomingMentions` returns exactly what `unreadMentionCount` counts —
 *      newest first, unread only, the Notes permission, the brand scope, no
 *      deleted subject — and never another workspace's, under RLS as well.
 *   4. It writes nothing.
 */

let platform: PrismaClient;
let app: PrismaClient;

interface World {
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly colleagueId: string;
  readonly brandOne: string;
  readonly brandTwo: string;
  readonly itemOne: string;
  readonly itemTwo: string;
}

async function user(label: string): Promise<string> {
  const row = await platform.user.create({
    data: {
      email: `incoming-${label}-${crypto.randomUUID()}@example.local`,
      name: `Incoming ${label}`,
      status: 'ACTIVE',
      timezone: 'UTC',
    },
  });
  return row.id;
}

async function world(label: string): Promise<World> {
  const run = crypto.randomUUID();
  const ownerId = await user(`${label}-owner`);
  const colleagueId = await user(`${label}-colleague`);
  const workspace = await platform.workspace.create({
    data: {
      id: run,
      workspaceId: run,
      slug: `incoming-${run.slice(0, 12)}`,
      name: `Incoming ${label}`,
      ownerUserId: ownerId,
      status: 'ACTIVE',
      country: 'SA',
      defaultLocale: 'EN',
      timezone: 'UTC',
      currency: 'USD',
    },
  });
  const role = await platform.role.findFirstOrThrow({
    where: { key: 'workspace_owner', realm: 'WORKSPACE', workspaceId: null },
    select: { id: true },
  });
  for (const userId of [ownerId, colleagueId]) {
    await platform.membership.create({
      data: {
        workspaceId: workspace.id,
        userId,
        roleId: role.id,
        status: 'ACTIVE',
        acceptedAt: new Date(),
      },
    });
  }
  const brand = async (name: string) =>
    (
      await platform.brand.create({
        data: { workspaceId: workspace.id, name, slug: `${name}-${run.slice(0, 8)}`.toLowerCase() },
      })
    ).id;
  const brandOne = await brand('One');
  const brandTwo = await brand('Two');
  const item = async (brandId: string, title: string) =>
    (
      await platform.contentItem.create({
        data: { workspaceId: workspace.id, brandId, title, status: 'DRAFT' },
      })
    ).id;
  return {
    workspaceId: workspace.id,
    ownerId,
    colleagueId,
    brandOne,
    brandTwo,
    itemOne: await item(brandOne, `Draft one ${label}`),
    itemTwo: await item(brandTwo, `Draft two ${label}`),
  };
}

function actor(userId: string, overrides: Partial<NoteActor> = {}): NoteActor {
  // Every role that reads content also triages notes (Q12, `notes.manage`).
  return { userId, permissionKeys: ['content.read', 'notes.manage'], brandScope: [], ...overrides };
}

function service(workspaceId: string, db: unknown = platform): NotesService {
  return new NotesService({
    db: db as TenantScopedClient,
    workspaceId,
    clock: systemClock,
  });
}

/** The colleague writes a note about an item, naming the owner. */
async function mentionOwner(w: World, contentItemId: string, body: string): Promise<string> {
  const { threadId } = await service(w.workspaceId).startThread({
    actor: actor(w.colleagueId),
    subject: { type: 'CONTENT_ITEM', contentItemId },
    body,
    mentionedUserIds: [w.ownerId],
  });
  return threadId;
}

beforeAll(async () => {
  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) throw new Error('DATABASE_PLATFORM_URL is required.');
  platform = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  app = appRoleClient();
  // CI migrates an EMPTY database and seeds nothing: the role catalogue this
  // suite reads must be bootstrapped here, not inherited from whichever suite
  // happened to run first.
  await ensureWorkspaceRbac(platform);
}, 60_000);

afterAll(async () => {
  await platform?.$disconnect();
  await app?.$disconnect();
});

describe('MO10 · a mention is from somebody else', () => {
  it('naming yourself is not a mention: not counted, not "mentioned", never incoming', async () => {
    const w = await world('self');
    const { threadId } = await service(w.workspaceId).startThread({
      actor: actor(w.ownerId),
      subject: { type: 'CONTENT_ITEM', contentItemId: w.itemOne },
      body: 'Reminder to myself',
      mentionedUserIds: [w.ownerId],
    });
    expect(await service(w.workspaceId).unreadMentionCount(actor(w.ownerId))).toBe(0);
    const entry = (await service(w.workspaceId).inbox(actor(w.ownerId))).forYou.find(
      (e) => e.threadId === threadId,
    );
    expect(entry).toMatchObject({ reason: 'participating', unreadMentions: 0, lastMention: null });
    expect(await service(w.workspaceId).incomingMentions(actor(w.ownerId))).toEqual([]);
  });

  it('the bell’s "who" is the note that mentioned you, not the last one in the thread', async () => {
    const w = await world('who');
    const threadId = await mentionOwner(w, w.itemOne, 'Can you look at this?');
    await service(w.workspaceId).reply({
      actor: actor(w.ownerId),
      threadId,
      body: 'Looking now.',
    });
    const entry = (await service(w.workspaceId).inbox(actor(w.ownerId))).forYou.find(
      (e) => e.threadId === threadId,
    );
    expect(entry?.lastNote?.authorUserId).toBe(w.ownerId);
    expect(entry?.lastMention).toMatchObject({
      authorUserId: w.colleagueId,
      body: 'Can you look at this?',
      unread: true,
    });
  });
});

describe('MO10 · incomingMentions', () => {
  it('is exactly the unread mentions by others, newest first, and reading writes nothing', async () => {
    const w = await world('incoming');
    await mentionOwner(w, w.itemOne, 'first');
    const second = await mentionOwner(w, w.itemOne, 'second');
    const before = await platform.noteMention.findMany({
      where: { workspaceId: w.workspaceId },
      select: { id: true, readAt: true },
    });

    const incoming = await service(w.workspaceId).incomingMentions(actor(w.ownerId));
    expect(incoming.map((m) => m.body)).toEqual(['second', 'first']);
    expect(incoming[0]).toMatchObject({
      authorUserId: w.colleagueId,
      threadId: second,
      subjectType: 'CONTENT_ITEM',
      subjectTitle: 'Draft one incoming',
      brandName: 'One',
    });
    expect(incoming).toHaveLength(
      await service(w.workspaceId).unreadMentionCount(actor(w.ownerId)),
    );
    expect(
      await platform.noteMention.findMany({
        where: { workspaceId: w.workspaceId },
        select: { id: true, readAt: true },
      }),
    ).toEqual(before);

    await service(w.workspaceId).markMentionsRead({ actor: actor(w.ownerId), threadId: second });
    expect(
      (await service(w.workspaceId).incomingMentions(actor(w.ownerId))).map((m) => m.body),
    ).toEqual(['first']);
  });

  it('follows the Notes permission, the brand scope and deleted subjects', async () => {
    const w = await world('rules');
    await mentionOwner(w, w.itemOne, 'in scope');
    await mentionOwner(w, w.itemTwo, 'other brand');
    const scoped = actor(w.ownerId, { brandScope: [w.brandOne] });
    expect((await service(w.workspaceId).incomingMentions(scoped)).map((m) => m.body)).toEqual([
      'in scope',
    ]);
    expect(
      await service(w.workspaceId).incomingMentions(actor(w.ownerId, { permissionKeys: [] })),
    ).toEqual([]);

    await platform.contentItem.update({
      where: { id: w.itemTwo },
      data: { deletedAt: new Date() },
    });
    expect(
      (await service(w.workspaceId).incomingMentions(actor(w.ownerId))).map((m) => m.body),
    ).toEqual(['in scope']);
  });

  it('never returns another workspace’s mentions — under RLS as well as by predicate', async () => {
    const a = await world('tenant-a');
    const b = await world('tenant-b');
    await mentionOwner(b, b.itemOne, "B's private mention");
    await mentionOwner(a, a.itemOne, "A's mention");

    const underRls = await withWorkspace(
      a.workspaceId,
      (db) => service(a.workspaceId, db).incomingMentions(actor(a.ownerId)),
      { prisma: app },
    );
    expect(underRls.map((m) => m.body)).toEqual(["A's mention"]);
    // B's owner, asked about from A, has nothing there.
    expect(await service(a.workspaceId).incomingMentions(actor(b.ownerId))).toEqual([]);
  });
});
