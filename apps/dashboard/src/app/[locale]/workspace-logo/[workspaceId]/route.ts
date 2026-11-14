import { inWorkspace } from '../../../../server/customer-context';
import { isMemberOf } from '../../../../server/pictures';
import { notFound, pictureResponse } from '../../../../server/picture-response';

/**
 * PR D (D-607) — A WORKSPACE'S LOGO, to its members only (the session's own
 * memberships, as the switcher lists them). Anyone else: the 404 a workspace
 * with no logo gets.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ locale: string; workspaceId: string }> },
): Promise<Response> {
  const { workspaceId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) return notFound();
  if (!(await isMemberOf(workspaceId))) return notFound();
  const row = await inWorkspace(workspaceId, ({ db }) =>
    db.workspace.findUnique({ where: { id: workspaceId }, select: { logoKey: true } }),
  );
  return pictureResponse(row?.logoKey);
}
