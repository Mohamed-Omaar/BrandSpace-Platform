import Link from 'next/link';
import { initialsFrom } from '@brandspace/ui';
import {
  NOTE_MANAGE_PERMISSION,
  NotesService,
  type NoteInboxEntry,
  type NoteSubject,
} from '@brandspace/collaboration';
import { systemClock } from '@brandspace/shared';
import { inWorkspace, requireWorkspacePage } from '../../../server/customer-context';
import { NoAccessPage } from '../../../components/no-access-page';
import { brandContextFor } from '../../../server/brand-context';
import { inNotes, mentionableMembers } from '../../../server/notes-context';
import { MentionField } from '../../../components/mention-field';
import { MoreDisclosure } from '../../../components/more-disclosure';
import {
  assignNoteThreadAction,
  markNoteMentionsReadAction,
  reopenNoteThreadAction,
  replyToNoteThreadAction,
  resolveNoteThreadAction,
  setNoteDueAction,
  setNoteImportanceAction,
} from '../notes-actions';
import { relativeTime } from '../../../server/home';
import { noteThreadHref } from '../../../server/note-links';
import { translator, type MessageKey } from '../../../i18n/messages';
import { WorkspaceShell } from '../../../components/workspace-shell';

export const dynamic = 'force-dynamic';

/**
 * NOTES — the conversations that concern the reader, across the product (P6-16).
 *
 * THE TOP BAR'S NOTES ENTRY LANDS HERE, and this page is a READING of the
 * existing collaboration domain rather than a second one. Threads stay attached
 * to the content item, campaign or brand they are about; each row here links
 * back to that subject, where the conversation continues and where a mention
 * is marked read. Nothing is written from this page.
 *
 * SCOPE: the Notes permission (the same one every notes read asks), the
 * member's brand scope, and — because the route is `brand-or-all` — the rail's
 * brand when one is selected, INTERSECTED with the scope (`NotesService.inbox`).
 *
 * DESIGN-SYSTEM EXTENSION (CLAUDE.md §4.2): the IDENTICAL composition
 * `/notifications` uses — `Card`, `SectionHeader`, `StateMessage`,
 * `StatusBadge`, the same list rows and the same inline-start mark for unread —
 * so the two inboxes read as one design.
 */
