'use server';

import { revalidatePath } from 'next/cache';
import { inNotes, subjectFromForm } from '../../server/notes-context';

/**
 * The server actions behind the notes panel (P6-05).
 *
 * EVERY ONE GOES THROUGH `inNotes`, which rebuilds the actor from the SESSION.
 * Nothing here trusts a user id, a permission or a brand scope from the form:
 * the only things the form supplies are what is being talked about and what was
 * said, and both are validated by the service.
 *
 * WHY THEY REVALIDATE A PATH RATHER THAN REDIRECT. A note is posted from the
 * middle of a screen somebody is working on — the composer, a campaign, the
 * brand. Redirecting would take them away from the thing they were writing
 * about, which is the whole point of the note being contextual.
 */

/** Where to refresh after a change. Validated, because it comes from the form. */
function safePath(formData: FormData): string {
  const raw = String(formData.get('returnPath') ?? '');
  /*
   * A RELATIVE PATH INSIDE THIS APP, OR NOTHING.
   *
   * `revalidatePath` does not navigate, so this is not an open-redirect
   * surface in the usual sense — but an attacker-supplied value would still let
   * somebody force cache invalidation on arbitrary routes, and the honest
   * answer to "is this one of our paths" is the same cheap check either way.
   */
  return raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
}

/** The people named in this note, as ids the service will re-check. */
function mentionsFrom(formData: FormData): readonly string[] {
  return formData
    .getAll('mentionedUserIds')
    .map((value) => String(value))
    .filter((value) => value !== '');
}

export async function startNoteThreadAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const subject = subjectFromForm(formData);
  const body = String(formData.get('body') ?? '');

  await inNotes(locale, async ({ service, actor }) => {
    await service.startThread({
      actor,
      subject,
      body,
      mentionedUserIds: mentionsFrom(formData),
    });
  });
  revalidatePath(safePath(formData));
}

export async function replyToNoteThreadAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const threadId = String(formData.get('threadId') ?? '');
  const body = String(formData.get('body') ?? '');

  await inNotes(locale, async ({ service, actor }) => {
    await service.reply({ actor, threadId, body, mentionedUserIds: mentionsFrom(formData) });
  });
  revalidatePath(safePath(formData));
}

export async function resolveNoteThreadAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const threadId = String(formData.get('threadId') ?? '');
  await inNotes(locale, async ({ service, actor }) => {
    await service.resolve({ actor, threadId });
  });
  revalidatePath(safePath(formData));
}

export async function reopenNoteThreadAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const threadId = String(formData.get('threadId') ?? '');
  await inNotes(locale, async ({ service, actor }) => {
    await service.reopen({ actor, threadId });
  });
  revalidatePath(safePath(formData));
}

export async function assignNoteThreadAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const threadId = String(formData.get('threadId') ?? '');
  const raw = String(formData.get('assignedToUserId') ?? '');
  await inNotes(locale, async ({ service, actor }) => {
    await service.assign({ actor, threadId, assignedToUserId: raw === '' ? null : raw });
  });
  revalidatePath(safePath(formData));
}

/**
 * Mark this reader's mentions in one thread as seen.
 *
 * SEPARATE FROM OPENING THE THREAD, deliberately. Marking on render would clear
 * somebody's unread count because a page happened to load — including a page
 * they navigated past — and the Command Center would then be quietly wrong
 * about what still needs them.
 */
export async function markNoteMentionsReadAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const threadId = String(formData.get('threadId') ?? '');
  await inNotes(locale, async ({ service, actor }) => {
    await service.markMentionsRead({ actor, threadId });
  });
  revalidatePath(safePath(formData));
}

/**
 * D-281 — when the conversation needs an answer by. An empty field clears it.
 * `<input type="date">` sends `YYYY-MM-DD`; it is stored as the END of that day
 * in UTC so "due Thursday" is not already overdue on Thursday morning.
 */
export async function setNoteDueAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const threadId = String(formData.get('threadId') ?? '');
  const raw = String(formData.get('dueAt') ?? '').trim();
  const dueAt = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T23:59:59.000Z`) : null;
  if (raw !== '' && dueAt === null) throw new Error('Invalid date.');
  await inNotes(locale, async ({ service, actor }) => {
    await service.setDue({ actor, threadId, dueAt });
  });
  revalidatePath(safePath(formData));
}

/** D-281 — Normal or Important, from a closed set. */
export async function setNoteImportanceAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const threadId = String(formData.get('threadId') ?? '');
  const importance =
    String(formData.get('importance') ?? '') === 'IMPORTANT' ? 'IMPORTANT' : 'NORMAL';
  await inNotes(locale, async ({ service, actor }) => {
    await service.setImportance({ actor, threadId, importance });
  });
  revalidatePath(safePath(formData));
}
