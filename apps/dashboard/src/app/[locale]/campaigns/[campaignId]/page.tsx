import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  Card,
  Cell,
  DataTable,
  MetricCard,
  Row,
  SectionHeader,
  StateMessage,
  StatusBadge,
  buttonStyle,
  colorTokens,
  spacingTokens,
  statusTone,
  typographyTokens,
} from '@brandspace/ui';
import { isAppError, systemClock } from '@brandspace/shared';
import { requireWorkspace } from '../../../../server/customer-context';
import { brandContextFor } from '../../../../server/brand-context';
import { inContentStudio } from '../../../../server/content-context';
import { inAnalytics } from '../../../../server/analytics-context';
import { statusMessage, translator } from '../../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../../components/workspace-shell';
import { NotesPanel } from '../../../../components/notes-panel';
import { archiveCampaignAction, updateCampaignAction } from '../actions';
import { CampaignFormView } from '../campaign-form-view';
import {
  contentStatusLabel,
  dateInputValue,
  formLabels,
  objectiveLabel,
  periodLabel,
  statusLabel,
} from '../labels';
import { briefFrom } from '../../../../server/campaign-form';

export const dynamic = 'force-dynamic';

/**
 * ONE CAMPAIGN: its details, its content, and its performance (AC-26.2 … 26.4).
 *
 * THE CAMPAIGN'S OWN BRAND DECIDES, NOT THE RAIL (D-190). An existing object
 * belongs to the brand stored on it, and global context never reinterprets
 * that — so this page reads `campaign.brandId` and passes it to the analytics
 * scope rather than asking the selector which brand the reader is "on".
 *
 * PERFORMANCE IS THE EXISTING ANALYTICS STACK, NARROWED. `AnalyticsScope`
 * already carries `campaignId` and `MetricObservation` already joins through
 * `content_item.campaignId`, so this is one `summary()` call with a scope —
 * not a second analytics implementation, which is what the phase brief rules
 * out and what a campaign-specific aggregation would have become.
 *
 * FOUR HEADLINE FIGURES, and a missing one reads as missing. `MetricValue.value`
 * is null for "no observation", which is not zero, and the card says so.
 */
const HEADLINE_METRICS = ['impressions', 'reach', 'engagements', 'engagement_rate'] as const;
const WINDOW_DAYS = 30;

