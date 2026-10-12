import Link from 'next/link';
import { FirstVisitHint } from '../../../components/first-visit-hint';
import {
  brandBrainChangedSince,
  usableFactsForDisplay,
  writingGoal,
} from '@brandspace/brand-brain';
import { brandScopeFilter, maySpendCredits, systemClock } from '@brandspace/shared';
import { CopilotLink } from '../../../components/copilot-link';
import {
  SegmentPill,
  Stack,
  StateMessage,
  colorTokens,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import { MoreDisclosure } from '../../../components/more-disclosure';
import { requireWorkspacePage } from '../../../server/customer-context';
import { NoAccessPage } from '../../../components/no-access-page';
import { brandContextFor, requiredBrand } from '../../../server/brand-context';
import { inAnalytics } from '../../../server/analytics-context';
import { inContentStudio } from '../../../server/content-context';
import { pillarAverages } from '../../../server/performance-view';
import { StartBusy, StartBusyReporter } from './start-busy';
import { copilotHref } from '../../../server/copilot-surface';
import { aiAvailableFor } from '../../../server/ai-availability';
import { AiUnavailableLine } from '../../../components/ai-unavailable';
import {
  GOAL_ITEM_KEY,
  campaignObjectiveFor,
  goalLabels,
  storedGoal,
} from '../../../server/setup-wizard-state';
import {
  campaignHref,
  campaignTimeline,
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
import {
  acknowledgeKnowledgeChangeAction,
  generateStrategyAction,
  proposeLearningsAction,
  reviewInsightAction,
} from './actions';

import { EmptyAction } from '../../../components/empty-action';
import { type DateFormatterLike, dayFormatter, rangeLabel } from '../../../server/prototype-dates';

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
  const access = await requireWorkspacePage(locale, '/strategy');
  const { messageLocale } = access.session;
  const t = translator(messageLocale);
  if (!access.allowed) return <NoAccessPage locale={locale} access={access} />;
  const session = access.session;
  const { workspace } = session;
  const may = (key: string) => workspace.permissionKeys.includes(key);

  const ok = typeof query['ok'] === 'string' ? query['ok'] : null;
  const error = typeof query['error'] === 'string' ? query['error'] : null;
  const mayManage = may('strategy.manage');
  // Q18 — proposing a strategy spends credits; reviewing one does not.
  // PR F (b), Q9: proposing one also needs its AI to be able to run; while it
  // cannot, the member who could propose sees "AI isn't available yet." instead.
  const mayPropose = maySpendCredits(workspace.permissionKeys, 'strategy.manage');
  const aiStrategy = await aiAvailableFor('strategy.generate');
  const mayGenerate = mayPropose && aiStrategy;
  const aiOff = mayPropose && !aiStrategy;
  const mayReview = may('brand_brain.review');

  const brandContext = await brandContextFor(
    session.workspace,
    '/strategy',
    typeof query['brand'] === 'string' ? query['brand'] : null,
  );
  const brand = requiredBrand(brandContext);

  const stamp = dayFormatter(locale, 'UTC', systemClock.now());
  const number = new Intl.NumberFormat('en-US');

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
          /*
           * THE GOAL PREFILLS THE OBJECTIVE the strategy is generated from, so
           * it is writing input and is read through the Brand Brain grounding
           * layer (D-354): never an expired goal, and none while the brand has
           * "Use Brand Brain" off — the objective then starts empty.
           */
          writingGoal(db, { brandId: brand.id, itemKey: GOAL_ITEM_KEY }),
          /*
           * THE DISPLAY LISTS (§9.1 fix, Phase 2C-4): the grounding layer's
           * usable rule — ACTIVE or STALE, not expired as of the workspace's
           * day — instead of `status: 'ACTIVE'`, which showed an expired fact
           * and hid a STALE one. Display only; no prompt is built from these.
           */
          usableFactsForDisplay(db, {
            brandId: brand.id,
            areas: ['AUDIENCE', 'OFFERS', 'PROOF_POINTS', 'STRATEGY'],
            take: 40,
          }),
        ]);
        /*
         * D13 (Phase 2C-4) — "BRAND BRAIN CHANGED", from the signature the
         * accepted strategy was generated on (M7) against the brand's usable
         * facts now. A strategy with no stored signature (older than M7) has
         * no baseline and never alerts. Reading this writes nothing.
         */
        const knowledgeChanged = await brandBrainChangedSince(db, {
          brandId: brand.id,
          storedSignature: accepted?.knowledgeSignature,
        });
        return { accepted, proposals, goal, knowledge, knowledgeChanged };
      })
    : null;

  const plan = data?.accepted ? parseStrategyBody(data.accepted.body) : null;
  /*
   * D-496 (Strategy 6) — the brand's campaigns for the three-month timeline,
   * read like Campaigns reads them (scope in the WHERE), for a member who may
   * open Campaigns.
   */
  const timeline =
    brand && may('campaigns.read')
      ? campaignTimeline(
          await inContentStudio(workspace.workspaceId, async (services) =>
            services.campaigns().list({
              brandId: brand.id,
              brandScope: workspace.brandScope,
              take: 200,
            }),
          ),
          systemClock.now(),
        )
      : null;
  const monthLabel = (value: Date) => {
    const label = new Intl.DateTimeFormat(locale === 'ar' ? 'ar-u-nu-latn' : 'en', {
      month: 'short',
      timeZone: 'UTC',
    }).format(value);
    return locale === 'ar' ? label : label.toUpperCase();
  };
  /*
   * PR D (Strategy 7) — "HOW IT'S GOING" (`x.st.perf`, line 1131): average
   * engagements per post, per pillar, over the last 28 days, from the posts'
   * own readings through the same analytics query Performance uses, for a
   * member who may read analytics. Real readings only: with none, no card.
   */
  const pillarPerformance =
    brand && plan && may('analytics.read')
      ? await inAnalytics(workspace.workspaceId, async (services) => {
          const queries = await services.queries();
          const now = systemClock.now();
          const rows = await queries.topPosts({
            scope: { brandId: brand.id },
            period: { start: new Date(now.getTime() - 28 * 86_400_000), end: now },
            metricKey: 'engagements',
            limit: 200,
            brandScope: workspace.brandScope,
          });
          const perPost = new Map<string, number>();
          for (const row of rows) {
            perPost.set(
              row.contentItemId,
              (perPost.get(row.contentItemId) ?? 0) + Number(row.value),
            );
          }
          const pillars =
            perPost.size > 0
              ? await services.db.contentItem.findMany({
                  where: {
                    workspaceId: workspace.workspaceId,
                    id: { in: [...perPost.keys()] },
                    ...brandScopeFilter(workspace.brandScope),
                  },
                  select: { id: true, pillar: true },
                })
              : [];
          return pillarAverages(
            pillars.map((item) => ({ pillar: item.pillar, value: perPost.get(item.id) ?? 0 })),
          );
        }).catch(() => [])
      : [];
  const goalTitle =
    data?.goal && typeof data.goal.title === 'object' && data.goal.title !== null
      ? (data.goal.title as Record<string, unknown>)
      : null;
  const firstGoal = storedGoal(data?.goal ?? null);
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
  const platformName = (key: string) =>
    optionalMessage(messageLocale, `content.platform.${key}`) ?? key;
  const refs = (rationale: Rationale) =>
    rationale.evidenceRefs.length > 0
      ? ` · ${t('strategy.rests')} ${evidenceRefs(locale, rationale.evidenceRefs)}`
      : '';
  const copilot =
    may('copilot.use') && (await aiAvailableFor('copilot.chat'))
      ? copilotHref(locale, 'strategy')
      : null;
  const brainHref = `/${locale}/brand-brain`;
  const view: 'current' | 'next' = query['view'] === 'next' ? 'next' : 'current';
  const brandParam = typeof query['brand'] === 'string' ? query['brand'] : null;
  const viewHref = (next: 'current' | 'next') => {
    const params = new URLSearchParams({
      ...(brandParam ? { brand: brandParam } : {}),
      ...(next === 'next' ? { view: 'next' } : {}),
    }).toString();
    return `/${locale}/strategy${params ? `?${params}` : ''}`;
  };

  return (
    <WorkspaceShell
      brandContext={brandContext}
      locale={locale}
      eyebrow={t('nav.group.plan')}
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
            {/*
              Gate 2b — THE PROTOTYPE'S STRATEGY (`Main.dc.html` lines 975–1110):
              the period switch, the objective hero, "Built on Brand Brain"
              beside the pillars, and the month's weeks. "Next strategy" holds
              what the prototype starts a new strategy with: the AI draft (the
              product's proposal form) and the drafts waiting for a decision.
              Left out, as the owner decided: the hero's weekly number and
              "Early signals"; and, for want of a feature: "Edit strategy",
              the history, the planned-vs-actual figure, "Start from the
              current strategy" and "Start empty".
            */}
            {/* D-496 (Strategy 1) — the first-visit hint, Main.dc.html L977. */}
            <FirstVisitHint
              storageKey="brandspace.hint.strategy"
              text={t('hint.strategy')}
              closeLabel={t('hint.close')}
              testId="hint-strategy"
            />
            <nav
              className="bsp-seg bsp-sp-seg"
              aria-label={t('strategy.view.label')}
              data-testid="strategy-views"
            >
              <SegmentPill selector='[aria-current="page"]' />
              <Link
                href={viewHref('current')}
                aria-current={view === 'current' ? 'page' : undefined}
                data-testid="strategy-view-current"
              >
                {t('strategy.view.current')}
                <span className={`bsp-xstatus bsp-sp-segst${data.accepted ? '' : ' bsp-neu'}`}>
                  {data.accepted ? t('strategy.status.active') : t('strategy.status.none')}
                </span>
              </Link>
              <Link
                href={viewHref('next')}
                aria-current={view === 'next' ? 'page' : undefined}
                data-testid="strategy-view-next"
              >
                {t('strategy.view.next')}
                <span
                  className={`bsp-xstatus bsp-sp-segst${data.proposals.length > 0 ? ' bsp-warn' : ' bsp-neu'}`}
                >
                  {data.proposals.length > 0
                    ? t('strategy.status.drafts').replace(
                        '{count}',
                        number.format(data.proposals.length),
                      )
                    : t('strategy.status.notStarted')}
                </span>
              </Link>
            </nav>

            {view === 'current' ? (
              <>
                {data.accepted ? (
                  /* The hero: `border-radius: 26px; padding: 26px 28px`, the gradient. */
                  <section className="bsp-sp-hero" data-testid="strategy-objective">
                    <div className="bsp-sp-pills">
                      <span className="bsp-pill bsp-sp-pill-p">{t('strategy.acceptedBadge')}</span>
                      <span className="bsp-pill bsp-sp-pill-w">
                        {t('strategy.acceptedOn')}{' '}
                        {stamp.format(data.accepted.reviewedAt ?? data.accepted.createdAt)} ·{' '}
                        {t('insights.basis')}:{' '}
                        {t(`insights.basis.${data.accepted.basis}` as MessageKey)}
                      </span>
                    </div>
                    {plan?.summary ? (
                      <div className="bsp-sp-obj" dir="auto" data-testid="strategy-summary">
                        {pick(plan.summary, locale)}
                      </div>
                    ) : goalText ? (
                      <div className="bsp-sp-obj" dir="auto">
                        {goalText}
                      </div>
                    ) : null}
                    {goalText ? (
                      <span className="bsp-sp-from" data-testid="strategy-goal">
                        {t('strategy.objectiveFrom').replace('{goal}', goalText)}
                      </span>
                    ) : null}
                    <span className="bsp-sp-mix" data-testid="strategy-channels">
                      <b>{t('strategy.channelMix')}:</b>{' '}
                      {plan && plan.channelMix.length > 0 ? (
                        <>
                          <span className="bsp-ltr">
                            {plan.channelMix
                              .map(
                                (channel) =>
                                  `${platformName(channel.platformKey)} ${number.format(channel.sharePercent)}%`,
                              )
                              .join(' · ')}
                          </span>
                          <MoreDisclosure
                            label={t('strategy.whyMix')}
                            testId="strategy-channels-why"
                          >
                            <ul className="bsp-sp-why">
                              {plan.channelMix.map((channel) => (
                                <li key={channel.platformKey}>
                                  <b>{platformName(channel.platformKey)}</b>{' '}
                                  <span dir="auto">
                                    {pick(channel.rationale.text, locale)}
                                    {refs(channel.rationale)}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </MoreDisclosure>
                        </>
                      ) : (
                        t('strategy.channelsEmpty')
                      )}
                    </span>
                    <div className="bsp-sp-acts">
                      {copilot ? (
                        <CopilotLink
                          href={copilot}
                          className="bsp-btn bsp-sm bsp-sec"
                          data-testid="strategy-copilot"
                        >
                          {t('home.recommended.giveToCopilot')}
                        </CopilotLink>
                      ) : null}
                      {mayGenerate || data.proposals.length > 0 ? (
                        <Link
                          href={viewHref('next')}
                          className="bsp-btn bsp-sm bsp-ghost bsp-sp-next"
                          data-testid="strategy-plan-next"
                        >
                          {t('strategy.planNext')} <span className="bsp-sp-arrow">→</span>
                        </Link>
                      ) : null}
                    </div>
                  </section>
                ) : (
                  /* No strategy yet (`x.es.stNone`): the card with its two ways on. */
                  <section className="bsp-card bsp-sp-empty" data-testid="strategy-objective">
                    <span className="bsp-xicon" aria-hidden="true">
                      ✧
                    </span>
                    <b className="bsp-sp-empty-t">{t('strategy.noAcceptedBadge')}</b>
                    <span className="bsp-sp-empty-s" data-testid="strategy-none">
                      {t('strategy.noneAccepted')}
                    </span>
                    {goalText ? (
                      <span className="bsp-sp-empty-s" data-testid="strategy-goal">
                        {t('strategy.objectiveFrom').replace('{goal}', goalText)}
                      </span>
                    ) : null}
                    {aiOff ? <AiUnavailableLine text={t('ai.unavailable')} /> : null}
                    <div className="bsp-sp-acts">
                      {mayGenerate ? (
                        <Link
                          href={viewHref('next')}
                          className="bsp-btn bsp-pur"
                          data-testid="strategy-plan-next"
                        >
                          {t('strategy.planOne')}
                        </Link>
                      ) : null}
                      <Link href={brainHref} className="bsp-btn bsp-sec">
                        {t('strategy.brainChanged.review')}
                      </Link>
                      {copilot ? (
                        <CopilotLink
                          href={copilot}
                          className="bsp-btn bsp-ghost"
                          data-testid="strategy-copilot"
                        >
                          {t('home.recommended.giveToCopilot')}
                        </CopilotLink>
                      ) : null}
                    </div>
                  </section>
                )}

                {data.knowledgeChanged ? (
                  /* The Brand Brain alert (`x.brainAlert`): one line, Review and OK. */
                  <div className="bsp-sp-alert" role="status" data-testid="strategy-brain-changed">
                    <span className="bsp-xstatus bsp-warn">Brand Brain</span>
                    <span className="bsp-sp-alert-t">
                      <strong>{t('strategy.brainChanged.title')}</strong>{' '}
                      {t('strategy.brainChanged.body')}
                    </span>
                    <Link
                      href={brainHref}
                      className="bsp-btn bsp-sm"
                      data-testid="strategy-brain-changed-review"
                    >
                      {t('strategy.brainChanged.review')}
                    </Link>
                    {mayManage && data.accepted ? (
                      /*
                       * D13 ACKNOWLEDGE (owner decision Option 1): re-baselines
                       * the accepted strategy on the current facts, server-side,
                       * `strategy.manage`. Not offered without it.
                       */
                      <form action={acknowledgeKnowledgeChangeAction}>
                        <input type="hidden" name="locale" value={locale} />
                        <input type="hidden" name="brandId" value={brand.id} />
                        <input type="hidden" name="insightId" value={data.accepted.id} />
                        <button
                          type="submit"
                          className="bsp-btn bsp-sm bsp-ghost"
                          data-testid="strategy-brain-changed-acknowledge"
                        >
                          {t('strategy.brainChanged.acknowledge')}
                        </button>
                      </form>
                    ) : null}
                  </div>
                ) : null}

                <div className="bsp-xgrid bsp-sp-grid">
                  {/* "Built on Brand Brain" (`x.links`): area, the fact, Open →. */}
                  <section className="bsp-xcard bsp-sp-brain" data-testid="strategy-brain">
                    <span className="bsp-sp-brain-top">
                      <span className="bsp-xicon" aria-hidden="true">
                        ◇
                      </span>
                      <span className="bsp-xstatus bsp-ai">{t('strategy.fromBrandBrain')}</span>
                    </span>
                    <span className="bsp-xtitle bsp-sp-brain-t">{t('strategy.builtOn')}</span>
                    <span className="bsp-xdesc bsp-sp-brain-s">{t('strategy.builtOnSub')}</span>
                    <BrainRows
                      testId="strategy-audience"
                      area={t('strategy.section.audience')}
                      emptyArea="AUDIENCE"
                      items={audience}
                      locale={locale}
                      empty={t('strategy.audienceEmpty')}
                      openLabel={t('strategy.open')}
                      addLabel={t('strategy.addKnowledge')}
                      href={brainHref}
                    />
                    <BrainRows
                      testId="strategy-messages"
                      area={t('strategy.section.messages')}
                      emptyArea="OFFERS"
                      items={messagesKnown}
                      locale={locale}
                      empty={t('strategy.messagesEmpty')}
                      openLabel={t('strategy.open')}
                      addLabel={t('strategy.addKnowledge')}
                      href={brainHref}
                    />
                  </section>
                  {/* The pillars: a dot, the name, the share, the bar and "↳" its reason. */}
                  <section className="bsp-xcard bsp-sp-pillars" data-testid="strategy-pillars">
                    <span className="bsp-xicon" aria-hidden="true">
                      ✧
                    </span>
                    <div className="bsp-sp-pil-head">
                      <span className="bsp-xtitle bsp-sp-pil-t">{t('strategy.pillars')}</span>
                      {plan && plan.pillars.length > 0 ? (
                        <span className="bsp-xcount">{t('strategy.plannedShare')}</span>
                      ) : null}
                    </div>
                    {plan && plan.pillars.length > 0 ? (
                      plan.pillars.map((pillar, index) => (
                        <div key={index} className="bsp-sp-pil" data-pil={index % 6}>
                          <div className="bsp-sp-pil-row">
                            <span className="bsp-sp-dot" aria-hidden="true" />
                            <span className="bsp-sp-pil-n" dir="auto">
                              {pick(pillar.name, locale)}
                            </span>
                            <span className="bsp-ltr bsp-sp-pil-v">
                              {number.format(pillar.sharePercent)}%
                            </span>
                          </div>
                          <div className="bsp-sp-pil-bar" aria-hidden="true">
                            <span
                              style={{
                                width: `${Math.max(0, Math.min(100, pillar.sharePercent))}%`,
                              }}
                            />
                          </div>
                          <span className="bsp-sp-pil-src" dir="auto">
                            ↳ {pick(pillar.rationale.text, locale)}
                            {refs(pillar.rationale)}
                          </span>
                        </div>
                      ))
                    ) : declaredPillars.length > 0 ? (
                      <>
                        <span className="bsp-sp-pil-note">{t('strategy.declaredPillars')}</span>
                        {declaredPillars.map((item, index) => (
                          <div key={item.id} className="bsp-sp-pil" data-pil={index % 6}>
                            <div className="bsp-sp-pil-row">
                              <span className="bsp-sp-dot" aria-hidden="true" />
                              <span className="bsp-sp-pil-n" dir="auto">
                                {localized(item.title, locale)}
                              </span>
                            </div>
                          </div>
                        ))}
                      </>
                    ) : (
                      <span className="bsp-sp-pil-note">{t('strategy.pillarsEmpty')}</span>
                    )}
                  </section>
                </div>

                {/* The month (`x.weeks`): a card per week, two across. */}
                <section className="bsp-sp-month" data-testid="strategy-month">
                  <div className="bsp-sp-month-h">
                    <h2 className="bsp-sech">{t('strategy.monthlyPlan')}</h2>
                    <span className="bsp-sp-month-hint">{t('strategy.monthHint')}</span>
                    {plan && plan.monthlyPlan.length > 0
                      ? (() => {
                          /*
                           * PR D (Strategy 5) — THE MONTH'S CADENCE (`x.st.cadence`,
                           * line 1070): the plan's own weeks, posts a week to one
                           * decimal and the month's total.
                           */
                          const total = plan.monthlyPlan.reduce(
                            (sum, week) => sum + week.postsPlanned,
                            0,
                          );
                          const weekly = Math.round((total / plan.monthlyPlan.length) * 10) / 10;
                          return (
                            <span className="bsp-sp-cadence" data-testid="strategy-cadence">
                              {t('strategy.cadence')
                                .replace('{week}', number.format(weekly))
                                .replace('{month}', number.format(total))}
                            </span>
                          );
                        })()
                      : null}
                  </div>
                  {plan && plan.monthlyPlan.length > 0 ? (
                    <div className="bsp-sp-weeks">
                      {plan.monthlyPlan.map((week) => (
                        <section
                          key={week.weekNumber}
                          className="bsp-xcard bsp-sp-week"
                          data-testid={`strategy-week-${week.weekNumber}`}
                        >
                          <span className="bsp-sp-week-h">
                            <span className="bsp-sp-week-t">
                              {t('strategy.week').replace('{n}', number.format(week.weekNumber))}
                            </span>
                            <span className="bsp-sp-week-th" dir="auto">
                              {pick(week.theme, locale)}
                            </span>
                          </span>
                          <div className="bsp-sp-topic">
                            <span className="bsp-sp-topic-c">
                              <span className="bsp-sp-topic-t" dir="auto">
                                {pick(week.rationale.text, locale)}
                              </span>
                              <span className="bsp-sp-topic-m">
                                {t('strategy.postsPlanned').replace(
                                  '{count}',
                                  number.format(week.postsPlanned),
                                )}
                                {refs(week.rationale)}
                              </span>
                            </span>
                          </div>
                          <div className="bsp-sp-week-acts">
                            {may('campaigns.manage') ? (
                              <Link
                                href={campaignHref({
                                  locale,
                                  week,
                                  channels: leadingChannels(plan),
                                  objective: campaignObjectiveFor(firstGoal),
                                })}
                                className="bsp-sp-act"
                                data-testid={`strategy-week-campaign-${week.weekNumber}`}
                              >
                                {t('strategy.createCampaign')}{' '}
                                <span className="bsp-sp-arrow">→</span>
                              </Link>
                            ) : null}
                            {may('content.create') ? (
                              <Link
                                href={contentHref({ locale, week })}
                                className="bsp-sp-act"
                                data-testid={`strategy-week-content-${week.weekNumber}`}
                              >
                                {t('strategy.sendToContent')}{' '}
                                <span className="bsp-sp-arrow">→</span>
                              </Link>
                            ) : null}
                            {copilot ? (
                              <CopilotLink href={copilot} className="bsp-sp-act">
                                {t('home.recommended.giveToCopilot')}{' '}
                                <span className="bsp-sp-arrow">→</span>
                              </CopilotLink>
                            ) : null}
                          </div>
                        </section>
                      ))}
                    </div>
                  ) : (
                    <span className="bsp-sp-month-hint">{t('strategy.monthEmpty')}</span>
                  )}
                </section>

                {timeline ? (
                  /*
                   * D-496 (Strategy 6) — "Campaigns in this period"
                   * (`Main.dc.html` L1116–1125): three months, one bar per
                   * campaign by status; a name opens that campaign.
                   */
                  <section className="bsp-xcard bsp-sp-tl" data-testid="strategy-timeline">
                    <div className="bsp-sp-tl-h">
                      <h2 className="bsp-sech">{t('strategy.timeline.title')}</h2>
                      <Link
                        href={`/${locale}/campaigns`}
                        className="bsp-btn bsp-sm bsp-ghost"
                        data-testid="strategy-timeline-all"
                      >
                        {t('strategy.timeline.viewAll')} →
                      </Link>
                    </div>
                    <div className="bsp-sp-tl-months" aria-hidden="true">
                      <span />
                      {timeline.months.map((month) => (
                        <span key={month.toISOString()} className="bsp-sp-tl-month">
                          {monthLabel(month)}
                        </span>
                      ))}
                    </div>
                    {timeline.rows.length === 0 ? (
                      <span className="bsp-sp-month-hint" data-testid="strategy-timeline-none">
                        {t('strategy.timeline.none')}
                      </span>
                    ) : (
                      timeline.rows.map((row) => (
                        <div
                          key={row.id}
                          className="bsp-sp-tl-row"
                          data-testid={`strategy-timeline-${row.id}`}
                        >
                          <Link
                            href={`/${locale}/campaigns/${row.id}`}
                            className="bsp-sp-tl-name"
                            dir="auto"
                          >
                            {row.name}
                          </Link>
                          <div className="bsp-sp-tl-track">
                            <span
                              className="bsp-sp-tl-bar bsp-ltr"
                              data-kind={row.kind}
                              style={{ insetInlineStart: `${row.left}%`, width: `${row.width}%` }}
                            >
                              {rangeLabel(row.start, row.end, locale, 'UTC')}
                            </span>
                          </div>
                        </div>
                      ))
                    )}
                  </section>
                ) : null}

                {pillarPerformance.length > 0 ? (
                  /*
                   * PR D (Strategy 7) — the prototype's "How it's going" half
                   * (line 1126). Its other half, the monthly review, is
                   * Strategy 8 and not built, so this half spans the card.
                   */
                  <section className="bsp-xcard bsp-sp-how" data-testid="strategy-how">
                    <h2 className="bsp-sech">{t('strategy.howGoing')}</h2>
                    <span className="bsp-sp-how-sub">{t('strategy.howSub')}</span>
                    {(() => {
                      const top = Math.max(1, ...pillarPerformance.map((row) => row.average));
                      return pillarPerformance.map((row, index) => {
                        const planned = plan
                          ? plan.pillars.findIndex(
                              (pillar) =>
                                pick(pillar.name, 'en') === row.pillar ||
                                pick(pillar.name, 'ar') === row.pillar,
                            )
                          : -1;
                        return (
                          <div
                            key={row.pillar}
                            className="bsp-sp-pil bsp-sp-how-row"
                            data-pil={(planned >= 0 ? planned : index) % 6}
                            data-testid={`strategy-how-${index}`}
                          >
                            <span className="bsp-sp-dot" aria-hidden="true" />
                            <span className="bsp-sp-how-n" dir="auto">
                              {row.pillar}
                            </span>
                            <span className="bsp-sp-how-bar" aria-hidden="true">
                              <span style={{ width: `${(row.average / top) * 100}%` }} />
                            </span>
                            <span className="bsp-ltr bsp-sp-how-v">
                              {number.format(Math.round(row.average))}
                            </span>
                            {index === 0 && pillarPerformance.length > 1 ? (
                              <span className="bsp-pill bsp-p-ok" data-testid="strategy-how-best">
                                {t('strategy.best')}
                              </span>
                            ) : null}
                          </div>
                        );
                      });
                    })()}
                  </section>
                ) : null}

                {/*
                  WHAT IT RESTS ON: the stored evidence rows. The prototype draws
                  none, so it is a disclosure at the page's foot, as Brand
                  Brain's notes are.
                */}
                <details className="bsp-bb-notes" data-testid="strategy-evidence">
                  <summary className="bsp-chip bsp-fdis-chip">
                    {t('strategy.section.evidence')}
                  </summary>
                  <div className="bsp-sp-evidence">
                    <span className="bsp-sp-month-hint">{t('insights.noExternalData')}</span>
                    {data.accepted && data.accepted.evidence.length > 0 ? (
                      <EvidenceList
                        locale={locale}
                        rows={data.accepted.evidence}
                        t={t}
                        stamp={stamp}
                        number={number}
                      />
                    ) : (
                      <span className="bsp-sp-month-hint">{t('strategy.evidenceEmpty')}</span>
                    )}
                  </div>
                </details>
              </>
            ) : (
              <>
                {/* A new strategy (`x.sp.choosing`): the gradient title, then the ways to start. */}
                <section className="bsp-sp-start">
                  <span className="bsp-sp-start-t">{t('strategy.startTitle')}</span>
                  <span className="bsp-sp-start-s">{t('strategy.startSub')}</span>
                </section>
                {aiOff ? <AiUnavailableLine text={t('ai.unavailable')} /> : null}
                {mayGenerate ? (
                  <StartBusy label={t('strategy.busy')}>
                    <div className="bsp-xgrid bsp-sp-opts">
                      <section className="bsp-sp-opt">
                        <span className="bsp-xicon" aria-hidden="true">
                          ✦
                        </span>
                        <span className="bsp-xtitle bsp-sp-opt-t">{t('strategy.optAi')}</span>
                        <span className="bsp-xdesc">{t('strategy.optAiSub')}</span>
                        <form
                          action={generateStrategyAction}
                          data-testid="strategy-form"
                          className="bsp-sp-form"
                        >
                          <input type="hidden" name="locale" value={locale} />
                          <input type="hidden" name="brandId" value={brand.id} />
                          <label className="bsp-sp-field">
                            <span className="bsp-lbl">{t('strategy.objectiveLabel')}</span>
                            <input
                              name="objective"
                              required
                              maxLength={400}
                              className="bs-control"
                              defaultValue={goalText ?? ''}
                              placeholder={t('strategy.objectivePlaceholder')}
                              data-testid="strategy-objective-input"
                            />
                          </label>
                          {goalText ? (
                            <span className="bsp-sp-month-hint">
                              {t('strategy.startsFromGoal')}
                            </span>
                          ) : null}
                          <button type="submit" className="bsp-btn bsp-sm bsp-pur">
                            {t('strategy.generate')}
                          </button>
                          <StartBusyReporter />
                        </form>
                      </section>
                    </div>
                  </StartBusy>
                ) : null}

                {/* The drafts (`x.sp.draft`): each proposal, apart from the plan. */}
                <section className="bsp-sp-drafts" data-testid="strategy-suggestions">
                  <div className="bsp-sp-month-h">
                    <h2 className="bsp-sech">{t('strategy.section.suggestions')}</h2>
                    <span className="bsp-sp-month-hint">{t('strategy.proposalNotice')}</span>
                  </div>
                  {data.proposals.length === 0 ? (
                    <span className="bsp-sp-month-hint">{t('strategy.empty')}</span>
                  ) : (
                    data.proposals.map((proposal) => {
                      const body = parseStrategyBody(proposal.body);
                      return (
                        <section
                          key={proposal.id}
                          className="bsp-sp-draft"
                          data-testid={`insight-${proposal.id}`}
                        >
                          <div className="bsp-sp-draft-l">
                            <span className="bsp-xstatus bsp-ai bsp-sp-tag">
                              {t('strategy.proposalBadge')}
                            </span>
                            <span className="bsp-sp-draft-t" dir="auto">
                              {localized(proposal.title, locale)}
                            </span>
                            <span className="bsp-sp-month-hint">
                              {stamp.format(proposal.createdAt)}
                            </span>
                            {body.summary ? (
                              <div className="bsp-sp-why-box">
                                <span className="bsp-sp-why-l">{t('strategy.why')}</span>
                                <span className="bsp-sp-why-t" dir="auto">
                                  {pick(body.summary, locale)}
                                </span>
                              </div>
                            ) : null}
                            {mayManage ? (
                              <>
                                <span className="bsp-sp-month-hint">
                                  {t('strategy.acceptExplains')}
                                </span>
                                <div className="bsp-sp-acts">
                                  <form action={reviewInsightAction}>
                                    <input type="hidden" name="locale" value={locale} />
                                    <input type="hidden" name="insightId" value={proposal.id} />
                                    <input type="hidden" name="decision" value="accept" />
                                    <button
                                      type="submit"
                                      className="bsp-btn bsp-sm bsp-pur"
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
                                      className="bsp-btn bsp-sm bsp-ghost bsp-sp-discard"
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
                                        className="bsp-btn bsp-sm bsp-sec"
                                        data-testid="propose-learnings"
                                      >
                                        {t('insights.proposeLearnings')}
                                      </button>
                                    </form>
                                  ) : null}
                                </div>
                              </>
                            ) : null}
                          </div>
                          <div className="bsp-sp-draft-r">
                            <span className="bsp-sp-k">{t('strategy.pillars')}</span>
                            {body.pillars.length > 0 ? (
                              <div className="bsp-sp-chips">
                                {body.pillars.map((pillar, index) => (
                                  <span
                                    key={index}
                                    className="bsp-chip bsp-sp-chip"
                                    data-pil={index % 6}
                                    dir="auto"
                                  >
                                    <span className="bsp-sp-dot" aria-hidden="true" />
                                    {pick(pillar.name, locale)}
                                  </span>
                                ))}
                              </div>
                            ) : (
                              <span className="bsp-sp-month-hint">
                                {t('strategy.pillarsEmpty')}
                              </span>
                            )}
                            {proposal.evidence.length > 0 ? (
                              <details>
                                <summary className="bsp-sp-k">{t('insights.evidence')}</summary>
                                <EvidenceList
                                  locale={locale}
                                  rows={proposal.evidence}
                                  t={t}
                                  stamp={stamp}
                                  number={number}
                                />
                              </details>
                            ) : null}
                          </div>
                        </section>
                      );
                    })
                  )}
                </section>
              </>
            )}
          </>
        )}
      </Stack>
    </WorkspaceShell>
  );
}

