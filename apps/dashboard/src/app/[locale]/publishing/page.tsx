import Link from 'next/link';
import {
  AssetThumb,
  Card,
  LinkTabs,
  SectionHeader,
  StateMessage,
  StatusBadge,
  buttonClass,
  buttonStyle,
  colorTokens,
  spacingTokens,
  typographyTokens,
  type BadgeTone,
} from '@brandspace/ui';
import { requireWorkspace } from '../../../server/customer-context';
import { brandContextFor } from '../../../server/brand-context';
import { inSocial } from '../../../server/social-context';
import { mediaForVariants } from '../../../server/media-picker';
import {
  optionalMessage,
  statusMessage,
  translator,
  type MessageKey,
} from '../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../components/workspace-shell';
import {
  cancelPublishAction,
  checkAccountAction,
  connectAccountAction,
  retryOnReconnectedAction,
  retryPublishAction,
} from '../integrations/actions';

import { EmptyAction } from '../../../components/empty-action';

export const dynamic = 'force-dynamic';

/**
 * PUBLISHING — Queue · Published · Failed · Accounts (Phase 6 final, D-277 §33).
 *
 * ONE CUSTOMER CONCEPT for getting posts out. The publish history and the
 * account health used to live on a technical "Integrations" page next to the
 * OAuth administration; ordinary publishing work now has its own place, and
 * connecting or removing accounts stays in Settings > Connections.
 *
 * NOTHING NEW UNDERNEATH: `PublishHistoryService` for the jobs,
 * `SocialConnectionService` for account health, and the SAME cancel / retry /
 * check actions Connections uses — each returning here through a closed
 * `returnTo`. Reconnecting is the OAuth flow itself and stays a human action
 * (§33): the button starts it; nothing retries on the customer's behalf.
 *
 * TABS ARE ADDRESSES (`?tab=`), so a failed-post notification can land on
 * Failed, and a reload keeps the reader where they were.
 */

type Tab = 'queue' | 'published' | 'failed' | 'accounts';
const TABS: readonly Tab[] = ['queue', 'published', 'failed', 'accounts'];

const QUEUE_STATUSES = ['PENDING', 'QUEUED', 'PUBLISHING', 'VERIFICATION_PENDING'] as const;

const STATUS_KEY: Record<string, MessageKey> = {
  PENDING: 'publishing.status.pending',
  QUEUED: 'publishing.status.queued',
  PUBLISHING: 'publishing.status.publishing',
  VERIFICATION_PENDING: 'publishing.status.verifying',
  PUBLISHED: 'publishing.status.published',
  FAILED: 'publishing.status.failed',
  CANCELLED: 'publishing.status.cancelled',
};

const STATUS_TONE: Record<string, BadgeTone> = {
  PENDING: 'neutral',
  QUEUED: 'info',
  PUBLISHING: 'info',
  VERIFICATION_PENDING: 'warning',
  PUBLISHED: 'success',
  FAILED: 'danger',
  CANCELLED: 'neutral',
};

const CONNECTION_KEY: Record<string, MessageKey> = {
  PENDING: 'integrations.status.pending',
  ACTIVE: 'integrations.status.active',
  NEEDS_REAUTH: 'integrations.status.needsReauth',
  REVOKED: 'integrations.status.revoked',
  DISABLED: 'integrations.status.disabled',
};

const CONNECTION_TONE: Record<string, BadgeTone> = {
  PENDING: 'neutral',
  ACTIVE: 'success',
  NEEDS_REAUTH: 'warning',
  REVOKED: 'danger',
  DISABLED: 'neutral',
};

