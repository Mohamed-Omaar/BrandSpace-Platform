import 'server-only';
import { NotesService, type NoteActor, type NoteSubject } from '@brandspace/collaboration';
import { systemClock } from '@brandspace/shared';
import { inWorkspace, requireWorkspace } from './customer-context';

/**
 * The dashboard's entry point into contextual collaboration (P6-05).
 *
 * ONE PLACE THAT BUILDS THE ACTOR. Every notes call needs a user id, the
 * permissions they hold and their brand scope, and all three come from the
 * session rather than from anything the caller supplies — a page or an action
 * that assembled its own actor would be one refactor away from assembling a
 * more generous one.
 */

export interface NotesContext {
  readonly service: NotesService;
  readonly actor: NoteActor;
  readonly locale: string;
}

/**
 * Run something with a notes service and an actor, inside the workspace.
 *
 * `requireWorkspace` re-verifies membership on every request and answers 404
 * without the permission, so a caller reaching this function has already been
 * authorised to be in the workspace; the service applies the collaboration
 * permission and the brand scope on top.
 */
export async function inNotes<T>(
  locale: string,
  run: (context: NotesContext) => Promise<T>,
): Promise<T> {
  const { customer, workspace } = await requireWorkspace(locale);
  return inWorkspace(workspace.workspaceId, async (scoped) =>
    run({
      service: new NotesService({
        db: scoped.db,
        workspaceId: workspace.workspaceId,
        clock: systemClock,
      }),
      actor: {
        userId: customer.userId,
        permissionKeys: workspace.permissionKeys,
        brandScope: workspace.brandScope,
      },
      locale,
    }),
  );
}

/**
 * The people a note may name, for the mention picker.
 *
 * ACTIVE MEMBERS OF THIS WORKSPACE ONLY — the same rule the service enforces
 * when the note is written. The picker showing somebody the service would
 * silently drop is a picker that lies, so the two read the same population.
 */
export async function mentionableMembers(
  locale: string,
): Promise<readonly { readonly userId: string; readonly name: string }[]> {
  const { workspace } = await requireWorkspace(locale);
  return inWorkspace(workspace.workspaceId, async (scoped) => {
    const members = await scoped.db.membership.findMany({
      where: { workspaceId: workspace.workspaceId, status: 'ACTIVE' },
      select: { userId: true, user: { select: { name: true, email: true } } },
      orderBy: { acceptedAt: 'asc' },
      take: 100,
    });
    return members.map((member) => ({
      userId: member.userId,
      // The name, or the address when somebody has not set one — never an
      // empty label, which reads as a broken row rather than a person.
      name: member.user.name?.trim() || member.user.email,
    }));
  });
}

/** Parse a subject out of form data, refusing anything that is not one. */
export function subjectFromForm(formData: FormData): NoteSubject {
  const type = String(formData.get('subjectType') ?? '');
  const id = String(formData.get('subjectId') ?? '');
  if (type === 'CONTENT_ITEM') return { type, contentItemId: id };
  if (type === 'CAMPAIGN') return { type, campaignId: id };
  if (type === 'BRAND') return { type, brandId: id };
  /*
   * AN UNKNOWN SUBJECT IS NOT A DEFAULT.
   *
   * Falling back to one of the three would attach the thread to whatever the
   * fallback was, using an id meant for something else — and the service would
   * accept it if that id happened to resolve. The parse refuses instead.
   */
  throw new Error('Unknown note subject.');
}