/**
 * "Built on Brand Brain" (`x.links`): a row per approved fact — its area, its
 * title, "Open →" — or, when Brand Brain has none, the area, what is missing
 * and the way to add it.
 */
function BrainRows({
  testId,
  area,
  items,
  locale,
  empty,
  openLabel,
  addLabel,
  href,
  emptyArea,
}: {
  readonly testId: string;
  readonly area: string;
  readonly items: readonly { id: string; area: string; title: unknown; body: unknown }[];
  readonly locale: string;
  readonly empty: string;
  readonly openLabel: string;
  readonly addLabel: string;
  readonly href: string;
  /** PR D (Strategy 9) — the area an empty row adds to. */
  readonly emptyArea: string;
}) {
  // PR D (Strategy 9) — "Open →" opens the fact's own area (`?area=`).
  const areaHref = (key: string) => `${href}?area=${encodeURIComponent(key)}`;
  return (
    <div className="bsp-sp-links" data-testid={testId}>
      {items.length === 0 ? (
        <div className="bsp-sp-link">
          <span className="bsp-sp-link-a">{area}</span>
          <span className="bsp-sp-link-t bsp-sp-link-none">{empty}</span>
          <Link href={areaHref(emptyArea)} className="bsp-sp-link-o">
            {addLabel} <span className="bsp-sp-arrow">→</span>
          </Link>
        </div>
      ) : (
        items.map((item) => (
          <div key={item.id} className="bsp-sp-link">
            <span className="bsp-sp-link-a">{area}</span>
            <span className="bsp-sp-link-t" dir="auto">
              <b>{localized(item.title, locale)}</b>
              {localized(item.body, locale)
                ? ` — ${localized(item.body, locale).slice(0, 160)}`
                : ''}
            </span>
            <Link
              href={areaHref(item.area)}
              className="bsp-sp-link-o"
              data-testid={`${testId}-open-${item.id}`}
            >
              {openLabel} <span className="bsp-sp-arrow">→</span>
            </Link>
          </div>
        ))
      )}
    </div>
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
  readonly stamp: DateFormatterLike;
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

const listStyle = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'grid',
  gap: spacingTokens.sm,
} as const;
const metaStyle = { ...typographyTokens.caption, margin: 0, color: colorTokens.textMuted } as const;
