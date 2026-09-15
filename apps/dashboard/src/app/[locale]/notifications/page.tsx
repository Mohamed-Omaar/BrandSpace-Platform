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
import { inWorkspace, requireWorkspace } from '../../../server/customer-context';
import { notificationService } from '../../../server/approvals-context';
import { statusMessage, translator, type MessageKey } from '../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../components/workspace-shell';
import { markAllNotificationsReadAction, markNotificationReadAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * The notification inbox — Phase 5B-3, docs/PRODUCT.md §5 module 16.
 *
 * IN-APP ONLY (D-123). Nothing here sends mail, SMS or a push; there is no
 * transport in this platform to send one with, and a screen offering channel
 * preferences it cannot honour would be a promise the product does not keep.
 * The `channel` column exists because docs/DATABASE.md §9.3 designs it, and a
 * database CHECK pins every row to `IN_APP` until Phase 8 adds a sender.
 *
 * THE WORDS ARE CHOSEN HERE, NOT STORED. A row carries a template key and a
 * payload; the reader's locale picks the sentence. Storing a rendered string
 * would fix an Arabic reader's inbox in whatever language the ACTOR happened to
 * be using.
 *
 * THE LINK IS RELATIVE AND RE-PREFIXED. A stored `linkPath` is workspace
 * relative with no locale; this page prefixes the reader's own. A database
 * CHECK rejects anything that is not a relative path, so a row can never carry
 * an absolute redirect target.
 */
export default async function NotificationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const t = translator(locale);
  const { customer, workspace } = await requireWorkspace(locale);

  const ok = typeof query.ok === 'string' ? query.ok : null;
  const error = typeof query.error === 'string' ? query.error : null;
  const reference = typeof query.ref === 'string' ? query.ref : undefined;

  const { items, unread } = await inWorkspace(workspace.workspaceId, async ({ db }) => {
    const service = notificationService({ db, workspaceId: workspace.workspaceId });
    return {
      items: await service.list({ userId: customer.userId, take: 50 }),
      unread: await service.unreadCount(customer.userId),
    };
  });

  const dateFormat = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });

  return (
    <WorkspaceShell
      locale={locale}
      activePath="/notifications"
      heading={t('notifications.title')}
      description={t('notifications.subtitle')}
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      {ok ? <CustomerBanner tone="success">{statusMessage(ok, locale)}</CustomerBanner> : null}
      {error ? (
        <CustomerBanner tone="error">{statusMessage(error, locale, reference)}</CustomerBanner>
      ) : null}
      <Stack>
        <Card testId="notifications">
          <SectionHeader
            eyebrow={t('notifications.eyebrow')}
            title={t('notifications.title')}
            actions={
              unread > 0 ? (
                <form action={markAllNotificationsReadAction}>
                  <input type="hidden" name="locale" value={locale} />
                  <button type="submit" style={buttonStyle('ghost')} data-testid="mark-all-read">
                    {t('notifications.markAllRead')}
                  </button>
                </form>
              ) : undefined
            }
          />
          <p style={metaStyle} data-testid="notifications-unread-count">
            {t('notifications.unread')}: {unread}
          </p>

          {items.length === 0 ? (
            <StateMessage
              title={t('notifications.emptyTitle')}
              description={t('notifications.emptyBody')}
            />
          ) : (
            <ul style={listStyle} data-testid="notifications-list">
              {items.map((item) => {
                const key = `notifications.template.${item.templateKey}` as MessageKey;
                const headline = t(key);
                return (
                  <li
                    key={item.id}
                    style={item.readAt ? rowStyle : unreadRowStyle}
                    data-testid={`notification-${item.id}`}
                    data-read={item.readAt ? 'true' : 'false'}
                  >
                    <div style={headRowStyle}>
                      <strong style={headlineStyle}>
                        {headline === key ? item.templateKey : headline}
                      </strong>
                      {item.readAt ? null : (
                        <StatusBadge label={t('notifications.unread')} tone="warning" dot />
                      )}
                    </div>
                    <span style={metaStyle}>
                      {item.payload.itemTitle ? `${item.payload.itemTitle} · ` : ''}
                      <time dateTime={item.createdAt.toISOString()}>
                        {dateFormat.format(item.createdAt)}
                      </time>
                    </span>
                    <div style={actionRowStyle}>
                      {item.linkPath ? (
                        <Link
                          href={`/${locale}${item.linkPath}`}
                          style={buttonStyle('ghost')}
                          data-testid={`notification-link-${item.id}`}
                        >
                          {t('notifications.view')}
                        </Link>
                      ) : null}
                      {item.readAt ? null : (
                        <form action={markNotificationReadAction}>
                          <input type="hidden" name="locale" value={locale} />
                          <input type="hidden" name="id" value={item.id} />
                          <button
                            type="submit"
                            style={buttonStyle('ghost')}
                            data-testid={`mark-read-${item.id}`}
                          >
                            {t('notifications.markRead')}
                          </button>
                        </form>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </Stack>
    </WorkspaceShell>
  );
}

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

/*
 * Unread is marked by a border on the INLINE START edge and by the badge, not by
 * colour alone — WCAG 2.2 AA 1.4.1, and the badge carries the word besides.
 */
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
const metaStyle = { ...typographyTokens.caption, color: colorTokens.textMuted } as const;
