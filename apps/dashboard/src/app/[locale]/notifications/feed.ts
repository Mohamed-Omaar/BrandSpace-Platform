'use server';

import { inPersonalNotes } from '../../../server/personal-notes-context';
import { requireWorkspace, inWorkspace } from '../../../server/customer-context';
import { notificationService } from '../../../server/approvals-context';
import { inNotes } from '../../../server/notes-context';
import { noteIdFromLink, noteThreadHref } from '../../../server/note-links';
import { relativeTime } from '../../../server/home';
import { optionalMessage } from '../../../i18n/messages';
import { systemClock } from '@brandspace/shared';
import { initialsFrom } from '@brandspace/ui';
import { avatarHref, pictureVersions } from '../../../server/pictures';

/**
 * THE BELL'S FEED (Phase 6 final, D-277 §40, D-297).
 *
 * Two real sources, never a copy of either: the member's NOTIFICATIONS
 * (NotificationService — approvals, publishing, automations, learnings) and
 * the Notes they are MENTIONED in (the Notes domain, the same inbox the top
 * bar's Notes count reads). Each row is a sentence in the reader's language,
 * who did it where the source knows, the object it is about, a relative time,
 * and a deep link to the exact place — a review, a post, a thread.
 *
 * A POINTER, NOT A COPY. Following a link runs that screen's own checks; the
 * feed carries a title and a short excerpt, never a caption or a document.
 * Read on open, not on every page render, and in-app only (no email, SMS or
 * push preferences exist for notifications, so none are offered).
 */
export type FeedKind = 'mention' | 'approval' | 'publishing' | 'other';

export interface FeedItem {
  readonly id: string;
  readonly kind: FeedKind;
  readonly headline: string;
  /** Who, where the source records it. */
  readonly who: string | null;
  /** A short excerpt — a mention's words. Never a caption. */
  readonly excerpt: string | null;
  /** The object: the post, campaign, asset or brand it is about. */
  readonly context: string | null;
  readonly href: string | null;
  readonly when: string;
  readonly at: string;
  readonly unread: boolean;
  /** PR D (D-609) — who did it, as their photo or their initials, when known. */
  readonly person: { readonly initials: string; readonly src: string | null } | null;
}

const EXCERPT = 140;

export async function loadNotificationFeed(
  rawLocale: string,
): Promise<{ readonly items: readonly FeedItem[] }> {
  const locale = rawLocale === 'ar' ? 'ar' : 'en';
  const { customer, workspace } = await requireWorkspace(locale);
  const now = systemClock.now();

  const notifications = await inWorkspace(workspace.workspaceId, async ({ db }) =>
    notificationService({ db, workspaceId: workspace.workspaceId }).list({
      userId: customer.userId,
      take: 15,
    }),
  );

  const mayNote = workspace.permissionKeys.includes('content.read');
  const mentioned = mayNote
    ? (await inNotes(locale, async ({ service, actor }) => service.inbox(actor))).forYou
        .filter((entry) => entry.reason === 'mentioned')
        .slice(0, 10)
    : [];
  /*
   * MO10 (Phase 2B-2b, owner option A): the mention's "who" is the author of
   * the note that MENTIONED the reader — never the thread's latest writer,
   * who may be the reader replying — and a mention the reader wrote about
   * themselves is not one (the service already leaves it out).
   */
  const mentionedBy = mentioned.filter((entry) => entry.lastMention !== null);
  const actorOf = (payload: Record<string, unknown>): string | null =>
    typeof payload['actorUserId'] === 'string' ? payload['actorUserId'] : null;
  const authorIds = [
    ...new Set([
      ...mentionedBy.flatMap((entry) =>
        entry.lastMention ? [entry.lastMention.authorUserId] : [],
      ),
      // PR D (D-609): who acted on a notification, to show their photo.
      ...notifications.flatMap((item) => {
        const actor = actorOf(item.payload as Record<string, unknown>);
        return actor ? [actor] : [];
      }),
    ]),
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
  const avatars = await pictureVersions(workspace.workspaceId, [...names.keys()]);
  const personOf = (userId: string | null) => {
    const name = userId ? names.get(userId) : undefined;
    return userId && name
      ? {
          initials: initialsFrom(name),
          src: avatarHref(locale, userId, avatars.get(userId) ?? null),
        }
      : null;
  };
  const mentions = mentionedBy.map((entry) => ({
    entry,
    mention: entry.lastMention!,
    author: entry.lastMention ? (names.get(entry.lastMention.authorUserId) ?? null) : null,
  }));

  /*
   * PR D (D-609) — A NOTE REMINDER NAMES ITS NOTE, FOR ITS OWNER ONLY. The row
   * holds no note text (owner condition 1); the title is read here, in the
   * reader's own workspace-and-person context, so it can only ever be theirs.
   */
  const reminderNoteIds = notifications
    .filter((item) => item.templateKey === 'note.reminder')
    .map((item) => noteIdFromLink(item.linkPath))
    .filter((id): id is string => id !== null);
  const noteTitles =
    reminderNoteIds.length > 0
      ? await inPersonalNotes(locale, (notes) => notes.titles(reminderNoteIds))
      : new Map<string, string>();

  const kindOf = (templateKey: string): FeedKind =>
    templateKey.startsWith('approval.')
      ? 'approval'
      : templateKey.startsWith('publishing.')
        ? 'publishing'
        : 'other';

  const items: FeedItem[] = [
    ...notifications.map((item) => ({
      id: `n:${item.id}`,
      kind: kindOf(item.templateKey),
      headline:
        optionalMessage(locale, `notifications.template.${item.templateKey}`) ??
        optionalMessage(locale, 'notifications.generic') ??
        '',
      who: null,
      excerpt: null,
      context:
        item.templateKey === 'note.reminder'
          ? (noteTitles.get(noteIdFromLink(item.linkPath) ?? '') ?? null)
          : typeof item.payload.itemTitle === 'string'
            ? item.payload.itemTitle
            : null,
      href: item.linkPath ? `/${locale}${item.linkPath}` : null,
      when: relativeTime(item.createdAt, now, locale),
      at: item.createdAt.toISOString(),
      unread: item.readAt === null,
      person: personOf(actorOf(item.payload as Record<string, unknown>)),
    })),
    ...mentions.map(({ entry, mention, author }) => ({
      id: `m:${entry.threadId}`,
      kind: 'mention' as const,
      headline: (optionalMessage(locale, 'notifications.feed.mentioned') ?? '{name}').replace(
        '{name}',
        author ?? optionalMessage(locale, 'notifications.feed.someone') ?? '',
      ),
      who: author,
      excerpt: mention.body.slice(0, EXCERPT),
      context: entry.subjectTitle ?? entry.brandName,
      href: noteThreadHref(locale, entry),
      when: relativeTime(mention.createdAt, now, locale),
      at: mention.createdAt.toISOString(),
      unread: entry.unreadMentions > 0,
      person: personOf(mention.authorUserId),
    })),
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  return { items: items.slice(0, 20) };
}
