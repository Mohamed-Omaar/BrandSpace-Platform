import Link from 'next/link';
import {
  Card,
  SectionHeader,
  Stack,
  StateMessage,
  StatusBadge,
  buttonStyle,
  colorTokens,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import { NOTE_PERMISSION, NotesService, type NoteInboxEntry } from '@brandspace/collaboration';
import { systemClock } from '@brandspace/shared';
import { inWorkspace, requireWorkspace } from '../../../server/customer-context';
import { brandContextFor } from '../../../server/brand-context';
import { mentionableMembers } from '../../../server/notes-context';
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
  const t = translator(locale);
  const { customer, workspace } = await requireWorkspace(locale, NOTE_PERMISSION);

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

  const dateFormat = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });

  /** Where the conversation lives — the subject's own screen, the thread highlighted. */
  const subjectHref = (entry: NoteInboxEntry): string => noteThreadHref(locale, entry);

  const row = (entry: NoteInboxEntry) => (
    <li
      key={entry.threadId}
      style={entry.unreadMentions > 0 ? unreadRowStyle : rowStyle}
      data-testid={`notes-thread-${entry.threadId}`}
      data-unread={String(entry.unreadMentions)}
    >
      <div style={headRowStyle}>
        <strong style={headlineStyle}>{entry.subjectTitle ?? entry.brandName}</strong>
        <StatusBadge
          label={t(`notesInbox.subject.${entry.subjectType}` as MessageKey)}
          tone="neutral"
        />
        {entry.reason !== 'open' ? (
          <StatusBadge label={t(`notesInbox.reason.${entry.reason}` as MessageKey)} tone="accent" />
        ) : null}
        {entry.unreadMentions > 0 ? (
          <StatusBadge
            label={t('notesInbox.unread').replace('{count}', String(entry.unreadMentions))}
            tone="warning"
            dot
          />
        ) : null}
        {entry.status === 'RESOLVED' ? (
          <StatusBadge label={t('notes.resolved')} tone="success" />
        ) : null}
      </div>
      {entry.lastNote ? (
        <p style={{ ...bodyStyle, margin: 0 }} dir="auto">
          {entry.lastNote.body}
        </p>
      ) : null}
      <span style={metaStyle}>
        {entry.subjectTitle ? `${entry.brandName} · ` : ''}
        {entry.lastNote
          ? `${t('notesInbox.lastBy').replace('{author}', nameOf(entry.lastNote.authorUserId))} · `
          : ''}
        <time dateTime={entry.updatedAt.toISOString()}>{dateFormat.format(entry.updatedAt)}</time>
      </span>
      <div style={actionRowStyle}>
        <Link
          href={subjectHref(entry)}
          style={buttonStyle('ghost')}
          data-testid={`notes-open-${entry.threadId}`}
        >
          {t('notesInbox.openSubject')}
        </Link>
      </div>
    </li>
  );

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
      <Stack>
        <Card testId="notes-for-you">
          <SectionHeader title={t('notesInbox.forYou')} description={t('notesInbox.forYouHint')} />
          {inbox.forYou.length === 0 ? (
            <StateMessage title={t('notesInbox.forYouEmpty')} />
          ) : (
            <ul style={listStyle}>{inbox.forYou.map(row)}</ul>
          )}
        </Card>
        <Card testId="notes-open">
          <SectionHeader title={t('notesInbox.others')} description={t('notesInbox.othersHint')} />
          {inbox.open.length === 0 ? (
            <StateMessage title={t('notesInbox.othersEmpty')} />
          ) : (
            <ul style={listStyle}>{inbox.open.map(row)}</ul>
          )}
        </Card>
      </Stack>
    </WorkspaceShell>
  );
}

/* The same row styles `/notifications` uses, so the two inboxes are one design. */
const listStyle = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'grid',
  gap: spacingTokens.sm,
} as const;

const rowStyle = {
  display: 'grid',
  gap: spacingTokens['3xs'],
  paddingBlock: spacingTokens.sm,
  borderBlockEnd: `1px solid ${colorTokens.border}`,
} as const;

/* Unread is an inline-start border AND a badge carrying the word (WCAG 1.4.1). */
const unreadRowStyle = {
  ...rowStyle,
  borderInlineStart: `3px solid ${colorTokens.brandPurple}`,
  paddingInlineStart: spacingTokens.sm,
} as const;

const headRowStyle = {
  display: 'flex',
  gap: spacingTokens.xs,
  alignItems: 'center',
  flexWrap: 'wrap',
} as const;

const actionRowStyle = {
  display: 'flex',
  gap: spacingTokens.xs,
  flexWrap: 'wrap',
  marginBlockStart: spacingTokens['3xs'],
} as const;

const headlineStyle = { ...typographyTokens.bodySm, fontWeight: 600 } as const;
const bodyStyle = { ...typographyTokens.bodySm, color: colorTokens.textSecondary } as const;
const metaStyle = { ...typographyTokens.caption, color: colorTokens.textMuted } as const;
