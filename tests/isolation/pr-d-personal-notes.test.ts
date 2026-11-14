import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, withWorkspacePerson } from '@brandspace/database';
import { PersonalNotesService } from '@brandspace/collaboration';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * PR D (D-608), owner condition 3 — A PERSON'S NOTES ARE THEIRS ALONE.
 *
 * `PersonalNote` (`personal_note`) and `PersonalNoteReminder`
 * (`personal_note_reminder`) are readable only when the workspace AND the
 * signed-in person match (`withWorkspacePerson`). Proven here at the database,
 * not only through the service:
 *
 *   - a teammate, the workspace's admin and its owner cannot read, list,
 *     count, update or delete another person's notes, nor write one in
 *     their name;
 *   - the Control Center's platform role has no privilege on `personal_note`
 *     at all, and may only read and update reminders (the sweep);
 *   - with `app.user_id` unset — a transaction that set only the workspace —
 *     no personal row is visible;
 *   - a reminder in another workspace cannot be read or touched, even by a
 *     person who belongs to both.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;

/** People in workspace A, each with a real ACTIVE membership. */
let author: string;
let teammate: string;
let admin: string;
let owner: string;
let noteId: string;
let reminderB: string;

async function person(workspaceId: string, roleKey: string): Promise<string> {
  const user = await platform.user.create({
    data: {
      email: `pr-d-${roleKey}-${randomUUID()}@example.test`,
      name: `PR D ${roleKey}`,
      status: 'ACTIVE',
      locale: 'EN',
      timezone: 'UTC',
    },
  });
  await join(workspaceId, user.id, roleKey);
  return user.id;
}

async function join(workspaceId: string, userId: string, roleKey: string): Promise<void> {
  const role = await platform.role.findFirstOrThrow({
    where: { key: roleKey, realm: 'WORKSPACE', workspaceId: null },
  });
  await platform.membership.create({
    data: { workspaceId, userId, roleId: role.id, status: 'ACTIVE', brandScope: [] },
  });
}

/** Run `fn` as `userId` in workspace A, with the raw tenant client. */
const as = <T>(
  userId: string,
  fn: (db: Parameters<Parameters<typeof withWorkspacePerson>[2]>[0]) => Promise<T>,
  workspaceId = fixtures.a.workspaceId,
) => withWorkspacePerson(workspaceId, userId, fn, { prisma: app });

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  author = await person(fixtures.a.workspaceId, 'copywriter');
  teammate = await person(fixtures.a.workspaceId, 'copywriter');
  admin = await person(fixtures.a.workspaceId, 'workspace_admin');
  owner = fixtures.a.userId;

  noteId = await as(author, async (db) => {
    const service = new PersonalNotesService({
      db,
      workspaceId: fixtures.a.workspaceId,
      ownerUserId: author,
    });
    const note = await service.create({ title: 'Call the roaster', body: 'Ask about Friday.' });
    await service.setReminder(note.id, {
      remindAt: new Date(Date.now() + 86_400_000),
      timeZone: 'Asia/Riyadh',
    });
    return note.id;
  });

  // The author also belongs to workspace B, and has a note and reminder there.
  await join(fixtures.b.workspaceId, author, 'copywriter');
  reminderB = await as(
    author,
    async (db) => {
      const service = new PersonalNotesService({
        db,
        workspaceId: fixtures.b.workspaceId,
        ownerUserId: author,
      });
      const note = await service.create({ title: 'Note in B' });
      await service.setReminder(note.id, {
        remindAt: new Date(Date.now() + 86_400_000),
        timeZone: 'UTC',
      });
      const r = await db.personalNoteReminder.findFirstOrThrow({ where: { noteId: note.id } });
      return r.id;
    },
    fixtures.b.workspaceId,
  );
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('PR D — the author sees and changes their own notes', () => {
  it('lists, counts, reads, updates, pins and searches their own note', async () => {
    const listed = await as(author, (db) =>
      new PersonalNotesService({
        db,
        workspaceId: fixtures.a.workspaceId,
        ownerUserId: author,
      }).list({ search: 'roaster' }),
    );
    expect(listed.map((n) => n.id)).toEqual([noteId]);
    expect(listed[0]?.reminder).toMatchObject({ state: 'PENDING', timeZone: 'Asia/Riyadh' });
    const count = await as(author, (db) =>
      db.personalNote.count({ where: { workspaceId: fixtures.a.workspaceId } }),
    );
    expect(count).toBe(1);
    await as(author, async (db) => {
      const s = new PersonalNotesService({
        db,
        workspaceId: fixtures.a.workspaceId,
        ownerUserId: author,
      });
      await s.setPinned(noteId, true);
      const updated = await s.update(noteId, { title: 'Call the roaster', body: 'Friday, 10:00.' });
      expect(updated.body).toBe('Friday, 10:00.');
      expect(updated.pinnedAt).not.toBeNull();
    });
  });
});

