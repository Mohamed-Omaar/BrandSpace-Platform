import Link from 'next/link';
import { CopilotLink } from '../../../components/copilot-link';
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
  radiusTokens,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import { requireWorkspace } from '../../../server/customer-context';
import { brandContextFor, requiredBrand } from '../../../server/brand-context';
import { inAnalytics } from '../../../server/analytics-context';
import { copilotHref } from '../../../server/copilot-surface';
import {
  GOAL_ITEM_KEY,
  campaignObjectiveFor,
  goalFromTitle,
  goalLabels,
} from '../../../server/setup-wizard-state';
import {
  campaignHref,
  contentHref,
  leadingChannels,
  parseStrategyBody,
  pick,
  type Rationale,
} from '../../../server/strategy-view';
import {
  evidenceLabel,
  evidenceRefs,
  optionalMessage,
  statusMessage,
  translator,
  type MessageKey,
} from '../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../components/workspace-shell';
import { generateStrategyAction, proposeLearningsAction, reviewInsightAction } from './actions';

import { EmptyAction } from '../../../components/empty-action';

export const dynamic = 'force-dynamic';

/**
 * STRATEGY — THE BRAND'S PLAN, NOT A GENERATOR (Phase 6 final, D-277 §13, D-292).
 *
 * The page reads top to bottom as a plan a person can work from: the current
 * objective, who it is for, the pillars, the channel mix, the key messages,
 * the month week by week, and what it rests on. AI proposals sit BELOW, under
 * "Suggested changes", visibly different from the accepted plan.
 *
 * A PROPOSAL IS A PROPOSAL UNTIL A PERSON ACCEPTS IT. Nothing above
 * "Suggested changes" is drawn from an unaccepted proposal; nothing in the
 * product acts on one.
 *
 * WHERE EACH SECTION COMES FROM — and nothing is filled in when there is no
 * source for it:
 *   - objective: the brand's first goal (`goal.primary`, the Setup Wizard's
 *     answer, D-278) and the accepted strategy's summary;
 *   - audience and key messages: Brand Brain's own approved knowledge
 *     (AUDIENCE; OFFERS and PROOF_POINTS) — the strategy engine does not
 *     generate them, and inventing them here would be the "fake data" the
 *     contract forbids;
 *   - pillars, channel mix and monthly plan: the ACCEPTED strategy's body;
 *   - evidence: the stored `insight_evidence` rows, never the model's prose.
 *
 * FROM PLAN TO WORK. Each week of the month offers Create campaign, Send to
 * Content and Give to Copilot — addresses that open the existing flows with the
 * week filled in. Nothing is created, scheduled or published from this screen.
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
  const may = (key: string) => workspace.permissionKeys.includes(key);

  const ok = typeof query['ok'] === 'string' ? query['ok'] : null;
  const error = typeof query['error'] === 'string' ? query['error'] : null;
  const mayManage = may('strategy.manage');
  const mayReview = may('brand_brain.review');

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

  const data = brand
    ? await inAnalytics(workspace.workspaceId, async ({ db }) => {
        const scope =
          workspace.brandScope.length > 0 ? { brandId: { in: [...workspace.brandScope] } } : {};
        const [accepted, proposals, goal, knowledge] = await Promise.all([
          db.insight.findFirst({
            where: { brandId: brand.id, type: 'STRATEGY', status: 'ACCEPTED', ...scope },
            orderBy: [{ reviewedAt: 'desc' }, { createdAt: 'desc' }],
            include: { evidence: { orderBy: { ordinal: 'asc' }, take: 12 } },
          }),
          db.insight.findMany({
            where: {
              brandId: brand.id,
              type: { in: ['STRATEGY', 'MONTHLY_PLAN'] },
              status: { in: ['NEW', 'SEEN'] },
              ...scope,
            },
            orderBy: { createdAt: 'desc' },
            take: 6,
            include: { evidence: { orderBy: { ordinal: 'asc' }, take: 8 } },
          }),
          db.brandKnowledgeItem.findFirst({
            where: {
              brandId: brand.id,
              area: 'STRATEGY',
              itemKey: GOAL_ITEM_KEY,
              status: { in: ['ACTIVE', 'STALE'] },
            },
            select: { title: true },
          }),
          db.brandKnowledgeItem.findMany({
            where: {
              brandId: brand.id,
              area: { in: ['AUDIENCE', 'OFFERS', 'PROOF_POINTS', 'STRATEGY'] },
              status: 'ACTIVE',
              NOT: { itemKey: { startsWith: 'goal.' } },
            },
            orderBy: { updatedAt: 'desc' },
            select: { id: true, area: true, title: true, body: true },
            take: 40,
          }),
        ]);
        return { accepted, proposals, goal, knowledge };
      })
    : null;

  const plan = data?.accepted ? parseStrategyBody(data.accepted.body) : null;
  const goalTitle =
    data?.goal && typeof data.goal.title === 'object' && data.goal.title !== null
      ? (data.goal.title as Record<string, unknown>)
      : null;
  const firstGoal = goalFromTitle(
    typeof goalTitle?.['en'] === 'string' ? goalTitle['en'] : undefined,
    goalLabels('en'),
  );
  const goalText = firstGoal
    ? goalLabels(locale === 'ar' ? 'ar' : 'en')[firstGoal]
    : typeof goalTitle?.[locale === 'ar' ? 'ar' : 'en'] === 'string'
      ? String(goalTitle[locale === 'ar' ? 'ar' : 'en'])
      : null;

  const knowledgeIn = (areas: readonly string[]) =>
    (data?.knowledge ?? []).filter((item) => areas.includes(item.area)).slice(0, 4);
  const audience = knowledgeIn(['AUDIENCE']);
  const messagesKnown = knowledgeIn(['OFFERS', 'PROOF_POINTS']);
  const declaredPillars = knowledgeIn(['STRATEGY']);
  const platformName = (key: string) => optionalMessage(locale, `content.platform.${key}`) ?? key;
  const refs = (rationale: Rationale) =>
    rationale.evidenceRefs.length > 0
      ? ` · ${t('strategy.rests')} ${evidenceRefs(locale, rationale.evidenceRefs)}`
      : '';
  const copilot = may('copilot.use') ? copilotHref(locale, 'strategy') : null;
  const brainHref = `/${locale}/brand-brain`;

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

        {!brand || !data ? (
          <StateMessage
            kind="empty"
            title={t('analytics.noBrandTitle')}
            description={t('analytics.noBrandBody')}
            action={
              brandContext.resolution.kind === 'empty' &&
              workspace.permissionKeys.includes('brand.manage') ? (
                <EmptyAction
                  href={`/${locale}/brand-brain`}
                  label={t('bb.createBrand')}
                  testId="no-brand-create"
                />
              ) : undefined
            }
          />
        ) : (
          <>
            {/* ------------------------------------------ CURRENT OBJECTIVE */}
            <Card testId="strategy-objective">
              <SectionHeader
                title={t('strategy.section.objective')}
                actions={
                  data.accepted ? (
                    <StatusBadge tone="success" label={t('strategy.acceptedBadge')} />
                  ) : (
                    <StatusBadge tone="neutral" label={t('strategy.noAcceptedBadge')} />
                  )
                }
              />
              <div style={{ display: 'grid', gap: spacingTokens.sm }}>
                {goalText ? (
                  <p style={leadStyle} data-testid="strategy-goal">
                    <span style={kickerStyle}>{t('strategy.firstGoal')}</span> {goalText}
                  </p>
                ) : null}
                {plan?.summary ? (
                  <p style={bodyStyle} dir="auto" data-testid="strategy-summary">
                    {pick(plan.summary, locale)}
                  </p>
                ) : null}
                {data.accepted ? (
                  <span style={metaStyle}>
                    {t('strategy.acceptedOn')}{' '}
                    {stamp.format(data.accepted.reviewedAt ?? data.accepted.createdAt)} ·{' '}
                    {t('insights.basis')}:{' '}
                    {t(`insights.basis.${data.accepted.basis}` as MessageKey)}
                  </span>
                ) : (
                  <p style={bodyStyle} data-testid="strategy-none">
                    {t('strategy.noneAccepted')}
                  </p>
                )}
                {copilot ? (
                  <div>
                    <CopilotLink
                      href={copilot}
                      style={buttonStyle('ghost', 'sm')}
                      className={buttonClass('ghost')}
                      data-testid="strategy-copilot"
                    >
                      {t('home.recommended.giveToCopilot')}
                    </CopilotLink>
                  </div>
                ) : null}
              </div>
            </Card>

            {/* ------------------------------- AUDIENCE · KEY MESSAGES */}
            <div className="bs-grid-2" style={twoColumnStyle}>
              <Card testId="strategy-audience">
                <SectionHeader
                  title={t('strategy.section.audience')}
                  description={t('strategy.fromBrandBrain')}
                />
                <KnowledgeList
                  items={audience}
                  locale={locale}
                  empty={t('strategy.audienceEmpty')}
                  addLabel={t('strategy.addKnowledge')}
                  addHref={brainHref}
                />
              </Card>
              <Card testId="strategy-messages">
                <SectionHeader
                  title={t('strategy.section.messages')}
                  description={t('strategy.fromBrandBrain')}
                />
                <KnowledgeList
                  items={messagesKnown}
                  locale={locale}
                  empty={t('strategy.messagesEmpty')}
                  addLabel={t('strategy.addKnowledge')}
                  addHref={brainHref}
                />
              </Card>
            </div>

            {/* ------------------------------------ PILLARS · CHANNEL MIX */}
            <div className="bs-grid-2" style={twoColumnStyle}>
              <Card testId="strategy-pillars">
                <SectionHeader title={t('strategy.pillars')} />
                {plan && plan.pillars.length > 0 ? (
                  <ul style={listStyle}>
                    {plan.pillars.map((pillar, index) => (
                      <li key={index} style={rowStyle}>
                        <ShareBar
                          label={pick(pillar.name, locale)}
                          value={pillar.sharePercent}
                          format={number}
                        />
                        <span style={metaStyle} dir="auto">
                          {pick(pillar.rationale.text, locale)}
                          {refs(pillar.rationale)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : declaredPillars.length > 0 ? (
                  <>
                    <p style={metaStyle}>{t('strategy.declaredPillars')}</p>
                    <KnowledgeList
                      items={declaredPillars}
                      locale={locale}
                      empty=""
                      addLabel=""
                      addHref={brainHref}
                    />
                  </>
                ) : (
                  <p style={metaStyle}>{t('strategy.pillarsEmpty')}</p>
                )}
              </Card>
              <Card testId="strategy-channels">
                <SectionHeader title={t('strategy.channelMix')} />
                {plan && plan.channelMix.length > 0 ? (
                  <ul style={listStyle}>
                    {plan.channelMix.map((channel) => (
                      <li key={channel.platformKey} style={rowStyle}>
                        <ShareBar
                          label={platformName(channel.platformKey)}
                          value={channel.sharePercent}
                          format={number}
                        />
                        <span style={metaStyle} dir="auto">
                          {pick(channel.rationale.text, locale)}
                          {refs(channel.rationale)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p style={metaStyle}>{t('strategy.channelsEmpty')}</p>
                )}
              </Card>
            </div>

            {/* ------------------------------------------- MONTHLY PLAN */}
            <Card testId="strategy-month">
              <SectionHeader
                title={t('strategy.monthlyPlan')}
                description={t('strategy.monthHint')}
              />
              {plan && plan.monthlyPlan.length > 0 ? (
                <ol style={listStyle}>
                  {plan.monthlyPlan.map((week) => (
                    <li
                      key={week.weekNumber}
                      style={rowStyle}
                      data-testid={`strategy-week-${week.weekNumber}`}
                    >
                      <div style={headStyle}>
                        <span style={kickerStyle}>
                          {t('strategy.week').replace('{n}', number.format(week.weekNumber))}
                        </span>
                        <strong style={titleStyle} dir="auto">
                          {pick(week.theme, locale)}
                        </strong>
                        <span style={metaStyle}>
                          {t('strategy.postsPlanned').replace(
                            '{count}',
                            number.format(week.postsPlanned),
                          )}
                        </span>
                      </div>
                      <span style={metaStyle} dir="auto">
                        {pick(week.rationale.text, locale)}
                        {refs(week.rationale)}
                      </span>
                      <div style={actionsStyle}>
                        {may('campaigns.manage') ? (
                          <Link
                            href={campaignHref({
                              locale,
                              week,
                              channels: leadingChannels(plan),
                              objective: campaignObjectiveFor(firstGoal),
                            })}
                            style={buttonStyle('neutral', 'sm')}
                            className={buttonClass('neutral')}
                            data-testid={`strategy-week-campaign-${week.weekNumber}`}
                          >
                            {t('strategy.createCampaign')}
                          </Link>
                        ) : null}
                        {may('content.create') ? (
                          <Link
                            href={contentHref({ locale, week })}
                            style={buttonStyle('neutral', 'sm')}
                            className={buttonClass('neutral')}
                            data-testid={`strategy-week-content-${week.weekNumber}`}
                          >
                            {t('strategy.sendToContent')}
                          </Link>
                        ) : null}
                        {copilot ? (
                          <CopilotLink
                            href={copilot}
                            style={buttonStyle('ghost', 'sm')}
                            className={buttonClass('ghost')}
                          >
                            {t('home.recommended.giveToCopilot')}
                          </CopilotLink>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <p style={metaStyle}>{t('strategy.monthEmpty')}</p>
              )}
            </Card>

            {/* ------------------------------------------ EVIDENCE / SOURCE */}
            <Card testId="strategy-evidence">
              <SectionHeader
                title={t('strategy.section.evidence')}
                description={t('insights.noExternalData')}
              />
              {data.accepted && data.accepted.evidence.length > 0 ? (
                <EvidenceList
                  locale={locale}
                  rows={data.accepted.evidence}
                  t={t}
                  stamp={stamp}
                  number={number}
                />
              ) : (
                <p style={metaStyle}>{t('strategy.evidenceEmpty')}</p>
              )}
            </Card>

            {/* ------------------------------------------ SUGGESTED CHANGES */}
            <Card testId="strategy-suggestions">
              <SectionHeader
                title={t('strategy.section.suggestions')}
                description={t('strategy.proposalNotice')}
              />
              <div style={{ display: 'grid', gap: spacingTokens.md }}>
                {mayManage ? (
                  <form
                    action={generateStrategyAction}
                    data-testid="strategy-form"
                    style={{ display: 'grid', gap: spacingTokens.xs }}
                  >
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="brandId" value={brand.id} />
                    <label style={{ display: 'grid', gap: spacingTokens['3xs'] }}>
                      <span style={metaStyle}>{t('strategy.objectiveLabel')}</span>
                      <input
                        name="objective"
                        required
                        maxLength={400}
                        className="bs-control"
                        style={inputStyle()}
                        defaultValue={goalText ?? ''}
                        placeholder={t('strategy.objectivePlaceholder')}
                        data-testid="strategy-objective-input"
                      />
                    </label>
                    {goalText ? (
                      <span style={metaStyle}>{t('strategy.startsFromGoal')}</span>
                    ) : null}
                    <div>
                      <button
                        type="submit"
                        style={buttonStyle('brand', 'sm')}
                        className={buttonClass('brand')}
                      >
                        {t('strategy.generate')}
                      </button>
                    </div>
                  </form>
                ) : null}

                {data.proposals.length === 0 ? (
                  <p style={metaStyle}>{t('strategy.empty')}</p>
                ) : (
                  <ul style={listStyle}>
                    {data.proposals.map((proposal) => {
                      const body = parseStrategyBody(proposal.body);
                      return (
                        <li
                          key={proposal.id}
                          style={proposalStyle}
                          data-testid={`insight-${proposal.id}`}
                        >
                          <div style={headStyle}>
                            <StatusBadge tone="info" label={t('strategy.proposalBadge')} />
                            <strong style={titleStyle}>{localized(proposal.title, locale)}</strong>
                            <span style={metaStyle}>{stamp.format(proposal.createdAt)}</span>
                          </div>
                          {body.summary ? (
                            <p style={bodyStyle} dir="auto">
                              {pick(body.summary, locale)}
                            </p>
                          ) : null}
                          {body.pillars.length > 0 ? (
                            <span style={metaStyle} dir="auto">
                              {t('strategy.pillars')}:{' '}
                              {body.pillars.map((pillar) => pick(pillar.name, locale)).join(' · ')}
                            </span>
                          ) : null}
                          {proposal.evidence.length > 0 ? (
                            <details>
                              <summary style={metaStyle}>{t('insights.evidence')}</summary>
                              <EvidenceList
                                locale={locale}
                                rows={proposal.evidence}
                                t={t}
                                stamp={stamp}
                                number={number}
                              />
                            </details>
                          ) : null}
                          {mayManage ? (
                            <>
                              <span style={metaStyle}>{t('strategy.acceptExplains')}</span>
                              <div style={actionsStyle}>
                                <form action={reviewInsightAction}>
                                  <input type="hidden" name="locale" value={locale} />
                                  <input type="hidden" name="insightId" value={proposal.id} />
                                  <input type="hidden" name="decision" value="accept" />
                                  <button
                                    type="submit"
                                    style={buttonStyle('brand', 'sm')}
                                    className={buttonClass('brand')}
                                    data-testid={`strategy-accept-${proposal.id}`}
                                  >
                                    {t('insights.accept')}
                                  </button>
                                </form>
                                <form action={reviewInsightAction}>
                                  <input type="hidden" name="locale" value={locale} />
                                  <input type="hidden" name="insightId" value={proposal.id} />
                                  <input type="hidden" name="decision" value="dismiss" />
                                  <button
                                    type="submit"
                                    style={buttonStyle('ghost', 'sm')}
                                    className={buttonClass('ghost')}
                                  >
                                    {t('insights.dismiss')}
                                  </button>
                                </form>
                                {mayReview ? (
                                  <form action={proposeLearningsAction}>
                                    <input type="hidden" name="locale" value={locale} />
                                    <input type="hidden" name="insightId" value={proposal.id} />
                                    <button
                                      type="submit"
                                      style={buttonStyle('neutral', 'sm')}
                                      className={buttonClass('neutral')}
                                      data-testid="propose-learnings"
                                    >
                                      {t('insights.proposeLearnings')}
                                    </button>
                                  </form>
                                ) : null}
                              </div>
                            </>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </Card>
          </>
        )}
      </Stack>
    </WorkspaceShell>
  );
}

/** A share of the whole, as a bar and a number — the number is the fact. */
function ShareBar({
  label,
  value,
  format,
}: {
  readonly label: string;
  readonly value: number;
  readonly format: Intl.NumberFormat;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div style={{ display: 'grid', gap: spacingTokens['3xs'] }}>
      <div style={{ ...headStyle, justifyContent: 'space-between' }}>
        <strong style={titleStyle} dir="auto">
          {label}
        </strong>
        <span style={metaStyle}>{format.format(value)}%</span>
      </div>
      <span aria-hidden="true" style={trackStyle}>
        <span style={{ ...fillStyle, inlineSize: `${clamped}%` }} />
      </span>
    </div>
  );
}

function KnowledgeList({
  items,
  locale,
  empty,
  addLabel,
  addHref,
}: {
  readonly items: readonly { id: string; title: unknown; body: unknown }[];
  readonly locale: string;
  readonly empty: string;
  readonly addLabel: string;
  readonly addHref: string;
}) {
  if (items.length === 0) {
    return (
      <div style={{ display: 'grid', gap: spacingTokens.xs }}>
        <p style={metaStyle}>{empty}</p>
        {addLabel ? (
          <div>
            <Link
              href={addHref}
              style={buttonStyle('ghost', 'sm')}
              className={buttonClass('ghost')}
            >
              {addLabel}
            </Link>
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <ul style={listStyle}>
      {items.map((item) => (
        <li key={item.id} style={rowStyle}>
          <strong style={titleStyle} dir="auto">
            {localized(item.title, locale)}
          </strong>
          <span style={metaStyle} dir="auto">
            {localized(item.body, locale).slice(0, 220)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function EvidenceList({
  locale,
  rows,
  t,
  stamp,
  number,
}: {
  readonly locale: string;
  readonly rows: readonly {
    id: string;
    ordinal: number;
    metricKey: string | null;
    labelKey: string | null;
    value: unknown;
    comparisonValue: unknown;
    periodStart: Date | null;
    periodEnd: Date | null;
  }[];
  readonly t: (key: MessageKey) => string;
  readonly stamp: Intl.DateTimeFormat;
  readonly number: Intl.NumberFormat;
}) {
  return (
    <ul style={{ ...listStyle, gap: spacingTokens['3xs'] }} data-testid="insight-evidence">
      {rows.map((row) => (
        <li key={row.id} style={metaStyle}>
          <strong style={{ color: colorTokens.textPrimary }}>{row.ordinal}.</strong>{' '}
          {row.metricKey
            ? t(`analytics.metric.${row.metricKey}` as MessageKey)
            : evidenceLabel(locale, row.labelKey)}
          {row.value === null ? '' : ` — ${number.format(Number(row.value))}`}
          {row.periodStart && row.periodEnd
            ? ` (${stamp.format(row.periodStart)} – ${stamp.format(row.periodEnd)})`
            : ''}
          {row.comparisonValue === null || row.comparisonValue === undefined
            ? ''
            : ` · ${t('insights.anomalyBaseline')} ${number.format(Number(row.comparisonValue))}`}
        </li>
      ))}
    </ul>
  );
}

/** A `{ ar, en }` JSON column, in the reader's own language. */
function localized(value: unknown, locale: string): string {
  if (typeof value !== 'object' || value === null) return '';
  const record = value as Record<string, unknown>;
  const picked = locale === 'ar' ? (record['ar'] ?? record['en']) : (record['en'] ?? record['ar']);
  return typeof picked === 'string' ? picked : '';
}

const twoColumnStyle = {
  display: 'grid',
  gap: spacingTokens.lg,
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 20rem), 1fr))',
} as const;
const listStyle = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'grid',
  gap: spacingTokens.sm,
} as const;
const rowStyle = { display: 'grid', gap: spacingTokens['3xs'] } as const;
const proposalStyle = {
  display: 'grid',
  gap: spacingTokens.xs,
  padding: spacingTokens.md,
  borderRadius: radiusTokens.md,
  border: `1px dashed ${colorTokens.border}`,
} as const;
const headStyle = {
  display: 'flex',
  gap: spacingTokens.xs,
  alignItems: 'center',
  flexWrap: 'wrap',
} as const;
const actionsStyle = { display: 'flex', gap: spacingTokens.xs, flexWrap: 'wrap' } as const;
const titleStyle = {
  ...typographyTokens.bodySm,
  fontWeight: 600,
  color: colorTokens.textPrimary,
} as const;
const leadStyle = { ...typographyTokens.body, margin: 0, color: colorTokens.textPrimary } as const;
const bodyStyle = {
  ...typographyTokens.bodySm,
  margin: 0,
  color: colorTokens.textSecondary,
} as const;
const kickerStyle = {
  ...typographyTokens.caption,
  fontWeight: 600,
  color: colorTokens.textSecondary,
} as const;
const metaStyle = { ...typographyTokens.caption, margin: 0, color: colorTokens.textMuted } as const;
const trackStyle = {
  display: 'block',
  blockSize: '0.375rem',
  borderRadius: radiusTokens.full,
  background: colorTokens.surfaceMuted,
  overflow: 'hidden',
} as const;
const fillStyle = {
  display: 'block',
  blockSize: '100%',
  borderRadius: radiusTokens.full,
  background: colorTokens.brandPurple,
} as const;
