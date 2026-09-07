import { colorTokens, scrollContainerStyle, spacingTokens, typographyTokens } from '@brandspace/ui';
import { inWorkspace, requireWorkspace } from '../../../server/customer-context';
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
  const { effective, wallet } = await inWorkspace(
    workspace.workspaceId,
    async ({ entitlements, credits }) => ({
      effective: await entitlements.resolveAll(workspace.workspaceId),
      wallet: workspace.permissionKeys.includes('credits.read')
        ? await credits.wallet(workspace.workspaceId)
        : null,
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

  return (
    <WorkspaceShell
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
    </WorkspaceShell>
  );
}
