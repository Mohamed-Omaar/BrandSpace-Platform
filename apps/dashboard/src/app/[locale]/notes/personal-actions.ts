'use server';

import { redirect } from 'next/navigation';
import { formatLocalTime, instantForIntent, nextDayKey } from '@brandspace/content';
import { isReminderTimeZone } from '@brandspace/collaboration';
import { isAppError, systemClock } from '@brandspace/shared';
import { inPersonalNotes } from '../../../server/personal-notes-context';

/**
 * PR D (D-607) — THE "MY NOTES" ACTIONS.
 *
 * Every one goes through `inPersonalNotes`, which takes the workspace AND the
 * person from the signed-in session (owner condition 4). The form supplies
 * only which note (re-checked against the owner by the service and by RLS)
 * and what was typed. A note id that is not the person's own is "not found",
 * exactly like one that does not exist.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function localeOf(formData: FormData): 'ar' | 'en' {
  return formData.get('locale') === 'ar' ? 'ar' : 'en';
}

function noteIdOf(formData: FormData): string {
  const id = String(formData.get('noteId') ?? '');
  return UUID.test(id) ? id : '';
}

/** Back to My notes, on this note (or the list), with an outcome to say. */
function back(locale: string, noteId: string | null, outcome?: string): never {
  const params = new URLSearchParams({ tab: 'mine' });
  if (noteId) params.set('note', noteId);
  if (outcome) params.set('outcome', outcome);
  redirect(`/${locale}/notes?${params.toString()}`);
}

/** Run, and turn a refusal into a stable outcome code on the page. */
async function attempt<T>(run: () => Promise<T>): Promise<{ ok: T } | { error: string }> {
  try {
    return { ok: await run() };
  } catch (error: unknown) {
    if (isAppError(error)) {
      return { error: error.code === 'NOT_FOUND' ? 'note-missing' : 'note-invalid' };
    }
    throw error;
  }
}

/**
 * The person's zone: the one their browser reports with the form, else the
 * zone the reminder already has. Never invented by the server.
 */
function zoneOf(formData: FormData): string | null {
  const zone = String(formData.get('timeZone') ?? '');
  return isReminderTimeZone(zone) ? zone : null;
}

export async function savePersonalNoteAction(formData: FormData): Promise<void> {
  const locale = localeOf(formData);
  const noteId = noteIdOf(formData);
  const input = { title: formData.get('title'), body: formData.get('body') };
  const result = await attempt(() =>
    inPersonalNotes(locale, (notes) =>
      noteId ? notes.update(noteId, input) : notes.create(input),
    ),
  );
  if ('error' in result) back(locale, noteId || 'new', result.error);
  back(locale, result.ok.id, 'note-saved');
}

export async function deletePersonalNoteAction(formData: FormData): Promise<void> {
  const locale = localeOf(formData);
  const noteId = noteIdOf(formData);
  const result = await attempt(() => inPersonalNotes(locale, (notes) => notes.remove(noteId)));
  back(locale, null, 'error' in result ? result.error : 'note-deleted');
}

export async function pinPersonalNoteAction(formData: FormData): Promise<void> {
  const locale = localeOf(formData);
  const noteId = noteIdOf(formData);
  const pinned = formData.get('pinned') === 'true';
  const result = await attempt(() =>
    inPersonalNotes(locale, (notes) => notes.setPinned(noteId, pinned)),
  );
  back(locale, noteId, 'error' in result ? result.error : undefined);
}

export async function setPersonalReminderAction(formData: FormData): Promise<void> {
  const locale = localeOf(formData);
  const noteId = noteIdOf(formData);
  const zone = zoneOf(formData);
  const local = String(formData.get('remindAt') ?? '');
  const remindAt =
    zone && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local) ? instantForIntent(local, zone) : null;
  if (!zone || !remindAt) back(locale, noteId, 'reminder-invalid');
  const result = await attempt(() =>
    inPersonalNotes(locale, (notes) => notes.setReminder(noteId, { remindAt, timeZone: zone })),
  );
  back(locale, noteId, 'error' in result ? 'reminder-invalid' : 'reminder-set');
}

export async function clearPersonalReminderAction(formData: FormData): Promise<void> {
  const locale = localeOf(formData);
  const noteId = noteIdOf(formData);
  const result = await attempt(() =>
    inPersonalNotes(locale, (notes) => notes.clearReminder(noteId)),
  );
  back(locale, noteId, 'error' in result ? result.error : 'reminder-cleared');
}

/** Snooze: an hour from now, or tomorrow at 09:00 in the reminder's own zone. */
export async function snoozePersonalReminderAction(formData: FormData): Promise<void> {
  const locale = localeOf(formData);
  const noteId = noteIdOf(formData);
  const until = String(formData.get('until') ?? '');
  const result = await attempt(() =>
    inPersonalNotes(locale, async (notes) => {
      const note = await notes.get(noteId);
      const zone = note.reminder?.timeZone ?? 'UTC';
      const now = systemClock.now();
      const at =
        until === 'tomorrow'
          ? instantForIntent(`${nextDayKey(formatLocalTime(now, zone).slice(0, 10))}T09:00`, zone)
          : new Date(now.getTime() + 3_600_000);
      if (!at) throw new Error('no instant for tomorrow');
      await notes.snooze(noteId, at);
    }),
  );
  back(locale, noteId, 'error' in result ? result.error : 'reminder-snoozed');
}

export async function markPersonalReminderDoneAction(formData: FormData): Promise<void> {
  const locale = localeOf(formData);
  const noteId = noteIdOf(formData);
  const result = await attempt(() => inPersonalNotes(locale, (notes) => notes.markDone(noteId)));
  back(locale, noteId, 'error' in result ? result.error : 'reminder-done');
}
