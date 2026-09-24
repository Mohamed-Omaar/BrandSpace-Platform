import 'server-only';
import { brandIdQueryFilter } from '@brandspace/shared';
import { inWorkspace } from './customer-context';
import { shellSession } from './topbar-counts';
import { copilotSubjectForPath, type CopilotSubjectKind } from './copilot-surface';

export interface CopilotDrawerSubject {
  readonly type: CopilotSubjectKind;
  readonly id: string;
  readonly title: string;
}

/**
 * THE SUBJECT THE GLOBAL COPILOT OPENS WITH (D-277 §37, D-280) — the object
 * named by the address the reader is on, WITH its title, so the drawer can say
 * "looking at October Awareness".
 *
 * READ UNDER RLS AND THE READER'S BRANDSCOPE, AND ONLY IN THE SELECTED BRAND.
 * Anything the reader could not open themselves — another brand's campaign, a
 * deleted post, an id that never existed — is no subject at all; the drawer
 * then opens as a plain conversation. The orchestrator admits the subject again
 * when the session opens, so this read is presentation, not authorization.
 */
export async function copilotDrawerSubject(
  requestPath: string | null,
  brandId: string | null,
  locale: string,
): Promise<CopilotDrawerSubject | null> {
  const subject = copilotSubjectForPath(requestPath);
  if (!subject || !brandId) return null;
  const session = await shellSession();
  if (!session || !session.workspace.permissionKeys.includes('copilot.use')) return null;
  const { workspace } = session;
  const where = {
    id: subject.id,
    workspaceId: workspace.workspaceId,
    ...brandIdQueryFilter({ brandId, brandScope: workspace.brandScope }),
  };

  try {
    const title = await inWorkspace(workspace.workspaceId, async ({ db }) => {
      switch (subject.type) {
        case 'CAMPAIGN':
          return (
            await db.campaign.findFirst({
              where: { ...where, deletedAt: null },
              select: { name: true },
            })
          )?.name;
        case 'CONTENT_ITEM':
          return (
            await db.contentItem.findFirst({
              where: { ...where, deletedAt: null },
              select: { title: true },
            })
          )?.title;
        case 'INSIGHT': {
          const row = await db.insight.findFirst({ where, select: { title: true } });
          const value = row?.title as { en?: unknown; ar?: unknown } | null | undefined;
          const [first, second] = locale === 'ar' ? [value?.ar, value?.en] : [value?.en, value?.ar];
          const text = typeof first === 'string' && first !== '' ? first : second;
          return typeof text === 'string' ? text : undefined;
        }
      }
    });
    return title ? { ...subject, title } : null;
  } catch {
    // A subject that cannot be read is no subject; the drawer still opens.
    return null;
  }
}
