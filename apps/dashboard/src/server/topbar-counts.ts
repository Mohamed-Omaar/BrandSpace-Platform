import 'server-only';
import { cache } from 'react';
import { NotesService } from '@brandspace/collaboration';
import { systemClock } from '@brandspace/shared';
import { notificationService } from './approvals-context';
import { inContentStudio } from './content-context';
import { resolveApiWorkspace } from './customer-context';
import type { TopbarCounts } from './topbar';

/**
 * WHAT THE TOP BAR'S DOTS ARE MADE OF (P6-16) — each from the domain that owns
 * it, for the signed-in member, in the active workspace.
 *
 *   Review         pending approvals in the member's brands — only for a member
 *                  holding `content.approve`, because a dot means "this is
 *                  waiting on YOU" and a reviewer is the one it waits on.
 *   Notes          unread mentions, under the Notes permission and brand scope
 *                  (`NotesService.unreadMentionCount`).
 *   Notifications  unread in-app notifications (`NotificationService.unreadCount`).
 *
 * THE SESSION IS RESOLVED HERE, NOT PASSED IN. The shell is rendered by thirty
 * pages and none of them hands it an id; `resolveApiWorkspace` re-derives the
 * workspace from the session cookie exactly as the page itself did, and returns
 * null rather than redirecting, so a top bar can never be the thing that sends
 * somebody to sign-in.
 *
 * A FAILURE IS "NO DOT", NEVER A BROKEN PAGE. A count that cannot be read is
 * unknown, and unknown draws nothing — the links themselves still work.
 *
 * ONE TRANSACTION, QUERIES IN SEQUENCE. Dispatching them together inside one
 * transaction lets a single failure reject all of them at once (D-269).
 */

const UNKNOWN: TopbarCounts = { review: null, notes: null, notifications: null };

export const topbarCounts = cache(async (): Promise<TopbarCounts> => {
  const session = await resolveApiWorkspace().catch(() => null);
  if (!session) return UNKNOWN;
  const { customer, workspace } = session;
  const workspaceId = workspace.workspaceId;
  const may = (key: string) => workspace.permissionKeys.includes(key);

  try {
    return await inContentStudio(workspaceId, async ({ db, approvals }) => {
      const notifications = await notificationService({ db, workspaceId }).unreadCount(
        customer.userId,
      );
      const notes = await new NotesService({
        db,
        workspaceId,
        clock: systemClock,
      }).unreadMentionCount({
        userId: customer.userId,
        permissionKeys: workspace.permissionKeys,
        brandScope: workspace.brandScope,
      });
      const review = may('content.approve')
        ? await (await approvals()).pendingCount(workspace.brandScope)
        : null;
      return { review, notes, notifications };
    });
  } catch {
    return UNKNOWN;
  }
});
