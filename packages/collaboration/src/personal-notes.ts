import type { TenantScopedClient } from '@brandspace/database';
import { AppError, systemClock, type Clock } from '@brandspace/shared';

/**
 * PR D (D-608) — A PERSON'S OWN NOTES, AND THEIR REMINDERS.
 *
 * PRIVATE TO THE PERSON WHO WROTE THEM, in one workspace. Two layers, as every
 * tenant read in this product has:
 *
 *   1. Every query here names BOTH the workspace and the owner in its WHERE.
 *   2. The database refuses the rest on its own: `personal_note` and
 *      `personal_note_reminder` are readable only when `app.workspace_id` AND
 *      `app.user_id` match the row (`withWorkspacePerson`), and the platform
 *      role holds no privilege on `personal_note` at all.
 *
 * The `db` handed in MUST come from `withWorkspacePerson(workspaceId,
 * ownerUserId, …)` with the same two ids, both from the signed-in session.
 *
 * NO AUDIT EVENT FOR A NOTE'S TEXT (owner decision, PR D): an audit row would
 * let a workspace admin see that, when and how often a person writes notes,
 * which is exactly what "private" rules out.
 */

export const PERSONAL_NOTE_TITLE_MAX = 200;
export const PERSONAL_NOTE_BODY_MAX = 20_000;
/** A list never returns more than this; search narrows it. */
export const PERSONAL_NOTE_LIST_MAX = 200;

export type ReminderState = 'PENDING' | 'SENT' | 'DONE';

export interface PersonalNoteReminderView {
  readonly id: string;
  readonly remindAt: Date;
  readonly timeZone: string;
  readonly state: ReminderState;
  readonly snoozeCount: number;
}

export interface PersonalNoteView {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly pinnedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly reminder: PersonalNoteReminderView | null;
}

export interface PersonalNotesOptions {
  /** From `withWorkspacePerson(workspaceId, ownerUserId, …)`. */
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
  /** The signed-in person — never a value from the request. */
  readonly ownerUserId: string;
  readonly clock?: Clock;
}

/** Is this a time zone the runtime knows (an IANA name)? */
export function isReminderTimeZone(zone: string): boolean {
  if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(zone) || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const invalid = (field: string) => new AppError('VALIDATION_FAILED', `Invalid ${field}.`);
const missing = () => new AppError('NOT_FOUND', 'Note not found.');

function cleanText(input: { title?: unknown; body?: unknown }): { title: string; body: string } {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const body = typeof input.body === 'string' ? input.body.replace(/\s+$/u, '') : '';
  if (title.length > PERSONAL_NOTE_TITLE_MAX) throw invalid('title');
  if (body.length > PERSONAL_NOTE_BODY_MAX) throw invalid('body');
  if (title.length === 0 && body.trim().length === 0) throw invalid('note');
  return { title, body };
}

const NOTE_SELECT = {
  id: true,
  title: true,
  body: true,
  pinnedAt: true,
  createdAt: true,
  updatedAt: true,
  reminders: {
    select: { id: true, remindAt: true, timeZone: true, state: true, snoozeCount: true },
    take: 1,
  },
} as const;

type NoteRow = {
  id: string;
  title: string;
  body: string;
  pinnedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  reminders: Array<{
    id: string;
    remindAt: Date;
    timeZone: string;
    state: string;
    snoozeCount: number;
  }>;
};

function toView(row: NoteRow): PersonalNoteView {
  const r = row.reminders[0];
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    pinnedAt: row.pinnedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    reminder: r
      ? {
          id: r.id,
          remindAt: r.remindAt,
          timeZone: r.timeZone,
          state: r.state as ReminderState,
          snoozeCount: r.snoozeCount,
        }
      : null,
  };
}

export class PersonalNotesService {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;
  readonly #ownerUserId: string;
  readonly #clock: Clock;

