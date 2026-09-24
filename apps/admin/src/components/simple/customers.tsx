import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import type { AuthenticatedPlatformActor } from '@brandspace/auth';
import { UsageService } from '@brandspace/entitlements';
import {
  Avatar,
  Card,
  ContentGrid,
  Field,
  LinkTabs,
  MetricCard,
  Stack,
  StatusBadge,
  buttonClass,
  buttonStyle,
  colorTokens,
  initialsFrom,
  inputStyle,
  radiusTokens,
  spacingTokens,
  statusTone,
  typographyTokens,
  type MediaSeed,
} from '@brandspace/ui';
import { fill, simpleCopy, type SimpleKey } from '../../i18n/simple';
import { loadCustomerFacts } from '../../server/owner-overview';
import {
  getConfigService,
  getCreditService,
  getEntitlementService,
  getMembershipService,
  getPlanCatalogue,
  getPlatformPrisma,
  getSubscriptionService,
  getWorkspaceService,
  currentEnvironment,
  serviceActor,
} from '../../server/platform-context';
import {
  adjustCreditsAction,
  assignPlanAction,
  changeStatusAction,
} from '../../app/[locale]/console/workspaces/actions';
import { AdvancedLink } from '../mode-switch';
import {
  ActionLink,
  ActionOutcome,
  SimpleSection,
  flash,
  formatCount,
  formatDay,
} from '../simple-ui';

/**
 * CUSTOMERS, FOR THE OWNER (contract §7).
 *
 * The directory reads the SAME paged, permission-checked listing as Advanced
 * (`WorkspaceAdminService.list`, with its status filter), and enriches only
 * the page on screen with counts. The detail page summarises; every change is
 * one of the directory's existing server actions — change plan, adjust
 * credits, suspend / reactivate — each re-checking its own authority. The
 * entitlement trace, overrides, invitations, cohorts and internal IDs stay in
 * Advanced.
 */

const FILTERS = ['ACTIVE', 'TRIALING', 'PAST_DUE', 'SUSPENDED'] as const;
type Filter = (typeof FILTERS)[number];

function avatarSeed(slug: string): MediaSeed {
  return ([...slug].reduce((total, c) => total + c.charCodeAt(0), 0) % 6) as MediaSeed;
}

const WORKSPACE_STATUSES = [
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'SUSPENDED',
  'CANCELLED',
  'ARCHIVED',
  'DELETED',
];

function statusWord(locale: string, status: string): string {
  return WORKSPACE_STATUSES.includes(status)
    ? simpleCopy(locale)(`ws.${status}` as SimpleKey)
    : status;
}

function credits(locale: string, milli: bigint | null): string {
  return milli === null ? '—' : formatCount(locale, Number(milli) / 1000);
}

