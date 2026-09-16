import { brandScopeFilter } from '@brandspace/shared';
import { SOCIAL_PROVIDERS } from '@brandspace/social-connectors';
import { inWorkspace, requireWorkspace } from '../../../server/customer-context';
import { inSocial } from '../../../server/social-context';
import { statusMessage, translator, type MessageKey } from '../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../components/workspace-shell';
import {
  IntegrationsView,
  type BrandOption,
  type ConnectableProvider,
  type ConnectionRow,
  type PublishRow,
} from './integrations-view';
import {
  cancelPublishAction,
  checkAccountAction,
  connectAccountAction,
  disconnectAccountAction,
  retryPublishAction,
} from './actions';

export const dynamic = 'force-dynamic';

/**
 * Connected accounts and publishing history — Phase 6.
 *
 * WHO MAY OPEN THIS SCREEN: a member holding `integrations.read`, and nobody
 * else. A Viewer (read-only) holds `workspace.read` and nothing else (D-62,
 * D-130), so they reach the same NOT_FOUND any member without the permission
 * gets — no connected accounts, no publishing history, no route.
 *
 * WHAT THE READER MAY DO IS RESOLVED HERE AND ENFORCED IN THE ACTIONS. Every
 * flag below is computed from the session's permissions, and every action
 * re-checks independently: the screen deciding wrongly could only hide a
 * control, never open one.
 *
 * BRANDSCOPE IS A QUERY PREDICATE ON EVERY READ (D-132/D-134). The connection
 * list, the publishing history and the brand picker are all filtered in the
 * database, so a brand-restricted member never has another brand's rows
 * fetched on their behalf.
 */
