import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EmailMessageInput } from '@brandspace/auth';
import { withWorkspace, withWorkspacePerson } from '@brandspace/database';
import { PersonalNotesService } from '@brandspace/collaboration';
import { setNoteReminderEmail } from '@brandspace/notifications';
import { sendDueNoteReminders } from '../../apps/api/src/note-reminders';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * PR D (D-607), owner condition 1 — WHAT A DUE REMINDER SENDS, AND TO WHOM.
 *
 * The sweep (`sendDueNoteReminders`, run by the API's scheduler) finds due
 * `PersonalNoteReminder` rows with the platform role and:
 *
 *   - writes ONE in-app `note.reminder` notification, to the owner only, with
 *     no note text in the row — just the link to the note;
 *   - sends an email ONLY when the owner switched "Email me my note reminders"
 *     on, with generic text and a link: no title, no body;
 *   - claims each reminder once (PENDING → SENT), so a second pass sends
 *     nothing; a snoozed reminder notifies again at its new time.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let author: string;
let teammate: string;
const TITLE = 'Secret launch plan';
const BODY = 'The body must never leave the product.';

const clockAt = (date: Date) => ({ now: () => date });

class RecordingEmail {
  readonly sent: Array<{ message: EmailMessageInput; workspaceId: string }> = [];
  async send(message: EmailMessageInput, workspaceId: string): Promise<void> {
    this.sent.push({ message, workspaceId });
  }
}

async function person(roleKey: string): Promise<string> {
  const user = await platform.user.create({
    data: {
      email: `pr-d-rem-${roleKey}-${randomUUID()}@example.test`,
      name: `Reminder ${roleKey}`,
      status: 'ACTIVE',
      locale: 'AR',
      timezone: 'Asia/Riyadh',
    },
  });
  const role = await platform.role.findFirstOrThrow({
    where: { key: roleKey, realm: 'WORKSPACE', workspaceId: null },
  });
  await platform.membership.create({
    data: {
      workspaceId: fixtures.a.workspaceId,
      userId: user.id,
      roleId: role.id,
      status: 'ACTIVE',
      brandScope: [],
    },
  });
  return user.id;
}

/** A note with a reminder, then made due by moving its time into the past. */
async function dueNote(): Promise<{ noteId: string; due: Date }> {
  const noteId = await withWorkspacePerson(
    fixtures.a.workspaceId,
    author,
    async (db) => {
      const s = new PersonalNotesService({
        db,
        workspaceId: fixtures.a.workspaceId,
        ownerUserId: author,
      });
      const note = await s.create({ title: TITLE, body: BODY });
      await s.setReminder(note.id, {
        remindAt: new Date(Date.now() + 60_000),
        timeZone: 'Asia/Riyadh',
      });
      return note.id;
    },
    { prisma: app },
  );
  const due = new Date(Date.now() - 1_000);
  await platform.personalNoteReminder.updateMany({ where: { noteId }, data: { remindAt: due } });
  return { noteId, due };
}

const notificationsFor = (userId: string, noteId: string) =>
  withWorkspace(
    fixtures.a.workspaceId,
    (db) =>
      db.notification.findMany({
        where: { userId, templateKey: 'note.reminder', resourceId: noteId },
      }),
    { prisma: app },
  );

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  author = await person('copywriter');
  teammate = await person('workspace_admin');
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('PR D — a due note reminder', () => {
  it('notifies the owner only, in-app, with no note text; no email unless they opted in', async () => {
    const { noteId } = await dueNote();
    const email = new RecordingEmail();
    const sent = await sendDueNoteReminders(
      {
        platform: platform as never,
        tenant: app,
        clock: clockAt(new Date()),
        email,
        dashboardBaseUrl: 'https://dashboard.example.test',
      },
      50,
    );
    expect(sent).toBeGreaterThanOrEqual(1);

    const mine = await notificationsFor(author, noteId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.linkPath).toBe(`/notes?note=${noteId}`);
    expect(mine[0]?.resourceType).toBe('PersonalNote');
    const stored = JSON.stringify(mine[0]);
    expect(stored).not.toContain(TITLE);
    expect(stored).not.toContain(BODY);
    expect(await notificationsFor(teammate, noteId)).toHaveLength(0);
    expect(await notificationsFor(fixtures.a.userId, noteId)).toHaveLength(0);

    // Not opted in: no email.
    expect(email.sent).toHaveLength(0);
    const reminder = await platform.personalNoteReminder.findFirstOrThrow({ where: { noteId } });
    expect(reminder.state).toBe('SENT');
    expect(reminder.emailSentAt).toBeNull();
  });

  it('a second pass sends nothing more', async () => {
    const { noteId } = await dueNote();
    const run = () =>
      sendDueNoteReminders(
        {
          platform: platform as never,
          tenant: app,
          clock: clockAt(new Date()),
          email: null,
          dashboardBaseUrl: undefined,
        },
        50,
      );
    await run();
    await run();
    expect(await notificationsFor(author, noteId)).toHaveLength(1);
  });

  it('with the email switched on: one generic email to the owner — no title, no body', async () => {
    await withWorkspace(
      fixtures.a.workspaceId,
      (db) => setNoteReminderEmail(db, fixtures.a.workspaceId, author, true),
      { prisma: app },
    );
    try {
      const { noteId } = await dueNote();
      const email = new RecordingEmail();
      await sendDueNoteReminders(
        {
          platform: platform as never,
          tenant: app,
          clock: clockAt(new Date()),
          email,
          dashboardBaseUrl: 'https://dashboard.example.test',
        },
        50,
      );
      const forThis = email.sent.filter((e) => e.message.link?.includes(noteId));
      expect(forThis).toHaveLength(1);
      const owner = await platform.user.findUniqueOrThrow({ where: { id: author } });
      expect(forThis[0]?.message).toEqual({
        to: owner.email,
        templateKey: 'note.reminder',
        locale: 'AR',
        link: `https://dashboard.example.test/ar/notes?note=${noteId}`,
      });
      const wire = JSON.stringify(forThis[0]);
      expect(wire).not.toContain(TITLE);
      expect(wire).not.toContain(BODY);
      const reminder = await platform.personalNoteReminder.findFirstOrThrow({ where: { noteId } });
      expect(reminder.emailSentAt).not.toBeNull();
    } finally {
      await withWorkspace(
        fixtures.a.workspaceId,
        (db) => setNoteReminderEmail(db, fixtures.a.workspaceId, author, false),
        { prisma: app },
      );
    }
  });

  it('a snoozed reminder notifies again at its new time', async () => {
    const { noteId } = await dueNote();
    const run = (at: Date) =>
      sendDueNoteReminders(
        {
          platform: platform as never,
          tenant: app,
          clock: clockAt(at),
          email: null,
          dashboardBaseUrl: undefined,
        },
        50,
      );
    await run(new Date());
    const later = new Date(Date.now() + 5_000);
    await withWorkspacePerson(
      fixtures.a.workspaceId,
      author,
      (db) =>
        new PersonalNotesService({
          db,
          workspaceId: fixtures.a.workspaceId,
          ownerUserId: author,
        }).snooze(noteId, later),
      { prisma: app },
    );
    await run(new Date(Date.now() + 10_000));
    expect(await notificationsFor(author, noteId)).toHaveLength(2);
  });

  it('a reminder marked done is never sent', async () => {
    const { noteId } = await dueNote();
    await platform.personalNoteReminder.updateMany({
      where: { noteId },
      data: { state: 'DONE', doneAt: new Date() },
    });
    await sendDueNoteReminders(
      {
        platform: platform as never,
        tenant: app,
        clock: clockAt(new Date()),
        email: null,
        dashboardBaseUrl: undefined,
      },
      50,
    );
    expect(await notificationsFor(author, noteId)).toHaveLength(0);
  });
});