export default async function NotesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const access = await requireWorkspacePage(locale, '/notes');
  const { messageLocale } = access.session;
  const t = translator(messageLocale);
  if (!access.allowed) return <NoAccessPage locale={locale} access={access} />;
  const { customer, workspace } = access.session;

  const brandContext = await brandContextFor(
    workspace,
    '/notes',
    typeof query['brand'] === 'string' ? query['brand'] : null,
  );
  const brandId =
    brandContext.resolution.kind === 'brand' ? brandContext.resolution.brand.id : null;

  const inbox = await inWorkspace(workspace.workspaceId, async ({ db }) =>
    new NotesService({ db, workspaceId: workspace.workspaceId, clock: systemClock }).inbox(
      {
        userId: customer.userId,
        permissionKeys: workspace.permissionKeys,
        brandScope: workspace.brandScope,
      },
      { brandId },
    ),
  );
  const members = await mentionableMembers(locale);
  const nameOf = (userId: string): string =>
    members.find((member) => member.userId === userId)?.name ?? t('notes.someone');
  const toneOf = (userId: string): number =>
    Math.max(
      0,
      members.findIndex((member) => member.userId === userId),
    ) % 4;

  /*
   * ROUND 4, GATE 2b — THE PROTOTYPE'S NOTES (`Main.dc.html` lines 927–973):
   * two panes — the conversations, grouped ("For you", "Other open"), and the
   * chosen one's thread. The chosen thread is `?thread=`, else the first
   * listed; the inbox only lists what this member may read, so a `?thread=`
   * that is not in it opens nothing (no hint that it exists).
   */
  const listed = [...inbox.forYou, ...inbox.open];
  const requested = typeof query['thread'] === 'string' ? query['thread'] : null;
  const chosen = listed.find((entry) => entry.threadId === requested) ?? listed[0] ?? null;

  const subjectOf = (entry: NoteInboxEntry): NoteSubject =>
    entry.subjectType === 'CONTENT_ITEM' && entry.contentItemId
      ? { type: 'CONTENT_ITEM', contentItemId: entry.contentItemId }
      : entry.subjectType === 'CAMPAIGN' && entry.campaignId
        ? { type: 'CAMPAIGN', campaignId: entry.campaignId }
        : entry.subjectType === 'ASSET' && entry.assetId
          ? { type: 'ASSET', assetId: entry.assetId, brandId: entry.brandId }
          : { type: 'BRAND', brandId: entry.brandId };

  const pane = chosen
    ? await inNotes(locale, async ({ service, actor }) => {
        const subject = subjectOf(chosen);
        const thread = (await service.threadsFor(subject, actor)).find(
          (candidate) => candidate.id === chosen.threadId,
        );
        if (!thread) return null;
        return {
          thread,
          notes: await service.notesIn(thread.id, actor),
          candidates: await service.mentionCandidates(subject, actor),
          mayManage: actor.permissionKeys.includes(NOTE_MANAGE_PERMISSION),
        };
      }).catch(() => null)
    : null;

  /** Where the conversation lives — the subject's own screen, the thread highlighted. */
  const subjectHref = (entry: NoteInboxEntry): string => noteThreadHref(locale, entry);
  const returnPath = chosen ? `/${locale}/notes?thread=${chosen.threadId}` : `/${locale}/notes`;
  const now = systemClock.now();

  const item = (entry: NoteInboxEntry) => (
    <Link
      key={entry.threadId}
      href={`/${locale}/notes?thread=${entry.threadId}`}
      className="bsp-nts-item"
      aria-current={chosen?.threadId === entry.threadId ? 'true' : undefined}
      data-testid={`notes-thread-${entry.threadId}`}
      data-unread={String(entry.unreadMentions)}
    >
      <span className="bsp-nts-tags">
        <span className={entry.reason === 'open' ? 'bsp-pill bsp-p-neu' : 'bsp-pill bsp-p-ai'}>
          {entry.reason === 'open'
            ? t(`notesInbox.subject.${entry.subjectType}` as MessageKey)
            : t(`notesInbox.reason.${entry.reason}` as MessageKey)}
        </span>
        {entry.unreadMentions > 0 ? (
          <span
            className="bsp-nts-dot"
            role="img"
            aria-label={t('notesInbox.unread').replace('{count}', String(entry.unreadMentions))}
          />
        ) : null}
        {entry.status === 'RESOLVED' ? (
          <span className="bsp-pill bsp-p-ok">{t('notes.resolved')}</span>
        ) : null}
      </span>
      <span className="bsp-nts-subject">{entry.subjectTitle ?? entry.brandName}</span>
      <span className="bsp-nts-last" dir="auto">
        {entry.lastNote
          ? `${nameOf(entry.lastNote.authorUserId)}: ${entry.lastNote.body}`
          : entry.brandName}
      </span>
    </Link>
  );

  const thread = pane?.thread ?? null;
  const replyFormId = thread ? `notes-reply-${thread.id}` : 'notes-reply';
  const hidden = thread ? (
    <>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="threadId" value={thread.id} />
      <input type="hidden" name="returnPath" value={returnPath} />
    </>
  ) : null;

  return (
    <WorkspaceShell
      brandContext={brandContext}
      locale={locale}
      heading={t('notes.title')}
      description={t('notesInbox.description')}
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      {listed.length === 0 ? (
        <section className="bsp-card bsp-nts-empty" data-testid="notes-for-you">
          <span className="bsp-xicon" aria-hidden="true">
            💬
          </span>
          <b className="bsp-nts-empty-t">{t('notesInbox.forYouEmpty')}</b>
          <span className="bsp-nts-empty-s">{t('notesInbox.othersEmpty')}</span>
          <Link href={`/${locale}/content`} className="bsp-btn bsp-sec">
            {t('content.title')}
          </Link>
        </section>
      ) : (
        <div className="bsp-nts">
          <section className="bsp-card bsp-nts-list">
            <div data-testid="notes-for-you">
              <div className="bsp-lbl bsp-nts-g">{t('notesInbox.forYou')}</div>
              {inbox.forYou.length === 0 ? (
                <p className="bsp-nts-none">{t('notesInbox.forYouEmpty')}</p>
              ) : (
                inbox.forYou.map(item)
              )}
            </div>
            <div data-testid="notes-open">
              <div className="bsp-lbl bsp-nts-g">{t('notesInbox.others')}</div>
              {inbox.open.length === 0 ? (
                <p className="bsp-nts-none">{t('notesInbox.othersEmpty')}</p>
              ) : (
                inbox.open.map(item)
              )}
            </div>
          </section>

          {chosen && thread && pane ? (
            <section className="bsp-card bsp-nts-th" data-testid={`notes-pane-${thread.id}`}>
              <div className="bsp-nts-head">
                <span className="bsp-nts-head-t">
                  <span className="bsp-nts-kind">
                    {t(`notesInbox.subject.${chosen.subjectType}` as MessageKey)}
                    {chosen.subjectTitle ? ` · ${chosen.brandName}` : ''}
                  </span>
                  <span className="bsp-nts-title">{chosen.subjectTitle ?? chosen.brandName}</span>
                </span>
                {thread.importance === 'IMPORTANT' ? (
                  <span className="bsp-pill bsp-p-bad" data-testid={`note-important-${thread.id}`}>
                    {t('notes.important')}
                  </span>
                ) : null}
                {thread.assignedToUserId ? (
                  <span className="bsp-pill bsp-p-neu">
                    {t('notes.waitingOn').replace('{name}', nameOf(thread.assignedToUserId))}
                  </span>
                ) : null}
                <Link
                  href={subjectHref(chosen)}
                  className="bsp-btn bsp-sm bsp-sec"
                  data-testid={`notes-open-${chosen.threadId}`}
                >
                  {t('notesInbox.openSubject')}
                </Link>
                {pane.mayManage ? (
                  <form
                    action={
                      thread.status === 'RESOLVED'
                        ? reopenNoteThreadAction
                        : resolveNoteThreadAction
                    }
                  >
                    {hidden}
                    <button
                      type="submit"
                      className="bsp-btn bsp-sm"
                      data-testid={`note-${thread.status === 'RESOLVED' ? 'reopen' : 'resolve'}-${thread.id}`}
                    >
                      {t(thread.status === 'RESOLVED' ? 'notes.reopen' : 'notes.resolve')}
                    </button>
                  </form>
                ) : null}
                {/* The product's other thread controls, behind the pane's "⋯". */}
                <MoreDisclosure
                  label={t('notes.options')}
                  testId={`note-options-${thread.id}`}
                  align="end"
                >
                  <div className="bsp-nts-opts">
                    {pane.mayManage ? (
                      <>
                        <form action={assignNoteThreadAction} className="bsp-nts-opt">
                          {hidden}
                          <label htmlFor={`assign-${thread.id}`} className="bsp-lbl">
                            {t('notes.assignLabel')}
                          </label>
                          <select
                            id={`assign-${thread.id}`}
                            name="assignedToUserId"
                            defaultValue={thread.assignedToUserId ?? ''}
                            className="bs-control bs-select"
                            data-testid={`note-assign-${thread.id}`}
                          >
                            <option value="">{t('notes.nobody')}</option>
                            {pane.candidates.map((member) => (
                              <option key={member.userId} value={member.userId}>
                                {member.name}
                              </option>
                            ))}
                          </select>
                          <button type="submit" className="bsp-btn bsp-sm bsp-sec">
                            {t('notes.save')}
                          </button>
                        </form>
                        <form action={setNoteDueAction} className="bsp-nts-opt">
                          {hidden}
                          <label htmlFor={`due-${thread.id}`} className="bsp-lbl">
                            {t('notes.dueLabel')}
                          </label>
                          <input
                            id={`due-${thread.id}`}
                            type="date"
                            name="dueAt"
                            defaultValue={
                              thread.dueAt ? thread.dueAt.toISOString().slice(0, 10) : ''
                            }
                            className="bs-control"
                            data-testid={`note-due-input-${thread.id}`}
                          />
                          <button type="submit" className="bsp-btn bsp-sm bsp-sec">
                            {t('notes.save')}
                          </button>
                        </form>
                      </>
                    ) : null}
                    {/*
                      MARKING READ IS AN ACT, NOT A SIDE EFFECT OF RENDERING:
                      opening the thread here does not clear the count.
                    */}
                    <form action={markNoteMentionsReadAction}>
                      {hidden}
                      <button
                        type="submit"
                        className="bsp-btn bsp-sm bsp-ghost"
                        data-testid={`note-mark-read-${thread.id}`}
                      >
                        {t('notes.markRead')}
                      </button>
                    </form>
                  </div>
                </MoreDisclosure>
              </div>

              <ol className="bsp-nts-msgs">
                {pane.notes.map((note) => {
                  const who = nameOf(note.authorUserId);
                  return (
                    <li key={note.id} className="bsp-nts-msg" data-testid={`note-${note.id}`}>
                      <span
                        aria-hidden="true"
                        className="bsp-tm-av bsp-nts-av"
                        data-c={toneOf(note.authorUserId)}
                      >
                        {initialsFrom(who)}
                      </span>
                      <div className="bsp-nts-msg-b">
                        <span className="bsp-nts-who">
                          <b>{who}</b>{' '}
                          <span className="bsp-nts-when">
                            ·{' '}
                            <time dateTime={note.createdAt.toISOString()}>
                              {relativeTime(note.createdAt, now, locale)}
                            </time>
                          </span>
                        </span>
                        <div className="bsp-nts-text" dir="auto">
                          {note.body}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>

              {thread.status === 'RESOLVED' && !pane.mayManage ? null : (
                <div className="bsp-nts-compose">
                  <form
                    action={replyToNoteThreadAction}
                    id={replyFormId}
                    data-testid={`note-reply-form-${thread.id}`}
                  >
                    {hidden}
                    <MentionField
                      id={`reply-${thread.id}`}
                      name="body"
                      multiline
                      required
                      label={t('notes.replyLabel')}
                      placeholder={t('notes.replyPlaceholder')}
                      suggestionsLabel={t('notes.mentionSuggestions')}
                      members={pane.candidates}
                      testId={`note-reply-${thread.id}`}
                    />
                  </form>
                  <div className="bsp-nts-bar">
                    {pane.mayManage ? (
                      <form action={setNoteImportanceAction}>
                        {hidden}
                        <input
                          type="hidden"
                          name="importance"
                          value={thread.importance === 'IMPORTANT' ? 'NORMAL' : 'IMPORTANT'}
                        />
                        <button
                          type="submit"
                          className="bsp-btn bsp-sm bsp-ghost"
                          data-testid={`note-importance-${thread.id}`}
                        >
                          {t(
                            thread.importance === 'IMPORTANT'
                              ? 'notes.markNormal'
                              : 'notes.important',
                          )}
                        </button>
                      </form>
                    ) : null}
                    <span className="bsp-nts-hint">{t('notes.mentionHint')}</span>
                    <button
                      type="submit"
                      form={replyFormId}
                      className="bsp-btn bsp-sm bsp-pur"
                      data-testid={`note-reply-submit-${thread.id}`}
                    >
                      {t('notes.reply')}
                    </button>
                  </div>
                </div>
              )}
            </section>
          ) : null}
        </div>
      )}
    </WorkspaceShell>
  );
}