export default async function CampaignDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; campaignId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, campaignId } = await params;
  const query = await searchParams;
  const t = translator(locale);
  const { customer, workspace } = await requireWorkspace(locale, 'campaigns.read');

  const single = (key: string): string | undefined => {
    const value = query[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  };

  const brandContext = await brandContextFor(workspace, '/campaigns');
  const mayManage = workspace.permissionKeys.includes('campaigns.manage');

  /*
   * A CAMPAIGN OUTSIDE THE MEMBER'S SCOPE IS INDISTINGUISHABLE FROM ONE THAT
   * DOES NOT EXIST (CLAUDE.md §2.1). The service puts the scope in the WHERE
   * and throws NOT_FOUND; this turns that into the framework's own 404 so the
   * response is shaped exactly like a route that was never there.
   */
  const data = await inContentStudio(workspace.workspaceId, async (services) => {
    const campaigns = services.campaigns();
    try {
      const campaign = await campaigns.get(campaignId, workspace.brandScope);
      const policy = await services.policy();
      const library = await services.library();
      const items = await library.listItems({
        brandId: campaign.brandId,
        brandScope: workspace.brandScope,
        campaignId: campaign.id,
        limit: 50,
      });
      return { campaign, platforms: policy.platforms, items };
    } catch (error: unknown) {
      if (isAppError(error) && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  });

  if (!data) notFound();
  const { campaign, platforms, items } = data;

  /*
   * PERFORMANCE IS BEST-EFFORT AND SAYS SO. A workspace with no connected
   * account has no analytics policy to resolve and no observations to read;
   * that is an empty state, not an error, and it must not take the whole page
   * down with it.
   */
  const performance = workspace.permissionKeys.includes('analytics.read')
    ? await inAnalytics(workspace.workspaceId, async (services) => {
        try {
          const queries = await services.queries();
          const now = systemClock.now();
          return await queries.summary({
            scope: { brandId: campaign.brandId, campaignId: campaign.id },
            period: { start: new Date(now.getTime() - WINDOW_DAYS * 86_400_000), end: now },
            brandScope: workspace.brandScope,
            metricKeys: HEADLINE_METRICS,
          });
        } catch {
          return null;
        }
      })
    : null;

  const brief = briefFrom(campaign.brief);

  return (
    <WorkspaceShell
      brandContext={brandContext}
      locale={locale}
      heading={campaign.name}
      description={objectiveLabel(t, campaign.objective)}
      activePath="/campaigns"
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.email}
      permissionKeys={workspace.permissionKeys}
      actions={
        <Link
          href={`/${locale}/campaigns`}
          style={buttonStyle('neutral')}
          data-testid="campaign-back"
        >
          {t('campaigns.back')}
        </Link>
      }
    >
      {single('error') && (
        <CustomerBanner tone="error">
          {statusMessage(single('error'), locale, single('ref'))}
        </CustomerBanner>
      )}
      {single('ok') && statusMessage(single('ok'), locale) && (
        <CustomerBanner tone="success">{statusMessage(single('ok'), locale)}</CustomerBanner>
      )}

      <div style={{ display: 'grid', gap: spacingTokens.lg }}>
        {/* ------------------------------------------------ at a glance --- */}
        <Card testId="campaign-summary">
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: spacingTokens.md,
              alignItems: 'center',
            }}
          >
            <StatusBadge
              tone={statusTone(campaign.status)}
              label={statusLabel(t, campaign.status)}
              testId="campaign-status"
            />
            <span style={{ ...typographyTokens.bodySm, color: colorTokens.textSecondary }}>
              {periodLabel(campaign.startDate, campaign.endDate, locale, t('campaigns.noDates'))}
            </span>
            <span
              style={{ ...typographyTokens.bodySm, color: colorTokens.textSecondary }}
              data-testid="campaign-channels-summary"
            >
              {campaign.channels.length === 0
                ? t('campaigns.noChannels')
                : campaign.channels.join(' · ')}
            </span>
          </div>
          {brief.en !== '' || brief.ar !== '' ? (
            <p
              style={{ ...typographyTokens.body, color: colorTokens.textPrimary, marginBlock: 0 }}
              data-testid="campaign-brief"
              dir={locale === 'ar' ? 'rtl' : 'ltr'}
            >
              {locale === 'ar' ? brief.ar || brief.en : brief.en || brief.ar}
            </p>
          ) : null}
        </Card>

        {/* ------------------------------------------------ performance --- */}
        <section>
          <SectionHeader title={t('campaigns.performance')} />
          {performance && performance.metrics.some((metric) => metric.value !== null) ? (
            <>
              {performance.containsMockData ? (
                <p
                  style={{
                    ...typographyTokens.bodySm,
                    color: colorTokens.textMuted,
                    marginBlockStart: 0,
                  }}
                  data-testid="campaign-sample-notice"
                >
                  {t('campaigns.performanceSample')}
                </p>
              ) : null}
              <div
                style={{
                  display: 'grid',
                  gap: spacingTokens.md,
                  gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))',
                }}
                data-testid="campaign-metrics"
              >
                {performance.metrics.map((metric) => (
                  <MetricCard
                    key={metric.metricKey}
                    label={metric.metricKey}
                    value={
                      metric.value === null
                        ? '—'
                        : new Intl.NumberFormat(locale === 'ar' ? 'ar' : 'en', {
                            numberingSystem: 'latn',
                          }).format(Number(metric.value))
                    }
                    testId={`campaign-metric-${metric.metricKey}`}
                  />
                ))}
              </div>
            </>
          ) : (
            <StateMessage
              kind="empty"
              title={t('campaigns.performance')}
              description={t('campaigns.performanceEmpty')}
              testId="campaign-performance-empty"
            />
          )}
        </section>

        {/* --------------------------------------------------- content --- */}
        <section>
          <SectionHeader
            title={t('campaigns.contentTitle')}
            description={`${items.length} ${t('campaigns.contentCount')}`}
          />
          {items.length === 0 ? (
            <StateMessage
              kind="empty"
              title={t('campaigns.contentTitle')}
              description={t('campaigns.contentEmpty')}
              testId="campaign-content-empty"
              action={
                <Link
                  href={`/${locale}/content/compose?campaign=${campaign.id}`}
                  style={buttonStyle('brand')}
                  data-testid="campaign-write-post"
                >
                  {t('campaigns.contentEmptyAction')}
                </Link>
              }
            />
          ) : (
            <Card testId="campaign-content">
              <DataTable
                headers={[t('campaigns.name'), t('campaigns.status')]}
                caption={t('campaigns.contentTitle')}
                testId="campaign-content-table"
              >
                {items.map((item) => (
                  <Row key={item.id} testId={`campaign-content-${item.id}`}>
                    <Cell>
                      <Link
                        href={`/${locale}/content/compose?item=${item.id}`}
                        style={{ color: colorTokens.brandPurple, fontWeight: 600 }}
                      >
                        {item.title}
                      </Link>
                    </Cell>
                    <Cell>
                      <StatusBadge
                        tone={statusTone(item.status)}
                        label={contentStatusLabel(t, item.status)}
                      />
                    </Cell>
                  </Row>
                ))}
              </DataTable>
            </Card>
          )}
        </section>

        {/* ----------------------------------------------------- edit --- */}
        {mayManage ? (
          <section>
            <SectionHeader title={t('campaigns.detailsTitle')} />
            <CampaignFormView
              action={updateCampaignAction}
              hidden={{
                locale,
                campaignId: campaign.id,
                version: String(campaign.version),
              }}
              values={{
                name: campaign.name,
                objective: campaign.objective,
                briefAr: brief.ar,
                briefEn: brief.en,
                description: campaign.description ?? '',
                startDate: dateInputValue(campaign.startDate),
                endDate: dateInputValue(campaign.endDate),
                channels: campaign.channels,
                status: campaign.status === 'ARCHIVED' ? 'DRAFT' : campaign.status,
              }}
              labels={formLabels(t, t('campaigns.save'))}
              platforms={platforms.map((platform) => ({
                key: platform.key,
                label: platform.key,
              }))}
              withStatus
              testId="campaign-edit-form"
            />

            {/*
              ARCHIVE IS ITS OWN FORM AND ITS OWN ACTION. It is a soft delete
              with its own audit event, not a value in the status dropdown —
              one state with two doors behind it is how two behaviours end up
              wearing one name.
            */}
            {campaign.status !== 'ARCHIVED' ? (
              <form
                action={archiveCampaignAction}
                style={{ marginBlockStart: spacingTokens.md }}
                data-testid="campaign-archive-form"
              >
                <input type="hidden" name="locale" value={locale} />
                <input type="hidden" name="campaignId" value={campaign.id} />
                <p
                  style={{
                    ...typographyTokens.bodySm,
                    color: colorTokens.textMuted,
                    marginBlockEnd: spacingTokens.xs,
                  }}
                >
                  {t('campaigns.archiveHint')}
                </p>
                <button type="submit" style={buttonStyle('neutral')} data-testid="campaign-archive">
                  {t('campaigns.archive')}
                </button>
              </form>
            ) : null}
          </section>
        ) : null}

        {/*
          THE CONVERSATION LIVES ON THE CAMPAIGN (P6-05).
        
          A campaign is a project room, so the notes about it belong in the room
          rather than in a separate inbox somebody has to correlate by hand. The
          panel renders NOTHING at all for a member who may not read this
          campaign's notes — the service answers 404 identically to a campaign
          that does not exist, and an empty conversation would claim there is
          nothing here, which is a different and wrong statement.
        */}
        <NotesPanel
          locale={locale}
          subject={{ type: 'CAMPAIGN', campaignId: campaign.id }}
          returnPath={`/${locale}/campaigns/${campaign.id}`}
          highlightThreadId={typeof query['thread'] === 'string' ? query['thread'] : null}
        />
      </div>
    </WorkspaceShell>
  );
}
