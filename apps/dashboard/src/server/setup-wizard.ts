import 'server-only';
import { localizedFrom } from '@brandspace/brand-brain';
import { inBrandBrain } from './brand-brain-context';
import { GOAL_ITEM_KEY, goalFromTitle, goalLabels, type SetupFacts } from './setup-wizard-state';

/**
 * THE FACTS THE WIZARD'S STEPS ARE COMPUTED FROM — read, never stored.
 *
 * One transaction under the workspace's RLS context, and every query names the
 * brand, which the caller resolved through the member's BrandScope
 * (`brandContextFor` on a `brand`-scoped route). No count here can include
 * another brand's rows, let alone another workspace's.
 */
export async function setupFactsFor(
  workspaceId: string,
  brandId: string | null,
): Promise<SetupFacts> {
  if (brandId === null) {
    return {
      brandId: null,
      sources: { total: 0, processing: 0, failed: 0 },
      pendingCandidates: 0,
      decidedCandidates: 0,
      activeKnowledge: 0,
      activeConnections: 0,
      goal: null,
    };
  }

  return inBrandBrain(workspaceId, async ({ db }) => {
    const [sources, pending, decided, active, connections, goal] = await Promise.all([
      db.brandSourceDocument.groupBy({
        by: ['status'],
        where: { brandId, deletedAt: null },
        _count: { _all: true },
      }),
      db.brandKnowledgeCandidate.count({
        where: { brandId, status: 'PENDING', sourceKind: 'DOCUMENT' },
      }),
      db.brandKnowledgeCandidate.count({
        where: { brandId, status: { in: ['ACCEPTED', 'EDITED_ACCEPTED', 'REJECTED'] } },
      }),
      db.brandKnowledgeItem.count({ where: { brandId, status: 'ACTIVE' } }),
      db.socialConnection.count({ where: { brandId, status: 'ACTIVE' } }),
      db.brandKnowledgeItem.findFirst({
        where: {
          brandId,
          area: 'STRATEGY',
          itemKey: GOAL_ITEM_KEY,
          status: { in: ['ACTIVE', 'STALE'] },
        },
        select: { id: true, title: true },
      }),
    ]);

    const count = (statuses: readonly string[]) =>
      sources
        .filter((row) => statuses.includes(row.status))
        .reduce((sum, row) => sum + row._count._all, 0);

    return {
      brandId,
      sources: {
        total: count(['UPLOADED', 'PROCESSING', 'READY', 'FAILED', 'QUARANTINED']),
        processing: count(['UPLOADED', 'PROCESSING']),
        failed: count(['FAILED', 'QUARANTINED']),
      },
      pendingCandidates: pending,
      decidedCandidates: decided,
      activeKnowledge: active,
      activeConnections: connections,
      goal: goal
        ? {
            itemId: goal.id,
            objective: goalFromTitle(localizedFrom(goal.title).en, goalLabels('en')),
          }
        : null,
    };
  });
}