export default async function IntegrationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const t = translator(locale);
  const session = await requireWorkspace(locale, 'integrations.read');
  const { workspace } = session;

  const ok = typeof query.ok === 'string' ? query.ok : null;
  const error = typeof query.error === 'string' ? query.error : null;
  const reference = typeof query.ref === 'string' ? query.ref : undefined;
  const successText = ok ? statusMessage(ok, locale) : null;
  const errorText = error ? statusMessage(error, locale, reference) : null;

  const permissions = workspace.permissionKeys;
  const mayManage = permissions.includes('integrations.manage');
  const mayReadPublishing = permissions.includes('publishing.read');
  const mayManagePublishing = permissions.includes('publishing.manage');

  const formatter = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });
  const stamp = (value: Date | null): string | null => (value ? formatter.format(value) : null);

  /*
   * THE BRANDS THIS MEMBER MAY ACT ON — filtered by `brandScopeFilter`, the
   * sibling helper that filters the BRAND table by `id` rather than a child by
   * `brandId`. A picker offering a brand the connect action would refuse is the
   * dead control §20 forbids.
   */
  const brandRows = await inWorkspace(workspace.workspaceId, async ({ db }) =>
    db.brand.findMany({
      where: { status: 'ACTIVE', ...brandScopeFilter(workspace.brandScope) },
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    }),
  );
  const brands: readonly BrandOption[] = brandRows.map((brand) => ({
    id: brand.id,
    name: brand.name,
  }));
  const brandNames = new Map(brandRows.map((brand) => [brand.id, brand.name]));

  const { connections, connectable, jobs, itemTitles } = await inSocial(
    workspace.workspaceId,
    async (services) => {
      const connectionService = await services.connections();
      const registry = await services.registry();
      const policy = await services.policy();

      const views = await connectionService.list({ brandScope: workspace.brandScope });

      /*
       * THE HISTORY IS READ ONLY WHEN THE READER MAY SEE IT. A count or a list
       * fetched and then dropped in JavaScript is a disclosure computed over
       * rows this person may not see (F-10).
       */
      const history = mayReadPublishing
        ? await services.history().list({ brandScope: workspace.brandScope, limit: 25 })
        : [];

      const titles = new Map<string, string>();
      if (history.length > 0) {
        const items = await services.db.contentItem.findMany({
          where: { id: { in: history.map((job) => job.contentItemId) } },
          select: { id: true, title: true },
        });
        for (const item of items) titles.set(item.id, item.title);
      }

      return {
        connections: views,
        connectable: registry.enabledProviders().map((provider) => ({
          provider,
          capabilities: registry.get(provider).capabilities,
          enabled: policy.providers[provider.toLowerCase() as never] !== undefined,
        })),
        jobs: history,
        itemTitles: titles,
      };
    },
  );

  const providerLabel = (provider: string): string =>
    t(`integrations.provider.${provider.toLowerCase()}` as MessageKey);

  const connectionRows: readonly ConnectionRow[] = connections.map((connection) => ({
    id: connection.id,
    provider: connection.provider,
    providerLabel: providerLabel(connection.provider),
    displayName: connection.displayName,
    targetKindLabel: connection.targetKind,
    brandName: brandNames.get(connection.brandId) ?? t('integrations.unknownBrand'),
    status: connection.status,
    connectedAtLabel: stamp(connection.connectedAt),
    lastSyncedAtLabel: stamp(connection.lastSyncedAt),
    tokenExpiresAtLabel: stamp(connection.tokenExpiresAt),
    expiringSoon: connection.expiringSoon,
    publishable: connection.publishable,
    consecutiveFailureCount: connection.consecutiveFailureCount,
  }));

  const connectableProviders: readonly ConnectableProvider[] = connectable.map((entry) => ({
    provider: entry.provider,
    label: providerLabel(entry.provider),
    postKinds: entry.capabilities.postKinds,
    maxBodyCharacters: entry.capabilities.maxBodyCharacters,
  }));

  /*
   * THE FAILURE SENTENCE IS RESOLVED FROM THE CLASS, HERE, IN THE READER'S
   * LOCALE. The job stores a class and a stable code; a provider's own message
   * is never stored and never rendered, because it routinely echoes the caption
   * that was rejected.
   */
  const failureMessage = (failureClass: string | null): string | null => {
    if (!failureClass) return null;
    const key = `publishing.failure.${failureClass.toLowerCase()}` as MessageKey;
    const message = t(key);
    return message === key ? t('publishing.failure.unknown') : message;
  };

  const publishRows: readonly PublishRow[] = jobs.map((job) => ({
    id: job.id,
    providerLabel: providerLabel(job.provider),
    brandName: brandNames.get(job.brandId) ?? t('integrations.unknownBrand'),
    itemTitle: itemTitles.get(job.contentItemId) ?? t('publishing.untitled'),
    status: job.status,
    scheduledAtLabel: formatter.format(job.scheduledAtUtc),
    publishedAtLabel: stamp(job.publishedAt),
    externalPostUrl: job.externalPostUrl,
    attemptCount: job.attemptCount,
    maxAttempts: job.maxAttempts,
    nextAttemptAtLabel: stamp(job.nextAttemptAt),
    failureMessage: failureMessage(job.failureClass),
    needsReconnect: job.needsReconnect,
    canCancel: job.canCancel,
    canRetry: job.canRetry,
  }));

  return (
    <WorkspaceShell
      locale={locale}
      heading={t('integrations.title')}
      description={t('integrations.subtitle')}
      activePath="/integrations"
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={session.customer.name ?? session.customer.email}
      permissionKeys={permissions}
    >
      {successText ? <CustomerBanner tone="success">{successText}</CustomerBanner> : null}
      {errorText ? <CustomerBanner tone="error">{errorText}</CustomerBanner> : null}
      <IntegrationsView
        locale={locale}
        t={t}
        connections={connectionRows}
        connectable={connectableProviders}
        brands={brands}
        publishing={publishRows}
        mayManage={mayManage}
        mayManagePublishing={mayManagePublishing}
        actions={{
          connect: connectAccountAction,
          disconnect: disconnectAccountAction,
          check: checkAccountAction,
          cancel: cancelPublishAction,
          retry: retryPublishAction,
        }}
      />
    </WorkspaceShell>
  );
}

/** Referenced so the provider list stays in step with the enum it renders. */
void SOCIAL_PROVIDERS;
