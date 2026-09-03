import { colorTokens, scrollContainerStyle } from '@brandspace/ui';
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
  const { workspace } = await requireWorkspace(locale, 'billing.read');

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

  return (
    <WorkspaceShell
      locale={locale}
      heading={t('plan.title')}
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      permissionKeys={workspace.permissionKeys}
    >
      <CustomerCard title={t('plan.current')} testId="plan-card">
        <p data-testid="current-plan" style={{ marginBlockStart: 0, fontSize: '1.125rem' }}>
          {effective.planKey ?? t('plan.none')}
        </p>
      </CustomerCard>

      {wallet && (
        <CustomerCard title={t('plan.credits')} testId="credits-card">
          <p style={{ marginBlockStart: 0, fontSize: '1.75rem', fontWeight: 700 }}>
            <span data-testid="credit-balance">{wallet.balanceCredits}</span>{' '}
            <span style={{ fontSize: '0.875rem', color: colorTokens.textSecondary }}>
              {locale === 'ar' ? 'وحدة' : 'credits'}
            </span>
          </p>
        </CustomerCard>
      )}

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
