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
import { activityService } from '../../../server/approvals-context';
import { translator, type MessageKey } from '../../../i18n/messages';
import { WorkspaceShell } from '../../../components/workspace-shell';

export const dynamic = 'force-dynamic';

/**
 * The customer Activity Log — Phase 5B-3, docs/PRODUCT.md §5 module 17,
 * AC-15.2 and AC-15.3.
 *
 * IT READS `audit_event`, AND NOTHING ELSE. There is no second event table: the
 * platform already keeps an append-only record of every state change, and a
 * customer-facing copy of the same facts would drift from it the first time one
 * writer updated one and not the other — a mutable copy at that, which is what
 * AC-15.7 exists to prevent.
 *
 * WHAT IS DELIBERATELY NOT RENDERED: the `before`/`after` diffs. They are
 * written redacted, but the customer screen does not need to depend on every
 * past and future writer having got that right. This log answers what happened,
 * to which thing, by whom — and the platform audit surface (AC-15.4) is where
 * diffs are read, by people who are cleared to read them.
 *
 * THE SCOPE IS A QUERY PREDICATE, NOT A FILTER. A reader graded "own" gets
 * `actorId = me` inside the SQL; a page boundary computed over rows they may not
 * see would itself disclose how many there are (docs/SECURITY.md §4.3).
 */
export default async function ActivityPage({
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

  const action = typeof query.action === 'string' && query.action.length > 0 ? query.action : null;
  const cursor = typeof query.cursor === 'string' ? query.cursor : null;

  const viewer = {
    userId: customer.userId,
    permissionKeys: workspace.permissionKeys,
    brandScope: workspace.brandScope,
  };

  const { page, actions, brandNames, actorNames } = await inWorkspace(
    workspace.workspaceId,
    async ({ db }) => {
      const service = activityService({ db, workspaceId: workspace.workspaceId });
      const result = await service.page({
        viewer,
        cursor,
        ...(action ? { filter: { action } } : {}),
      });
      const knownActions = await service.actions({ viewer });

      const brandIds = [...new Set(result.entries.map((e) => e.brandId).filter(isString))];
      const actorIds = [...new Set(result.entries.map((e) => e.actorId).filter(isString))];
      const brands = await db.brand.findMany({
        where: { workspaceId: workspace.workspaceId, id: { in: brandIds } },
        select: { id: true, name: true },
      });
      /*
       * ACTOR NAMES COME FROM MEMBERSHIPS OF THIS WORKSPACE. An audit row's
       * `actorId` may name a platform user acting under support mode (D-28) or
       * a system process; those resolve to nothing here and render as their
       * actor TYPE instead. Looking a stranger's id up in `user` would answer
       * "does this account exist?" to anyone who could get an id into a log.
       */
      const members = await db.membership.findMany({
        where: { workspaceId: workspace.workspaceId, userId: { in: actorIds } },
        select: { userId: true, user: { select: { email: true, name: true } } },
      });
      return {
        page: result,
        actions: knownActions,
        brandNames: new Map(brands.map((b) => [b.id, b.name] as const)),
        actorNames: new Map(members.map((m) => [m.userId, m.user.name ?? m.user.email] as const)),
      };
    },
  );

  const dateFormat = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });

  const actorLabel = (entry: (typeof page.entries)[number]): string => {
    if (entry.actorId && entry.actorId === customer.userId) return t('activity.you');
    if (entry.actorId && actorNames.has(entry.actorId)) return actorNames.get(entry.actorId) ?? '—';
    const key = `activity.actor.${entry.actorType}` as MessageKey;
    const translated = t(key);
    return translated === key ? entry.actorType : translated;
  };

  return (
    <WorkspaceShell
      locale={locale}
      activePath="/activity"
      heading={t('activity.title')}
      description={t('activity.subtitle')}
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      <Stack>
        <Card testId="activity-log">
          <SectionHeader
            eyebrow={t('activity.eyebrow')}
            title={t('activity.title')}
            description={
              page.scope === 'none' ? undefined : t(`activity.scope.${page.scope}` as MessageKey)
            }
          />

          {page.scope === 'none' ? (
            <StateMessage
              title={t('activity.noAccessTitle')}
              description={t('activity.noAccessBody')}
            />
          ) : (
            <>
              {/*
                A GET form, so a filtered view is a real URL that can be
                bookmarked, shared and reloaded — and so the page still filters
                with scripting unavailable. The options are the action keys that
                actually occur within the reader's scope, so the filter cannot
                be used to probe for events they may not see.
              */}
              <form method="get" style={filterFormStyle}>
                <label htmlFor="activity-action" style={labelStyle}>
                  {t('activity.filterAction')}
                </label>
                <select
                  id="activity-action"
                  name="action"
                  defaultValue={action ?? ''}
                  style={selectStyle}
                  data-testid="activity-filter"
                >
                  <option value="">{t('activity.filterAll')}</option>
                  {actions.map((key) => (
                    <option key={key} value={key}>
                      {key}
                    </option>
                  ))}
                </select>
                <button type="submit" style={buttonStyle('ghost')}>
                  {t('activity.filterAction')}
                </button>
              </form>

              {page.entries.length === 0 ? (
                <StateMessage
                  title={t('activity.emptyTitle')}
                  description={t('activity.emptyBody')}
                />
              ) : (
                <ol style={listStyle} data-testid="activity-list">
                  {page.entries.map((entry) => (
                    <li key={entry.id} style={rowStyle} data-testid={`activity-${entry.id}`}>
                      <div style={headRowStyle}>
                        <strong style={actionStyle}>{entry.action}</strong>
                        {entry.outcome === 'SUCCESS' ? null : (
                          <StatusBadge
                            label={t(`activity.outcome.${entry.outcome}` as MessageKey)}
                            tone={entry.outcome === 'DENIED' ? 'warning' : 'danger'}
                          />
                        )}
                      </div>
                      <span style={metaStyle}>
                        {actorLabel(entry)} ·{' '}
                        <time dateTime={entry.occurredAt.toISOString()}>
                          {dateFormat.format(entry.occurredAt)}
                        </time>
                        {entry.resourceType ? ` · ${entry.resourceType}` : ''}
                        {entry.brandId && brandNames.has(entry.brandId)
                          ? ` · ${brandNames.get(entry.brandId)}`
                          : ''}
                      </span>
                    </li>
                  ))}
                </ol>
              )}

              {page.nextCursor ? (
                <Link
                  href={buildHref(locale, action, page.nextCursor)}
                  style={buttonStyle('ghost')}
                  data-testid="activity-more"
                >
                  {t('activity.more')}
                </Link>
              ) : null}
            </>
          )}
        </Card>
      </Stack>
    </WorkspaceShell>
  );
}

