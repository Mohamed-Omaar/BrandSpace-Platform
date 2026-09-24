'use server';

import { requireWorkspace, inWorkspace } from '../../../server/customer-context';
import { notificationService } from '../../../server/approvals-context';
import { inNotes } from '../../../server/notes-context';
import { noteThreadHref } from '../../../server/note-links';
import { relativeTime } from '../../../server/home';
import { optionalMessage } from '../../../i18n/messages';
import { systemClock } from '@brandspace/shared';

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
  const authorIds = [
    ...new Set(mentioned.flatMap((entry) => (entry.lastNote ? [entry.lastNote.authorUserId] : []))),
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
  const mentions = mentioned.map((entry) => ({
    entry,
    author: entry.lastNote ? (names.get(entry.lastNote.authorUserId) ?? null) : null,
  }));

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
      context: typeof item.payload.itemTitle === 'string' ? item.payload.itemTitle : null,
      href: item.linkPath ? `/${locale}${item.linkPath}` : null,
      when: relativeTime(item.createdAt, now, locale),
      at: item.createdAt.toISOString(),
      unread: item.readAt === null,
    })),
    ...mentions.map(({ entry, author }) => ({
      id: `m:${entry.threadId}`,
      kind: 'mention' as const,
      headline: (optionalMessage(locale, 'notifications.feed.mentioned') ?? '{name}').replace(
        '{name}',
        author ?? optionalMessage(locale, 'notifications.feed.someone') ?? '',
      ),
      who: author,
      excerpt: entry.lastNote ? entry.lastNote.body.slice(0, EXCERPT) : null,
      context: entry.subjectTitle ?? entry.brandName,
      href: noteThreadHref(locale, entry),
      when: relativeTime(entry.lastNote?.createdAt ?? entry.updatedAt, now, locale),
      at: (entry.lastNote?.createdAt ?? entry.updatedAt).toISOString(),
      unread: entry.unreadMentions > 0,
    })),
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  return { items: items.slice(0, 20) };
}
