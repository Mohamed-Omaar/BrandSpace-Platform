import 'server-only';
import { withWorkspacePerson } from '@brandspace/database';
import { PersonalNotesService } from '@brandspace/collaboration';
import { requireWorkspace, type WorkspaceSession } from './customer-context';

/**
 * PR D (D-607) — THE ONLY DOOR TO A PERSON'S PRIVATE NOTES IN THE DASHBOARD.
 *
 * Owner condition 4: `app.user_id` is set ONLY here, and only from the
 * SIGNED-IN SESSION — `requireWorkspace` resolves the customer from the
 * session cookie (`getCustomer`) and re-verifies their membership of the
 * workspace on every request. `withWorkspacePerson` then sets
 * `app.workspace_id` and `app.user_id` in the SAME transaction, before the
 * callback runs. No user id is ever taken from a form, a query string or a
 * header: nothing in `fn`'s inputs can change whose notes it reaches.
 */
export async function inPersonalNotes<T>(
  locale: string,
  fn: (notes: PersonalNotesService, session: WorkspaceSession) => Promise<T>,
): Promise<T> {
  const session = await requireWorkspace(locale);
  const workspaceId = session.workspace.workspaceId;
  const ownerUserId = session.customer.userId;
  return withWorkspacePerson(workspaceId, ownerUserId, (db) =>
    fn(new PersonalNotesService({ db, workspaceId, ownerUserId }), session),
  );
}
