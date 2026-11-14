import Link from 'next/link';
import { formatLocalTime } from '@brandspace/content';
import type { PersonalNoteView } from '@brandspace/collaboration';
import { inPersonalNotes } from '../../../server/personal-notes-context';
import { CustomerBanner } from '../../../components/workspace-shell';
import { SubmitButton } from '../../../components/pending-submit';
import { BrowserTimeZoneInput } from '../../../components/browser-time-zone';
import type { MessageKey } from '../../../i18n/messages';
import {
  clearPersonalReminderAction,
  deletePersonalNoteAction,
  markPersonalReminderDoneAction,
  pinPersonalNoteAction,
  savePersonalNoteAction,
  setPersonalReminderAction,
  snoozePersonalReminderAction,
} from './personal-actions';

/**
 * PR D (D-609) — MY NOTES: the person's own notes in this workspace.
 *
 * PRIVATE TO THEM. Everything is read through `inPersonalNotes`, which takes
 * the workspace and the person from the session; the database refuses every
 * other person's rows on its own (RLS on workspace AND owner).
 *
 * DESIGN-SYSTEM EXTENSION (CLAUDE.md §4.2): the prototype draws no personal
 * notes, so this is the team Notes screen's own two panes — `.bsp-nts` list
 * and pane, its rows, pills, labels and controls — with three small classes
 * for what the team pane has no slot for (the search row, the editor fields,
 * the reminder line), recorded in the contract §6.
 */

const OUTCOMES: Record<string, 'success' | 'error'> = {
  'note-saved': 'success',
  'note-deleted': 'success',
  'reminder-set': 'success',
  'reminder-cleared': 'success',
  'reminder-snoozed': 'success',
  'reminder-done': 'success',
  'note-missing': 'error',
  'note-invalid': 'error',
  'reminder-invalid': 'error',
};

