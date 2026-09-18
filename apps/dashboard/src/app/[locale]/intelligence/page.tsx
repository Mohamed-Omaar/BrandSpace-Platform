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
import {
  analyseContentGapsAction,
  proposeLearningsAction,
  reviewIntelligenceAction,
} from './actions';

export const dynamic = 'force-dynamic';

/**
 * MARKETING INTELLIGENCE — Phase 8, workstream 6 (AC-30.1, AC-30.4).
 *
 * WHAT THIS AREA IS, AND WHY IT IS NOT ANALYTICS AND NOT STRATEGY. Analytics is
 * the numbers. Strategy is the plan. This is the space between them: what the
 * numbers and the brand's own declarations MEAN, and what the brand should
 * therefore remember. Those were three questions answered on two screens until
 * now — `/strategy` listed every insight the workspace had ever produced beside
 * its strategy proposals, which made "what did we learn" and "what shall we do"
 * the same list.
 *
 * IT HAS NO EXTERNAL SOURCE, AND SAYS SO ABOVE EVERYTHING. BrandSpace has no
 * competitor feed and no trends provider (D-18, D-19 approved none), so content
 * gap analysis rests on ABSENCE EVIDENCE: pillars this brand declared in its own
 * Brand Brain and has not published against, platforms it connected and has not
 * posted on, a cadence it set and has not kept. Every one of those is a fact
 * about rows that are not there, checkable against this workspace's own data.
 * A screen that let a customer assume otherwise would be implying a market feed
 * the product does not have.
 *
 * THE EVIDENCE IS RENDERED FROM THE STORED ROWS, never from the model's prose.
 * Every figure below comes out of `insight_evidence`, written from the analytics
 * query BEFORE any model call — so a number here is a number a provider
 * reported, and the model's sentences sit beside it rather than containing it.
 *
 * IT CLOSES THE PHASE 8 EXIT JOURNEY. The last step of that journey is accepted
 * learning going back into Brand Brain, and the control for it is on this page:
 * it proposes PENDING candidates into the existing Brand Brain review queue,
 * with provenance and evidence, and writes nothing into the brand (D-150). A
 * human accepting them there is what closes the loop.
 *
 * DESIGN-SYSTEM EXTENSION, NOT A DEMO PORT (CLAUDE.md §4.2). There is no
 * approved reference for this screen. It is composed from the same `Card`,
 * `SectionHeader`, `StatusBadge`, `StateMessage` and form controls the Strategy
 * and Analytics screens already use, in the same order and with the same
 * spacing — deliberately, so a reader moving between the three areas is reading
 * one product. Nothing new was drawn.
 */
export default async function IntelligencePage({
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

  const brandContext = await brandContextFor(
    session.workspace,
    '/intelligence',
    typeof query['brand'] === 'string' ? query['brand'] : null,
  );
  const brand = requiredBrand(brandContext);

  const stamp = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  });
  const number = new Intl.NumberFormat(locale === 'ar' ? 'ar' : 'en');

  /*
   * WHAT BELONGS TO THIS AREA, DECLARED RATHER THAN "everything recent".
   *
   * Content gaps and opportunities are what this screen commissions; the
   * explanations, anomalies and recommendations analytics produced are what it
   * INTERPRETS. Strategies and monthly plans are `/strategy`'s subject and are
   * deliberately absent — a plan is not a finding.
   *
   * THE SCOPE IS IN THE QUERY (D-132). `brandScope` intersects the selected
   * brand rather than filtering a wider read afterwards, so an out-of-scope
   * brand returns nothing rather than being fetched and dropped.
   */
  const insights =
    brand && (workspace.brandScope.length === 0 || workspace.brandScope.includes(brand.id))
      ? await inAnalytics(workspace.workspaceId, async (services) =>
          services.db.insight.findMany({
            where: {
              workspaceId: workspace.workspaceId,
              brandId: brand.id,
              type: {
                in: [
                  'CONTENT_GAP',
                  'OPPORTUNITY',
                  'ANALYTICS_EXPLANATION',
                  'ANOMALY',
                  'RECOMMENDATION',
                ],
              },
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
      heading={t('intelligence.title')}
      description={t('intelligence.subtitle')}
      activePath="/intelligence"
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
         * THE HONESTY LINE, above everything, exactly as on `/strategy`. It is
         * not small print: it is the answer to the question a customer will ask
         * of any finding here — "compared with what?"
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
              <Card title={t('intelligence.analyse')}>
                <form action={analyseContentGapsAction} data-testid="content-gap-form">
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="brandId" value={brand.id} />
                  <label style={{ display: 'grid', gap: '0.25rem' }}>
                    <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
                      {t('intelligence.focusLabel')}
                    </span>
                    <input
                      name="objective"
                      required
                      maxLength={400}
                      className="bs-control"
                      style={inputStyle()}
                      placeholder={t('intelligence.focusPlaceholder')}
                    />
                  </label>
                  <p style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
                    {t('intelligence.basisNotice')}
                  </p>
                  <button type="submit" style={buttonStyle('brand', 'sm')}>
                    {t('intelligence.analyse')}
                  </button>
                </form>
              </Card>
            ) : null}

            {insights.length === 0 ? (
              <StateMessage
                kind="empty"
                title={t('intelligence.empty')}
                description={t('intelligence.emptyBody')}
              />
            ) : (
              insights.map((insight) => (
                <Card key={insight.id} testId={`intelligence-${insight.id}`}>
                  <SectionHeader
                    title={localized(insight.title, locale)}
                    description={`${t(`insights.type.${insight.type}` as MessageKey)} · ${t(
                      'insights.basis',
                    )}: ${t(`insights.basis.${insight.basis}` as MessageKey)} · ${stamp.format(
                      insight.createdAt,
                    )}`}
                    actions={
                      <StatusBadge
                        tone={insight.status === 'ACCEPTED' ? 'success' : 'neutral'}
                        label={t(`insights.status.${insight.status}` as MessageKey)}
                      />
                    }
                  />

                  {/*
                   * THE EVIDENCE, AS A LIST OF MEASUREMENTS. Each line is a
                   * metric, a value and a window a customer can check against
                   * the analytics screen. The model's prose never supplies a
                   * figure here.
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
                    data-testid="intelligence-evidence"
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
                      <form action={reviewIntelligenceAction}>
                        <input type="hidden" name="locale" value={locale} />
                        <input type="hidden" name="insightId" value={insight.id} />
                        <input type="hidden" name="decision" value="accept" />
                        <button type="submit" style={buttonStyle('brand', 'sm')}>
                          {t('insights.accept')}
                        </button>
                      </form>
                      <form action={reviewIntelligenceAction}>
                        <input type="hidden" name="locale" value={locale} />
                        <input type="hidden" name="insightId" value={insight.id} />
                        <input type="hidden" name="decision" value="dismiss" />
                        <button type="submit" style={buttonStyle('ghost', 'sm')}>
                          {t('insights.dismiss')}
                        </button>
                      </form>
                    </div>
                  ) : null}

                  {/*
                   * THE LAST STEP OF THE EXIT JOURNEY. Offered whatever the
                   * insight's own review state, because a finding somebody has
                   * already accepted is exactly the one worth remembering — and
                   * gated on `brand_brain.review` rather than `strategy.manage`,
                   * because the person asking for the inference is the person
                   * who will have to judge it in the queue.
                   */}
                  {mayReview ? (
                    <div style={{ display: 'grid', gap: spacingTokens['2xs'] }}>
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
                      <p style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
                        {t('insights.proposeLearningsHint')}
                      </p>
                    </div>
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
