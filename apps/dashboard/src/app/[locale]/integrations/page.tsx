import { brandScopeFilter } from '@brandspace/shared';
import { SOCIAL_PROVIDERS } from '@brandspace/social-connectors';
import { inWorkspace, requireWorkspace } from '../../../server/customer-context';
import { brandContextFor } from '../../../server/brand-context';
import { callSocialApi, inSocial } from '../../../server/social-context';
import { statusMessage, translator, type MessageKey } from '../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../components/workspace-shell';
import {
  IntegrationsView,
  type BrandOption,
  type ConnectableProvider,
  type ConnectionRow,
  type PendingSelection,
  type PendingTarget,
  type PublishRow,
} from './integrations-view';
import {
  cancelPublishAction,
  checkAccountAction,
  connectAccountAction,
  disconnectAccountAction,
  retryPublishAction,
  selectTargetAction,
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

  /*
   * WHERE THE OAUTH CALLBACK LANDS (D-141).
   *
   * The provider redirects the browser to `apps/api`, which has no UI and
   * cannot have one, and the API redirects here with a single coarse `social`
   * word. It is mapped to a sentence from a CLOSED SET — an unrecognised value
   * renders nothing at all — so a crafted link cannot put text of its choosing
   * on this page.
   */
  const landing = typeof query.social === 'string' ? query.social : null;
  const landingStatus =
    landing === 'connected'
      ? 'ACCOUNT_CONNECTED'
      : landing === 'partial'
        ? 'ACCOUNT_NEEDS_REAUTH'
        : landing === 'declined'
          ? 'ACCOUNT_CONNECT_DECLINED'
          : landing === 'invalid'
            ? 'ACCOUNT_CONNECT_INVALID'
            : null;

  const successText =
    (ok ? statusMessage(ok, locale) : null) ??
    (landingStatus === 'ACCOUNT_CONNECTED' ? statusMessage(landingStatus, locale) : null);
  const errorText =
    (error ? statusMessage(error, locale, reference) : null) ??
    (landingStatus && landingStatus !== 'ACCOUNT_CONNECTED'
      ? statusMessage(landingStatus, locale)
      : null);

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

  /*
   * A GRANT WAITING ON A CHOICE (D-142).
   *
   * The customer authorized an account that administers several pages, and
   * BrandSpace has deliberately not picked one. The offered pages are fetched
   * from `apps/api` — which re-checks the workspace, the permission, the brand
   * scope and that this is the person who started the flow — so a stale or
   * borrowed `?select=` renders nothing rather than another workspace's pages.
   *
   * ONLY FOR A MEMBER WHO MAY CONNECT. A reader without `integrations.manage`
   * is never shown a choice they could not act on.
   */
  const selectionToken =
    mayManage && typeof query.select === 'string' && query.select.length > 0 ? query.select : null;
  let pendingSelection: PendingSelection | null = null;
  if (selectionToken) {
    const response = await callSocialApi('/v1/social/connections/selection', { selectionToken });
    if (response.ok) {
      const payload = response.payload as {
        provider?: unknown;
        targets?: unknown;
      };
      const targets = Array.isArray(payload.targets) ? payload.targets : [];
      const parsed = targets.flatMap((entry): PendingTarget[] => {
        if (typeof entry !== 'object' || entry === null) return [];
        const row = entry as Record<string, unknown>;
        const id = row['externalAccountId'];
        if (typeof id !== 'string' || id === '') return [];
        return [
          {
            externalAccountId: id,
            displayName: typeof row['displayName'] === 'string' ? row['displayName'] : id,
            targetKind: typeof row['targetKind'] === 'string' ? row['targetKind'] : '',
          },
        ];
      });
      if (parsed.length > 0) {
        pendingSelection = {
          selectionToken,
          providerLabel: providerLabel(
            typeof payload.provider === 'string' ? payload.provider : '',
          ),
          targets: parsed,
        };
      }
    }
  }

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
  const failureMessage = (
    failureClass: string | null,
    failureCode: string | null,
  ): string | null => {
    if (!failureClass) return null;

    /*
     * PHASE 8 — OUR OWN CODE FIRST, when there is a sentence for it.
     *
     * The class alone was misleading for every PRE-FLIGHT refusal, and media
     * made that visible. A post whose picture had been quarantined failed with
     * class `CONTENT_REJECTED`, which reads "the platform rejected this
     * content" — and the platform was never called. The customer would go and
     * edit a caption nothing is wrong with.
     *
     * `failureCode` is stable and OURS, which is exactly why it can carry a
     * sentence: it is never a provider string. Where a code has no sentence the
     * class's own sentence stands, which is the right answer for a genuine
     * provider refusal.
     */
    if (failureCode) {
      const codeKey = `publishing.code.${failureCode}` as MessageKey;
      const codeMessage = t(codeKey);
      if (codeMessage !== codeKey) return codeMessage;
    }

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
    failureMessage: failureMessage(job.failureClass, job.failureCode),
    needsReconnect: job.needsReconnect,
    canCancel: job.canCancel,
    canRetry: job.canRetry,
  }));

  const brandContext = await brandContextFor(session.workspace, '/integrations');

  return (
    <WorkspaceShell
      brandContext={brandContext}
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
        pendingSelection={pendingSelection}
        actions={{
          connect: connectAccountAction,
          disconnect: disconnectAccountAction,
          check: checkAccountAction,
          cancel: cancelPublishAction,
          retry: retryPublishAction,
          selectTarget: selectTargetAction,
        }}
      />
    </WorkspaceShell>
  );
}

/** Referenced so the provider list stays in step with the enum it renders. */
void SOCIAL_PROVIDERS;
