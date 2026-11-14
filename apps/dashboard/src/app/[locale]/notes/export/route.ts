import { NextResponse } from 'next/server';
import { systemClock } from '@brandspace/shared';
import { inPersonalNotes } from '../../../../server/personal-notes-context';

/**
 * PR D (D-607), owner condition 2 — "DOWNLOAD MY NOTES".
 *
 * The signed-in person's OWN notes in this workspace, with their reminders, as
 * one JSON file. Whose notes is not a question the request can ask: the
 * workspace and the person both come from the session (`inPersonalNotes`), and
 * the database refuses every other person's rows on its own (RLS on workspace
 * AND owner). Nobody — a teammate, the workspace owner, the Control Center —
 * can download someone else's.
 *
 * The filename is built here from the date alone; nothing from the query
 * string reaches a header. Not cached anywhere.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ locale: string }> },
): Promise<Response> {
  const { locale } = await params;
  const { notes, workspaceName } = await inPersonalNotes(locale, async (service, session) => ({
    notes: await service.exportAll(),
    workspaceName: session.workspace.workspaceName,
  }));
  const now = systemClock.now();
  const file = {
    kind: 'brandspace.personal-notes',
    version: 1,
    exportedAt: now.toISOString(),
    workspace: workspaceName,
    notes: notes.map((note) => ({
      title: note.title,
      body: note.body,
      pinned: note.pinnedAt !== null,
      createdAt: note.createdAt.toISOString(),
      updatedAt: note.updatedAt.toISOString(),
      reminder: note.reminder
        ? {
            remindAt: note.reminder.remindAt.toISOString(),
            timeZone: note.reminder.timeZone,
            state: note.reminder.state,
          }
        : null,
    })),
  };
  return new NextResponse(`${JSON.stringify(file, null, 2)}\n`, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="brandspace-my-notes-${now.toISOString().slice(0, 10)}.json"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
