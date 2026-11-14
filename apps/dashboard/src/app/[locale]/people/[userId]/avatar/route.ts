import { getPrisma } from '@brandspace/database';
import { getCustomer } from '../../../../../server/customer-context';
import { mayViewAvatar } from '../../../../../server/pictures';
import { notFound, pictureResponse } from '../../../../../server/picture-response';

/**
 * PR D (D-608) — A PERSON'S AVATAR. Signed in, and the person is a member of
 * the viewer's current workspace (or is the viewer). Otherwise the same 404 as
 * a person with no picture: nothing says who exists elsewhere.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ locale: string; userId: string }> },
): Promise<Response> {
  const { userId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return notFound();
  const viewer = await getCustomer().catch(() => null);
  if (!viewer) return notFound();
  if (!(await mayViewAvatar(viewer.userId, viewer.activeWorkspaceId, userId))) return notFound();
  const row = await getPrisma().user.findUnique({
    where: { id: userId },
    select: { avatarKey: true },
  });
  return pictureResponse(row?.avatarKey);
}