export async function SimpleCustomers({
  locale,
  actor,
  query,
}: {
  readonly locale: string;
  readonly actor: AuthenticatedPlatformActor;
  readonly query: Record<string, string | string[] | undefined>;
}) {
  const copy = simpleCopy(locale);
  const base = `/${locale}/console/workspaces`;
  const search = typeof query['q'] === 'string' ? query['q'].trim() : '';
  const rawStatus = typeof query['status'] === 'string' ? query['status'] : '';
  const status: Filter | null = (FILTERS as readonly string[]).includes(rawStatus)
    ? (rawStatus as Filter)
    : null;
  const requestedPage = Number.parseInt(String(query['page'] ?? '1'), 10);

  const page = await getWorkspaceService().list(serviceActor(actor), {
    ...(search ? { query: search } : {}),
    ...(status ? { status } : {}),
    page: Number.isNaN(requestedPage) ? 1 : requestedPage,
    pageSize: 25,
  });
  const facts = await loadCustomerFacts(page.items.map((item) => item.id));
  const catalogue = actor.permissionKeys.includes('platform.configuration.read')
    ? await getPlanCatalogue()
    : null;
  const planName = (key: string | null) => {
    if (!key) return copy('cust.noPlan');
    const plan = catalogue?.plans.find((candidate) => candidate.key === key);
    return plan ? (locale === 'ar' ? plan.nameAr : plan.nameEn) : key;
  };
  const href = (changes: Record<string, string | number | null>) => {
    const next = new URLSearchParams();
    if (search) next.set('q', search);
    if (status) next.set('status', status);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, String(value));
    }
    const qs = next.toString();
    return qs ? `${base}?${qs}` : base;
  };
  const { ok, error, ref } = flash(query);

  return (
    <Stack>
      <ActionOutcome locale={locale} ok={ok} error={error} reference={ref} />
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: spacingTokens.sm,
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <form
          method="get"
          action={base}
          role="search"
          style={{ display: 'flex', flexWrap: 'wrap', gap: spacingTokens.xs }}
        >
          {status ? <input type="hidden" name="status" value={status} /> : null}
          <label
            htmlFor="customer-search"
            style={{
              position: 'absolute',
              inlineSize: 1,
              blockSize: 1,
              overflow: 'hidden',
              clip: 'rect(0 0 0 0)',
            }}
          >
            {copy('cust.search')}
          </label>
          <input
            id="customer-search"
            name="q"
            type="search"
            defaultValue={search}
            placeholder={copy('cust.search')}
            className="bs-control"
            style={{ ...inputStyle(), inlineSize: 'min(22rem, 100%)' }}
            data-testid="customer-search"
          />
          <button type="submit" className={buttonClass('neutral')} style={buttonStyle('neutral')}>
            {copy('cust.searchButton')}
          </button>
        </form>
        {actor.permissionKeys.includes('platform.workspace.create') ? (
          <ActionLink href={`${base}?view=new`} variant="primary" testId="customer-add">
            {copy('cust.add')}
          </ActionLink>
        ) : null}
      </div>

      <LinkTabs
        label={copy('cust.filter')}
        testId="customer-filters"
        currentId={status ?? 'all'}
        tabs={[
          { id: 'all', href: href({ status: null, page: null }), label: copy('cust.all') },
          ...FILTERS.map((filter) => ({
            id: filter,
            href: `${base}?${new URLSearchParams({ ...(search ? { q: search } : {}), status: filter }).toString()}`,
            label: copy(`ws.${filter}` as SimpleKey),
          })),
        ]}
      />

      {page.items.length === 0 ? (
        <Card testId="customers-empty">
          <p style={{ margin: 0, ...typographyTokens.bodySm }}>
            {search || status ? copy('cust.none') : copy('cust.noneYet')}
          </p>
        </Card>
      ) : (
        <ContentGrid min="17rem" testId="customer-cards">
          {page.items.map((workspace) => {
            const fact = facts.get(workspace.id);
            return (
              <Card key={workspace.id} testId={`customer-${workspace.slug}`}>
                <div style={{ display: 'grid', gap: spacingTokens.sm }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: spacingTokens.sm,
                      minInlineSize: 0,
                    }}
                  >
                    <Avatar
                      initials={initialsFrom(workspace.name)}
                      seed={avatarSeed(workspace.slug)}
                      shape="tile"
                    />
                    <div style={{ display: 'grid', minInlineSize: 0 }}>
                      <strong
                        style={{
                          ...typographyTokens.bodySm,
                          fontWeight: 700,
                          overflowWrap: 'anywhere',
                        }}
                      >
                        {workspace.name}
                      </strong>
                      <span style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
                        {planName(workspace.planKey)}
                      </span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: spacingTokens.xs }}>
                    <StatusBadge
                      label={statusWord(locale, workspace.status)}
                      tone={statusTone(workspace.status)}
                      dot
                      testId={`customer-${workspace.slug}-status`}
                    />
                    {fact?.trialEndsAt ? (
                      <StatusBadge
                        label={fill(copy('cust.trialEnds'), {
                          when: formatDay(locale, fact.trialEndsAt),
                        })}
                        tone="info"
                      />
                    ) : null}
                  </div>
                  <dl
                    style={{
                      margin: 0,
                      display: 'grid',
                      gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                      gap: spacingTokens.xs,
                      ...typographyTokens.caption,
                    }}
                  >
                    {[
                      [copy('cust.members'), formatCount(locale, workspace.memberCount)],
                      [copy('cust.brands'), formatCount(locale, fact?.brands ?? 0)],
                      [copy('cust.credits'), credits(locale, fact?.creditsMilli ?? null)],
                      [copy('cust.connections'), formatCount(locale, fact?.socialAccounts ?? 0)],
                    ].map(([term, value]) => (
                      <div
                        key={term}
                        style={{
                          padding: spacingTokens.xs,
                          borderRadius: radiusTokens.md,
                          background: colorTokens.surfaceSoft,
                        }}
                      >
                        <dt style={{ color: colorTokens.textMuted }}>{term}</dt>
                        <dd style={{ margin: 0, fontWeight: 700, color: colorTokens.textPrimary }}>
                          {value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <div>
                    <ActionLink
                      href={`${base}/${workspace.id}`}
                      testId={`customer-${workspace.slug}-open`}
                    >
                      {copy('cust.open')}
                    </ActionLink>
                  </div>
                </div>
              </Card>
            );
          })}
        </ContentGrid>
      )}

      {page.total > 0 ? (
        <nav
          aria-label={fill(copy('cust.range'), { from: page.from, to: page.to, total: page.total })}
          style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: spacingTokens.sm }}
        >
          <span
            style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}
            data-testid="customer-range"
          >
            {fill(copy('cust.range'), {
              from: formatCount(locale, page.from),
              to: formatCount(locale, page.to),
              total: formatCount(locale, page.total),
            })}
          </span>
          {page.hasPrevious ? (
            <ActionLink href={href({ page: page.page - 1 })}>{copy('cust.previous')}</ActionLink>
          ) : null}
          {page.hasNext ? (
            <ActionLink href={href({ page: page.page + 1 })}>{copy('cust.next')}</ActionLink>
          ) : null}
        </nav>
      ) : null}

      <div>
        <AdvancedLink
          locale={locale}
          href="/workspaces"
          label={copy('mode.technicalDetails')}
          testId="customers-technical"
        />
      </div>
    </Stack>
  );
}