export async function MyNotes({
  locale,
  t,
  query,
}: {
  readonly locale: string;
  readonly t: (key: MessageKey) => string;
  readonly query: Record<string, string | string[] | undefined>;
}) {
  const search = typeof query['q'] === 'string' ? query['q'].slice(0, 200) : '';
  const requested = typeof query['note'] === 'string' ? query['note'] : null;
  const outcome = typeof query['outcome'] === 'string' ? query['outcome'] : null;

  const { notes, total } = await inPersonalNotes(locale, async (service) => ({
    notes: await service.list({ search }),
    total: search ? await service.count() : null,
  }));
  const creating = requested === 'new' || (notes.length === 0 && !search);
  const chosen = creating
    ? null
    : (notes.find((note) => note.id === requested) ?? (requested ? null : notes[0]) ?? null);

  const when = (note: PersonalNoteView): string | null => {
    const reminder = note.reminder;
    if (!reminder) return null;
    return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-u-nu-latn' : 'en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: reminder.timeZone,
    }).format(reminder.remindAt);
  };
  const titleOf = (note: PersonalNoteView): string =>
    note.title || note.body.split('\n')[0]?.slice(0, 80) || t('myNotes.untitled');
  const href = (params: Record<string, string>) =>
    `/${locale}/notes?${new URLSearchParams({ tab: 'mine', ...(search ? { q: search } : {}), ...params }).toString()}`;

  const reminderPill = (note: PersonalNoteView) => {
    const reminder = note.reminder;
    if (!reminder) return null;
    const time = when(note) ?? '';
    if (reminder.state === 'DONE') {
      return <span className="bsp-pill bsp-p-ok">{t('myNotes.reminder.done')}</span>;
    }
    return (
      <span className={reminder.state === 'SENT' ? 'bsp-pill bsp-p-warn' : 'bsp-pill bsp-p-ai'}>
        {t(reminder.state === 'SENT' ? 'myNotes.reminder.sent' : 'myNotes.reminder.at').replace(
          '{time}',
          time,
        )}
      </span>
    );
  };

  const hidden = (note: PersonalNoteView) => (
    <>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="noteId" value={note.id} />
    </>
  );

  return (
    <>
      {outcome && OUTCOMES[outcome] ? (
        <CustomerBanner tone={OUTCOMES[outcome]}>
          {t(`myNotes.outcome.${outcome}` as MessageKey)}
        </CustomerBanner>
      ) : null}
      <div className="bsp-nts" data-testid="my-notes">
        <section className="bsp-card bsp-nts-list" data-testid="my-notes-list">
          <form className="bsp-pn-search" role="search" action={`/${locale}/notes`}>
            <input type="hidden" name="tab" value="mine" />
            <input
              name="q"
              type="search"
              defaultValue={search}
              maxLength={200}
              className="bs-control"
              placeholder={t('myNotes.search')}
              aria-label={t('myNotes.search')}
              data-testid="my-notes-search"
            />
            <Link
              href={href({ note: 'new' })}
              className="bsp-btn bsp-sm bsp-pur"
              data-testid="my-notes-new"
            >
              {t('myNotes.new')}
            </Link>
          </form>
          <p className="bsp-nts-none">{t('myNotes.private')}</p>
          {notes.length === 0 ? (
            <p className="bsp-nts-none" data-testid="my-notes-empty">
              {search ? t('myNotes.noMatch') : t('myNotes.empty')}
            </p>
          ) : (
            notes.map((note) => (
              <Link
                key={note.id}
                href={href({ note: note.id })}
                className="bsp-nts-item"
                aria-current={chosen?.id === note.id ? 'true' : undefined}
                data-testid={`my-note-${note.id}`}
              >
                {note.pinnedAt || note.reminder ? (
                  <span className="bsp-nts-tags">
                    {note.pinnedAt ? (
                      <span className="bsp-pill bsp-p-neu">{t('myNotes.pinned')}</span>
                    ) : null}
                    {reminderPill(note)}
                  </span>
                ) : null}
                <span className="bsp-nts-subject" dir="auto">
                  {titleOf(note)}
                </span>
                {note.body ? (
                  <span className="bsp-nts-last" dir="auto">
                    {note.title ? note.body : note.body.split('\n').slice(1).join(' ')}
                  </span>
                ) : null}
              </Link>
            ))
          )}
          {total !== null && total > notes.length ? (
            <p className="bsp-nts-none">
              {t('myNotes.matching')
                .replace('{shown}', String(notes.length))
                .replace('{total}', String(total))}
            </p>
          ) : null}
        </section>

        {creating || chosen ? (
          <section
            className="bsp-card bsp-nts-th"
            data-testid={chosen ? `my-note-pane-${chosen.id}` : 'my-note-new'}
          >
            {chosen ? (
              <div className="bsp-nts-head">
                <span className="bsp-nts-head-t">
                  <span className="bsp-nts-kind">{t('myNotes.tab.mine')}</span>
                  <span className="bsp-nts-title" dir="auto">
                    {titleOf(chosen)}
                  </span>
                </span>
                {reminderPill(chosen)}
                <form action={pinPersonalNoteAction}>
                  {hidden(chosen)}
                  <input type="hidden" name="pinned" value={String(!chosen.pinnedAt)} />
                  <SubmitButton
                    className="bsp-btn bsp-sm bsp-sec"
                    data-testid={`my-note-pin-${chosen.id}`}
                  >
                    {t(chosen.pinnedAt ? 'myNotes.unpin' : 'myNotes.pin')}
                  </SubmitButton>
                </form>
              </div>
            ) : (
              <div className="bsp-nts-head">
                <span className="bsp-nts-head-t">
                  <span className="bsp-nts-kind">{t('myNotes.tab.mine')}</span>
                  <span className="bsp-nts-title">{t('myNotes.new')}</span>
                </span>
              </div>
            )}

            <form
              action={savePersonalNoteAction}
              className="bsp-pn-editor"
              key={chosen?.id ?? 'new'}
              data-testid="my-note-form"
            >
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="noteId" value={chosen?.id ?? ''} />
              <label className="bsp-lbl" htmlFor="my-note-title">
                {t('myNotes.titleLabel')}
              </label>
              <input
                id="my-note-title"
                name="title"
                maxLength={200}
                dir="auto"
                defaultValue={chosen?.title ?? ''}
                className="bs-control"
                data-testid="my-note-title"
              />
              <label className="bsp-lbl" htmlFor="my-note-body">
                {t('myNotes.bodyLabel')}
              </label>
              <textarea
                id="my-note-body"
                name="body"
                maxLength={20_000}
                dir="auto"
                rows={8}
                defaultValue={chosen?.body ?? ''}
                className="bs-control bsp-pn-body"
                data-testid="my-note-body"
              />
              <div className="bsp-nts-bar">
                <span className="bsp-nts-hint">{t('myNotes.private')}</span>
                <SubmitButton className="bsp-btn bsp-sm bsp-pur" data-testid="my-note-save">
                  {t('myNotes.save')}
                </SubmitButton>
              </div>
            </form>

            {chosen ? (
              <>
                <div className="bsp-pn-reminder" data-testid={`my-note-reminder-${chosen.id}`}>
                  <form action={setPersonalReminderAction} className="bsp-nts-opt">
                    {hidden(chosen)}
                    <BrowserTimeZoneInput name="timeZone" testId="my-note-zone" />
                    <label className="bsp-lbl" htmlFor="my-note-remind-at">
                      {t('myNotes.reminder.label')}
                    </label>
                    <span className="bsp-nts-bar">
                      <input
                        id="my-note-remind-at"
                        type="datetime-local"
                        name="remindAt"
                        required
                        defaultValue={
                          chosen.reminder && chosen.reminder.state === 'PENDING'
                            ? formatLocalTime(chosen.reminder.remindAt, chosen.reminder.timeZone)
                            : ''
                        }
                        className="bs-control"
                        data-testid="my-note-remind-at"
                      />
                      <SubmitButton
                        className="bsp-btn bsp-sm bsp-sec"
                        data-testid="my-note-remind-set"
                      >
                        {t('myNotes.reminder.set')}
                      </SubmitButton>
                    </span>
                    <span className="bsp-nts-hint">{t('myNotes.reminder.hint')}</span>
                  </form>
                  {chosen.reminder ? (
                    <div className="bsp-nts-bar">
                      {chosen.reminder.state !== 'DONE' ? (
                        <>
                          <form action={snoozePersonalReminderAction}>
                            {hidden(chosen)}
                            <input type="hidden" name="until" value="hour" />
                            <SubmitButton
                              className="bsp-btn bsp-sm bsp-ghost"
                              data-testid="my-note-snooze-hour"
                            >
                              {t('myNotes.reminder.snoozeHour')}
                            </SubmitButton>
                          </form>
                          <form action={snoozePersonalReminderAction}>
                            {hidden(chosen)}
                            <input type="hidden" name="until" value="tomorrow" />
                            <SubmitButton
                              className="bsp-btn bsp-sm bsp-ghost"
                              data-testid="my-note-snooze-tomorrow"
                            >
                              {t('myNotes.reminder.snoozeTomorrow')}
                            </SubmitButton>
                          </form>
                          <form action={markPersonalReminderDoneAction}>
                            {hidden(chosen)}
                            <SubmitButton
                              className="bsp-btn bsp-sm bsp-ghost"
                              data-testid="my-note-done"
                            >
                              {t('myNotes.reminder.markDone')}
                            </SubmitButton>
                          </form>
                        </>
                      ) : null}
                      <form action={clearPersonalReminderAction}>
                        {hidden(chosen)}
                        <SubmitButton
                          className="bsp-btn bsp-sm bsp-ghost"
                          data-testid="my-note-remind-clear"
                        >
                          {t('myNotes.reminder.clear')}
                        </SubmitButton>
                      </form>
                    </div>
                  ) : null}
                </div>
                <form action={deletePersonalNoteAction} className="bsp-nts-bar">
                  {hidden(chosen)}
                  <span className="bsp-nts-hint" />
                  <SubmitButton
                    className="bsp-btn bsp-sm bsp-ghost bsp-pn-delete"
                    data-testid={`my-note-delete-${chosen.id}`}
                  >
                    {t('myNotes.delete')}
                  </SubmitButton>
                </form>
              </>
            ) : null}
          </section>
        ) : null}
      </div>
    </>
  );
}
