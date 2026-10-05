import 'server-only';
import { cache } from 'react';
import { NotesService } from '@brandspace/collaboration';
import { systemClock } from '@brandspace/shared';
import type { IncomingNotice } from '@brandspace/ui';
import { optionalMessage } from '../i18n/messages';
import { inContentStudio } from './content-context';
import { noteThreadHref } from './note-links';
import { shellSession } from './topbar-counts';
import { requestMessageLocale } from './message-locale';

/**
 * MO10 (Phase 2B-2b, owner option A) — THE INCOMING MENTIONS THE SHELL HANDS
 * ITS TOAST HOST on this page render: the reader's unread mentions by OTHER
 * people (`NotesService.incomingMentions` — the same rows the Notes dot
 * counts), newest first, as the notice draws them. No polling, no stream and
 * no new delivery path: they appear on the next page the reader opens, and
 * the host shows each one once per browser tab.
 *
 * Like the top bar's counts, a failure is "no notice", never a broken page.
 */
export const incomingMentions = cache(
  async (locale: string): Promise<readonly IncomingNotice[]> => {
    const session = await shellSession();
    if (!session) return [];
    const { customer, workspace } = session;
    try {
      return await inContentStudio(workspace.workspaceId, async ({ db }) => {
        const mentions = await new NotesService({
          db,
          workspaceId: workspace.workspaceId,
          clock: systemClock,
        }).incomingMentions({
          userId: customer.userId,
          permissionKeys: workspace.permissionKeys,
          brandScope: workspace.brandScope,
        });
        if (mentions.length === 0) return [];
        const authors = new Map(
          (
            await db.membership.findMany({
              where: {
                workspaceId: workspace.workspaceId,
                userId: { in: [...new Set(mentions.map((m) => m.authorUserId))] },
              },
              select: { userId: true, user: { select: { name: true, email: true } } },
            })
          ).map((member) => [member.userId, member.user.name?.trim() || member.user.email]),
        );
        const someone =
          optionalMessage(requestMessageLocale(locale), 'notifications.feed.someone') ?? '';
        const template =
          optionalMessage(requestMessageLocale(locale), 'notifications.feed.mentioned') ?? '{name}';
        return mentions.map((mention) => {
          const name = authors.get(mention.authorUserId) ?? someone;
          return {
            id: mention.mentionId,
            initial: (Array.from(name.trim())[0] ?? '?').toLocaleUpperCase(locale),
            title: template.replace('{name}', name),
            context: mention.subjectTitle ?? mention.brandName,
            href: noteThreadHref(locale, mention),
          };
        });
      });
    } catch {
      return [];
    }
  },
);
