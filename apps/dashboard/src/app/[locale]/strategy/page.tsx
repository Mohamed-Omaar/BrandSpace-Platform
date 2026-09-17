import {
  Card,
  SectionHeader,
  Stack,
  StateMessage,
  StatusBadge,
  buttonStyle,
  colorTokens,
  inputStyle,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import { requireWorkspace } from '../../../server/customer-context';
import { brandContextFor, requiredBrand } from '../../../server/brand-context';
import { inAnalytics } from '../../../server/analytics-context';
import { statusMessage, translator, type MessageKey } from '../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../components/workspace-shell';
import { generateStrategyAction, proposeLearningsAction, reviewInsightAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * AI STRATEGY AND MARKETING INTELLIGENCE.
 *
 * A PROPOSAL IS A PROPOSAL UNTIL A PERSON ACCEPTS IT, and this screen says so in
 * a banner above every generated document rather than leaving the customer to
 * infer it from a status badge. Nothing in the product acts on a strategy that
 * has not been through the accept action below.
 *
 * IT STATES WHAT EVERY SUGGESTION RESTS ON. BrandSpace has no external trend or
 * competitor provider (D-18, D-19 approved none), so each insight renders its
 * `basis` — this brand's own performance, its approved knowledge, or its content
 * history — and the page says plainly that there is no outside source. A product
 * that let a customer assume otherwise would be implying a market feed it does
 * not have.
 *
 * THE EVIDENCE IS RENDERED FROM THE STORED ROWS, never from the model's prose.
 * Every figure below comes out of `insight_evidence`, which is written from the
 * analytics query before any model call — so a number on this screen is a number
 * a provider reported, and the model's sentences sit beside it rather than
 * containing it.
 */
export default async function StrategyPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const t = translator(locale);
  const session = await requireWorkspace(locale, 'strategy.read');
  const { workspace } = session;

  const ok = typeof query['ok'] === 'string' ? query['ok'] : null;
  const error = typeof query['error'] === 'string' ? query['error'] : null;
  const mayManage = workspace.permissionKeys.includes('strategy.manage');
  const mayReview = workspace.permissionKeys.includes('brand_brain.review');

  /*
   * THE GLOBAL BRAND CONTEXT (D-190). A strategy is generated FROM one brand's
   * memories and accepted AGAINST that brand, so the screen still needs exactly
   * one — it just no longer picks it, and no longer keeps its own list beside
   * the rail's.
   */
  const brandContext = await brandContextFor(
    session.workspace,
    '/strategy',
    typeof query['brand'] === 'string' ? query['brand'] : null,
  );
  const brand = requiredBrand(brandContext);

  const stamp = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  });
  const number = new Intl.NumberFormat(locale === 'ar' ? 'ar' : 'en');

  const insights = brand
    ? await inAnalytics(workspace.workspaceId, async (services) =>
        services.db.insight.findMany({
          where: {
            workspaceId: workspace.workspaceId,
            brandId: brand.id,
            ...(workspace.brandScope.length > 0
              ? { brandId: { in: [...workspace.brandScope] } }
              : {}),
          },
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: { evidence: { orderBy: { ordinal: 'asc' }, take: 8 } },
        }),
      )
    : [];

  return (
    <WorkspaceShell
      brandContext={brandContext}
      locale={locale}
      heading={t('strategy.title')}
      description={t('strategy.subtitle')}
      activePath="/strategy"
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={session.customer.name ?? session.customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      <Stack gap={spacingTokens.lg}>
        {ok ? (
          <CustomerBanner tone="success">{statusMessage(ok, locale) ?? ok}</CustomerBanner>
        ) : null}
        {error ? (
          <CustomerBanner tone="error">{statusMessage(error, locale) ?? error}</CustomerBanner>
        ) : null}

        {/*
         * THE HONESTY LINE, above everything. It is not a disclaimer in small
         * print: it is the answer to the question a customer will ask of any
         * recommendation — "compared with what?"
         */}
        <CustomerBanner tone="info">{t('insights.noExternalData')}</CustomerBanner>

        {!brand ? (
          <StateMessage
            kind="empty"
            title={t('analytics.noBrandTitle')}
            description={t('analytics.noBrandBody')}
          />
        ) : (
          <>
            {mayManage ? (
              <Card title={t('strategy.generate')}>
                <form action={generateStrategyAction} data-testid="strategy-form">
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="brandId" value={brand.id} />
                  <label style={{ display: 'grid', gap: '0.25rem' }}>
                    <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
                      {t('strategy.objectiveLabel')}
                    </span>
                    <input
                      name="objective"
                      required
                      maxLength={400}
                      className="bs-control"
                      style={inputStyle()}
                      placeholder={t('strategy.objectivePlaceholder')}
                    />
                  </label>
                  <p style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
                    {t('strategy.proposalNotice')}
                  </p>
                  <button type="submit" style={buttonStyle('brand', 'sm')}>
                    {t('strategy.generate')}
                  </button>
                </form>
              </Card>
            ) : null}

            {insights.length === 0 ? (
              <StateMessage kind="empty" title={t('strategy.empty')} />
            ) : (
              insights.map((insight) => (
                <Card key={insight.id} testId={`insight-${insight.id}`}>
                  <SectionHeader
                    title={localized(insight.title, locale)}
                    description={`${t('insights.basis')}: ${t(
                      `insights.basis.${insight.basis}` as MessageKey,
                    )} · ${stamp.format(insight.createdAt)}`}
                    actions={
                      <StatusBadge
                        tone={insight.status === 'ACCEPTED' ? 'success' : 'neutral'}
                        label={t(`insights.status.${insight.status}` as MessageKey)}
                      />
                    }
                  />

                  {/*
                   * THE EVIDENCE, AS A LIST OF MEASUREMENTS. Rendered from the
                   * stored rows: each line is a metric, a value and a window a
                   * customer can check against the analytics screen. The model's
                   * prose never supplies a figure here.
                   */}
                  <SectionHeader title={t('insights.evidence')} />
                  <ul
                    style={{
                      listStyle: 'none',
                      margin: 0,
                      padding: 0,
                      display: 'grid',
                      gap: '0.25rem',
                    }}
                    data-testid="insight-evidence"
                  >
                    {insight.evidence.map((row) => (
                      <li
                        key={row.id}
                        style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}
                      >
                        <strong style={{ color: colorTokens.textPrimary }}>e{row.ordinal}</strong>{' '}
                        {row.metricKey
                          ? t(`analytics.metric.${row.metricKey}` as MessageKey)
                          : row.labelKey}
                        {row.value === null ? '' : ` — ${number.format(Number(row.value))}`}
                        {row.periodStart && row.periodEnd
                          ? ` (${stamp.format(row.periodStart)} – ${stamp.format(row.periodEnd)})`
                          : ''}
                        {row.comparisonValue === null || row.comparisonValue === undefined
                          ? ''
                          : ` · ${t('insights.anomalyBaseline')} ${number.format(
                              Number(row.comparisonValue),
                            )}`}
                      </li>
                    ))}
                  </ul>

                  {mayManage && insight.status !== 'ACCEPTED' ? (
                    <div style={{ display: 'flex', gap: spacingTokens.sm, flexWrap: 'wrap' }}>
                      <form action={reviewInsightAction}>
                        <input type="hidden" name="locale" value={locale} />
                        <input type="hidden" name="insightId" value={insight.id} />
                        <input type="hidden" name="decision" value="accept" />
                        <button type="submit" style={buttonStyle('brand', 'sm')}>
                          {t('insights.accept')}
                        </button>
                      </form>
                      <form action={reviewInsightAction}>
                        <input type="hidden" name="locale" value={locale} />
                        <input type="hidden" name="insightId" value={insight.id} />
                        <input type="hidden" name="decision" value="dismiss" />
                        <button type="submit" style={buttonStyle('ghost', 'sm')}>
                          {t('insights.dismiss')}
                        </button>
                      </form>
                      {mayReview ? (
                        <form action={proposeLearningsAction}>
                          <input type="hidden" name="locale" value={locale} />
                          <input type="hidden" name="insightId" value={insight.id} />
                          <button
                            type="submit"
                            style={buttonStyle('neutral', 'sm')}
                            data-testid="propose-learnings"
                          >
                            {t('insights.proposeLearnings')}
                          </button>
                        </form>
                      ) : null}
                    </div>
                  ) : null}
                  {mayReview ? (
                    <p style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
                      {t('insights.proposeLearningsHint')}
                    </p>
                  ) : null}
                </Card>
              ))
            )}
          </>
        )}
      </Stack>
    </WorkspaceShell>
  );
}

/** A `{ ar, en }` JSON column, in the reader's own language. */
function localized(value: unknown, locale: string): string {
  if (typeof value !== 'object' || value === null) return '';
  const record = value as Record<string, unknown>;
  const picked = locale === 'ar' ? record['ar'] : record['en'];
  return typeof picked === 'string' ? picked : '';
}