export default async function PublishingPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const t = translator(locale);
  const session = await requireWorkspace(locale, 'publishing.read');
  const { workspace } = session;
  const may = (key: string) => workspace.permissionKeys.includes(key);

  const tab: Tab = TABS.includes(query['tab'] as Tab) ? (query['tab'] as Tab) : 'queue';
  const ok = typeof query['ok'] === 'string' ? query['ok'] : null;
  const error = typeof query['error'] === 'string' ? query['error'] : null;
  const reference = typeof query['ref'] === 'string' ? query['ref'] : undefined;

  const brandContext = await brandContextFor(workspace, '/publishing');
  const brandId =
    brandContext.resolution.kind === 'brand' ? brandContext.resolution.brand.id : undefined;

  const data = await inSocial(workspace.workspaceId, async (services) => {
    const history = services.history();
    const counts = await history.countsByStatus({ brandScope: workspace.brandScope, brandId });
    const statuses =
      tab === 'queue'
        ? [...QUEUE_STATUSES]
        : tab === 'published'
          ? (['PUBLISHED'] as const)
          : tab === 'failed'
            ? (['FAILED'] as const)
            : null;
    const jobs = statuses
      ? await history.list({ brandScope: workspace.brandScope, brandId, statuses, limit: 50 })
      : [];
    const connections =
      tab === 'accounts' && may('integrations.read')
        ? (await (await services.connections()).list({ brandScope: workspace.brandScope })).filter(
            (connection) => brandId === undefined || connection.brandId === brandId,
          )
        : [];
    /*
     * D-291 — WHAT A ROW NEEDS BESIDES THE JOB: the post's picture, the
     * account it goes through (its health is the job's readiness), the
     * post's latest review, and — on Failed — whether the account it failed
     * on has since been reconnected. All read under RLS and BrandScope; the
     * account's NAME only for a member who may read accounts.
     */
    const jobVariants = jobs.length
      ? await services.db.contentVariant.findMany({
          where: { id: { in: [...new Set(jobs.map((job) => job.contentVariantId))] } },
          select: { id: true, assetIds: true, coverAssetId: true },
        })
      : [];
    const jobConnections = jobs.length
      ? await services.db.socialConnection.findMany({
          where: { id: { in: [...new Set(jobs.map((job) => job.socialConnectionId))] } },
          select: { id: true, status: true, displayName: true },
        })
      : [];
    const reviews =
      tab === 'queue' && jobs.length
        ? await services.db.approval.findMany({
            where: { contentItemId: { in: [...new Set(jobs.map((job) => job.contentItemId))] } },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: { contentItemId: true, status: true },
          })
        : [];
    const reconnected =
      tab === 'failed' && may('publishing.manage')
        ? await (
            await services.pipeline()
          ).reconnectedRetryable(jobs.filter((job) => job.status === 'FAILED').map((j) => j.id))
        : new Set<string>();
    const latestReview = new Map<string, string>();
    for (const review of reviews) {
      if (review.contentItemId && !latestReview.has(review.contentItemId)) {
        latestReview.set(review.contentItemId, review.status);
      }
    }
    const itemIds = [...new Set(jobs.map((job) => job.contentItemId))];
    const brandIds = [
      ...new Set([...jobs.map((job) => job.brandId), ...connections.map((c) => c.brandId)]),
    ];
    const items = itemIds.length
      ? await services.db.contentItem.findMany({
          where: { id: { in: itemIds } },
          select: { id: true, title: true },
        })
      : [];
    const brands = brandIds.length
      ? await services.db.brand.findMany({
          where: { id: { in: brandIds } },
          select: { id: true, name: true },
        })
      : [];
    return {
      counts,
      jobs,
      connections,
      coverOf: new Map(
        jobVariants.flatMap((variant) => {
          const cover = variant.coverAssetId ?? variant.assetIds[0];
          return cover ? [[variant.id, cover] as const] : [];
        }),
      ),
      jobConnections: new Map(jobConnections.map((connection) => [connection.id, connection])),
      latestReview,
      reconnected,
      titles: new Map(items.map((item) => [item.id, item.title])),
      brandNames: new Map(brands.map((brand) => [brand.id, brand.name])),
    };
  });

  const covers = await mediaForVariants({
    workspaceId: workspace.workspaceId,
    userId: session.customer.userId,
    permissionKeys: workspace.permissionKeys,
    brandScope: workspace.brandScope,
    assetIds: [...data.coverOf.values()],
  });
  const REVIEW_KEY: Record<string, MessageKey> = {
    PENDING: 'approvals.status.PENDING',
    APPROVED: 'approvals.status.APPROVED',
    CHANGES_REQUESTED: 'approvals.status.CHANGES_REQUESTED',
  };

  const formatter = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });
  const providerLabel = (provider: string): string =>
    optionalMessage(locale, `integrations.provider.${provider.toLowerCase()}`) ?? provider;
  const failureText = (failureClass: string | null, failureCode: string | null): string | null =>
    failureClass === null
      ? null
      : ((failureCode ? optionalMessage(locale, `publishing.code.${failureCode}`) : null) ??
        optionalMessage(locale, `publishing.failure.${failureClass.toLowerCase()}`) ??
        t('publishing.failure.unknown'));

  const count = (statuses: readonly string[]) =>
    statuses.reduce((sum, status) => sum + (data.counts[status] ?? 0), 0);
  const badge = (value: number) => (value > 0 ? String(value) : undefined);
  const tabHref = (id: Tab) => `/${locale}/publishing${id === 'queue' ? '' : `?tab=${id}`}`;

  /** Hidden fields every action from this screen carries, so it returns here. */
  const back = (
    <>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="returnTo" value="/publishing" />
      <input type="hidden" name="tab" value={tab} />
    </>
  );

  /** The OAuth start for one provider and brand: a human action, never automatic. */
  const reconnect = (provider: string, forBrand: string, testId: string) =>
    may('integrations.manage') ? (
      <form action={connectAccountAction}>
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="provider" value={provider} />
        <input type="hidden" name="brandId" value={forBrand} />
        <button
          type="submit"
          style={buttonStyle('primary', 'sm')}
          className={buttonClass('primary')}
          data-testid={testId}
        >
          {t('publishingHub.reconnect').replace('{provider}', providerLabel(provider))}
        </button>
      </form>
    ) : null;

  const emptyKey: Record<Exclude<Tab, 'accounts'>, [MessageKey, MessageKey]> = {
    queue: ['publishingHub.queue.emptyTitle', 'publishingHub.queue.emptyBody'],
    published: ['publishingHub.published.emptyTitle', 'publishingHub.published.emptyBody'],
    failed: ['publishingHub.failed.emptyTitle', 'publishingHub.failed.emptyBody'],
  };

  return (
    <WorkspaceShell
      brandContext={brandContext}
      locale={locale}
      heading={t('publishingHub.title')}
      description={t('publishingHub.subtitle')}
      activePath="/publishing"
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={session.customer.name ?? session.customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      {ok ? <CustomerBanner tone="success">{statusMessage(ok, locale)}</CustomerBanner> : null}
      {error ? (
        <CustomerBanner tone="error">{statusMessage(error, locale, reference)}</CustomerBanner>
      ) : null}

      <LinkTabs
        label={t('publishingHub.tabsLabel')}
        currentId={tab}
        testId="publishing-tabs"
        tabs={[
          {
            id: 'queue',
            href: tabHref('queue'),
            label: t('publishingHub.tab.queue'),
            badge: badge(count(QUEUE_STATUSES)),
          },
          {
            id: 'published',
            href: tabHref('published'),
            label: t('publishingHub.tab.published'),
            badge: badge(count(['PUBLISHED'])),
          },
          {
            id: 'failed',
            href: tabHref('failed'),
            label: t('publishingHub.tab.failed'),
            badge: badge(count(['FAILED'])),
          },
          ...(may('integrations.read')
            ? [
                {
                  id: 'accounts',
                  href: tabHref('accounts'),
                  label: t('publishingHub.tab.accounts'),
                },
              ]
            : []),
        ]}
      />

      {tab !== 'accounts' ? (
        <Card testId={`publishing-${tab}`}>
          {data.jobs.length === 0 ? (
            <StateMessage
              title={t(emptyKey[tab][0])}
              description={t(emptyKey[tab][1])}
              action={
                /* D-299 — the queue fills from the calendar; "no failures" is good news. */
                tab !== 'failed' ? (
                  <EmptyAction
                    href={`/${locale}/calendar`}
                    label={t('publishingHub.emptyAction')}
                    testId="publishing-empty-calendar"
                    tone="neutral"
                  />
                ) : undefined
              }
            />
          ) : (
            <ul style={listStyle} data-testid="publishing-rows">
              {data.jobs.map((job) => {
                const title = data.titles.get(job.contentItemId) ?? t('publishing.untitled');
                const failure = failureText(job.failureClass, job.failureCode);
                const when =
                  job.status === 'PUBLISHED' && job.publishedAt
                    ? job.publishedAt
                    : job.scheduledAtUtc;
                return (
                  <li key={job.id} style={jobRowStyle} data-testid={`publish-job-${job.id}`}>
                    {(() => {
                      const coverId = data.coverOf.get(job.contentVariantId);
                      const media = coverId ? covers.get(coverId) : undefined;
                      return media?.previewToken ? (
                        <AssetThumb
                          src={`/${locale}/assets/file/${media.previewToken}`}
                          alt=""
                          size="3rem"
                        />
                      ) : (
                        <span aria-hidden="true" style={textThumbStyle}>
                          {title.slice(0, 1)}
                        </span>
                      );
                    })()}
                    <div style={jobBodyStyle}>
                      <div style={headStyle}>
                        <Link
                          href={`/${locale}/content/compose?item=${job.contentItemId}`}
                          style={titleStyle}
                        >
                          {title}
                        </Link>
                        <StatusBadge
                          label={t(STATUS_KEY[job.status] ?? 'publishing.status.pending')}
                          tone={STATUS_TONE[job.status] ?? 'neutral'}
                        />
                      </div>
                      <span style={metaStyle}>
                        {providerLabel(job.provider)} ·{' '}
                        {data.brandNames.get(job.brandId) ?? t('integrations.unknownBrand')} ·{' '}
                        {job.status === 'PUBLISHED'
                          ? t('publishingHub.publishedOn')
                          : t('publishingHub.scheduledFor')}{' '}
                        <time dateTime={when.toISOString()}>{formatter.format(when)}</time>
                      </span>
                      {tab === 'queue' ? (
                        <span style={headStyle}>
                          {(() => {
                            const account = data.jobConnections.get(job.socialConnectionId);
                            const ready = account?.status === 'ACTIVE';
                            return (
                              <span data-testid={`readiness-${job.id}`}>
                                <StatusBadge
                                  label={
                                    ready
                                      ? t('publishingHub.readiness.ready')
                                      : t('publishingHub.readiness.reconnect')
                                  }
                                  tone={ready ? 'success' : 'warning'}
                                />
                              </span>
                            );
                          })()}
                          {data.latestReview.get(job.contentItemId) &&
                          REVIEW_KEY[data.latestReview.get(job.contentItemId) ?? ''] ? (
                            <span data-testid={`review-${job.id}`} style={metaStyle}>
                              {t('calendar.approvalState')}:{' '}
                              {t(
                                REVIEW_KEY[
                                  data.latestReview.get(job.contentItemId) ?? ''
                                ] as MessageKey,
                              )}
                            </span>
                          ) : null}
                          {may('integrations.read') &&
                          data.jobConnections.get(job.socialConnectionId)?.displayName ? (
                            <span style={metaStyle}>
                              {data.jobConnections.get(job.socialConnectionId)?.displayName}
                            </span>
                          ) : null}
                        </span>
                      ) : null}
                      {failure ? (
                        <p style={failureStyle} data-testid={`failure-${job.id}`}>
                          {failure}
                        </p>
                      ) : null}
                      {data.reconnected.has(job.id) ? (
                        <p style={reconnectedStyle} data-testid={`reconnected-${job.id}`}>
                          {t('publishingHub.reconnected')}
                        </p>
                      ) : null}
                      <div style={actionsStyle}>
                        {job.status === 'PUBLISHED' && job.externalPostUrl ? (
                          <a
                            href={job.externalPostUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={buttonStyle('ghost', 'sm')}
                            className={buttonClass('ghost')}
                            data-testid={`post-link-${job.id}`}
                          >
                            {t('publishing.viewPost')}
                          </a>
                        ) : null}
                        {data.reconnected.has(job.id) ? (
                          <form action={retryOnReconnectedAction}>
                            {back}
                            <input type="hidden" name="jobId" value={job.id} />
                            <button
                              type="submit"
                              style={buttonStyle('primary', 'sm')}
                              className={buttonClass('primary')}
                              data-testid={`retry-reconnected-${job.id}`}
                            >
                              {t('publishing.retry')}
                            </button>
                          </form>
                        ) : null}
                        {(job.needsReconnect || job.failureClass === 'AUTH_EXPIRED') &&
                        job.status === 'FAILED' &&
                        !data.reconnected.has(job.id)
                          ? reconnect(job.provider, job.brandId, `reconnect-${job.id}`)
                          : null}
                        {job.canRetry &&
                        job.status === 'FAILED' &&
                        !data.reconnected.has(job.id) &&
                        may('publishing.manage') ? (
                          <form action={retryPublishAction}>
                            {back}
                            <input type="hidden" name="jobId" value={job.id} />
                            <button
                              type="submit"
                              style={buttonStyle('neutral', 'sm')}
                              className={buttonClass('neutral')}
                              data-testid={`retry-${job.id}`}
                            >
                              {t('publishing.retry')}
                            </button>
                          </form>
                        ) : null}
                        {job.canCancel && may('publishing.manage') ? (
                          <form action={cancelPublishAction}>
                            {back}
                            <input type="hidden" name="jobId" value={job.id} />
                            <button
                              type="submit"
                              style={buttonStyle('ghost', 'sm')}
                              className={buttonClass('ghost')}
                              data-testid={`cancel-${job.id}`}
                            >
                              {t('publishing.cancel')}
                            </button>
                          </form>
                        ) : null}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      ) : (
        <Card testId="publishing-accounts">
          <SectionHeader
            title={t('publishingHub.tab.accounts')}
            description={t('publishingHub.accounts.body')}
            actions={
              <Link
                href={`/${locale}/integrations`}
                style={buttonStyle('ghost', 'sm')}
                className={buttonClass('ghost')}
                data-testid="publishing-manage-connections"
              >
                {t('publishingHub.manageConnections')}
              </Link>
            }
          />
          {data.connections.length === 0 ? (
            <StateMessage
              title={t('integrations.emptyTitle')}
              description={t('integrations.emptyBody')}
              action={
                may('integrations.manage') ? (
                  <EmptyAction
                    href={`/${locale}/integrations`}
                    label={t('publishingHub.connectAction')}
                    testId="publishing-empty-connect"
                  />
                ) : undefined
              }
            />
          ) : (
            <ul style={listStyle}>
              {data.connections.map((connection) => (
                <li key={connection.id} style={rowStyle} data-testid={`account-${connection.id}`}>
                  <div style={headStyle}>
                    <strong style={titleStyle}>{connection.displayName}</strong>
                    <StatusBadge
                      label={t(CONNECTION_KEY[connection.status] ?? 'integrations.status.pending')}
                      tone={CONNECTION_TONE[connection.status] ?? 'neutral'}
                    />
                    {connection.expiringSoon ? (
                      <StatusBadge label={t('integrations.expiringSoon')} tone="warning" />
                    ) : null}
                  </div>
                  <span style={metaStyle}>
                    {providerLabel(connection.provider)} ·{' '}
                    {data.brandNames.get(connection.brandId) ?? t('integrations.unknownBrand')}
                    {connection.lastSyncedAt
                      ? ` · ${t('integrations.lastSynced')} ${formatter.format(connection.lastSyncedAt)}`
                      : ''}
                    {connection.tokenExpiresAt
                      ? ` · ${t('integrations.tokenExpires')} ${formatter.format(connection.tokenExpiresAt)}`
                      : ''}
                  </span>
                  <span style={metaStyle}>
                    {connection.publishable
                      ? t('publishingHub.accounts.canPublish')
                      : t('publishingHub.accounts.cannotPublish')}
                  </span>
                  <div style={actionsStyle}>
                    {connection.status === 'NEEDS_REAUTH' || connection.expiringSoon
                      ? reconnect(
                          connection.provider,
                          connection.brandId,
                          `reconnect-account-${connection.id}`,
                        )
                      : null}
                    <form action={checkAccountAction}>
                      {back}
                      <input type="hidden" name="connectionId" value={connection.id} />
                      <button
                        type="submit"
                        style={buttonStyle('ghost', 'sm')}
                        className={buttonClass('ghost')}
                        data-testid={`check-${connection.id}`}
                      >
                        {t('integrations.check')}
                      </button>
                    </form>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
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

const jobRowStyle = {
  ...rowStyle,
  gridTemplateColumns: '3rem minmax(0, 1fr)',
  columnGap: spacingTokens.sm,
  alignItems: 'start',
} as const;

const jobBodyStyle = { display: 'grid', gap: spacingTokens['3xs'], minInlineSize: 0 } as const;

/** A text-only post: an intentional neutral tile, never fake art (§15). */
const textThumbStyle = {
  display: 'grid',
  placeItems: 'center',
  inlineSize: '3rem',
  blockSize: '3rem',
  borderRadius: '0.75rem',
  background: colorTokens.surfaceMuted,
  color: colorTokens.textSecondary,
  ...typographyTokens.label,
} as const;

const reconnectedStyle = {
  ...typographyTokens.bodySm,
  margin: 0,
  color: colorTokens.success,
} as const;

const headStyle = {
  display: 'flex',
  gap: spacingTokens.xs,
  alignItems: 'center',
  flexWrap: 'wrap',
} as const;

const actionsStyle = {
  display: 'flex',
  gap: spacingTokens.xs,
  flexWrap: 'wrap',
  marginBlockStart: spacingTokens['3xs'],
} as const;

const titleStyle = {
  ...typographyTokens.bodySm,
  fontWeight: 600,
  color: colorTokens.textPrimary,
} as const;
const metaStyle = { ...typographyTokens.caption, color: colorTokens.textMuted } as const;
const failureStyle = {
  ...typographyTokens.bodySm,
  margin: 0,
  color: colorTokens.danger,
} as const;
