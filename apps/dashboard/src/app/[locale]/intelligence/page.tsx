import Link from 'next/link';
import {
  Card,
  SectionHeader,
  Stack,
  StateMessage,
  StatusBadge,
  buttonClass,
  buttonStyle,
  colorTokens,
  inputStyle,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import { requireWorkspace } from '../../../server/customer-context';
import { brandContextFor, requiredBrand } from '../../../server/brand-context';
import { inAnalytics } from '../../../server/analytics-context';
import { evidenceLabel, statusMessage, translator, type MessageKey } from '../../../i18n/messages';
import { insightNarrative, type NarrativeLine } from '../../../server/insight-narrative';
import { INTELLIGENCE_INSIGHT_TYPES } from '../../../server/command-center';
import { copilotHref } from '../../../server/copilot-surface';
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
  const mayReadBrain = workspace.permissionKeys.includes('brand_brain.read');
  /*
   * THE DEEP LINK (P6-11). Analytics, Home's Pulse and the explain action all
   * link here with `?insight=<id>`, and until now the page ignored it — the
   * reader arrived at a list and had to find the one they were sent to. The id
   * is only ever used INSIDE the scoped query below, so a foreign or invented
   * id matches nothing and the page renders exactly as it would without it.
   */
  const focusId =
    typeof query['insight'] === 'string' && /^[0-9a-f-]{36}$/i.test(query['insight'])
      ? query['insight']
      : null;

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
  const inScope =
    brand !== null &&
    (workspace.brandScope.length === 0 || workspace.brandScope.includes(brand.id));
  const { insights, loop } = inScope
    ? await inAnalytics(workspace.workspaceId, async (services) => {
        const where = {
          workspaceId: workspace.workspaceId,
          brandId: brand.id,
          type: { in: [...INTELLIGENCE_INSIGHT_TYPES] },
        };
        const include = { evidence: { orderBy: { ordinal: 'asc' as const }, take: 8 } };
        const recent = await services.db.insight.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: 10,
          include,
        });
        /*
         * The focused insight is read with the SAME predicate plus its id, so
         * it is found only if it would have been listed anyway — just older
         * than the ten most recent. It is then shown FIRST, once.
         */
        const focused =
          focusId && !recent.some((row) => row.id === focusId)
            ? await services.db.insight.findFirst({ where: { ...where, id: focusId }, include })
            : null;
        const ordered = focusId
          ? [
              ...(focused ? [focused] : recent.filter((row) => row.id === focusId)),
              ...recent.filter((row) => row.id !== focusId),
            ]
          : recent;

        /*
         * WHERE EACH FINDING IS IN THE LEARNING LOOP. A learning proposed from
         * an insight waits in Brand Brain's review queue, and nothing on this
         * screen said so — the loop's PROPOSE step and its HUMAN REVIEW step
         * were on two screens with no thread between them. Counted per insight
         * and per status, only for a reader who may open Brand Brain.
         */
        const loopRows =
          mayReadBrain && ordered.length > 0
            ? await services.db.brandKnowledgeCandidate.groupBy({
                by: ['insightId', 'status'],
                where: {
                  workspaceId: workspace.workspaceId,
                  brandId: brand.id,
                  insightId: { in: ordered.map((row) => row.id) },
                },
                _count: { _all: true },
              })
            : [];
        const loopByInsight = new Map<string, { pending: number; accepted: number }>();
        for (const row of loopRows) {
          if (!row.insightId) continue;
          const entry = loopByInsight.get(row.insightId) ?? { pending: 0, accepted: 0 };
          if (row.status === 'PENDING') entry.pending += row._count._all;
          if (row.status === 'ACCEPTED' || row.status === 'EDITED_ACCEPTED') {
            entry.accepted += row._count._all;
          }
          loopByInsight.set(row.insightId, entry);
        }
        return { insights: ordered, loop: loopByInsight };
      })
    : { insights: [], loop: new Map<string, { pending: number; accepted: number }>() };

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

        {brand && workspace.permissionKeys.includes('copilot.use') ? (
          <div>
            <Link
              href={copilotHref(locale, 'intelligence')}
              style={buttonStyle('ghost', 'sm')}
              className={buttonClass('ghost')}
              data-testid="intelligence-ask-copilot"
            >
              {t('copilot.ask')}
            </Link>
          </div>
        ) : null}

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
              insights.map((insight) => {
                const narrative = insightNarrative({
                  type: insight.type,
                  body: insight.body,
                  locale,
                  shownEvidence: insight.evidence.map((row) => row.ordinal),
                });
                const learnings = loop.get(insight.id);
                return (
                  <Card
                    key={insight.id}
                    testId={`intelligence-${insight.id}`}
                    tone={insight.id === focusId ? 'lavender' : 'plain'}
                  >
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
                    {insight.id === focusId ? (
                      <p
                        data-testid="intelligence-focused"
                        style={{
                          margin: 0,
                          ...typographyTokens.caption,
                          color: colorTokens.textSecondary,
                        }}
                      >
                        {t('intelligence.focused')}
                      </p>
                    ) : null}

                    {/*
                     * WHY · WHAT HAPPENED · WHAT NEXT (P6-11). The body the
                     * provider wrote, re-parsed against its schema, each line
                     * carrying the evidence ordinals it cites — so every sentence
                     * points at a stored measurement below. An unparseable body
                     * renders nothing here, and the evidence still stands alone.
                     */}
                    {narrative ? (
                      <div
                        data-testid="intelligence-narrative"
                        style={{ display: 'grid', gap: spacingTokens.sm }}
                      >
                        <NarrativeBlock
                          title={t('intelligence.why')}
                          lines={[{ text: narrative.why, evidence: [] }]}
                          testId="narrative-why"
                          evidenceLabel={t('insights.evidence')}
                        />
                        <NarrativeBlock
                          title={t('intelligence.happened')}
                          lines={narrative.happened}
                          testId="narrative-happened"
                          evidenceLabel={t('insights.evidence')}
                        />
                        {narrative.next.length > 0 ? (
                          <NarrativeBlock
                            title={t('intelligence.next')}
                            lines={narrative.next}
                            testId="narrative-next"
                            evidenceLabel={t('insights.evidence')}
                          />
                        ) : null}
                      </div>
                    ) : null}

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
                            : evidenceLabel(locale, row.labelKey)}
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

                    {/*
                     * THE LOOP, MADE VISIBLE. Proposed learnings wait for a
                     * person in Brand Brain; accepted ones are governed memory at
                     * the lowest authority. Shown only when there is something to
                     * say — no "0 learnings" line.
                     */}
                    {learnings && (learnings.pending > 0 || learnings.accepted > 0) ? (
                      <p
                        data-testid="intelligence-loop"
                        style={{
                          margin: 0,
                          ...typographyTokens.caption,
                          color: colorTokens.textSecondary,
                        }}
                      >
                        {learnings.pending > 0
                          ? t('intelligence.loop.pending').replace(
                              '{count}',
                              number.format(learnings.pending),
                            )
                          : null}
                        {learnings.pending > 0 && learnings.accepted > 0 ? ' · ' : null}
                        {learnings.accepted > 0
                          ? t('intelligence.loop.accepted').replace(
                              '{count}',
                              number.format(learnings.accepted),
                            )
                          : null}{' '}
                        <Link href={`/${locale}/brand-brain`} data-testid="intelligence-loop-link">
                          {t('intelligence.loop.open')}
                        </Link>
                      </p>
                    ) : null}
                  </Card>
                );
              })
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

/**
 * One of the three answers, as a short list whose lines cite their evidence.
 *
 * Composed from the typography and spacing tokens the evidence list below it
 * already uses — a heading and a list — so it adds no visual treatment of its
 * own (CLAUDE.md §4.2).
 */
function NarrativeBlock({
  title,
  lines,
  testId,
  evidenceLabel,
}: {
  title: string;
  lines: readonly NarrativeLine[];
  testId: string;
  evidenceLabel: string;
}) {
  if (lines.length === 0) return null;
  return (
    <section data-testid={testId} style={{ display: 'grid', gap: spacingTokens['2xs'] }}>
      <h3 style={{ margin: 0, ...typographyTokens.label, color: colorTokens.textPrimary }}>
        {title}
      </h3>
      <ul
        style={{ margin: 0, paddingInlineStart: spacingTokens.lg, display: 'grid', gap: '0.25rem' }}
      >
        {lines.map((line, index) => (
          <li key={index} style={{ ...typographyTokens.bodySm, color: colorTokens.textPrimary }}>
            {line.text}
            {line.evidence.length > 0 ? (
              <span
                title={evidenceLabel}
                style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}
              >
                {' '}
                ({line.evidence.map((ref) => `e${ref}`).join(', ')})
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
