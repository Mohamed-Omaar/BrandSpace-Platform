import Link from 'next/link';
import {
  Card,
  ContentGrid,
  MetricCard,
  OverviewHero,
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
 * The authenticated workspace home, and the screen the approved direction is
 * judged on (§5 of the brief).
 *
 * THE LARGE OVERVIEW IS REPRODUCED, THE INVENTED DATA IS NOT. The reference's
 * hero, its four-across statistic row, its 1.45/0.8 split and its section
 * kickers are all here at the reference's scale. What is not here is the
 * reference's content: "12 scheduled", "03 in review", "28 published across 4
 * channels", "76% of AI credits, resets in 12 days", and two posts on a
 * calendar. There is no Post model, no connected account and no publishing
 * pipeline in this phase, so every one of those would be a fabricated
 * measurement — CLAUDE.md §2.2, and the reason this page has always shown
 * either a real figure or an explicit reason it is unavailable.
 *
 * So each panel says which of the three things is true: here is the real
 * number; you do not have permission to see it; or the capability has not
 * shipped yet. An empty state that names its reason is a finished screen. A
 * plausible-looking zero is not.
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

  /*
   * Both hero actions go somewhere real, and to a page the reader is actually
   * allowed to open — §20 forbids a dead button or a `#` placeholder, and a
   * primary action that lands on a 404 is worse than no primary action.
   */
  const primaryHref = maySeeMembers ? `/${locale}/members` : `/${locale}/settings`;
  const primaryLabel = maySeeMembers ? t('overview.hero.primary') : t('nav.settings');

  return (
    <WorkspaceShell
      locale={locale}
      activePath="/overview"
      heading={t('overview.greeting')}
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      permissionKeys={workspace.permissionKeys}
      hero={
        <OverviewHero
          isPageTitle
          eyebrow={workspace.workspaceName}
          title={t('overview.hero.title')}
          description={t('overview.hero.body')}
          primaryAction={
            <Link href={primaryHref} style={buttonStyle('primary')} data-testid="hero-primary">
              {primaryLabel}
            </Link>
          }
          secondaryAction={
            <Link
              href={`/${locale}/settings`}
              data-testid="hero-secondary"
              style={{
                ...buttonStyle('ghost'),
                background: 'transparent',
                color: colorTokens.textPrimary,
              }}
            >
              {t('overview.hero.secondary')}
              <span aria-hidden="true">→</span>
            </Link>
          }
        />
      }
    >
      <Stack>
        <ContentGrid min="12rem" testId="overview-metrics">
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
            testId="metric-published"
          />
        </ContentGrid>

        <div className="bs-split-main">
          <Stack>
            {/*
              The reference's "Next on your calendar". The composition is
              reproduced; the two posts inside it are not, because a scheduled
              post cannot exist before the schedule does.
            */}
            <Card testId="overview-upcoming">
              <SectionHeader
                eyebrow={t('overview.upcomingKicker')}
                title={t('overview.upcoming')}
              />
              <StateMessage
                title={t('overview.upcomingEmptyTitle')}
                description={t('overview.upcomingEmptyBody')}
              />
            </Card>

            <Card testId="overview-activity">
              <SectionHeader title={t('overview.activity')} />
              <StateMessage
                title={t('overview.activityEmptyTitle')}
                description={t('overview.activityEmptyBody')}
              />
            </Card>
          </Stack>

          <Stack>
            <Card testId="overview-copilot">
              <SectionHeader eyebrow={t('overview.copilotKicker')} title={t('overview.copilot')} />
              <StateMessage
                title={t('overview.copilotEmptyTitle')}
                description={t('overview.copilotEmptyBody')}
              />
            </Card>

            <Card testId="overview-identity">
              <SectionHeader
                title={t('overview.workspaceSection')}
                description={t('overview.workspaceSectionHint')}
                actions={
                  <StatusBadge
                    label={workspace.workspaceStatus}
                    tone={statusTone(workspace.workspaceStatus)}
                    testId={`workspace-status-${workspace.workspaceStatus}`}
                  />
                }
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
                  <div key={row.label} style={{ display: 'grid', gap: spacingTokens['3xs'] }}>
                    <dt
                      style={{
                        ...typographyTokens.caption,
                        color: colorTokens.textMuted,
                      }}
                    >
                      {row.label}
                    </dt>
                    <dd
                      data-testid={row.testId}
                      style={{
                        margin: 0,
                        ...typographyTokens.bodySm,
                        fontWeight: 600,
                        overflowWrap: 'anywhere',
                      }}
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
                  <Link href={`/${locale}/plan`} style={buttonStyle('neutral', 'sm')}>
                    {t('nav.plan')}
                  </Link>
                }
              >
                <p
                  style={{ margin: 0, ...typographyTokens.bodySm }}
                  data-testid="overview-plan-key"
                >
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
          </Stack>
        </div>
      </Stack>
    </WorkspaceShell>
  );
}
