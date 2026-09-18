import { colorTokens, scrollContainerStyle, spacingTokens, typographyTokens } from '@brandspace/ui';
import { inWorkspace, requireWorkspace } from '../../../server/customer-context';
import { brandContextFor } from '../../../server/brand-context';
import { translator } from '../../../i18n/messages';
import {
  CustomerCard,
  CustomerEmpty,
  WorkspaceShell,
  customerTableStyle,
  customerTdStyle,
  customerThStyle,
} from '../../../components/workspace-shell';

export const dynamic = 'force-dynamic';

/**
 * Plan, effective features, limits and the AI credit balance.
 *
 * Every value is resolved by the SAME precedence engine the Control Center
 * uses, so a customer and an operator looking at the same workspace can never
 * be shown different answers.
 *
 * Where nothing is configured the page says so. It does not fill the gap with a
 * plausible zero — that is exactly the kind of invented number that gets acted
 * on.
 */
export default async function PlanPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = translator(locale);
  const { customer, workspace } = await requireWorkspace(locale, 'billing.read');

  // Inside the tenant context: the overrides and the wallet are tenant-owned,
  // and the catalogue comes through the allow-listed configuration function.
  const mayReadCredits = workspace.permissionKeys.includes('credits.read');
  const mayReadBilling = workspace.permissionKeys.includes('billing.read');

  const { effective, wallet, grants, ledger, subscription, counters } = await inWorkspace(
    workspace.workspaceId,
    async ({ entitlements, credits, ledger: creditLedger, subscriptions, usage }) => ({
      effective: await entitlements.resolveAll(workspace.workspaceId),
      // Credits are gated on their own permission, not on being signed in: a
      // member without `credits.read` sees the page without the balance.
      wallet: mayReadCredits ? await credits.wallet(workspace.workspaceId) : null,
      grants: mayReadCredits ? await creditLedger.grants(workspace.workspaceId) : [],
      ledger: mayReadCredits ? await credits.ledger(workspace.workspaceId, 10) : [],
      subscription: mayReadBilling ? await subscriptions.get(workspace.workspaceId) : null,
      counters: await usage.currentCounters(workspace.workspaceId),
    }),
  );

  const memberCount = await inWorkspace(workspace.workspaceId, async ({ db }) =>
    db.membership.count({ where: { workspaceId: workspace.workspaceId, status: 'ACTIVE' } }),
  );

  const laterPhase = t('overview.metric.laterPhase');
  const usageRows: readonly {
    readonly key: string;
    readonly label: string;
    readonly value: string | null;
    readonly unavailable: string;
    /* The hook stays on the value that answers "what is the balance". */
    readonly valueTestId?: string;
  }[] = [
    {
      key: 'credits',
      label: t('plan.credits'),
      value: wallet ? String(wallet.balanceCredits) : null,
      unavailable: t('overview.metric.hidden'),
      valueTestId: 'credit-balance',
    },
    {
      key: 'members',
      label: t('overview.metric.members'),
      value: String(memberCount),
      unavailable: laterPhase,
    },
    {
      key: 'scheduled',
      label: t('plan.usageScheduled'),
      value: null,
      unavailable: laterPhase,
    },
    { key: 'storage', label: t('plan.usageStorage'), value: null, unavailable: laterPhase },
  ];

  // The capabilities this workspace does not have. Quota dimensions are
  // excluded: "you do not have limit.seats" is not a capability a customer
  // recognises, and it would bury the three or four that matter.
  const unavailable = effective.decisions.filter(
    (decision) => !decision.enabled && !decision.featureKey.startsWith('limit.'),
  );

  const brandContext = await brandContextFor(workspace, '/plan');

  return (
    <WorkspaceShell
      brandContext={brandContext}
      locale={locale}
      heading={t('plan.title')}
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      {/*
        `.dashboard-grid { grid-template-columns: 1.25fr .75fr }` — the plan on
        one side, this cycle's usage on the other, which is how the demo
        composes this screen. Three full-width cards stacked down the page was
        neither its shape nor its rhythm.

        The demo fills its usage list with figures (700/1,000 credits, 12
        scheduled posts, 2.8 GB) that this workspace does not have. Only the
        two that are REAL are shown as numbers — the credit balance from the
        ledger and the member count — and the rest say what they will hold and
        that nothing holds it yet (§33). The rows keep the demo's `.list-item`
        geometry either way.
      */}
      <div className="bs-split-main">
        <CustomerCard title={t('plan.current')} testId="plan-card">
          <p data-testid="current-plan" style={{ marginBlockStart: 0, ...typographyTokens.h3 }}>
            {effective.planKey ?? t('plan.none')}
          </p>

          {/* Trial and cycle come from the subscription, which is the record
              that also pins the agreed price — so what is shown here cannot
              drift from what the customer actually agreed to. */}
          {subscription ? (
            <dl style={{ margin: 0, display: 'grid', gap: spacingTokens.xs }}>
              <div
                style={{ display: 'flex', justifyContent: 'space-between', gap: spacingTokens.sm }}
              >
                <dt style={{ ...typographyTokens.bodySm, color: colorTokens.textSecondary }}>
                  {t('plan.trial')}
                </dt>
                <dd
                  data-testid="trial-status"
                  style={{ margin: 0, ...typographyTokens.caption, textAlign: 'end' }}
                >
                  {subscription.trialEndsAt && subscription.status === 'TRIALING'
                    ? `${t('plan.trialEnds')} ${subscription.trialEndsAt.toISOString().slice(0, 10)}`
                    : t('plan.trialNone')}
                </dd>
              </div>
              <div
                style={{ display: 'flex', justifyContent: 'space-between', gap: spacingTokens.sm }}
              >
                <dt style={{ ...typographyTokens.bodySm, color: colorTokens.textSecondary }}>
                  {t('plan.cycle')}
                </dt>
                <dd
                  data-testid="billing-cycle"
                  style={{ margin: 0, ...typographyTokens.caption, textAlign: 'end' }}
                >
                  {subscription.currentPeriodStart.toISOString().slice(0, 10)} →{' '}
                  {subscription.currentPeriodEnd.toISOString().slice(0, 10)}
                </dd>
              </div>
            </dl>
          ) : mayReadBilling ? (
            <p
              data-testid="no-subscription"
              style={{ margin: 0, ...typographyTokens.caption, color: colorTokens.textMuted }}
            >
              {t('plan.noSubscription')}
            </p>
          ) : null}
        </CustomerCard>

        <CustomerCard title={t('plan.usageTitle')} testId="usage-card">
          <dl style={{ margin: 0, display: 'grid' }}>
            {usageRows.map((row, index) => (
              <div
                key={row.key}
                data-testid={`usage-${row.key}`}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  gap: spacingTokens.sm,
                  paddingBlock: spacingTokens.sm,
                  borderBlockStart: index === 0 ? 'none' : `1px solid ${colorTokens.hairline}`,
                }}
              >
                <dt style={{ ...typographyTokens.bodySm, color: colorTokens.textPrimary }}>
                  {row.label}
                </dt>
                <dd
                  data-testid={row.value === null ? undefined : row.valueTestId}
                  style={{
                    margin: 0,
                    ...typographyTokens.caption,
                    color: row.value === null ? colorTokens.textMuted : colorTokens.textPrimary,
                    fontWeight: row.value === null ? 400 : 700,
                    textAlign: 'end',
                  }}
                >
                  {row.value ?? row.unavailable}
                </dd>
              </div>
            ))}
          </dl>
        </CustomerCard>
      </div>

      {/* --- Credit allocations (Phase 3) ------------------------------- */}
      {mayReadCredits ? (
        <CustomerCard title={t('plan.allocations')} testId="allocations-card">
          {grants.length === 0 ? (
            <CustomerEmpty message={t('plan.allocNone')} />
          ) : (
            <div style={scrollContainerStyle()}>
              <table style={customerTableStyle()} data-testid="allocations-table">
                <thead>
                  <tr>
                    <th style={customerThStyle()}>{t('plan.allocSource')}</th>
                    <th style={customerThStyle()}>{t('plan.allocRemaining')}</th>
                    <th style={customerThStyle()}>{t('plan.reserved')}</th>
                    <th style={customerThStyle()}>{t('plan.allocExpires')}</th>
                  </tr>
                </thead>
                <tbody>
                  {grants.map((grant) => (
                    <tr key={grant.id} data-testid={`allocation-${grant.id}`}>
                      <td style={customerTdStyle()}>{grant.source}</td>
                      <td style={customerTdStyle()}>
                        {Number(grant.remainingMilliCredits / 1000n)}
                      </td>
                      <td style={customerTdStyle()}>
                        {Number(grant.reservedMilliCredits / 1000n)}
                      </td>
                      <td style={customerTdStyle()}>
                        {grant.expiresAt
                          ? grant.expiresAt.toISOString().slice(0, 10)
                          : t('plan.allocNever')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p
            data-testid="alloc-note"
            style={{
              marginBlockEnd: 0,
              ...typographyTokens.caption,
              color: colorTokens.textSecondary,
            }}
          >
            {t('plan.allocNote')}
          </p>
          {/* D-11, stated plainly. A customer who does not know the platform
              hard-stops will assume it bills them instead. */}
          <p
            data-testid="hard-stop-note"
            style={{
              marginBlockEnd: 0,
              ...typographyTokens.caption,
              color: colorTokens.textSecondary,
            }}
          >
            {t('plan.hardStop')}
          </p>
        </CustomerCard>
      ) : null}

      {/* --- Usage against limits (Phase 3) ------------------------------ */}
      <CustomerCard title={t('plan.quotaTitle')} testId="quota-card">
        {counters.length === 0 ? (
          <CustomerEmpty message={t('plan.quotaNone')} />
        ) : (
          <div style={scrollContainerStyle()}>
            <table style={customerTableStyle()} data-testid="quota-table">
              <thead>
                <tr>
                  <th style={customerThStyle()}>{t('plan.features')}</th>
                  <th style={customerThStyle()}>{t('plan.quotaUsed')}</th>
                  <th style={customerThStyle()}>{t('plan.limit')}</th>
                </tr>
              </thead>
              <tbody>
                {counters.map((counter) => {
                  const decision = effective.decisions.find(
                    (d) => d.featureKey === counter.featureKey,
                  );
                  return (
                    <tr key={counter.featureKey} data-testid={`quota-${counter.featureKey}`}>
                      <td style={customerTdStyle()}>{counter.featureKey}</td>
                      <td style={customerTdStyle()}>{counter.used}</td>
                      <td style={customerTdStyle()}>
                        {decision?.limitValue ?? t('plan.unlimited')}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CustomerCard>

      {/* --- Credit history (Phase 3) ------------------------------------ */}
      {mayReadCredits ? (
        <CustomerCard title={t('plan.history')} testId="credit-history-card">
          {ledger.length === 0 ? (
            <CustomerEmpty message={t('plan.historyNone')} />
          ) : (
            <div style={scrollContainerStyle()}>
              <table style={customerTableStyle()} data-testid="credit-history-table">
                <tbody>
                  {ledger.map((entry) => (
                    <tr key={entry.id} data-testid={`ledger-${entry.id}`}>
                      <td style={customerTdStyle()}>
                        {entry.occurredAt.toISOString().slice(0, 10)}
                      </td>
                      <td style={customerTdStyle()}>{Number(entry.amountMilliCredits / 1000n)}</td>
                      <td style={customerTdStyle()}>{entry.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CustomerCard>
      ) : null}

      <CustomerCard title={t('plan.features')} testId="features-card">
        {effective.decisions.length === 0 ? (
          <CustomerEmpty message={t('plan.noFeatures')} />
        ) : (
          <div style={scrollContainerStyle()}>
            <table style={customerTableStyle()} data-testid="features-table">
              <thead>
                <tr>
                  <th style={customerThStyle()}>{t('plan.features')}</th>
                  <th style={customerThStyle()}>{t('members.status')}</th>
                  <th style={customerThStyle()}>{t('plan.limit')}</th>
                </tr>
              </thead>
              <tbody>
                {effective.decisions.map((d) => (
                  <tr key={d.featureKey} data-testid={`feature-${d.featureKey}`}>
                    <td style={customerTdStyle()}>{d.featureKey}</td>
                    <td style={customerTdStyle()}>
                      {d.enabled ? t('common.enabled') : t('common.disabled')}
                    </td>
                    <td style={customerTdStyle()}>{d.limitValue ?? t('plan.unlimited')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CustomerCard>

      {/* --- The upgrade prompt (Phase 3) -------------------------------- */}
      {/*
        WHAT THIS DELIBERATELY DOES NOT SAY. It names the capabilities this
        workspace does not have, and nothing else: not which plan would grant
        them, not what that plan costs, not what any limit is set to. Those are
        commercial configuration, and a customer-facing surface that reads them
        out is a configuration leak (CLAUDE.md §2.3). The route to a change is a
        conversation, not a number rendered from the plan catalogue.
      */}
      {unavailable.length > 0 ? (
        <CustomerCard title={t('plan.upgradeTitle')} testId="upgrade-card">
          <p style={{ marginBlockStart: 0, ...typographyTokens.bodySm }}>{t('plan.upgradeBody')}</p>
          <ul
            data-testid="upgrade-list"
            style={{ margin: 0, paddingInlineStart: spacingTokens.lg }}
          >
            {unavailable.map((decision) => (
              <li
                key={decision.featureKey}
                data-testid={`upgrade-${decision.featureKey}`}
                style={{ ...typographyTokens.bodySm, color: colorTokens.textSecondary }}
              >
                {decision.featureKey}
              </li>
            ))}
          </ul>
        </CustomerCard>
      ) : null}
    </WorkspaceShell>
  );
}
