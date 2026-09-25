import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotesService, type NoteActor } from '@brandspace/collaboration';
import { systemClock } from '@brandspace/shared';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { appRoleClient, ensureWorkspaceRbac } from './fixtures';

/**
 * PHASE 6 · P6-16 — THE GLOBAL NOTES SURFACE AND THE TOP BAR'S NOTES DOT.
 *
 * `NotesService.inbox` reads conversations ACROSS subjects for the first time,
 * and `unreadMentionCount` is now what the top bar draws its dot from. Both are
 * the kind of read that leaks by being broad, so this pins, against real
 * PostgreSQL:
 *
 *   1. another workspace's threads never appear — under the APPLICATION role
 *      with RLS in force, not only by the service's own predicate;
 *   2. a thread about a brand outside the member's scope never appears, and
 *      its mentions are not counted (the count used to include them);
 *   3. the rail's brand NARROWS the scope and never replaces it (D-267);
 *   4. without the Notes permission the inbox is a 404 and the count is zero;
 *   5. unread state is the domain's own `readAt`, cleared by the domain's own
 *      mark-read;
 *   6. a thread whose subject was deleted is not listed.
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
      email: `inbox-${label}-${crypto.randomUUID()}@example.local`,
      name: `Inbox ${label}`,
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
      slug: `inbox-${run.slice(0, 12)}`,
      name: `Inbox ${label}`,
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

describe('P6-16 · the Notes inbox', () => {
  it('lists a mention for the person named, unread, and clears it through the domain', async () => {
    const w = await world('mention');
    const threadId = await mentionOwner(w, w.itemOne, 'Can you check the caption?');

    const inbox = await service(w.workspaceId).inbox(actor(w.ownerId));
    const entry = inbox.forYou.find((e) => e.threadId === threadId);
    expect(entry).toMatchObject({
      reason: 'mentioned',
      unreadMentions: 1,
      subjectType: 'CONTENT_ITEM',
      subjectTitle: 'Draft one mention',
      brandName: 'One',
    });
    expect(entry?.lastNote?.body).toBe('Can you check the caption?');
    expect(await service(w.workspaceId).unreadMentionCount(actor(w.ownerId))).toBe(1);

    await service(w.workspaceId).markMentionsRead({ actor: actor(w.ownerId), threadId });
    const after = await service(w.workspaceId).inbox(actor(w.ownerId));
    expect(after.forYou.find((e) => e.threadId === threadId)?.unreadMentions).toBe(0);
    expect(await service(w.workspaceId).unreadMentionCount(actor(w.ownerId))).toBe(0);
  });

  it('never shows another workspace’s conversations — under RLS as well as by predicate', async () => {
    const a = await world('tenant-a');
    const b = await world('tenant-b');
    const foreign = await mentionOwner(b, b.itemOne, "B's private note");
    const own = await mentionOwner(a, a.itemOne, "A's note");

    const underRls = await withWorkspace(
      a.workspaceId,
      (db) => service(a.workspaceId, db).inbox(actor(a.ownerId)),
      { prisma: app },
    );
    const ids = [...underRls.forYou, ...underRls.open].map((e) => e.threadId);
    expect(ids).toContain(own);
    expect(ids).not.toContain(foreign);

    // B's owner, asked about from A, is nobody there.
    const crossed = await service(a.workspaceId).inbox(actor(b.ownerId));
    expect([...crossed.forYou, ...crossed.open].map((e) => e.threadId)).not.toContain(foreign);
    expect(await service(a.workspaceId).unreadMentionCount(actor(b.ownerId))).toBe(0);
  });

  it('a brand outside the member’s scope is neither listed nor counted', async () => {
    const w = await world('scope');
    const inScope = await mentionOwner(w, w.itemOne, 'in scope');
    const outOfScope = await mentionOwner(w, w.itemTwo, 'out of scope');
    const scoped = actor(w.ownerId, { brandScope: [w.brandOne] });

    const inbox = await service(w.workspaceId).inbox(scoped);
    const ids = [...inbox.forYou, ...inbox.open].map((e) => e.threadId);
    expect(ids).toContain(inScope);
    expect(ids).not.toContain(outOfScope);

    // The dot: the out-of-scope mention used to be counted here.
    expect(await service(w.workspaceId).unreadMentionCount(scoped)).toBe(1);
    expect(await service(w.workspaceId).unreadMentionCount(actor(w.ownerId))).toBe(2);
  });

  it('the rail’s brand narrows the scope and never replaces it', async () => {
    const w = await world('narrow');
    const one = await mentionOwner(w, w.itemOne, 'one');
    const two = await mentionOwner(w, w.itemTwo, 'two');

    const narrowed = await service(w.workspaceId).inbox(actor(w.ownerId), { brandId: w.brandTwo });
    expect(narrowed.forYou.map((e) => e.threadId)).toEqual([two]);

    // Asking for a brand OUTSIDE the scope yields nothing — not the scope.
    const escaped = await service(w.workspaceId).inbox(
      actor(w.ownerId, { brandScope: [w.brandOne] }),
      { brandId: w.brandTwo },
    );
    expect([...escaped.forYou, ...escaped.open]).toEqual([]);
    expect(one).toBeTruthy();
  });

  it('without the Notes permission the inbox is a 404 and the dot is zero', async () => {
    const w = await world('permission');
    await mentionOwner(w, w.itemOne, 'hello');
    const without = actor(w.ownerId, { permissionKeys: ['workspace.read'] });
    await expect(service(w.workspaceId).inbox(without)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await service(w.workspaceId).unreadMentionCount(without)).toBe(0);
  });

  it('separates what concerns the reader from other open conversations, and drops resolved ones from the latter', async () => {
    const w = await world('sections');
    const theirs = await service(w.workspaceId).startThread({
      actor: actor(w.colleagueId),
      subject: { type: 'BRAND', brandId: w.brandOne },
      body: 'Not about the owner',
    });
    const inbox = await service(w.workspaceId).inbox(actor(w.ownerId));
    expect(inbox.forYou.map((e) => e.threadId)).not.toContain(theirs.threadId);
    const open = inbox.open.find((e) => e.threadId === theirs.threadId);
    expect(open).toMatchObject({ reason: 'open', subjectType: 'BRAND', subjectTitle: null });

    await service(w.workspaceId).resolve({
      actor: actor(w.colleagueId),
      threadId: theirs.threadId,
    });
    const later = await service(w.workspaceId).inbox(actor(w.ownerId));
    expect(later.open.map((e) => e.threadId)).not.toContain(theirs.threadId);
  });

  it('a thread whose content was deleted is neither listed nor counted', async () => {
    const w = await world('deleted');
    const threadId = await mentionOwner(w, w.itemOne, 'about to be deleted');
    await platform.contentItem.update({
      where: { id: w.itemOne },
      data: { deletedAt: new Date() },
    });
    const inbox = await service(w.workspaceId).inbox(actor(w.ownerId));
    expect([...inbox.forYou, ...inbox.open].map((e) => e.threadId)).not.toContain(threadId);
    // And the dot agrees with the list: a mention the page cannot show is not counted.
    expect(await service(w.workspaceId).unreadMentionCount(actor(w.ownerId))).toBe(0);
  });
});
