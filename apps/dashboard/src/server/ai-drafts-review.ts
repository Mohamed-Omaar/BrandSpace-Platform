import 'server-only';
import { brandIdQueryFilter, createLogger, internalErrorFields } from '@brandspace/shared';
import { resolveApiWorkspace } from './customer-context';
import { inContentStudio } from './content-context';

const log = createLogger({ context: { component: 'dashboard.ai-drafts-review' } });

/**
 * D-496 (Settings 3) — "AI DRAFTS GO TO REVIEW".
 *
 * When the brand has the switch on, a post the Studio's AI just wrote is sent
 * for review as it is created — through THE EXISTING SUBMIT PATH, the one
 * "Send for review" uses (`ContentApprovalService.submit`, with the
 * dashboard's own approval notifier), so the reviewer is told exactly as they
 * are for a person's post. No new notification path.
 *
 * ONLY WHAT IT IS ASKED TO SEND, AND ONLY WHEN IT MAY:
 *   - the member must hold `content.submit`, as "Send for review" requires;
 *   - the post must be this member's, in scope, AI-written and still a draft;
 *   - the brand must have `aiDraftsToReview` on (existing brands off, brands
 *     created after PR E on — Q3).
 * A refusal leaves the draft a draft — the words are never lost — and is
 * logged without content.
 *
 * In the beta no AI provider is configured, so this never runs; the switch is
 * stored now so it applies when AI arrives.
 */
export async function submitAiDraftWhenAsked(itemId: string): Promise<boolean> {
  const session = await resolveApiWorkspace('content.submit');
  if (!session) return false;
  const { workspace, customer } = session;
  try {
    return await inContentStudio(workspace.workspaceId, async (services) => {
      const item = await services.db.contentItem.findFirst({
        where: {
          id: itemId,
          workspaceId: workspace.workspaceId,
          origin: 'AI_GENERATED',
          status: 'DRAFT',
          deletedAt: null,
          createdByUserId: customer.userId,
          ...brandIdQueryFilter({ brandScope: workspace.brandScope }),
        },
        select: { id: true, brand: { select: { aiDraftsToReview: true } } },
      });
      if (!item?.brand.aiDraftsToReview) return false;
      await (
        await services.approvals()
      ).submit({
        itemId: item.id,
        actor: {
          userId: customer.userId,
          roleKey: workspace.roleKey,
          permissionKeys: workspace.permissionKeys,
          brandScope: workspace.brandScope,
        },
      });
      return true;
    });
  } catch (error: unknown) {
    log.warn('AI draft not sent for review; it stays a draft', internalErrorFields(error));
    return false;
  }
}
