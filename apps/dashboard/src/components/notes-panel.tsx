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
  textareaStyle,
  typographyTokens,
} from '@brandspace/ui';
import type { NoteSubject } from '@brandspace/collaboration';
import { inNotes, mentionableMembers } from '../server/notes-context';
import { translator, type MessageKey } from '../i18n/messages';
import {
  markNoteMentionsReadAction,
  replyToNoteThreadAction,
  reopenNoteThreadAction,
  resolveNoteThreadAction,
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
 * THE MENTION PICKER IS A NATIVE MULTIPLE SELECT rather than a typeahead. It
 * shows exactly the population the service will accept, it is keyboard
 * operable, it needs no client bundle, and it cannot get out of step with what
 * the server does with the ids. A richer picker is a later refinement, not a
 * correctness question.
 */

export async function NotesPanel({
  locale,
  subject,
  returnPath,
  title,
}: {
  readonly locale: string;
  readonly subject: NoteSubject;
  /** Where to refresh after a post. The page this panel is on. */
  readonly returnPath: string;
  readonly title?: string | undefined;
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
  try {
    threads = await inNotes(locale, ({ service, actor }) => service.threadsFor(subject, actor));
    members = await mentionableMembers(locale);
  } catch {
    return null;
  }

  const subjectId =
    subject.type === 'CONTENT_ITEM'
      ? subject.contentItemId
      : subject.type === 'CAMPAIGN'
        ? subject.campaignId
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
              threadId={thread.id}
              status={thread.status}
              returnPath={returnPath}
              members={members}
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
        <input type="hidden" name="returnPath" value={returnPath} />

        <label htmlFor="note-body" style={{ ...typographyTokens.caption, fontWeight: 800 }}>
          {t('notes.newLabel')}
        </label>
        <textarea
          className="bs-control"
          id="note-body"
          name="body"
          required
          rows={3}
          placeholder={t('notes.placeholder')}
          data-testid="note-body"
          style={textareaStyle()}
        />

        <MentionPicker locale={locale} members={members} id="note-mentions" />

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
  threadId,
  status,
  returnPath,
  members,
}: {
  readonly locale: string;
  readonly threadId: string;
  readonly status: 'OPEN' | 'RESOLVED';
  readonly returnPath: string;
  readonly members: readonly { readonly userId: string; readonly name: string }[];
}) {
  const t = translator(locale);
  const notes = await inNotes(locale, ({ service, actor }) => service.notesIn(threadId, actor));
  const names = new Map(members.map((member) => [member.userId, member.name]));
  const formatter = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });

  return (
    <li
      data-testid={`note-thread-${threadId}`}
      data-status={status}
      style={{
        border: `1px solid ${colorTokens.hairline}`,
        borderRadius: '0.875rem',
        padding: spacingTokens.md,
        display: 'grid',
        gap: spacingTokens.sm,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: spacingTokens.sm }}>
        <StatusBadge
          tone={status === 'RESOLVED' ? 'success' : 'info'}
          label={t(status === 'RESOLVED' ? 'notes.resolved' : 'notes.open')}
        />
      </div>

      <ol
        style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: spacingTokens.sm }}
      >
        {notes.map((note) => (
          <li key={note.id} data-testid={`note-${note.id}`}>
            <p
              style={{
                margin: 0,
                ...typographyTokens.caption,
                color: colorTokens.textSecondary,
              }}
            >
              {/* The author by name, and when. An id here would be unreadable. */}
              {names.get(note.authorUserId) ?? t('notes.someone')} ·{' '}
              {formatter.format(note.createdAt)}
            </p>
            <p style={{ margin: 0, ...typographyTokens.body }}>{note.body}</p>
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
                {note.mentionedUserIds.map((id) => names.get(id) ?? t('notes.someone')).join('، ')}
              </p>
            ) : null}
          </li>
        ))}
      </ol>

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
        <input
          className="bs-control"
          id={`reply-${threadId}`}
          name="body"
          required
          placeholder={t('notes.replyPlaceholder')}
          data-testid={`note-reply-${threadId}`}
          style={inputStyle({ size: 'sm' })}
        />
        <MentionPicker locale={locale} members={members} id={`reply-mentions-${threadId}`} />
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

      <div style={{ display: 'flex', gap: spacingTokens.xs, flexWrap: 'wrap' }}>
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
    </li>
  );
}

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