function isString(value: string | null): value is string {
  return typeof value === 'string' && value.length > 0;
}

function buildHref(locale: string, action: string | null, cursor: string): string {
  const params = new URLSearchParams();
  if (action) params.set('action', action);
  params.set('cursor', cursor);
  return `/${locale}/activity?${params.toString()}`;
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
  paddingBlock: spacingTokens.xs,
  borderBlockEnd: `1px solid ${colorTokens.border}`,
} as const;

const headRowStyle = {
  display: 'flex',
  gap: spacingTokens.xs,
  alignItems: 'center',
  flexWrap: 'wrap',
} as const;

const actionStyle = { ...typographyTokens.bodySm, fontWeight: 600 } as const;
const metaStyle = { ...typographyTokens.caption, color: colorTokens.textMuted } as const;
const labelStyle = { ...typographyTokens.caption, color: colorTokens.textMuted } as const;

const filterFormStyle = {
  display: 'flex',
  gap: spacingTokens.xs,
  alignItems: 'center',
  flexWrap: 'wrap',
  marginBlockEnd: spacingTokens.md,
} as const;

const selectStyle = {
  ...typographyTokens.bodySm,
  padding: spacingTokens['3xs'],
  borderRadius: '8px',
  border: `1px solid ${colorTokens.border}`,
  background: colorTokens.surface,
  color: colorTokens.textPrimary,
  maxInlineSize: '100%',
} as const;
