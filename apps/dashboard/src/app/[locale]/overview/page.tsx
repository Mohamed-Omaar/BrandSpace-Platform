import Link from 'next/link';
import { colorTokens, spacingTokens } from '@brandspace/ui';
import { inWorkspace, requireWorkspace } from '../../../server/customer-context';
import { translator } from '../../../i18n/messages';
import { CustomerCard, WorkspaceShell } from '../../../components/workspace-shell';

export const dynamic = 'force-dynamic';

/**
 * The authenticated workspace home.
 *
 * Deliberately sparse: the Command Center widgets in docs/PRODUCT.md §5.1 need
 * content, publishing and analytics data that Phase 2B does not create. Showing
 * an empty "Publishing today" card would be a fabricated surface, so the page
 * shows only what genuinely exists — who you are, where you are, and what your
 * workspace is entitled to.
 */
export default async function OverviewPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = translator(locale);
  const { customer, workspace } = await requireWorkspace(locale);

  const maySeeBilling = workspace.permissionKeys.includes('billing.read');
  const { effective, wallet } = await inWorkspace(
    workspace.workspaceId,
    async ({ entitlements, credits }) => ({
      effective: maySeeBilling ? await entitlements.resolveAll(workspace.workspaceId) : null,
      wallet: workspace.permissionKeys.includes('credits.read')
        ? await credits.wallet(workspace.workspaceId)
        : null,
    }),
  );

  return (
    <WorkspaceShell
      locale={locale}
      heading={t('nav.overview')}
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      permissionKeys={workspace.permissionKeys}
    >
      <CustomerCard testId="overview-identity">
        <p style={{ marginBlockStart: 0 }} data-testid="signed-in-as">
          {customer.email}
        </p>
        <p style={{ marginBlockEnd: 0, color: colorTokens.textSecondary }}>
          {workspace.workspaceName} ·{' '}
          {locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
        </p>
      </CustomerCard>

      {maySeeBilling && effective && (
        <CustomerCard title={t('plan.current')} testId="overview-plan">
          <p style={{ marginBlockStart: 0 }} data-testid="overview-plan-key">
            {effective.planKey ?? t('plan.none')}
          </p>
          {wallet && (
            <p style={{ marginBlockEnd: 0 }}>
              {t('plan.credits')}:{' '}
              <strong data-testid="overview-credits">{wallet.balanceCredits}</strong>
            </p>
          )}
          <p style={{ marginBlockEnd: 0, marginBlockStart: spacingTokens.sm }}>
            <Link href={`/${locale}/plan`} style={{ color: colorTokens.brandPurple }}>
              {t('nav.plan')}
            </Link>
          </p>
        </CustomerCard>
      )}
    </WorkspaceShell>
  );
}
