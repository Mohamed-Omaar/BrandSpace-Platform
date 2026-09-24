import { ActivityLogService } from '@brandspace/activity';
import { systemClock } from '@brandspace/shared';
import { inWorkspace } from './customer-context';
import { activityActionLabel } from './activity-labels';
import { relativeTime } from './home';
import { messages, optionalMessage } from '../i18n/messages';

/**
 * A CONTEXTUAL MINI-TIMELINE (Phase 6 final, D-277 §41/§47, D-298).
 *
 * "Maha requested changes · 18 min ago" — read from `audit_event` through the
 * same `ActivityLogService` the global Activity log uses, with the same viewer
 * grading (own / brand scope / all) and a resource-id narrowing. No second
 * activity store, no diffs: what happened, who, when.
 *
 * WHO is a member's name (or address) by THIS workspace's memberships; "You"
 * for the reader; the actor TYPE, translated, for a system or support actor.
 */
export interface TimelineEntry {
  readonly id: string;
  readonly label: string;
  readonly actor: string;
  readonly at: Date;
  readonly when: string;
}

export async function activityTimeline(input: {
  readonly locale: string;
  readonly workspace: {
    readonly workspaceId: string;
    readonly permissionKeys: readonly string[];
    readonly brandScope: readonly string[];
  };
  readonly userId: string;
  readonly resourceIds: readonly string[];
  readonly take: number;
}): Promise<readonly TimelineEntry[]> {
  const { locale, workspace } = input;
  if (input.resourceIds.length === 0) return [];
  const dictionary = (locale === 'ar' ? messages.ar : messages.en) as Readonly<
    Record<string, string | undefined>
  >;
  const now = systemClock.now();
  return inWorkspace(workspace.workspaceId, async ({ db }) => {
    const page = await new ActivityLogService({ db, workspaceId: workspace.workspaceId }).page({
      viewer: {
        userId: input.userId,
        permissionKeys: workspace.permissionKeys,
        brandScope: workspace.brandScope,
      },
      filter: { resourceIds: input.resourceIds },
      take: input.take,
    });
    const actorIds = [
      ...new Set(page.entries.flatMap((entry) => (entry.actorId ? [entry.actorId] : []))),
    ];
    const members =
      actorIds.length === 0
        ? []
        : await db.membership.findMany({
            where: { workspaceId: workspace.workspaceId, userId: { in: actorIds } },
            select: { userId: true, user: { select: { name: true, email: true } } },
          });
    const names = new Map(
      members.map((member) => [member.userId, member.user.name?.trim() || member.user.email]),
    );
    return page.entries.map((entry) => ({
      id: entry.id,
      label: activityActionLabel(entry.action, dictionary),
      actor:
        entry.actorId === input.userId
          ? (optionalMessage(locale, 'activity.you') ?? '')
          : entry.actorId && names.has(entry.actorId)
            ? (names.get(entry.actorId) ?? '')
            : (optionalMessage(locale, `activity.actor.${entry.actorType}`) ?? '—'),
      at: entry.occurredAt,
      when: relativeTime(entry.occurredAt, now, locale),
    }));
  });
}
