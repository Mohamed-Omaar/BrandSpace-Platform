import type { NoteActor, NotesService } from '@brandspace/collaboration';

/*
 * WHAT FOLLOWS FROM AN APPROVAL VERDICT (P6-06).
 *
 * NO `server-only` MARKER, for the reason `command-center.ts` records: this
 * module opens no connection, reads no secret and constructs no client — the
 * service and the actor are PARAMETERS, supplied by a caller already inside a
 * tenant transaction. That is what lets the isolation suite exercise the rule
 * against real PostgreSQL rather than against a copy of it written in a test.
 */

/**
 * The conversation a "needs work" verdict leaves behind (P6-06).
 *
 * THE APPROVAL IS AND REMAINS THE SOURCE OF TRUTH. This runs after the decision
 * has committed, changes nothing about it, and the verdict stands whatever
 * happens here.
 *
 * WHY IT EXISTS. `REQUEST_CHANGES` hands the item back to its author with a
 * `decisionNote` attached to a CLOSED approval cycle. The author opens the
 * draft and the reason they were asked to change it is on another screen, in a
 * record that is finished and cannot be replied to. Every team solves that the
 * same way — by repeating the reviewer's words somewhere answerable — and doing
 * it by hand is how the request and the work drift apart.
 *
 * ITS OWN FUNCTION, TAKING EXPLICIT ARGUMENTS, so the rule is testable against
 * a real database without a Next request. The action supplies the session; this
 * decides what follows from a verdict.
 *
 * Returns the thread id when one was written, or null when the rule says none
 * should be — never throws for a reason the caller should ignore.
 */
export async function noteForChangesRequested(input: {
  readonly service: NotesService;
  readonly actor: NoteActor;
  readonly verdict: string;
  readonly contentItemId: string | null;
  readonly requestedByUserId: string;
  readonly decisionNote: string;
}): Promise<string | null> {
  /*
   * ONLY `REQUEST_CHANGES`, AND ONLY WITH SOMETHING TO SAY.
   *
   * An approval needs no conversation. A rejection ends the cycle rather than
   * asking for something. And a changes-requested verdict with an empty note
   * has nothing to repeat — a thread reading "" would be the product talking to
   * itself, and it would carry a mention, so somebody would be notified about
   * nothing.
   */
  if (input.verdict !== 'REQUEST_CHANGES') return null;
  if (input.contentItemId === null) return null;
  if (input.decisionNote.trim() === '') return null;

  const { threadId } = await input.service.startThread({
    actor: input.actor,
    subject: { type: 'CONTENT_ITEM', contentItemId: input.contentItemId },
    body: input.decisionNote,
    /*
     * THE AUTHOR IS MENTIONED, so the request reaches their Command Center
     * rather than waiting to be found. `startThread` names only members of this
     * workspace and drops anything else, so a requester who has since left
     * produces a note with no mention rather than a failure.
     */
    mentionedUserIds: [input.requestedByUserId],
  });
  return threadId;
}
