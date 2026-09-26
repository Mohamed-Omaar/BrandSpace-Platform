import {
  Card,
  SectionHeader,
  StateMessage,
  StatusBadge,
  buttonClass,
  buttonStyle,
  colorTokens,
  inputStyle,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import {
  NOTE_MANAGE_PERMISSION,
  type NoteSubject,
  type NoteThreadSummary,
} from '@brandspace/collaboration';
import { systemClock } from '@brandspace/shared';
import { inNotes, mentionableMembers } from '../server/notes-context';
import { relativeTime } from '../server/home';
import { MentionField } from './mention-field';
import { translator, type MessageKey } from '../i18n/messages';
import {
  assignNoteThreadAction,
  markNoteMentionsReadAction,
  replyToNoteThreadAction,
  reopenNoteThreadAction,
  resolveNoteThreadAction,
  setNoteDueAction,
  setNoteImportanceAction,
  startNoteThreadAction,
} from '../app/[locale]/notes-actions';

/**
 * CONTEXTUAL COLLABORATION, RENDERED WHERE THE WORK IS (P6-05).
 *
 * The conversation lives on the thing it is about — a draft, a campaign, a
 * brand — rather than in a separate inbox somebody has to correlate by hand.
 * That is the whole reason notes exist as their own capability instead of being
 * a chat integration.
 *
 * NO NEW VISUAL LANGUAGE (CLAUDE.md §4.2 rule 5). It composes `Card`,
 * `SectionHeader`, `StatusBadge`, `buttonStyle`/`buttonClass`, `inputStyle` and
 * `textareaStyle` — the same primitives every other surface uses. There is no
 * drawer, no modal and no new overlay: a conversation about a draft belongs
 * beside the draft, and an overlay would put it on top of the work it is about.
 *
 * A SERVER COMPONENT, deliberately. Every read is already permission- and
 * brand-scoped by the service, and the forms are plain server actions — so the
 * panel needs no client JavaScript to post a note, which means it works before
 * hydration and on a locked-down browser.
 *
 * MENTIONS ARE A REAL TYPEAHEAD (D-277 §28): "@Sa" offers "Sara" from the
 * same active-member population the service accepts (`MentionField`). Without
 * script the native multiple select is still there, inside `<noscript>`.
 *
 * D-281: a thread shows who is talking (avatar, name, relative time), whether
 * it is Important, when it is due and who it waits on — and a deep link
 * (`?thread=`, `#thread-…`) opens the page with THAT conversation highlighted.
 */

export async function NotesPanel({
  locale,
  subject,
  returnPath,
  title,
  highlightThreadId = null,
}: {
  readonly locale: string;
  readonly subject: NoteSubject;
  /** Where to refresh after a post. The page this panel is on. */
  readonly returnPath: string;
  readonly title?: string | undefined;
  /** A deep link's target thread, drawn highlighted (D-281). */
  readonly highlightThreadId?: string | null | undefined;
}) {
  const t = translator(locale);

  /*
   * A PANEL THAT CANNOT READ ITS THREADS RENDERS NOTHING AT ALL.
   *
   * The service answers 404 for a subject outside this member's brand scope or
   * for a member without the collaboration permission — identically to a
   * subject that does not exist. Showing an empty conversation in that case
   * would say "there is nothing here", which is a different and wrong claim.
   */
  let threads;
  let members;
  let mayManage = false;
  try {
    threads = await inNotes(locale, async ({ service, actor }) => {
      // Q12 — whether this member may run a conversation or only take part.
      mayManage = actor.permissionKeys.includes(NOTE_MANAGE_PERMISSION);
      return service.threadsFor(subject, actor);
    });
    members = await mentionableMembers(locale);
  } catch {
    return null;
  }

  const subjectId =
    subject.type === 'CONTENT_ITEM'
      ? subject.contentItemId
      : subject.type === 'CAMPAIGN'
        ? subject.campaignId
        : subject.type === 'ASSET'
          ? subject.assetId
          : subject.brandId;

  return (
    <Card testId="notes-panel">
      <SectionHeader title={title ?? t('notes.title')} />

      {threads.length === 0 ? (
        <StateMessage title={t('notes.emptyTitle')} description={t('notes.emptyBody')} />
      ) : (
        <ul
          data-testid="notes-threads"
          style={{
            margin: 0,
            padding: 0,
            listStyle: 'none',
            display: 'grid',
            gap: spacingTokens.md,
          }}
        >
          {threads.map((thread) => (
            <NoteThread
              key={thread.id}
              locale={locale}
              thread={thread}
              returnPath={returnPath}
              members={members}
              highlighted={thread.id === highlightThreadId}
              mayManage={mayManage}
            />
          ))}
        </ul>
      )}

      {/*
        THE START FORM IS ALWAYS PRESENT, including when there are threads
        already. A conversation about a different point is a different thread,
        and making somebody resolve the current one first would push unrelated
        remarks into it.
      */}
      <form
        action={startNoteThreadAction}
        data-testid="note-start-form"
        style={{ display: 'grid', gap: spacingTokens.sm, marginBlockStart: spacingTokens.lg }}
      >
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="subjectType" value={subject.type} />
        <input type="hidden" name="subjectId" value={subjectId} />
        {subject.type === 'ASSET' ? (
          <input type="hidden" name="subjectBrandId" value={subject.brandId} />
        ) : null}
        <input type="hidden" name="returnPath" value={returnPath} />

        <label htmlFor="note-body" style={{ ...typographyTokens.caption, fontWeight: 800 }}>
          {t('notes.newLabel')}
        </label>
        <MentionField
          id="note-body"
          name="body"
          multiline
          required
          placeholder={t('notes.placeholderMention')}
          suggestionsLabel={t('notes.mentionSuggestions')}
          members={members}
          testId="note-body"
        />
        <noscript>
          <MentionPicker locale={locale} members={members} id="note-mentions" />
        </noscript>

        <div>
          <button
            type="submit"
            data-testid="note-submit"
            className={buttonClass('primary')}
            style={buttonStyle('primary', 'sm')}
          >
            {t('notes.post')}
          </button>
        </div>
      </form>
    </Card>
  );
}

/** One conversation: its messages, a reply box, and resolve/reopen. */
async function NoteThread({
  locale,
  thread,
  returnPath,
  members,
  highlighted,
  mayManage,
}: {
  readonly locale: string;
  readonly thread: NoteThreadSummary;
  readonly returnPath: string;
  readonly members: readonly { readonly userId: string; readonly name: string }[];
  readonly highlighted: boolean;
  /**
   * Q12 — `notes.manage`: resolve, reopen, assign, due date, importance, and
   * replying to a resolved thread (which reopens it). Without it the member
   * may still reply to an open thread and mark their mentions read.
   */
  readonly mayManage: boolean;
}) {
  const t = translator(locale);
  const threadId = thread.id;
  const status = thread.status;
  const now = systemClock.now();
  const dayFormat = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en-GB', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  });
  const hidden = (
    <>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="threadId" value={threadId} />
      <input type="hidden" name="returnPath" value={returnPath} />
    </>
  );
  const notes = await inNotes(locale, ({ service, actor }) => service.notesIn(threadId, actor));
  const names = new Map(members.map((member) => [member.userId, member.name]));
  const assignee = thread.assignedToUserId ? names.get(thread.assignedToUserId) : null;
  const overdue = thread.dueAt !== null && status === 'OPEN' && thread.dueAt < now;

  return (
    <li
      id={`thread-${threadId}`}
      data-testid={`note-thread-${threadId}`}
      data-status={status}
      data-importance={thread.importance}
      data-highlighted={highlighted ? 'true' : undefined}
      style={{
        border: `1px solid ${highlighted ? colorTokens.brandPurpleBorder : colorTokens.hairline}`,
        background: highlighted ? colorTokens.surfaceLavender : 'transparent',
        borderRadius: '0.875rem',
        padding: spacingTokens.md,
        display: 'grid',
        gap: spacingTokens.sm,
        scrollMarginBlockStart: '6rem',
      }}
    >
      <div
        style={{ display: 'flex', alignItems: 'center', gap: spacingTokens.sm, flexWrap: 'wrap' }}
      >
        <StatusBadge
          tone={status === 'RESOLVED' ? 'success' : 'info'}
          label={t(status === 'RESOLVED' ? 'notes.resolved' : 'notes.open')}
        />
        {thread.importance === 'IMPORTANT' ? (
          <StatusBadge
            tone="accent"
            label={t('notes.important')}
            dot
            testId={`note-important-${threadId}`}
          />
        ) : null}
        {thread.dueAt ? (
          <StatusBadge
            tone={overdue ? 'danger' : 'neutral'}
            label={t(overdue ? 'notes.overdue' : 'notes.due').replace(
              '{date}',
              dayFormat.format(thread.dueAt),
            )}
            testId={`note-due-${threadId}`}
          />
        ) : null}
        {assignee ? (
          <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
            {t('notes.waitingOn').replace('{name}', assignee)}
          </span>
        ) : null}
      </div>

      <ol
        style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: spacingTokens.sm }}
      >
        {notes.map((note) => (
          <li
            key={note.id}
            data-testid={`note-${note.id}`}
            style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: spacingTokens.sm }}
          >
            <span aria-hidden="true" style={avatarStyle}>
              {(names.get(note.authorUserId) ?? '?').slice(0, 1).toUpperCase()}
            </span>
            <div style={{ display: 'grid', gap: spacingTokens['3xs'], minInlineSize: 0 }}>
              <p
                style={{
                  margin: 0,
                  ...typographyTokens.caption,
                  color: colorTokens.textSecondary,
                }}
              >
                {/* The author by name, and when. An id here would be unreadable. */}
                <strong style={{ color: colorTokens.textPrimary }}>
                  {names.get(note.authorUserId) ?? t('notes.someone')}
                </strong>{' '}
                ·{' '}
                <time dateTime={note.createdAt.toISOString()}>
                  {relativeTime(note.createdAt, now, locale)}
                </time>
              </p>
              <p
                dir="auto"
                style={{ margin: 0, ...typographyTokens.body, overflowWrap: 'anywhere' }}
              >
                {note.body}
              </p>
              {note.mentionedUserIds.length > 0 ? (
                <p
                  style={{
                    margin: 0,
                    ...typographyTokens.caption,
                    color: colorTokens.textSecondary,
                  }}
                  data-testid={`note-mentions-${note.id}`}
                >
                  {t('notes.mentioned')}{' '}
                  {note.mentionedUserIds
                    .map((id) => names.get(id) ?? t('notes.someone'))
                    .join('، ')}
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>

      {status === 'RESOLVED' && !mayManage ? null : (
        <form
          action={replyToNoteThreadAction}
          style={{ display: 'grid', gap: spacingTokens.xs }}
          data-testid={`note-reply-form-${threadId}`}
        >
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="threadId" value={threadId} />
          <input type="hidden" name="returnPath" value={returnPath} />
          <label htmlFor={`reply-${threadId}`} className="bs-sr-only">
            {t('notes.replyLabel')}
          </label>
          <MentionField
            id={`reply-${threadId}`}
            name="body"
            multiline={false}
            required
            placeholder={t('notes.replyPlaceholder')}
            suggestionsLabel={t('notes.mentionSuggestions')}
            members={members}
            testId={`note-reply-${threadId}`}
          />
          <noscript>
            <MentionPicker locale={locale} members={members} id={`reply-mentions-${threadId}`} />
          </noscript>
          <div style={{ display: 'flex', gap: spacingTokens.xs, flexWrap: 'wrap' }}>
            <button
              type="submit"
              className={buttonClass('neutral')}
              style={buttonStyle('neutral', 'sm')}
              data-testid={`note-reply-submit-${threadId}`}
            >
              {t('notes.reply')}
            </button>
          </div>
        </form>
      )}

      <div style={{ display: 'flex', gap: spacingTokens.xs, flexWrap: 'wrap' }}>
        {mayManage ? (
          <form action={status === 'RESOLVED' ? reopenNoteThreadAction : resolveNoteThreadAction}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="threadId" value={threadId} />
            <input type="hidden" name="returnPath" value={returnPath} />
            <button
              type="submit"
              className={buttonClass('ghost')}
              style={buttonStyle('ghost', 'sm')}
              data-testid={`note-${status === 'RESOLVED' ? 'reopen' : 'resolve'}-${threadId}`}
            >
              {t(status === 'RESOLVED' ? 'notes.reopen' : 'notes.resolve')}
            </button>
          </form>
        ) : null}

        {/*
          MARKING READ IS AN ACT, NOT A SIDE EFFECT OF RENDERING. Clearing
          somebody's unread count because a page loaded — including one they
          scrolled past — would make the Command Center quietly wrong about what
          still needs them.
        */}
        <form action={markNoteMentionsReadAction}>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="threadId" value={threadId} />
          <input type="hidden" name="returnPath" value={returnPath} />
          <button
            type="submit"
            className={buttonClass('ghost')}
            style={buttonStyle('ghost', 'sm')}
            data-testid={`note-mark-read-${threadId}`}
          >
            {t('notes.markRead')}
          </button>
        </form>
      </div>

      {/*
        WHO IT WAITS ON, WHEN, AND HOW MUCH IT MATTERS (D-281) — three small
        forms behind one native disclosure, so the thread stays a conversation
        and not a task card. Each is the service's own rule; no workflow sits
        behind them.
      */}
      {mayManage ? (
        <details data-testid={`note-options-${threadId}`}>
          <summary style={{ cursor: 'pointer', ...typographyTokens.caption, fontWeight: 700 }}>
            {t('notes.options')}
          </summary>
          <div
            style={{ display: 'grid', gap: spacingTokens.sm, marginBlockStart: spacingTokens.sm }}
          >
            <form action={assignNoteThreadAction} style={optionRowStyle}>
              {hidden}
              <label htmlFor={`assign-${threadId}`} style={optionLabelStyle}>
                {t('notes.assignLabel')}
              </label>
              <select
                id={`assign-${threadId}`}
                name="assignedToUserId"
                defaultValue={thread.assignedToUserId ?? ''}
                className="bs-control bs-select"
                style={inputStyle({ size: 'sm' })}
                data-testid={`note-assign-${threadId}`}
              >
                <option value="">{t('notes.nobody')}</option>
                {members.map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {member.name}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className={buttonClass('neutral')}
                style={buttonStyle('neutral', 'sm')}
              >
                {t('notes.save')}
              </button>
            </form>
            <form action={setNoteDueAction} style={optionRowStyle}>
              {hidden}
              <label htmlFor={`due-${threadId}`} style={optionLabelStyle}>
                {t('notes.dueLabel')}
              </label>
              <input
                id={`due-${threadId}`}
                type="date"
                name="dueAt"
                defaultValue={thread.dueAt ? thread.dueAt.toISOString().slice(0, 10) : ''}
                className="bs-control"
                style={inputStyle({ size: 'sm' })}
                data-testid={`note-due-input-${threadId}`}
              />
              <button
                type="submit"
                className={buttonClass('neutral')}
                style={buttonStyle('neutral', 'sm')}
                data-testid={`note-due-save-${threadId}`}
              >
                {t('notes.save')}
              </button>
            </form>
            <form action={setNoteImportanceAction} style={optionRowStyle}>
              {hidden}
              <input
                type="hidden"
                name="importance"
                value={thread.importance === 'IMPORTANT' ? 'NORMAL' : 'IMPORTANT'}
              />
              <button
                type="submit"
                className={buttonClass('neutral')}
                style={buttonStyle('neutral', 'sm')}
                data-testid={`note-importance-${threadId}`}
              >
                {t(thread.importance === 'IMPORTANT' ? 'notes.markNormal' : 'notes.markImportant')}
              </button>
            </form>
          </div>
        </details>
      ) : null}
    </li>
  );
}

const avatarStyle = {
  display: 'inline-grid',
  placeItems: 'center',
  inlineSize: '1.75rem',
  blockSize: '1.75rem',
  borderRadius: '50%',
  background: colorTokens.surfaceLavenderStrong,
  color: colorTokens.brandPurplePressed,
  ...typographyTokens.caption,
  fontWeight: 700,
} as const;

const optionRowStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: spacingTokens.xs,
} as const;

const optionLabelStyle = {
  ...typographyTokens.caption,
  color: colorTokens.textSecondary,
  minInlineSize: '6rem',
} as const;

/**
 * Who this note is addressed to.
 *
 * A NATIVE `multiple` SELECT: it shows exactly the population the service will
 * accept, needs no client bundle, is keyboard operable, and carries the global
 * chevron and focus treatment P6-02 gave every select. The label is visible
 * rather than a placeholder, for the reason `Field` states — a placeholder
 * disappears the moment somebody types.
 */
function MentionPicker({
  locale,
  members,
  id,
}: {
  readonly locale: string;
  readonly members: readonly { readonly userId: string; readonly name: string }[];
  readonly id: string;
}) {
  const t = translator(locale);
  if (members.length === 0) return null;
  return (
    <div style={{ display: 'grid', gap: spacingTokens['3xs'] }}>
      <label htmlFor={id} style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
        {t('notes.mentionLabel')}
      </label>
      <select
        className="bs-control"
        id={id}
        name="mentionedUserIds"
        multiple
        size={Math.min(members.length, 4)}
        data-testid={`${id}-select`}
        style={inputStyle({ size: 'sm' })}
      >
        {members.map((member) => (
          <option key={member.userId} value={member.userId}>
            {member.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The message keys this panel needs, so a missing one is a typecheck failure. */
export type NotesMessageKey = Extract<MessageKey, `notes.${string}`>;