describe('PR D — the rules a note and its reminder follow', () => {
  const mine = <T>(fn: (s: PersonalNotesService) => Promise<T>) =>
    as(author, (db) =>
      fn(
        new PersonalNotesService({ db, workspaceId: fixtures.a.workspaceId, ownerUserId: author }),
      ),
    );

  it('refuses an empty note, a title over 200 characters and a time already past', async () => {
    await expect(mine((s) => s.create({ title: '  ', body: ' ' }))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(mine((s) => s.create({ title: 'x'.repeat(201) }))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(
      mine((s) =>
        s.setReminder(noteId, { remindAt: new Date(Date.now() - 60_000), timeZone: 'UTC' }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      mine((s) =>
        s.setReminder(noteId, {
          remindAt: new Date(Date.now() + 60_000),
          timeZone: 'Mars/Olympus',
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('snooze returns a reminder to waiting at the new time; done stops it; delete takes both', async () => {
    const note = await mine((s) => s.create({ title: 'Snooze me' }));
    await mine((s) =>
      s.setReminder(note.id, {
        remindAt: new Date(Date.now() + 3_600_000),
        timeZone: 'Africa/Cairo',
      }),
    );
    // As the sweep would: sent.
    await platform.personalNoteReminder.updateMany({
      where: { noteId: note.id },
      data: { state: 'SENT', sentAt: new Date() },
    });
    const until = new Date(Date.now() + 2 * 3_600_000);
    await mine((s) => s.snooze(note.id, until));
    let view = await mine((s) => s.get(note.id));
    expect(view.reminder).toMatchObject({ state: 'PENDING', snoozeCount: 1 });
    expect(view.reminder?.remindAt.getTime()).toBe(until.getTime());
    await mine((s) => s.markDone(note.id));
    view = await mine((s) => s.get(note.id));
    expect(view.reminder?.state).toBe('DONE');
    await mine((s) => s.remove(note.id));
    expect(await platform.personalNoteReminder.count({ where: { noteId: note.id } })).toBe(0);
  });
});

describe.each([
  ['a teammate', () => teammate],
  ['the workspace admin', () => admin],
  ['the workspace owner', () => owner],
])('PR D — %s cannot see or touch the author’s notes', (_label, who) => {
  it('cannot read, list or count them (service and raw SQL)', async () => {
    const reader = who();
    const result = await as(reader, async (db) => ({
      list: await new PersonalNotesService({
        db,
        workspaceId: fixtures.a.workspaceId,
        ownerUserId: reader,
      }).list(),
      byId: await db.personalNote.findUnique({ where: { id: noteId } }),
      all: await db.personalNote.findMany({}),
      count: await db.personalNote.count(),
      raw: await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM personal_note`,
      reminders: await db.personalNoteReminder.count(),
      rawReminders: await db.$queryRaw<
        Array<{ n: bigint }>
      >`SELECT count(*) AS n FROM personal_note_reminder`,
    }));
    expect(result.list).toEqual([]);
    expect(result.byId).toBeNull();
    expect(result.all).toEqual([]);
    expect(result.count).toBe(0);
    expect(Number(result.raw[0]?.n)).toBe(0);
    expect(result.reminders).toBe(0);
    expect(Number(result.rawReminders[0]?.n)).toBe(0);
  });

  it('cannot update or delete them, even by naming the id', async () => {
    const reader = who();
    const changed = await as(reader, async (db) => ({
      update: (await db.personalNote.updateMany({ where: { id: noteId }, data: { title: 'x' } }))
        .count,
      remove: (await db.personalNote.deleteMany({ where: { id: noteId } })).count,
      reminder: (
        await db.personalNoteReminder.updateMany({
          where: { noteId },
          data: { state: 'DONE', doneAt: new Date() },
        })
      ).count,
      rawUpdate:
        await db.$executeRaw`UPDATE personal_note SET title = 'x' WHERE id = ${noteId}::uuid`,
    }));
    expect(changed).toEqual({ update: 0, remove: 0, reminder: 0, rawUpdate: 0 });
    // The service says the note does not exist, exactly as for a real miss.
    await expect(
      as(reader, (db) =>
        new PersonalNotesService({
          db,
          workspaceId: fixtures.a.workspaceId,
          ownerUserId: reader,
        }).get(noteId),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const intact = await as(author, (db) =>
      db.personalNote.findUniqueOrThrow({ where: { id: noteId } }),
    );
    expect(intact.title).toBe('Call the roaster');
  });

  it('cannot write a note in the author’s name', async () => {
    const reader = who();
    await expect(
      as(reader, (db) =>
        db.personalNote.create({
          data: { workspaceId: fixtures.a.workspaceId, ownerUserId: author, title: 'forged' },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('PR D — the Control Center (platform role)', () => {
  it('has no privilege on personal_note: reading, counting, changing and deleting all fail', async () => {
    await expect(platform.personalNote.findMany({})).rejects.toThrow(/permission denied/i);
    await expect(platform.personalNote.count()).rejects.toThrow(/permission denied/i);
    await expect(
      platform.personalNote.updateMany({ where: { id: noteId }, data: { title: 'x' } }),
    ).rejects.toThrow(/permission denied/i);
    await expect(platform.personalNote.deleteMany({ where: { id: noteId } })).rejects.toThrow(
      /permission denied/i,
    );
    await expect(
      platform.$queryRaw`SELECT title FROM personal_note WHERE id = ${noteId}::uuid`,
    ).rejects.toThrow(/permission denied/i);
  });

  it('may read and update reminders (the sweep), never create or delete one, and sees no text there', async () => {
    const due = await platform.personalNoteReminder.findMany({
      where: { noteId },
      select: { id: true, remindAt: true, state: true },
    });
    expect(due).toHaveLength(1);
    await expect(
      platform.personalNoteReminder.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          ownerUserId: author,
          noteId,
          remindAt: new Date(),
          timeZone: 'UTC',
        },
      }),
    ).rejects.toThrow(/permission denied|Unique constraint/i);
    await expect(platform.personalNoteReminder.deleteMany({ where: { noteId } })).rejects.toThrow(
      /permission denied/i,
    );
    const columns = await platform.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'personal_note_reminder'`;
    expect(columns.map((c) => c.column_name)).not.toEqual(
      expect.arrayContaining(['title', 'body']),
    );
  });
});

describe('PR D — with app.user_id unset, nothing is visible', () => {
  it('a transaction that set only the workspace sees no note and no reminder', async () => {
    const seen = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => ({
        notes: await db.personalNote.count(),
        reminders: await db.personalNoteReminder.count(),
        raw: await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM personal_note`,
        update: (await db.personalNote.updateMany({ where: { id: noteId }, data: { title: 'x' } }))
          .count,
      }),
      { prisma: app },
    );
    expect(seen.notes).toBe(0);
    expect(seen.reminders).toBe(0);
    expect(Number(seen.raw[0]?.n)).toBe(0);
    expect(seen.update).toBe(0);
  });

  it('a malformed user id is refused before it reaches the database', async () => {
    await expect(
      withWorkspacePerson(fixtures.a.workspaceId, "' OR 1=1 --", async () => 1, { prisma: app }),
    ).rejects.toMatchObject({ code: 'TENANT_CONTEXT_MISSING' });
  });
});

describe('PR D — a reminder in another workspace cannot be touched', () => {
  it('not from workspace A, even by the person who owns it in B', async () => {
    const fromA = await as(author, async (db) => ({
      read: await db.personalNoteReminder.findUnique({ where: { id: reminderB } }),
      update: (
        await db.personalNoteReminder.updateMany({
          where: { id: reminderB },
          data: { state: 'DONE', doneAt: new Date() },
        })
      ).count,
      remove: (await db.personalNoteReminder.deleteMany({ where: { id: reminderB } })).count,
      notes: await db.personalNote.count(),
    }));
    expect(fromA).toEqual({ read: null, update: 0, remove: 0, notes: 1 });
  });

  it('not by B’s own people, and not by moving a reminder into A', async () => {
    const bOwner = fixtures.b.userId;
    const fromB = await as(
      bOwner,
      async (db) => ({
        read: await db.personalNoteReminder.findUnique({ where: { id: reminderB } }),
        update: (
          await db.personalNoteReminder.updateMany({
            where: { id: reminderB },
            data: { remindAt: new Date() },
          })
        ).count,
      }),
      fixtures.b.workspaceId,
    );
    expect(fromB).toEqual({ read: null, update: 0 });
    // The owner, in B, cannot re-home the reminder into workspace A.
    await expect(
      as(
        author,
        (db) =>
          db.personalNoteReminder.update({
            where: { id: reminderB },
            data: { workspaceId: fixtures.a.workspaceId },
          }),
        fixtures.b.workspaceId,
      ),
    ).rejects.toThrow();
    const still = await platform.personalNoteReminder.findUniqueOrThrow({
      where: { id: reminderB },
    });
    expect(still.workspaceId).toBe(fixtures.b.workspaceId);
    expect(still.state).toBe('PENDING');
  });
});

describe('PR D — owner condition 2: export and account deletion', () => {
  it('the export holds the person’s own notes and reminders, and nobody else’s', async () => {
    const exported = await as(author, (db) =>
      new PersonalNotesService({
        db,
        workspaceId: fixtures.a.workspaceId,
        ownerUserId: author,
      }).exportAll(),
    );
    expect(exported.map((n) => n.id)).toContain(noteId);
    expect(exported.every((n) => n.title !== 'Note in B')).toBe(true);
    const theirs = await as(teammate, (db) =>
      new PersonalNotesService({
        db,
        workspaceId: fixtures.a.workspaceId,
        ownerUserId: teammate,
      }).exportAll(),
    );
    expect(theirs).toEqual([]);
  });

  it('removing a person’s account removes their notes and reminders in every workspace', async () => {
    const leaving = await person(fixtures.a.workspaceId, 'copywriter');
    await join(fixtures.b.workspaceId, leaving, 'copywriter');
    for (const workspaceId of [fixtures.a.workspaceId, fixtures.b.workspaceId]) {
      await as(
        leaving,
        async (db) => {
          const s = new PersonalNotesService({ db, workspaceId, ownerUserId: leaving });
          const note = await s.create({ title: `Leaving ${workspaceId}` });
          await s.setReminder(note.id, {
            remindAt: new Date(Date.now() + 86_400_000),
            timeZone: 'UTC',
          });
        },
        workspaceId,
      );
    }
    const countIn = (workspaceId: string) =>
      as(leaving, (db) => db.personalNote.count(), workspaceId);
    expect(await countIn(fixtures.a.workspaceId)).toBe(1);
    expect(await countIn(fixtures.b.workspaceId)).toBe(1);
    expect(await platform.personalNoteReminder.count({ where: { ownerUserId: leaving } })).toBe(2);

    // The account goes: its memberships, then the person.
    await platform.membership.deleteMany({ where: { userId: leaving } });
    await platform.user.delete({ where: { id: leaving } });

    // Asked as that same id, nothing is left anywhere.
    expect(await countIn(fixtures.a.workspaceId)).toBe(0);
    expect(await countIn(fixtures.b.workspaceId)).toBe(0);
    expect(await platform.personalNoteReminder.count({ where: { ownerUserId: leaving } })).toBe(0);
  });
});
