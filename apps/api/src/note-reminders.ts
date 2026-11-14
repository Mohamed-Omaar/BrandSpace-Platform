import type { EmailMessageInput } from '@brandspace/auth';
import { withWorkspace, type PrismaClient } from '@brandspace/database';
import type { PlatformPrismaClient } from '@brandspace/database/platform';
import { NotificationService, noteReminderEmailOn } from '@brandspace/notifications';
import { createLogger, internalErrorFields, type Clock } from '@brandspace/shared';

const log = createLogger({ context: { component: 'api.note-reminders' } });

/**
 * PR D (D-609) — A NOTE'S REMINDER IS DUE: TELL ITS OWNER, AND ONLY THEM.
 *
 * WHAT EACH CHANNEL CARRIES (owner condition 1):
 *
 *   - IN-APP: a `note.reminder` notification to the note's owner alone, with
 *     NO note text in the row — the platform role can read notifications and
 *     can never read a note. The row carries the link to the note
 *     (`/notes?note=<id>`); when the owner opens the bell or the feed, the
 *     dashboard reads the note's title in the owner's own workspace-and-person
 *     context and shows it there. Nobody else can resolve it.
 *   - EMAIL: only when the owner switched "Email me my note reminders" on (off
 *     unless they do). Generic text and a link to their notes; neither the
 *     title nor the body is in it.
 *
 * HOW. The due reminders are found across workspaces with the PLATFORM role,
 * which may read and update `personal_note_reminder` (no note text in it) and
 * has no privilege on `personal_note`. Each one is CLAIMED by compare-and-set
 * (PENDING and due → SENT) before anything is sent, so two API replicas never
 * send it twice; the notification and the email preference are then written
 * and read inside the owner's workspace (RLS). The notification is idempotent
 * on the reminder and the time it was due, so a snoozed reminder notifies
 * again at its new time and a retried pass never twice for the same time.
 */

export interface NoteReminderEmail {
  send(message: EmailMessageInput, workspaceId: string): Promise<unknown>;
}

export interface NoteReminderSweepOptions {
  /** The platform client: due reminders across workspaces, and the owner's address. */
  readonly platform: PlatformPrismaClient;
  /** The tenant (application-role) client the notification is written through. */
  readonly tenant?: PrismaClient;
  readonly clock: Clock;
  readonly email: NoteReminderEmail | null;
  /** The dashboard's public origin, for the email's link; no origin, no email. */
  readonly dashboardBaseUrl: string | undefined;
}

export async function sendDueNoteReminders(
  options: NoteReminderSweepOptions,
  batch: number,
): Promise<number> {
  const now = options.clock.now();
  const due = await options.platform.personalNoteReminder.findMany({
    where: { state: 'PENDING', remindAt: { lte: now } },
    orderBy: { remindAt: 'asc' },
    take: batch,
    select: { id: true, workspaceId: true, ownerUserId: true, noteId: true, remindAt: true },
  });

  let sent = 0;
  for (const reminder of due) {
    try {
      // Claim it first: one sender, whatever runs beside this pass.
      const claimed = await options.platform.personalNoteReminder.updateMany({
        where: { id: reminder.id, state: 'PENDING', remindAt: reminder.remindAt },
        data: { state: 'SENT', sentAt: now },
      });
      if (claimed.count === 0) continue;

      const linkPath = `/notes?note=${reminder.noteId}`;
      const wantsEmail = await withWorkspace(
        reminder.workspaceId,
        async (db) => {
          await new NotificationService({
            db,
            workspaceId: reminder.workspaceId,
            clock: options.clock,
          }).create({
            userIds: [reminder.ownerUserId],
            templateKey: 'note.reminder',
            payload: {},
            linkPath,
            resourceType: 'PersonalNote',
            resourceId: reminder.noteId,
            idempotencyKey: `note.reminder:${reminder.id}:${reminder.remindAt.toISOString()}`,
          });
          return noteReminderEmailOn(db, reminder.workspaceId, reminder.ownerUserId);
        },
        options.tenant ? { prisma: options.tenant } : {},
      );
      sent += 1;

      if (wantsEmail && options.email && options.dashboardBaseUrl) {
        const owner = await options.platform.user.findUnique({
          where: { id: reminder.ownerUserId },
          select: { email: true, locale: true, status: true },
        });
        if (owner && owner.status === 'ACTIVE') {
          const locale = owner.locale === 'AR' ? 'AR' : 'EN';
          const link = new URL(
            `/${locale === 'AR' ? 'ar' : 'en'}${linkPath}`,
            options.dashboardBaseUrl,
          ).toString();
          await options.email.send(
            { to: owner.email, templateKey: 'note.reminder', locale, link },
            reminder.workspaceId,
          );
          await options.platform.personalNoteReminder.updateMany({
            where: { id: reminder.id },
            data: { emailSentAt: options.clock.now() },
          });
        }
      }
    } catch (error: unknown) {
      // One reminder must not stop the rest; the in-app half is idempotent.
      log.warn('a note reminder could not be delivered', {
        reminderId: reminder.id,
        ...internalErrorFields(error),
      });
    }
  }
  return sent;
}