  constructor(options: PersonalNotesOptions) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#ownerUserId = options.ownerUserId;
    this.#clock = options.clock ?? systemClock;
  }

  /** The person's own notes in this workspace: pinned first, then the latest. */
  get #mine() {
    return { workspaceId: this.#workspaceId, ownerUserId: this.#ownerUserId };
  }

  async list(input: { search?: string } = {}): Promise<PersonalNoteView[]> {
    const q = input.search?.trim().slice(0, 200) ?? '';
    const rows = await this.#db.personalNote.findMany({
      where: {
        ...this.#mine,
        ...(q
          ? {
              OR: [
                { title: { contains: q, mode: 'insensitive' as const } },
                { body: { contains: q, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      orderBy: [{ pinnedAt: { sort: 'desc', nulls: 'last' } }, { updatedAt: 'desc' }],
      take: PERSONAL_NOTE_LIST_MAX,
      select: NOTE_SELECT,
    });
    return rows.map(toView);
  }

  /** How many notes the person has here (the rail's count). */
  async count(): Promise<number> {
    return this.#db.personalNote.count({ where: this.#mine });
  }

  async get(noteId: string): Promise<PersonalNoteView> {
    const row = await this.#db.personalNote.findFirst({
      where: { id: noteId, ...this.#mine },
      select: NOTE_SELECT,
    });
    if (!row) throw missing();
    return toView(row);
  }

  async create(input: { title?: unknown; body?: unknown }): Promise<PersonalNoteView> {
    const text = cleanText(input);
    const row = await this.#db.personalNote.create({
      data: { ...this.#mine, ...text },
      select: NOTE_SELECT,
    });
    return toView(row);
  }

  async update(
    noteId: string,
    input: { title?: unknown; body?: unknown },
  ): Promise<PersonalNoteView> {
    const text = cleanText(input);
    const { count } = await this.#db.personalNote.updateMany({
      where: { id: noteId, ...this.#mine },
      data: { ...text, updatedAt: this.#clock.now() },
    });
    if (count === 0) throw missing();
    return this.get(noteId);
  }

  async remove(noteId: string): Promise<void> {
    // The reminder goes with the note (ON DELETE CASCADE).
    const { count } = await this.#db.personalNote.deleteMany({
      where: { id: noteId, ...this.#mine },
    });
    if (count === 0) throw missing();
  }

  async setPinned(noteId: string, pinned: boolean): Promise<void> {
    const { count } = await this.#db.personalNote.updateMany({
      where: { id: noteId, ...this.#mine },
      data: { pinnedAt: pinned ? this.#clock.now() : null },
    });
    if (count === 0) throw missing();
  }

  /**
   * Remind me at this instant. The caller resolves the local date and time the
   * person chose in their own zone (`timeZone`), and the zone is kept so the
   * note shows the time they typed. A time already past is refused.
   */
  async setReminder(noteId: string, input: { remindAt: Date; timeZone: string }): Promise<void> {
    if (!isReminderTimeZone(input.timeZone)) throw invalid('time zone');
    if (Number.isNaN(input.remindAt.getTime())) throw invalid('time');
    if (input.remindAt.getTime() <= this.#clock.now().getTime()) throw invalid('time');
    await this.get(noteId); // the note is the person's own, or not found
    await this.#db.personalNoteReminder.upsert({
      where: { noteId },
      create: {
        ...this.#mine,
        noteId,
        remindAt: input.remindAt,
        timeZone: input.timeZone,
        state: 'PENDING',
      },
      update: {
        remindAt: input.remindAt,
        timeZone: input.timeZone,
        state: 'PENDING',
        sentAt: null,
        emailSentAt: null,
        doneAt: null,
        snoozeCount: 0,
      },
    });
  }

  async clearReminder(noteId: string): Promise<void> {
    await this.get(noteId);
    await this.#db.personalNoteReminder.deleteMany({ where: { noteId, ...this.#mine } });
  }

  /** Remind me again later: back to waiting, at `until`. */
  async snooze(noteId: string, until: Date): Promise<void> {
    if (until.getTime() <= this.#clock.now().getTime()) throw invalid('time');
    const reminder = await this.#db.personalNoteReminder.findFirst({
      where: { noteId, ...this.#mine },
      select: { id: true, snoozeCount: true },
    });
    if (!reminder) throw missing();
    await this.#db.personalNoteReminder.updateMany({
      where: { id: reminder.id, ...this.#mine },
      data: {
        remindAt: until,
        state: 'PENDING',
        sentAt: null,
        emailSentAt: null,
        doneAt: null,
        snoozeCount: Math.min(1000, reminder.snoozeCount + 1),
      },
    });
  }

  /** Done: the reminder stays on the note, marked done, and is not sent again. */
  async markDone(noteId: string): Promise<void> {
    const { count } = await this.#db.personalNoteReminder.updateMany({
      where: { noteId, ...this.#mine },
      data: { state: 'DONE', doneAt: this.#clock.now() },
    });
    if (count === 0) throw missing();
  }

  /**
   * The titles of these notes, for the person's own notification feed: a
   * `note.reminder` row carries no note text, so the title is read here, in
   * the owner's own workspace-and-person context, when they open the feed.
   * A note that is gone (or not theirs) has no entry.
   */
  async titles(noteIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const ids = [...new Set(noteIds)].filter((id) => /^[0-9a-f-]{36}$/i.test(id));
    if (ids.length === 0) return new Map();
    const rows = await this.#db.personalNote.findMany({
      where: { id: { in: ids }, ...this.#mine },
      select: { id: true, title: true, body: true },
    });
    // A note without a title is named by its first line, as the list names it.
    return new Map(
      rows.map((r) => [r.id, r.title || (r.body.split('\n')[0] ?? '').slice(0, 80)] as const),
    );
  }

  /** Everything the person wrote here, for their own data export (PR D, condition 2). */
  async exportAll(): Promise<PersonalNoteView[]> {
    const rows = await this.#db.personalNote.findMany({
      where: this.#mine,
      orderBy: { createdAt: 'asc' },
      select: NOTE_SELECT,
    });
    return rows.map(toView);
  }
}
