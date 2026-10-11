'use server';

import { requireWorkspace, inWorkspace } from '../../../server/customer-context';
import { inNotes } from '../../../server/notes-context';
import { noteThreadHref } from '../../../server/note-links';
import { optionalMessage } from '../../../i18n/messages';

/**
 * D-496 (Shell 1, 2) — THE NOTES SQUARE'S POPOVER (`Main.dc.html` L152–161):
 * the two latest notes for this person, each opening its thread, and "All
 * notes" at the foot.
 *
 * THE SAME INBOX THE NOTES SCREEN READS (`NotesService.inbox`): "For you"
 * first (unread mentions, then the rest, as the service orders them), then the
 * open threads, one row per thread. A POINTER, NOT A COPY: a title, a short
 * excerpt and where it is; following it runs the thread's own checks. Read on
 * open, not on every page render.
 */
export interface NotesPopoverItem {
  readonly id: string;
  readonly title: string;
  readonly meta: string | null;
  readonly href: string;
  readonly unread: boolean;
}

const EXCERPT = 80;
const SHOWN = 2;

export async function loadNotesPopover(
  rawLocale: string,
): Promise<{ readonly items: readonly NotesPopoverItem[] }> {
  const locale = rawLocale === 'ar' ? 'ar' : 'en';
  const { workspace } = await requireWorkspace(locale);
  if (!workspace.permissionKeys.includes('content.read')) return { items: [] };

  const inbox = await inNotes(locale, async ({ service, actor }) => service.inbox(actor));
  const seen = new Set<string>();
  const entries = [...inbox.forYou, ...inbox.open]
    .filter((entry) => {
      if (seen.has(entry.threadId)) return false;
      seen.add(entry.threadId);
      return true;
    })
    .slice(0, SHOWN);

  const authorIds = [
    ...new Set(
      entries.flatMap((entry) =>
        entry.reason === 'mentioned' && entry.lastMention
          ? [entry.lastMention.authorUserId]
          : entry.lastNote
            ? [entry.lastNote.authorUserId]
            : [],
      ),
    ),
  ];
  const names = authorIds.length
    ? await inWorkspace(
        workspace.workspaceId,
        async ({ db }) =>
          new Map(
            (
              await db.membership.findMany({
                where: { workspaceId: workspace.workspaceId, userId: { in: authorIds } },
                select: { userId: true, user: { select: { name: true, email: true } } },
              })
            ).map((member) => [member.userId, member.user.name?.trim() || member.user.email]),
          ),
      )
    : new Map<string, string>();
  const someone = optionalMessage(locale, 'notifications.feed.someone') ?? '';

  return {
    items: entries.map((entry) => {
      const mention = entry.reason === 'mentioned' ? entry.lastMention : null;
      const note = mention ?? entry.lastNote;
      const name = note ? (names.get(note.authorUserId) ?? someone) : someone;
      const title = mention
        ? (optionalMessage(locale, 'notifications.feed.mentioned') ?? '{name}').replace(
            '{name}',
            name,
          )
        : note
          ? `${name}: “${note.body.slice(0, EXCERPT)}”`
          : name;
      const subject = entry.subjectTitle ?? entry.brandName ?? null;
      return {
        id: entry.threadId,
        title,
        meta: subject
          ? (optionalMessage(locale, 'notes.pop.on') ?? '{subject}').replace('{subject}', subject)
          : null,
        href: noteThreadHref(locale, entry),
        unread: entry.unreadMentions > 0,
      };
    }),
  };
}
