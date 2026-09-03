import Link from 'next/link';
import {
  Card,
  ContentGrid,
  MetricCard,
  SectionHeader,
  Stack,
  StateMessage,
  StatusBadge,
  buttonStyle,
  colorTokens,
  spacingTokens,
  statusTone,
  typographyTokens,
} from '@brandspace/ui';
import { inWorkspace, requireWorkspace } from '../../../server/customer-context';
import { translator } from '../../../i18n/messages';
import { WorkspaceShell } from '../../../components/workspace-shell';

export const dynamic = 'force-dynamic';

/**
 * The authenticated workspace home.
 *
 * DELIBERATELY SPARSE, AND HONESTLY SO. The Command Center widgets in
 * docs/PRODUCT.md §5.1 need content, publishing and analytics data that no
 * phase has created yet. Phase 2C restyles this page; it does not invent
 * content for it. The metric cards below therefore show either a real figure or
 * an explicit "not available yet" — never a plausible-looking zero that a
 * reader would take for a measurement.
 */
export default async function OverviewPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = translator(locale);
  const { customer, workspace } = await requireWorkspace(locale);

  const maySeeBilling = workspace.permissionKeys.includes('billing.read');
  const maySeeCredits = workspace.permissionKeys.includes('credits.read');
  const maySeeMembers = workspace.permissionKeys.includes('member.read');

  const { effective, wallet, memberCount } = await inWorkspace(
    workspace.workspaceId,
    async ({ entitlements, credits, db }) => ({
      effective: maySeeBilling ? await entitlements.resolveAll(workspace.workspaceId) : null,
      wallet: maySeeCredits ? await credits.wallet(workspace.workspaceId) : null,
      memberCount: maySeeMembers
        ? await db.membership.count({
            where: { workspaceId: workspace.workspaceId, status: 'ACTIVE' },
          })
        : null,
    }),
  );

  return (
    <WorkspaceShell
      locale={locale}
      activePath="/overview"
      heading={t('overview.greeting')}
      description={customer.email}
      meta={
        <StatusBadge
          label={workspace.workspaceStatus}
          tone={statusTone(workspace.workspaceStatus)}
          testId={`workspace-status-${workspace.workspaceStatus}`}
        />
      }
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      permissionKeys={workspace.permissionKeys}
    >
      <Stack>
        <ContentGrid min="14rem" testId="overview-metrics">
          <MetricCard
            label={t('overview.metric.plan')}
            value={effective?.planKey ?? undefined}
            unavailable={!maySeeBilling || !effective?.planKey}
            unavailableLabel={maySeeBilling ? t('plan.none') : t('overview.metric.hidden')}
            hint={t('overview.metric.planHint')}
            testId="metric-plan"
          />
          <MetricCard
            label={t('overview.metric.credits')}
            value={wallet ? String(wallet.balanceCredits) : undefined}
            unavailable={!wallet}
            unavailableLabel={t('overview.metric.hidden')}
            hint={t('overview.metric.creditsHint')}
            testId="metric-credits"
          />
          <MetricCard
            label={t('overview.metric.members')}
            value={memberCount === null ? undefined : String(memberCount)}
            unavailable={memberCount === null}
            unavailableLabel={t('overview.metric.hidden')}
            testId="metric-members"
          />
          {/*
            Publishing is a Phase 3 capability. The card states that plainly
            rather than rendering a zero that would read as "you published
            nothing today" — a fabricated measurement of a feature that does
            not exist.
          */}
          <MetricCard
            label={t('overview.metric.published')}
            unavailable
            unavailableLabel={t('overview.metric.laterPhase')}
            accent
            testId="metric-published"
          />
        </ContentGrid>

        <Card testId="overview-identity">
          <SectionHeader
            title={t('overview.workspaceSection')}
            description={t('overview.workspaceSectionHint')}
          />
          <dl style={{ margin: 0, display: 'grid', gap: spacingTokens.sm }}>
            {[
              {
                label: t('overview.field.signedInAs'),
                value: customer.email,
                testId: 'signed-in-as',
              },
              { label: t('overview.field.workspace'), value: workspace.workspaceName },
              {
                label: t('overview.field.role'),
                value: locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn,
              },
            ].map((row) => (
              <div
                key={row.label}
                style={{ display: 'flex', flexWrap: 'wrap', gap: spacingTokens.sm }}
              >
                <dt
                  style={{
                    ...typographyTokens.label,
                    color: colorTokens.textSecondary,
                    minInlineSize: '9rem',
                  }}
                >
                  {row.label}
                </dt>
                <dd
                  data-testid={row.testId}
                  style={{ margin: 0, ...typographyTokens.bodySm, overflowWrap: 'anywhere' }}
                >
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        </Card>

        {maySeeBilling && effective ? (
          <Card
            title={t('plan.current')}
            testId="overview-plan"
            actions={
              <Link href={`/${locale}/plan`} style={buttonStyle('secondary', 'sm')}>
                {t('nav.plan')}
              </Link>
            }
          >
            <p style={{ margin: 0, ...typographyTokens.bodySm }} data-testid="overview-plan-key">
              {effective.planKey ?? t('plan.none')}
            </p>
            {wallet ? (
              <p style={{ marginBlockEnd: 0, ...typographyTokens.bodySm }}>
                {t('plan.credits')}:{' '}
                <strong data-testid="overview-credits">{wallet.balanceCredits}</strong>
              </p>
            ) : null}
          </Card>
        ) : null}

        {/*
          The activity feed is Phase 3 work. An empty state that names the
          reason is the honest surface; a placeholder chart would not be.
        */}
        <Card title={t('overview.activity')} testId="overview-activity">
          <StateMessage
            title={t('overview.activityEmptyTitle')}
            description={t('overview.activityEmptyBody')}
          />
        </Card>
      </Stack>
    </WorkspaceShell>
  );
}