/** Audit actions an owner cares about, by kind. Everything else stays in Advanced. */
function eventKind(action: string): SimpleKey | null {
  const a = action.toLowerCase();
  if (
    a.includes('suspend') ||
    a.includes('reactivat') ||
    /^platform\.workspace\.(active|trialing|past_due|cancelled|archived|suspended)$/.test(a)
  )
    return 'cd.event.status';
  if (a.includes('plan') || a.includes('subscription')) return 'cd.event.plan';
  if (a.includes('credit')) return 'cd.event.credit';
  if (a.includes('payment')) return 'cd.event.payment';
  if (a.includes('invoice')) return 'cd.event.invoice';
  if (a.includes('invitation') || a.includes('member')) return 'cd.event.member';
  if (a.includes('support')) return 'cd.event.support';
  if (a.includes('social') || a.includes('connection')) return 'cd.event.social';
  return null;
}

export async function SimpleCustomerDetail({
  locale,
  actor,
  workspaceId,
  query,
}: {
  readonly locale: string;
  readonly actor: AuthenticatedPlatformActor;
  readonly workspaceId: string;
  readonly query: Record<string, string | string[] | undefined>;
}) {
  const copy = simpleCopy(locale);
  const base = `/${locale}/console/workspaces`;
  const workspaceService = getWorkspaceService();
  const workspace = await workspaceService.get(serviceActor(actor), workspaceId).catch(() => null);
  if (!workspace) notFound();

  const prisma = getPlatformPrisma();
  const entitlements = getEntitlementService();
  const [
    members,
    subscription,
    wallet,
    activity,
    counters,
    effective,
    brands,
    connections,
    catalogue,
    entitlementDoc,
  ] = await Promise.all([
    getMembershipService().list(workspaceId),
    getSubscriptionService().get(workspaceId),
    getCreditService().wallet(workspaceId),
    workspaceService.recentActivity(serviceActor(actor), workspaceId, 40),
    new UsageService({ prisma }).currentCounters(workspaceId),
    entitlements.resolveAll(workspaceId),
    prisma.brand.findMany({
      where: { workspaceId, status: { not: 'ARCHIVED' } },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
      take: 50,
    }),
    prisma.socialConnection.findMany({
      where: { workspaceId },
      orderBy: { displayName: 'asc' },
      select: { id: true, provider: true, displayName: true, status: true },
      take: 50,
    }),
    getPlanCatalogue(),
    getConfigService().get('entitlements', currentEnvironment()),
  ]);

  const may = (key: string) => actor.permissionKeys.includes(key);
  const planName = (key: string | null) => {
    if (!key) return copy('cust.noPlan');
    const plan = catalogue.plans.find((candidate) => candidate.key === key);
    return plan ? (locale === 'ar' ? plan.nameAr : plan.nameEn) : key;
  };
  const featureName = (key: string) => {
    const feature = entitlementDoc.features.find((candidate) => candidate.key === key);
    return feature ? (locale === 'ar' ? feature.name.ar : feature.name.en) : null;
  };
  const { ok, error, ref } = flash(query);

  const needsReauth = connections.filter(
    (connection) => connection.status === 'NEEDS_REAUTH',
  ).length;
  const issues: string[] = [];
  if (workspace.status === 'PAST_DUE') issues.push(copy('cd.issue.pastDue'));
  if (workspace.status === 'SUSPENDED') issues.push(copy('cd.issue.suspended'));
  if (subscription?.status === 'TRIALING' && subscription.trialEndsAt) {
    issues.push(
      fill(copy('cd.issue.trial'), { when: formatDay(locale, subscription.trialEndsAt) }),
    );
  }
  if (needsReauth > 0) issues.push(fill(copy('cd.issue.reauth'), { count: needsReauth }));
  if (wallet.balanceMilliCredits <= 0n) issues.push(copy('cd.issue.noCredits'));

  const usage = counters
    .map((counter) => {
      const name = featureName(counter.featureKey);
      if (!name) return null;
      const decision = effective.decisions.find((d) => d.featureKey === counter.featureKey);
      return {
        key: counter.featureKey,
        name,
        text:
          decision?.limitValue !== null && decision?.limitValue !== undefined
            ? fill(copy('cd.usageOf'), {
                used: formatCount(locale, counter.used),
                limit: formatCount(locale, decision.limitValue),
              })
            : fill(copy('cd.usageUnlimited'), { used: formatCount(locale, counter.used) }),
      };
    })
    .filter((row): row is { key: string; name: string; text: string } => row !== null);

  const events = activity
    .map((event) => ({ ...event, kind: eventKind(event.action) }))
    .filter((event): event is typeof event & { kind: SimpleKey } => event.kind !== null)
    .slice(0, 8);

  const rowStyle = {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: spacingTokens.xs,
    padding: spacingTokens.sm,
    borderRadius: radiusTokens.control,
    background: colorTokens.surfaceSoft,
    ...typographyTokens.bodySm,
  } as const;
  const listStyle = {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'grid',
    gap: spacingTokens.xs,
  } as const;
  const hidden = (
    <>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="workspaceId" value={workspaceId} />
    </>
  );
  const reasonField = (id: string) => (
    <Field label={copy('common.reason')} htmlFor={id} hint={copy('common.reasonHint')}>
      <input
        className="bs-control"
        id={id}
        name="reason"
        required
        minLength={8}
        style={{ ...inputStyle(), maxInlineSize: '28rem' }}
        data-testid={id}
      />
    </Field>
  );
  const suspended = workspace.status === 'SUSPENDED';
  const mayChangeStatus =
    may('platform.workspace.suspend') &&
    ['TRIALING', 'ACTIVE', 'PAST_DUE', 'SUSPENDED'].includes(workspace.status);
  const anyAction = may('platform.plan.assign') || may('platform.credit.adjust') || mayChangeStatus;

  return (
    <Stack>
      <p style={{ margin: 0 }}>
        <ActionLink href={base} variant="ghost" testId="customer-back">
          {copy('cd.back')}
        </ActionLink>
      </p>
      <ActionOutcome
        locale={locale}
        ok={ok}
        error={error}
        reference={ref}
        okText={(code) =>
          ['STATUS_CHANGED', 'PLAN_ASSIGNED', 'CREDITS_ADJUSTED'].includes(code)
            ? copy(`cd.ok.${code}` as SimpleKey)
            : null
        }
      />
      <div
        style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: spacingTokens.sm }}
      >
        <Avatar
          initials={initialsFrom(workspace.name)}
          seed={avatarSeed(workspace.slug)}
          shape="tile"
        />
        <h2
          style={{ margin: 0, ...typographyTokens.h3, overflowWrap: 'anywhere' }}
          data-testid="customer-name"
        >
          {workspace.name}
        </h2>
        <StatusBadge
          label={statusWord(locale, workspace.status)}
          tone={statusTone(workspace.status)}
          dot
          testId="customer-status"
        />
      </div>

      <SimpleSection title={copy('cd.issues')} testId="customer-issues">
        {issues.length === 0 ? (
          <p style={{ margin: 0, ...typographyTokens.bodySm }}>{copy('cd.issuesNone')}</p>
        ) : (
          <ul style={listStyle}>
            {issues.map((issue) => (
              <li key={issue} style={rowStyle}>
                {issue}
              </li>
            ))}
          </ul>
        )}
      </SimpleSection>

      <ContentGrid min="16rem" testId="customer-summary">
        <Card title={copy('cd.account')} testId="customer-account">
          <dl
            style={{
              margin: 0,
              display: 'grid',
              gap: spacingTokens.xs,
              ...typographyTokens.bodySm,
            }}
          >
            {[
              [copy('cd.owner'), workspace.ownerEmail ?? '—'],
              [copy('cd.country'), workspace.country],
              [copy('cd.created'), formatDay(locale, workspace.createdAt)],
              [
                copy('cd.lastActive'),
                workspace.lastActivityAt
                  ? formatDay(locale, workspace.lastActivityAt)
                  : copy('cd.never'),
              ],
            ].map(([term, value]) => (
              <div
                key={term}
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  justifyContent: 'space-between',
                  gap: spacingTokens.xs,
                }}
              >
                <dt style={{ color: colorTokens.textMuted }}>{term}</dt>
                <dd style={{ margin: 0, fontWeight: 600, overflowWrap: 'anywhere' }}>{value}</dd>
              </div>
            ))}
          </dl>
        </Card>
        <Card title={copy('cd.planTitle')} testId="customer-plan">
          <div style={{ display: 'grid', gap: spacingTokens.xs, ...typographyTokens.bodySm }}>
            <strong style={typographyTokens.h3}>{planName(workspace.planKey)}</strong>
            {subscription ? (
              <>
                <span>
                  {copy('cd.subscription')}: {copy(`sub.${subscription.status}` as SimpleKey)}
                </span>
                <span style={{ color: colorTokens.textSecondary }}>
                  {fill(copy('cd.renews'), {
                    when: formatDay(locale, subscription.currentPeriodEnd),
                  })}
                </span>
                {subscription.cancelAtPeriodEnd ? <span>{copy('cd.cancelAtEnd')}</span> : null}
              </>
            ) : (
              <span style={{ color: colorTokens.textSecondary }}>{copy('cd.noSubscription')}</span>
            )}
          </div>
        </Card>
        <MetricCard
          testId="customer-credits"
          label={copy('cd.creditsBalance')}
          value={credits(locale, wallet.balanceMilliCredits)}
        />
      </ContentGrid>

      <SimpleSection title={copy('cd.usage')} testId="customer-usage">
        {usage.length === 0 ? (
          <p style={{ margin: 0, ...typographyTokens.bodySm }}>{copy('cd.usageNone')}</p>
        ) : (
          <ul style={listStyle}>
            {usage.map((row) => (
              <li key={row.key} style={rowStyle}>
                <span style={{ fontWeight: 600 }}>{row.name}</span>
                <span>{row.text}</span>
              </li>
            ))}
          </ul>
        )}
      </SimpleSection>

      <ContentGrid min="16rem">
        <Card
          title={`${copy('cd.brandsTitle')} · ${formatCount(locale, brands.length)}`}
          testId="customer-brands"
        >
          {brands.length === 0 ? (
            <p style={{ margin: 0, ...typographyTokens.bodySm }}>{copy('cd.brandsNone')}</p>
          ) : (
            <ul style={listStyle}>
              {brands.map((brand) => (
                <li key={brand.id} style={rowStyle}>
                  {brand.name}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card
          title={`${copy('cd.membersTitle')} · ${formatCount(locale, members.length)}`}
          testId="customer-members"
        >
          <ul style={listStyle}>
            {members.slice(0, 20).map((member) => (
              <li key={member.membershipId} style={rowStyle}>
                <span style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
                  {member.name ?? member.email}
                </span>
                <span style={{ color: colorTokens.textSecondary }}>
                  {locale === 'ar' ? member.roleNameAr : member.roleNameEn}
                </span>
              </li>
            ))}
          </ul>
        </Card>
        <Card title={copy('cd.connectionsTitle')} testId="customer-connections">
          {connections.length === 0 ? (
            <p style={{ margin: 0, ...typographyTokens.bodySm }}>{copy('cd.connectionsNone')}</p>
          ) : (
            <ul style={listStyle}>
              {connections.map((connection) => (
                <li key={connection.id} style={rowStyle}>
                  <span style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
                    {connection.displayName}
                  </span>
                  <span style={{ color: colorTokens.textSecondary }}>
                    {copy(
                      (['ACTIVE', 'PENDING', 'NEEDS_REAUTH'].includes(connection.status)
                        ? `cd.conn.${connection.status}`
                        : 'cd.conn.other') as SimpleKey,
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </ContentGrid>

      <SimpleSection title={copy('cd.events')} testId="customer-events">
        {events.length === 0 ? (
          <p style={{ margin: 0, ...typographyTokens.bodySm }}>{copy('cd.eventsNone')}</p>
        ) : (
          <ul style={listStyle}>
            {events.map((event) => (
              <li key={event.id} style={rowStyle}>
                <span style={{ fontWeight: 600 }}>{copy(event.kind)}</span>
                <span style={{ color: colorTokens.textSecondary }}>
                  {formatDay(locale, event.occurredAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SimpleSection>

      <SimpleSection title={copy('cd.actions')} testId="customer-actions">
        {!anyAction ? (
          <p style={{ margin: 0, ...typographyTokens.bodySm }}>{copy('cd.forbidden')}</p>
        ) : (
          <ContentGrid min="18rem">
            {may('platform.plan.assign') ? (
              <Card
                title={copy('cd.changePlan')}
                description={copy('cd.changePlanHint')}
                testId="customer-change-plan"
              >
                <form action={assignPlanAction} style={{ display: 'grid', gap: spacingTokens.xs }}>
                  {hidden}
                  <Field label={copy('cd.choosePlan')} htmlFor="simple-plan">
                    <select
                      id="simple-plan"
                      name="planKey"
                      defaultValue={workspace.planKey ?? ''}
                      className="bs-control"
                      style={{ ...inputStyle(), maxInlineSize: '28rem' }}
                      data-testid="simple-plan"
                    >
                      {catalogue.plans
                        .filter(
                          (plan) => plan.status === 'active' || plan.key === workspace.planKey,
                        )
                        .map((plan) => (
                          <option key={plan.key} value={plan.key}>
                            {locale === 'ar' ? plan.nameAr : plan.nameEn}
                          </option>
                        ))}
                      <option value="">{copy('cd.planNoneOption')}</option>
                    </select>
                  </Field>
                  {reasonField('plan-reason')}
                  <div>
                    <button
                      type="submit"
                      className={buttonClass('primary')}
                      style={buttonStyle('primary')}
                      data-testid="simple-plan-submit"
                    >
                      {copy('cd.apply')}
                    </button>
                  </div>
                </form>
              </Card>
            ) : null}
            {may('platform.credit.adjust') ? (
              <Card
                title={copy('cd.adjustCredits')}
                description={copy('cd.adjustHint')}
                testId="customer-adjust-credits"
              >
                <form
                  action={adjustCreditsAction}
                  style={{ display: 'grid', gap: spacingTokens.xs }}
                >
                  {hidden}
                  {/* One key per render: a double submit replays the same adjustment. */}
                  <input type="hidden" name="idempotencyKey" value={randomUUID()} />
                  <Field label={copy('cd.creditsAmount')} htmlFor="simple-credits">
                    <input
                      id="simple-credits"
                      name="credits"
                      type="number"
                      step={1}
                      required
                      className="bs-control"
                      style={{ ...inputStyle(), maxInlineSize: '12rem' }}
                      data-testid="simple-credits"
                    />
                  </Field>
                  {reasonField('credits-reason')}
                  <div>
                    <button
                      type="submit"
                      className={buttonClass('primary')}
                      style={buttonStyle('primary')}
                      data-testid="simple-credits-submit"
                    >
                      {copy('cd.apply')}
                    </button>
                  </div>
                </form>
              </Card>
            ) : null}
            {mayChangeStatus ? (
              <Card
                title={suspended ? copy('cd.reactivate') : copy('cd.suspend')}
                description={suspended ? copy('cd.reactivateHint') : copy('cd.suspendHint')}
                testId="customer-status-change"
              >
                <form
                  action={changeStatusAction}
                  style={{ display: 'grid', gap: spacingTokens.xs }}
                >
                  {hidden}
                  <input
                    type="hidden"
                    name="nextStatus"
                    value={suspended ? 'ACTIVE' : 'SUSPENDED'}
                  />
                  <input type="hidden" name="lockVersion" value={workspace.lockVersion} />
                  {reasonField('status-reason')}
                  {suspended ? null : (
                    <label
                      style={{
                        display: 'flex',
                        gap: spacingTokens.xs,
                        alignItems: 'start',
                        ...typographyTokens.bodySm,
                      }}
                    >
                      <input type="checkbox" required data-testid="suspend-confirm" />
                      {fill(copy('cd.suspendConfirm'), { name: workspace.name })}
                    </label>
                  )}
                  <div>
                    <button
                      type="submit"
                      className={buttonClass(suspended ? 'primary' : 'danger')}
                      style={buttonStyle(suspended ? 'primary' : 'danger')}
                      data-testid="simple-status-submit"
                    >
                      {suspended ? copy('cd.reactivate') : copy('cd.suspend')}
                    </button>
                  </div>
                </form>
              </Card>
            ) : null}
          </ContentGrid>
        )}
      </SimpleSection>

      <div>
        <AdvancedLink
          locale={locale}
          href={`/workspaces/${workspaceId}`}
          label={copy('mode.technicalDetails')}
          testId="customer-technical"
        />
      </div>
    </Stack>
  );
}
