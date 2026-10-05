import { CopilotLink } from '../../../components/copilot-link';
import { SegmentPill } from '@brandspace/ui';
import {
  AUTOMATION_ACTIONS,
  AUTOMATION_TRIGGERS,
  CONDITION_FIELDS,
  CONDITION_FIELD_CONTRACTS,
  authorableConditionFieldsFor,
  conditionFieldsForRule,
  entitledActionTypes,
  isAuthorablePair,
  isOlderAutomation,
  memberCatalogueFor,
  findAction,
  satisfiesActionPermissions,
  triggerAvailable,
  type ConditionField,
} from '@brandspace/automation';
import { INGESTED_METRIC_KEYS } from '@brandspace/analytics';
import { PAUSABLE_CAMPAIGN_STATUSES } from '@brandspace/content';
import { brandIdQueryFilter, brandScopeFilter, systemClock } from '@brandspace/shared';
import {
  currentEnvironment,
  inWorkspace,
  requireWorkspacePage,
} from '../../../server/customer-context';
import { NoAccessPage } from '../../../components/no-access-page';
import { brandContextFor, requiredBrand } from '../../../server/brand-context';
import { copilotHref } from '../../../server/copilot-surface';
import {
  aiCapReached,
  ideasLine,
  requestLine as requestLineFor,
  runPresentation,
  waitingHint,
} from '../../../server/automation-run-display';
import { createAutomationAiQuota, workspaceMonthLabel } from '@brandspace/entitlements';
import { inAnalytics } from '../../../server/analytics-context';
import {
  optionalMessage,
  statusMessage,
  translator,
  type MessageKey,
  successFlash,
  type MessageLocale,
} from '../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../components/workspace-shell';
import Link from 'next/link';
import { AutomationForm, type AutomationFormInitial } from './automation-form';
import { RuleDialog } from './rule-dialog';
import { RuleMenu } from './rule-menu';
import { MoreDisclosure } from '../../../components/more-disclosure';
import {
  confirmAutomationRunAction,
  createAutomationAction,
  deleteAutomationAction,
  skipAutomationRunAction,
  toggleAutomationAction,
  updateAutomationAction,
} from './actions';
import { whenLabel } from '../../../server/prototype-dates';

export const dynamic = 'force-dynamic';

/**
 * AUTOMATIONS — trigger, condition, action.
 *
 * WHAT THE SCREEN PROMISES AND THE ENGINE KEEPS:
 *
 *  - NO CODE, NO EXPRESSIONS, NO WEBHOOKS. The trigger and action pickers are
 *    rendered FROM THE REGISTRY, so a customer can only ever choose something the
 *    engine declares. There is no free-text field that becomes behaviour.
 *  - AN EXTERNAL ACTION NEVER RUNS ON ITS OWN. The banner says so, and a CHECK
 *    constraint on `automation_rule` makes a rule that claims otherwise
 *    unrepresentable.
 *  - A RULE STORES NO AUTHORITY. The run history renders
 *    `BLOCKED_BY_AUTHORIZATION` in words, so a rule that stopped working because
 *    its author was demoted says so rather than failing silently.
 */
/**
 * A CLOSED FIELD'S CHOICES, ALREADY TRANSLATED.
 *
 * `brand.id` and `metric.key` name things the registry cannot enumerate — one
 * is tenant data, the other is the analytics catalogue — so their lists are
 * supplied by the caller, which already holds both. Everything else comes
 * straight from the contract's own closed set.
 */
function conditionChoicesFor(
  field: ConditionField,
  messageLocale: MessageLocale,
  catalogues: {
    readonly brands: readonly { readonly id: string; readonly name: string }[];
    readonly campaigns: readonly { readonly id: string; readonly name: string }[];
    readonly members: readonly { readonly id: string; readonly name: string }[];
  },
): readonly { readonly value: string; readonly label: string }[] {
  const t = translator(messageLocale);
  const contract = CONDITION_FIELD_CONTRACTS[field];

  if (contract.catalogue === 'brands') {
    return catalogues.brands.map((brand) => ({ value: brand.id, label: brand.name }));
  }
  // B12 + G13 option (a) — the brand's live campaigns, and the workspace's
  // ACTIVE members (a post's author is one of them).
  if (contract.catalogue === 'campaigns') {
    return catalogues.campaigns.map((campaign) => ({ value: campaign.id, label: campaign.name }));
  }
  if (contract.catalogue === 'members') {
    return catalogues.members.map((member) => ({ value: member.id, label: member.name }));
  }
  if (contract.catalogue === 'metricKeys') {
    return INGESTED_METRIC_KEYS.map((key) => ({
      value: key,
      label: t(`analytics.metric.${key}` as MessageKey),
    }));
  }
  if (contract.options === null) return [];

  if (field === 'content.status') {
    return contract.options.map((value) => ({
      value,
      label: t(`content.status.${value}` as MessageKey),
    }));
  }
  if (field === 'content.type') {
    return contract.options.map((value) => ({
      value,
      label: t(`content.type.${value}` as MessageKey),
    }));
  }
  if (field === 'publish.provider' || field === 'content.channels') {
    return contract.options.map((value) => ({
      value,
      label: t(`integrations.provider.${value.toLowerCase()}` as MessageKey),
    }));
  }
  return contract.options.map((value) => ({
    value,
    label: t(`automations.failureClass.${value}` as MessageKey),
  }));
}

/**
 * Review of #67 — WHERE EACH TRIGGER LISTENS, as the prototype's sub-line names
 * it ("Listens to Approvals"): the screen whose events start the rule. A
 * presentation map from the closed trigger registry to a translated label.
 */
const LISTENS_TO: Readonly<Record<string, string>> = {
  CONTENT_APPROVED: 'APPROVALS',
  REVIEW_WAITING_24H: 'APPROVALS',
  CONTENT_SCHEDULED: 'CALENDAR',
  SCHEDULE_GAP: 'CALENDAR',
  SCHEDULED_TIME: 'CALENDAR',
  POST_PUBLISHED: 'PUBLISHING',
  POST_FAILED: 'PUBLISHING',
  CAMPAIGN_STARTED: 'CAMPAIGNS',
  CAMPAIGN_ENDED: 'CAMPAIGNS',
  FACT_EXPIRING: 'BRAND',
  WEEKLY_ENGAGEMENT_DROPPED: 'PERFORMANCE',
  POST_TOP_10_PERCENT: 'PERFORMANCE',
  ANALYTICS_REFRESHED: 'PERFORMANCE',
  METRIC_THRESHOLD_CROSSED: 'PERFORMANCE',
  ANOMALY_DETECTED: 'PERFORMANCE',
};

export default async function AutomationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const access = await requireWorkspacePage(locale, '/automations');
  const { messageLocale } = access.session;
  const t = translator(messageLocale);
  if (!access.allowed) return <NoAccessPage locale={locale} access={access} />;
  const session = access.session;
  const { workspace } = session;

  const ok = typeof query['ok'] === 'string' ? query['ok'] : null;
  const error = typeof query['error'] === 'string' ? query['error'] : null;
  const mayManage = workspace.permissionKeys.includes('automation.manage');
  /*
   * WHO MAY DECIDE A REQUEST IS ITS ACTION'S QUESTION (Phase 2B-3 PR 5): a
   * publish or a retry needs `publishing.manage`, a pause `campaigns.manage` —
   * the permission the engine checks on approval.
   */
  const mayDecide = (actionType: string): boolean => {
    const action = findAction(actionType);
    return action
      ? satisfiesActionPermissions(workspace.permissionKeys, action.permissions)
      : false;
  };

  /*
   * THE RAIL'S BRAND (P6-12, D-190). The page computed the brand context and
   * then ignored it, listing every in-scope brand's rules whatever the rail
   * said. One selected brand now narrows the lists and the authoring form;
   * "all brands" shows the whole scope, as before.
   */
  const brandContext = await brandContextFor(
    session.workspace,
    '/automations',
    typeof query['brand'] === 'string' ? query['brand'] : null,
  );
  const selectedBrand = requiredBrand(brandContext);

  const brands = await inWorkspace(workspace.workspaceId, async ({ db }) =>
    db.brand.findMany({
      where: { status: 'ACTIVE', ...brandScopeFilter(workspace.brandScope) },
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    }),
  );
  const brandNames = new Map(brands.map((brand) => [brand.id, brand.name]));

  const { rules, runs, needsYou, automationPolicy, entitledActions, aiCapIsReached } =
    await inAnalytics(workspace.workspaceId, async (services) => {
      const engine = await services.automations();
      const entitled = await entitledActionTypes((featureKey) =>
        services.entitlements.can(workspace.workspaceId, featureKey),
      );
      return {
        /** Phase 2B-3 PR 4 — which analytics events have their thresholds set. */
        automationPolicy: await services.automationPolicy(),
        /**
         * Phase 2B-3 PR 6 — the actions this workspace's plan includes: the same
         * answer `createRule` refuses on (owner decision 11).
         */
        entitledActions: entitled,
        /**
         * Phase 2B-3 PR 6 (owner decision 2a) — this month's AI automation
         * actions are used up. Asked only of a workspace whose plan includes
         * them: "not entitled" is a different sentence, said in Run history.
         */
        aiCapIsReached: entitled.has('DRAFT_IDEAS')
          ? await (async () => {
              const quota = createAutomationAiQuota({
                db: services.db,
                workspaceId: workspace.workspaceId,
                environment: currentEnvironment(),
              });
              const limit = await quota.limit();
              if (limit === null) return false;
              const zone = await services.db.workspace.findUnique({
                where: { id: workspace.workspaceId },
                select: { timezone: true },
              });
              return aiCapReached({
                limit,
                used: await quota.used(
                  workspaceMonthLabel(zone?.timezone ?? 'UTC', systemClock.now()),
                ),
              });
            })()
          : false,
        rules: await engine.listRules({
          brandId: selectedBrand?.id,
          brandScope: workspace.brandScope,
        }),
        runs: await engine.listRuns({
          brandId: selectedBrand?.id,
          brandScope: workspace.brandScope,
          take: 25,
        }),
        /*
         * B12 (Phase 2B-2b) — "NEEDS YOU": every open asks-first run this person
         * could decide — only actions whose permission they hold — not merely the
         * ones among the last 25 runs.
         */
        needsYou: await engine.awaitingRuns({
          brandId: selectedBrand?.id,
          brandScope: workspace.brandScope,
          permissionKeys: workspace.permissionKeys,
        }),
      };
    });

  /*
   * WHAT A PROPOSED PUBLISH WOULD PUBLISH (P6-12). The confirm button used to
   * stand alone — no rule, no content — so a person authorised an external
   * action on trust. Each waiting run is resolved to its rule's name and the
   * content item's title, through the same brand-scope predicate as every
   * other read here; a title the reader cannot see is reported as such, never
   * shown.
   */
  const awaiting = [
    ...needsYou,
    ...runs.filter(
      (run) =>
        run.status === 'AWAITING_CONFIRMATION' &&
        run.confirmationExpiresAt !== null &&
        run.confirmationExpiresAt.getTime() > Date.now() &&
        !needsYou.some((waiting) => waiting.id === run.id),
    ),
  ];
  const proposals = new Map<
    string,
    { rule: string | null; content: string | null; campaign: string | null }
  >();
  if (awaiting.length > 0) {
    await inWorkspace(workspace.workspaceId, async ({ db }) => {
      const scoped = brandIdQueryFilter({ brandScope: workspace.brandScope });
      const ruleRows = await db.automationRule.findMany({
        where: {
          workspaceId: workspace.workspaceId,
          id: { in: awaiting.map((r) => r.ruleId) },
          ...scoped,
        },
        select: { id: true, name: true },
      });
      const ruleNames = new Map(ruleRows.map((row) => [row.id, row.name]));
      for (const run of awaiting) {
        let contentItemId: string | null = null;
        if (run.resourceId && run.resourceType === 'ContentItem') contentItemId = run.resourceId;
        if (run.resourceId && run.resourceType === 'CalendarSlot') {
          const slot = await db.calendarSlot.findFirst({
            where: { id: run.resourceId, workspaceId: workspace.workspaceId, ...scoped },
            select: { contentItemId: true },
          });
          contentItemId = slot?.contentItemId ?? null;
        }
        if (run.resourceId && run.resourceType === 'PublishJob') {
          const job = await db.publishJob.findFirst({
            where: { id: run.resourceId, workspaceId: workspace.workspaceId, ...scoped },
            select: { contentItemId: true },
          });
          contentItemId = job?.contentItemId ?? null;
        }
        // Phase 2B-3 PR 5 — a retry request names the failed attempt; its post
        // is read through the attempt's job, under the same scope.
        if (run.resourceId && run.resourceType === 'PublishAttempt') {
          const attempt = await db.publishAttempt.findFirst({
            where: { id: run.resourceId, workspaceId: workspace.workspaceId },
            select: { publishJobId: true },
          });
          const job = attempt
            ? await db.publishJob.findFirst({
                where: { id: attempt.publishJobId, workspaceId: workspace.workspaceId, ...scoped },
                select: { contentItemId: true },
              })
            : null;
          contentItemId = job?.contentItemId ?? null;
        }
        // …and a pause request names its campaign.
        const campaign =
          run.resourceId && run.resourceType === 'Campaign'
            ? await db.campaign.findFirst({
                where: {
                  id: run.resourceId,
                  workspaceId: workspace.workspaceId,
                  deletedAt: null,
                  ...scoped,
                },
                select: { name: true },
              })
            : null;
        const item = contentItemId
          ? await db.contentItem.findFirst({
              where: { id: contentItemId, workspaceId: workspace.workspaceId, ...scoped },
              select: { title: true },
            })
          : null;
        proposals.set(run.id, {
          rule: ruleNames.get(run.ruleId) ?? null,
          content: item?.title ?? null,
          campaign: campaign?.name ?? null,
        });
      }
    });
  }

  /*
   * WHO DECIDED (Phase 2B-3 PR 5): "Approved by" from the run's own
   * `confirmedByUserId`, "Skipped by" from the skip's audit event — the run
   * does not store its skipper. Names are read through this workspace's
   * memberships only, as the Activity screen does; an id that is not a member
   * here resolves to nothing and no line is shown.
   */
  const decided = new Map<string, { kind: 'approved' | 'skipped'; name: string }>();
  {
    const skippedIds = runs
      .filter((run) => run.status === 'CANCELLED' && run.failureCode === 'skipped_by_member')
      .map((run) => run.id);
    const deciders = await inWorkspace(workspace.workspaceId, async ({ db }) => {
      const skips =
        skippedIds.length === 0
          ? []
          : await db.auditEvent.findMany({
              where: {
                workspaceId: workspace.workspaceId,
                action: 'automation.run_skipped',
                resourceType: 'AutomationRun',
                resourceId: { in: skippedIds },
              },
              select: { resourceId: true, actorId: true },
            });
      const userIds = [
        ...new Set(
          [
            ...runs.map((run) => run.confirmedByUserId),
            ...skips.map((skip) => skip.actorId),
          ].filter((id): id is string => typeof id === 'string'),
        ),
      ];
      const members =
        userIds.length === 0
          ? []
          : await db.membership.findMany({
              where: { workspaceId: workspace.workspaceId, userId: { in: userIds } },
              select: { userId: true, user: { select: { name: true, email: true } } },
            });
      return {
        skips,
        names: new Map(members.map((m) => [m.userId, m.user.name ?? m.user.email] as const)),
      };
    });
    for (const run of runs) {
      const name = run.confirmedByUserId ? deciders.names.get(run.confirmedByUserId) : undefined;
      if (name) decided.set(run.id, { kind: 'approved', name });
    }
    for (const skip of deciders.skips) {
      const name = skip.actorId ? deciders.names.get(skip.actorId) : undefined;
      if (skip.resourceId && name) decided.set(skip.resourceId, { kind: 'skipped', name });
    }
  }

  /**
   * WHAT A REQUEST WOULD DO, in one line (Phase 2B-3 PR 5, approved copy): the
   * post a publish or a retry concerns, the campaign a pause names.
   */
  const requestLine = (run: { id: string; actionType: string }): string => {
    const line = requestLineFor(run.actionType, proposals.get(run.id));
    return 'token' in line ? t(line.key).replace(line.token, line.value) : t(line.key);
  };
  const formBrands = selectedBrand
    ? brands.filter((brand) => brand.id === selectedBrand.id)
    : brands;

  /*
   * B12 (Phase 2B-2b) — THE RULE BEING EDITED, from the list this page already
   * read through the member's scope; an id outside it simply opens nothing.
   */
  const editId = typeof query['edit'] === 'string' ? query['edit'] : null;
  const editing = mayManage && editId ? (rules.find((rule) => rule.id === editId) ?? null) : null;

  /*
   * THE CAMPAIGN AND PERSON CATALOGUES, PER RULE BRAND (Phase 2B-3 PR 1).
   *
   * A condition's campaign must be one of THE RULE'S BRAND, and its person an
   * ACTIVE member whose BrandScope admits that brand — the same predicates a
   * run applies before it evaluates (`conditionValuesResolve`), so the screen
   * never offers a value the run would then refuse as unavailable. An edited
   * rule's brand is fixed; a new rule's brand is picked in the form, which
   * switches between these lists.
   */
  const catalogueBrandIds = editing ? [editing.brandId] : formBrands.map((brand) => brand.id);
  const catalogueByBrand = await inWorkspace(workspace.workspaceId, async ({ db }) => {
    const byBrand = new Map<
      string,
      {
        campaigns: readonly { id: string; name: string; status: string }[];
        members: readonly { id: string; name: string }[];
      }
    >();
    for (const brandId of catalogueBrandIds) {
      byBrand.set(brandId, {
        campaigns: await db.campaign.findMany({
          where: {
            workspaceId: workspace.workspaceId,
            deletedAt: null,
            ...brandIdQueryFilter({ brandId, brandScope: workspace.brandScope }),
          },
          select: { id: true, name: true, status: true },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          take: 200,
        }),
        members: await memberCatalogueFor(db, {
          workspaceId: workspace.workspaceId,
          brandId,
          viewerBrandScope: workspace.brandScope,
        }),
      });
    }
    return byBrand;
  });
  const conditionChoices = (
    field: ConditionField,
    brandId: string | undefined,
  ): readonly { value: string; label: string }[] =>
    conditionChoicesFor(field, messageLocale, {
      brands,
      campaigns: (brandId ? catalogueByBrand.get(brandId)?.campaigns : undefined) ?? [],
      members: (brandId ? catalogueByBrand.get(brandId)?.members : undefined) ?? [],
    });
  /** A brand-dependent catalogue, one list per brand the form can pick. */
  const perBrand = (field: ConditionField) =>
    CONDITION_FIELD_CONTRACTS[field].catalogue === 'campaigns' ||
    CONDITION_FIELD_CONTRACTS[field].catalogue === 'members'
      ? Object.fromEntries(
          catalogueBrandIds.map((brandId) => [brandId, conditionChoices(field, brandId)]),
        )
      : undefined;
  const editInitial: AutomationFormInitial | null = editing
    ? (() => {
        const trigger = (editing.triggerConfig ?? {}) as Record<string, unknown>;
        const action = (editing.actionConfig ?? {}) as Record<string, unknown>;
        const conditions = Array.isArray(editing.conditions)
          ? (editing.conditions as {
              field: string;
              operator: string;
              value?: string | number | boolean | string[];
            }[])
          : [];
        const first = conditions[0];
        const number = (value: unknown): number | null =>
          typeof value === 'number' && Number.isFinite(value) ? value : null;
        return {
          ruleId: editing.id,
          version: editing.version,
          name: editing.name,
          description: editing.description ?? '',
          brandName: brandNames.get(editing.brandId) ?? '',
          triggerType: editing.triggerType,
          actionType: editing.actionType,
          hourLocal: number(trigger['hourLocal']),
          daysOfWeek: Array.isArray(trigger['daysOfWeek'])
            ? (trigger['daysOfWeek'] as unknown[]).filter(
                (day): day is number => typeof day === 'number',
              )
            : [],
          metricKey: typeof trigger['metricKey'] === 'string' ? trigger['metricKey'] : null,
          direction:
            trigger['direction'] === 'above' || trigger['direction'] === 'below'
              ? trigger['direction']
              : null,
          threshold: number(trigger['threshold']),
          windowDays: number(trigger['windowDays']),
          offsetHours:
            editing.actionType === 'PLACE_ON_CALENDAR'
              ? (number(action['offsetHours']) ?? 24)
              : null,
          brandId: editing.brandId,
          actionUserId: typeof action['userId'] === 'string' ? action['userId'] : null,
          actionCampaignId: typeof action['campaignId'] === 'string' ? action['campaignId'] : null,
          condition: first
            ? { field: first.field, operator: first.operator, value: first.value ?? null }
            : null,
          extraConditions: Math.max(0, conditions.length - 1),
        };
      })()
    : null;

  // Round 3 (C2) — the prototype's one style: "Oct 16 · 10:00", 24-hour.
  const stamp = { format: (value: Date) => whenLabel(value, locale, 'UTC') };

  /*
   * D-468 — THE PROTOTYPE'S TWO TABS AND ITS RULE DIALOG, all in the address:
   * `?view=runs` is Run history, `?new=1` and `?edit=<rule>` open the dialog.
   * The rail's brand rides along on every link.
   */
  /*
   * Review of #67 — "RAN 6 TIMES · LAST TODAY 09:14": per rule, how many runs
   * finished their action and when the last one started, read from the run
   * rows inside the tenant context (RLS), in the workspace's own clock.
   */
  const { ranByRule, zone } = await inWorkspace(workspace.workspaceId, async ({ db }) => {
    const grouped =
      rules.length === 0
        ? []
        : await db.automationRun.groupBy({
            by: ['ruleId'],
            where: {
              workspaceId: workspace.workspaceId,
              ruleId: { in: rules.map((rule) => rule.id) },
              status: 'SUCCEEDED',
            },
            _count: { _all: true },
            _max: { startedAt: true },
          });
    const row = await db.workspace.findUnique({
      where: { id: workspace.workspaceId },
      select: { timezone: true },
    });
    return {
      ranByRule: new Map(
        grouped.map((entry) => [
          entry.ruleId,
          { count: entry._count._all, last: entry._max.startedAt },
        ]),
      ),
      zone: row?.timezone ?? 'UTC',
    };
  });
  const tag = locale === 'ar' ? 'ar' : 'en-GB';
  const dayOf = (date: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: zone, dateStyle: 'short' }).format(date);
  const clock = new Intl.DateTimeFormat(tag, {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    numberingSystem: 'latn',
  });
  const ranLine = (ruleId: string): string => {
    const ran = ranByRule.get(ruleId);
    if (!ran || ran.count === 0 || !ran.last) return t('automations.notRun');
    const when =
      dayOf(ran.last) === dayOf(systemClock.now())
        ? t('automations.lastToday').replace('{time}', clock.format(ran.last))
        : // Round 3 (C2) — the prototype's one style: "Oct 4 · 02:31".
          whenLabel(ran.last, locale, zone, systemClock.now());
    return t('automations.ran').replace('{count}', String(ran.count)).replace('{when}', when);
  };

  const view = query['view'] === 'runs' ? 'runs' : 'rules';
  const creating = mayManage && editInitial === null && query['new'] === '1';
  const hrefWith = (extra: Record<string, string>): string => {
    const params = new URLSearchParams();
    if (typeof query['brand'] === 'string') params.set('brand', query['brand']);
    for (const [key, value] of Object.entries(extra)) params.set(key, value);
    const search = params.toString();
    return `/${locale}/automations${search ? `?${search}` : ''}`;
  };
  const listHref = hrefWith({});
  const ruleNames = new Map(rules.map((rule) => [rule.id, rule.name]));
  const asksFirst = (actionType: string): boolean => findAction(actionType)?.asksFirst ?? false;
  const spendsCredits = (actionType: string): boolean =>
    findAction(actionType)?.spendsCredits ?? false;
  const mayCopilot = workspace.permissionKeys.includes('copilot.use');

  return (
    <WorkspaceShell
      flash={successFlash(ok, locale)}
      brandContext={brandContext}
      locale={locale}
      heading={t('automations.title')}
      description={t('automations.subtitle')}
      eyebrow={t('nav.group.automate')}
      activePath="/automations"
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={session.customer.name ?? session.customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      {/*
        THE PROTOTYPE'S AUTOMATIONS, `Main.dc.html` lines 1304–1334 (D-468): the
        Rules · Run history switch and "New rule" on one row; the requests
        waiting for an OK; the rules as one card of rows; the suggestions and
        the notes under it. Run history is the second tab.
      */}
      <div className="bsp-au">
        {error ? (
          <CustomerBanner tone="error">{statusMessage(error, locale) ?? error}</CustomerBanner>
        ) : null}

        <div className="bsp-au-top">
          <nav
            className="bsp-seg"
            aria-label={t('automations.title')}
            data-testid="automations-tabs"
          >
            <SegmentPill selector='[aria-current="page"]' />
            <Link
              href={listHref}
              aria-current={view === 'rules' ? 'page' : undefined}
              data-testid="automations-tab-rules"
            >
              {t('automations.rules')} <span className="bsp-ltr">{rules.length}</span>
            </Link>
            <Link
              href={hrefWith({ view: 'runs' })}
              aria-current={view === 'runs' ? 'page' : undefined}
              data-testid="automations-tab-runs"
            >
              {t('automations.tab.activity')}
            </Link>
          </nav>
          {selectedBrand ? (
            /*
              Round 3 — the prototype's tab row carries no "Rules and runs for …"
              line; which brand the lists are for is still said to a screen reader.
            */
            <span className="bs-sr-only" data-testid="automations-brand-filter">
              {t('automations.brandFilter').replace('{brand}', selectedBrand.name)}
            </span>
          ) : null}
          {mayManage && formBrands.length > 0 ? (
            <Link
              href={hrefWith({ new: '1' })}
              className="bsp-btn bsp-sm bsp-pur bsp-au-new"
              data-testid="automation-new"
            >
              {t('automations.create')}
            </Link>
          ) : null}
        </div>

        {view === 'rules' ? (
          <>
            {/*
              B12 (Phase 2B-2b) — NEEDS YOU, at the top, as the prototype's
              amber card: the asks-first runs this person could decide, with
              Approve (the existing confirmation path) or Skip on each. Nobody
              sees a run here whose action they could not take.
            */}
            {needsYou.length > 0 ? (
              <section className="bsp-xcard bsp-au-pend" data-testid="automations-needs-you">
                <h2 className="bsp-au-pend-t">{t('automations.needsYou.title')}</h2>
                <p className="bsp-au-pend-b">{t('automations.needsYou.body')}</p>
                {needsYou.map((run) => (
                  <div
                    key={run.id}
                    className="bsp-au-pend-row"
                    data-testid={`automation-needs-you-${run.id}`}
                  >
                    <span className="bsp-au-pend-what">
                      <span className="bsp-au-pend-w">
                        {t('automations.previewRule').replace(
                          '{rule}',
                          proposals.get(run.id)?.rule ?? '—',
                        )}
                      </span>
                      <span
                        className="bsp-au-sub"
                        data-testid={`automation-needs-you-line-${run.id}`}
                      >
                        {t(`automations.action.${run.actionType}` as MessageKey)}
                        {' · '}
                        {requestLine(run)}
                      </span>
                      {run.actionType === 'PAUSE_CAMPAIGN' ? (
                        <span
                          className="bsp-au-sub"
                          data-testid={`automation-pause-note-${run.id}`}
                        >
                          {t('automations.pauseNote')}
                        </span>
                      ) : null}
                    </span>
                    <form action={skipAutomationRunAction}>
                      <input type="hidden" name="locale" value={locale} />
                      <input type="hidden" name="runId" value={run.id} />
                      <button
                        type="submit"
                        className="bsp-btn bsp-sm bsp-sec"
                        data-testid="automation-skip"
                      >
                        {t('automations.skipRun')}
                      </button>
                    </form>
                    <form action={confirmAutomationRunAction}>
                      <input type="hidden" name="locale" value={locale} />
                      <input type="hidden" name="runId" value={run.id} />
                      <button
                        type="submit"
                        className="bsp-btn bsp-sm bsp-pur"
                        data-testid="automation-confirm"
                      >
                        {/* "Confirm publish" stays the publish's own words. */}
                        {run.actionType === 'PROPOSE_PUBLISH'
                          ? t('automations.confirmRun')
                          : t('automations.approveRun')}
                      </button>
                    </form>
                  </div>
                ))}
              </section>
            ) : null}

            <section className="bsp-xcard bsp-au-card" aria-label={t('automations.rules')}>
              {rules.length === 0 ? (
                <div className="bsp-au-none">
                  <b>{t('automations.empty')}</b> {t('automations.emptyBody')}
                </div>
              ) : (
                <ul className="bsp-au-list" data-testid="automation-rules">
                  {rules.map((rule) => (
                    <li
                      key={rule.id}
                      className="bsp-au-rule"
                      data-testid={`automation-rule-${rule.id}`}
                    >
                      <span className="bsp-xicon bsp-au-ico" aria-hidden="true">
                        ↻
                      </span>
                      <span className="bsp-au-main">
                        <span className="bsp-au-line">
                          <b>{t(`automations.trigger.${rule.triggerType}` as MessageKey)}</b>{' '}
                          <span className="bsp-au-arrow" aria-hidden="true">
                            →
                          </span>{' '}
                          <b>{t(`automations.action.${rule.actionType}` as MessageKey)}</b>
                        </span>
                        {/*
                          Review of #67 — the prototype's sub-line: what the
                          rule listens to and how often it has run, from the
                          run rows. The rule's own name and brand stay, after.
                        */}
                        <span className="bsp-au-meta">
                          <span data-testid={`automation-listens-${rule.id}`}>
                            {t('automations.listens').replace(
                              '{source}',
                              t(
                                `automations.source.${LISTENS_TO[rule.triggerType] ?? 'BRAND'}` as MessageKey,
                              ),
                            )}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span data-testid={`automation-ran-${rule.id}`}>{ranLine(rule.id)}</span>
                          <span aria-hidden="true">·</span>
                          <span>{rule.name}</span>
                          {brandNames.get(rule.brandId) ? (
                            <>
                              <span aria-hidden="true">·</span>
                              <span>{brandNames.get(rule.brandId)}</span>
                            </>
                          ) : null}
                          {asksFirst(rule.actionType) ? (
                            <span className="bsp-xstatus bsp-warn">
                              {t('automations.asksFirst')}
                            </span>
                          ) : null}
                          {spendsCredits(rule.actionType) ? (
                            <span className="bsp-xstatus bsp-ai">
                              {t('automations.usesCredits')}
                            </span>
                          ) : null}
                          {/*
                            AN OLDER AUTOMATION SAYS SO (Phase 2B-3 PR 1): its
                            trigger or action a new rule could not use any more.
                          */}
                          {isOlderAutomation(rule) ? (
                            <span data-testid={`automation-older-${rule.id}`}>
                              {t('automations.olderAutomation')}
                            </span>
                          ) : null}
                        </span>
                        {rule.actionType === 'DRAFT_IDEAS' && aiCapIsReached ? (
                          <span
                            className="bsp-au-meta"
                            data-testid={`automation-ai-cap-${rule.id}`}
                          >
                            {t('automations.aiCapReached')}
                          </span>
                        ) : null}
                      </span>
                      <span
                        className={`bsp-xstatus${rule.enabled ? '' : ' bsp-neu'}`}
                        data-testid={`automation-state-${rule.id}`}
                      >
                        {t(rule.enabled ? 'automations.on' : 'automations.off')}
                      </span>
                      {mayManage ? (
                        <>
                          <form action={toggleAutomationAction} className="bsp-au-tglf">
                            <input type="hidden" name="locale" value={locale} />
                            <input type="hidden" name="ruleId" value={rule.id} />
                            <input type="hidden" name="enabled" value={rule.enabled ? '0' : '1'} />
                            <button
                              type="submit"
                              className="bsp-tgl"
                              aria-pressed={rule.enabled}
                              aria-label={`${t(
                                rule.enabled ? 'automations.disable' : 'automations.enable',
                              )}: ${rule.name}`}
                              data-testid={`automation-toggle-${rule.id}`}
                            >
                              <span className="bsp-tgl-k" aria-hidden="true" />
                            </button>
                          </form>
                          {/*
                            THE ROW'S ⋯ MENU — Edit, and Delete, which still asks
                            twice (P6-12). Native disclosures, so both work
                            without script and from the keyboard as they are.
                          */}
                          <RuleMenu
                            label={`${t('automations.more')}: ${rule.name}`}
                            testId={`automation-more-${rule.id}`}
                          >
                            <div className="bsp-au-menu">
                              <Link
                                href={hrefWith({ edit: rule.id })}
                                className="bsp-au-mi"
                                data-testid={`automation-edit-${rule.id}`}
                              >
                                {t('automations.edit')}
                              </Link>
                              <details data-testid={`automation-delete-${rule.id}`}>
                                <summary className="bsp-au-mi bsp-au-mi-bad">
                                  {t('automations.deleteConfirm')}
                                </summary>
                                <form action={deleteAutomationAction} className="bsp-au-del">
                                  <input type="hidden" name="locale" value={locale} />
                                  <input type="hidden" name="ruleId" value={rule.id} />
                                  <span>{t('automations.deleteConfirmBody')}</span>
                                  <button type="submit" className="bsp-btn bsp-sm bsp-danger">
                                    {t('automations.deleteConfirmSubmit')}
                                  </button>
                                </form>
                              </details>
                            </div>
                          </RuleMenu>
                        </>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/*
              D-277 §39, D-296 — HOW MOST PEOPLE SHOULD FIND AUTOMATION: by
              asking the Copilot, in the prototype's "Suggested rules" row; what
              stays true is said in its notes.
            */}
            {mayCopilot ? (
              <div className="bsp-au-sugg" data-testid="automations-discover">
                <span className="bsp-au-sugg-row">
                  <span className="bsp-au-sugg-t">{t('automations.discover.title')}</span>
                  <CopilotLink
                    href={copilotHref(locale, 'automations')}
                    request={t('automations.discover.example')}
                    className="bsp-chip bsp-au-chip"
                    testId="automations-discover-copilot"
                  >
                    + {t('automations.discover.cta')}
                  </CopilotLink>
                  {/* Review of #67 — the prototype's footer is one row; the three
                      notes on what stays true are under its "⋯". */}
                  <MoreDisclosure
                    label={t('automations.more')}
                    testId="automations-discover-more"
                    align="start"
                  >
                    <span className="bsp-au-note">{t('automations.discover.off')}</span>
                    <span className="bsp-au-note">{t('automations.discover.publish')}</span>
                    <span className="bsp-au-note">{t('automations.discover.home')}</span>
                  </MoreDisclosure>
                </span>
              </div>
            ) : null}
            <span className="bsp-au-note">{t('automations.externalNotice')}</span>
            <Link href={`/${locale}/settings/notifications`} className="bsp-au-notif">
              {t('automations.notifLink')} →
            </Link>
          </>
        ) : (
          /*
           * RUN HISTORY — the prototype's Activity card (lines 1325–1331): when,
           * what and which rule, and the outcome's pill, with every line the
           * product says about a run under it.
           */
          <section className="bsp-xcard bsp-au-card" aria-label={t('automations.runs')}>
            {runs.length === 0 ? (
              <div className="bsp-au-none">
                <b>{t('automations.runsEmpty')}</b> {t('automations.runsEmptyBody')}
              </div>
            ) : (
              <ul className="bsp-au-list" data-testid="automation-runs">
                {runs.map((run) => {
                  const shown = runPresentation(run);
                  return (
                    <li
                      key={run.id}
                      className="bsp-au-run"
                      data-testid={`automation-run-${run.id}`}
                    >
                      <span className="bsp-au-when">{stamp.format(run.startedAt)}</span>
                      <span className="bsp-au-main">
                        <span className="bsp-au-what">
                          {t(`automations.trigger.${run.triggerType}` as MessageKey)} →{' '}
                          {t(`automations.action.${run.actionType}` as MessageKey)}
                        </span>
                        {ruleNames.get(run.ruleId) ? (
                          <span className="bsp-au-sub">↻ {ruleNames.get(run.ruleId)}</span>
                        ) : null}
                        {/*
                          THE REASON LINE, ALWAYS IN WORDS (Phase 2B-3 PR 2,
                          D5-B): a code `runPresentation` does not know reads as
                          the approved fallback, never as the code itself.
                        */}
                        {shown.reason.kind === 'message' ? (
                          <span
                            className="bsp-au-sub"
                            data-testid={`automation-run-failure-${run.id}`}
                          >
                            {t(shown.reason.key)}
                          </span>
                        ) : null}
                        {/* PHASE 2B-3 PR 6 — where the ideas are. */}
                        {ideasLine(run) ? (
                          <Link
                            href={`/${locale}/content?brand=${run.brandId}&status=DRAFT`}
                            className="bsp-au-sublink"
                            data-testid={`automation-run-ideas-${run.id}`}
                          >
                            {t('automations.ideasDrafted')}
                          </Link>
                        ) : null}
                        {proposals.has(run.id) ? (
                          <span
                            className="bsp-au-sub"
                            data-testid={`automation-proposal-${run.id}`}
                          >
                            <strong>{t('automations.previewTitle')}</strong>
                            {' — '}
                            {t('automations.previewRule').replace(
                              '{rule}',
                              proposals.get(run.id)?.rule ?? '—',
                            )}
                            {' · '}
                            {requestLine(run)}
                          </span>
                        ) : null}
                        {decided.has(run.id) ? (
                          <span
                            className="bsp-au-sub"
                            data-testid={`automation-run-decided-${run.id}`}
                          >
                            {t(
                              decided.get(run.id)?.kind === 'approved'
                                ? 'automations.approvedBy'
                                : 'automations.skippedBy',
                            ).replace('{name}', decided.get(run.id)?.name ?? '')}
                          </span>
                        ) : null}
                        {/*
                          WHO A WAITING REQUEST WAITS FOR (`waitingHint`), or that
                          it is decided under Rules (B12). The confirm button
                          itself lives only there, and only while its window is
                          open (R3-4).
                        */}
                        {proposals.has(run.id) && !mayDecide(run.actionType)
                          ? (() => {
                              const hint = waitingHint(run.actionType);
                              return hint ? (
                                <span
                                  className="bsp-au-sub"
                                  data-testid={`automation-run-waiting-${run.id}`}
                                >
                                  {t(hint)}
                                </span>
                              ) : null;
                            })()
                          : null}
                        {proposals.has(run.id) && mayDecide(run.actionType) ? (
                          <span className="bsp-au-sub">{t('automations.decideAbove')}</span>
                        ) : null}
                      </span>
                      <span
                        className={`bsp-xstatus${
                          run.status === 'SUCCEEDED'
                            ? ''
                            : run.status === 'FAILED' || run.status === 'BLOCKED_BY_AUTHORIZATION'
                              ? ' bsp-warn'
                              : ' bsp-neu'
                        }`}
                        data-testid={`automation-run-status-${run.id}`}
                      >
                        {t(shown.statusKey as MessageKey)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}
      </div>

      {mayManage && (editInitial !== null || (creating && formBrands.length > 0)) ? (
        <RuleDialog
          title={editInitial ? t('automations.editTitle') : t('automations.create')}
          closeHref={listHref}
          closeLabel={t('automations.cancelEdit')}
          testId={editInitial ? 'automation-edit-card' : 'automation-new-dialog'}
        >
          {/* A refused save reopens the dialog: its reason is said inside it. */}
          {error ? (
            <CustomerBanner tone="error">{statusMessage(error, locale) ?? error}</CustomerBanner>
          ) : null}
          {/*
            THE FORM IS BUILT FROM THE REGISTRY, ON THE SERVER, AND HANDED PLAIN
            DATA. Every option a customer can choose — trigger, action, condition
            field, operator, metric — is derived here from the engine's own closed
            lists, including which ACTIONS `actionSupportsTrigger` allows for each
            trigger and which CONDITION FIELDS have a producer in that trigger's
            context. The client component only decides which to show.

            STRINGS CROSS THE BOUNDARY, NEVER `t`. Passing a translator into a
            client component is what took the Copilot screen down at render.
          */}
          <AutomationForm
            key={editInitial?.ruleId ?? 'create'}
            locale={locale}
            action={editInitial ? updateAutomationAction : createAutomationAction}
            initial={editInitial ?? undefined}
            cancelHref={listHref}
            brands={formBrands.map((brand) => ({ id: brand.id, name: brand.name }))}
            /*
              ONLY WHAT IS AUTHORABLE (Phase 2B-3 PR 1). A trigger or action
              registered as not authorable is never offered for a new rule;
              an edited rule keeps its own, which the form names and never
              posts.
            */
            triggers={AUTOMATION_TRIGGERS.filter(
              (trigger) => trigger.authorable || trigger.type === editing?.triggerType,
            ).map((trigger) => ({
              type: trigger.type,
              label: t(`automations.trigger.${trigger.type}` as MessageKey),
              // Round 3 — the tile's own words, where the prototype has them.
              ...(optionalMessage(messageLocale, `automations.tile.${trigger.type}`)
                ? {
                    tileLabel:
                      optionalMessage(messageLocale, `automations.tile.${trigger.type}`) ?? '',
                  }
                : {}),
              // Review of #67 — the tile's "Listens to …" line.
              listens: t('automations.listens').replace(
                '{source}',
                t(`automations.source.${LISTENS_TO[trigger.type] ?? 'BRAND'}` as MessageKey),
              ),
              actionTypes: AUTOMATION_ACTIONS.filter(
                (action) =>
                  isAuthorablePair(trigger.type, action.type) && entitledActions.has(action.type),
              ).map((action) => action.type),
              /*
                Phase 2B-3 PR 2 — a NEW rule is offered its trigger's G13
                conditions; the rule being EDITED the fields its own action
                may name (a stored rule keeps what its trigger produces).
              */
              conditionFields: [
                ...(editing && trigger.type === editing.triggerType
                  ? conditionFieldsForRule(editing)
                  : authorableConditionFieldsFor(trigger.type)),
              ],
              needsSchedule: trigger.type === 'SCHEDULED_TIME',
              needsThreshold: trigger.type === 'METRIC_THRESHOLD_CROSSED',
              /*
                Phase 2B-3 PR 4 — the same verdict `createRule` refuses on:
                an analytics event without its operator thresholds is shown
                but cannot be chosen.
              */
              unavailable: !triggerAvailable(automationPolicy, trigger.type),
            }))}
            actionLabels={Object.fromEntries(
              AUTOMATION_ACTIONS.map((action) => [
                action.type,
                t(`automations.action.${action.type}` as MessageKey),
              ]),
            )}
            /*
              EVERY FIELD'S WHOLE AUTHORING CONTRACT, DERIVED FROM THE ENGINE
              (R4-1).

              The screen used to hand the client every operator in the
              registry and a text box, whatever the field was — so
              `brand.id greater_than 5` and `content.hasCampaign equals
              "true"` were both one click away, both stored, and both false
              for ever. The operators, the value control and the parsing now
              all come from `CONDITION_FIELD_CONTRACTS`, which is also what
              `createRule` and `updateRule` refuse against.

              CLOSED SETS ARE LABELLED HERE, on the server, where `t` lives —
              a raw `PARTIALLY_PUBLISHED` in a picker is untranslated copy,
              and §4 does not make an exception for enum values.
            */
            conditionCatalogue={Object.fromEntries(
              CONDITION_FIELDS.map((field) => {
                const contract = CONDITION_FIELD_CONTRACTS[field];
                const optionsByBrand = perBrand(field);
                return [
                  field,
                  {
                    label: t(`automations.field.${field}` as MessageKey),
                    kind: contract.kind,
                    operators: contract.operators.map((operator) => ({
                      value: operator,
                      label: t(`automations.operator.${operator}` as MessageKey),
                    })),
                    options: conditionChoices(field, catalogueBrandIds[0]),
                    ...(optionsByBrand ? { optionsByBrand } : {}),
                  },
                ];
              }),
            )}
            actionPeopleByBrand={Object.fromEntries(
              catalogueBrandIds.map((brandId) => [
                brandId,
                (catalogueByBrand.get(brandId)?.members ?? []).map((member) => ({
                  value: member.id,
                  label: member.name,
                })),
              ]),
            )}
            actionCampaignsByBrand={Object.fromEntries(
              catalogueBrandIds.map((brandId) => [
                brandId,
                (catalogueByBrand.get(brandId)?.campaigns ?? []).map((campaign) => ({
                  value: campaign.id,
                  label: campaign.name,
                })),
              ]),
            )}
            actionPausableCampaignsByBrand={Object.fromEntries(
              catalogueBrandIds.map((brandId) => [
                brandId,
                (catalogueByBrand.get(brandId)?.campaigns ?? [])
                  .filter((campaign) =>
                    (PAUSABLE_CAMPAIGN_STATUSES as readonly string[]).includes(campaign.status),
                  )
                  .map((campaign) => ({ value: campaign.id, label: campaign.name })),
              ]),
            )}
            actionNotes={Object.fromEntries(
              AUTOMATION_ACTIONS.map((action) => [
                action.type,
                { asksFirst: action.asksFirst, spendsCredits: action.spendsCredits },
              ]),
            )}
            metrics={INGESTED_METRIC_KEYS.map((key) => ({
              key,
              label: t(`analytics.metric.${key}` as MessageKey),
            }))}
            labels={{
              name: t('automations.nameLabel'),
              when: t('automations.form.when'),
              onlyIf: t('automations.form.onlyIf'),
              then: t('automations.form.then'),
              preview: t('automations.form.preview'),
              previewEmpty: t('automations.form.previewEmpty'),
              moreFields: t('automations.form.moreFields'),
              pickTriggerFirst: t('automations.form.pickTriggerFirst'),
              asksFirst: t('automations.asksFirst'),
              usesCredits: t('automations.usesCredits'),
              brand: t('analytics.brandLabel'),
              trigger: t('automations.triggerLabel'),
              action: t('automations.actionLabel'),
              submit: editInitial ? t('automations.save') : t('automations.saveRule'),
              description: t('automations.descriptionLabel'),
              offsetHours: t('automations.offsetHoursLabel'),
              actionPerson: t('automations.actionPersonLabel'),
              actionCampaign: t('automations.actionCampaignLabel'),
              pauseNote: t('automations.pauseNote'),
              chooseTrigger: t('automations.chooseTrigger'),
              chooseAction: t('automations.chooseAction'),
              triggerUnavailable: t('automations.triggerUnavailable'),
              conditionsKept: t('automations.conditionsKept'),
              valueUnavailable: t('automations.valueUnavailable'),
              cancel: t('automations.cancelEdit'),
              hour: t('automations.hourLabel'),
              days: t('automations.daysLabel'),
              metric: t('automations.metricLabel'),
              direction: t('automations.directionLabel'),
              above: t('automations.directionAbove'),
              below: t('automations.directionBelow'),
              threshold: t('automations.thresholdLabel'),
              windowDays: t('automations.windowLabel'),
              conditionLegend: t('automations.conditionLegend'),
              conditionNone: t('automations.conditionNone'),
              conditionField: t('automations.conditionField'),
              conditionOperator: t('automations.conditionOperator'),
              conditionValue: t('automations.conditionValue'),
              conditionValues: t('automations.conditionValues'),
              conditionValuesHint: t('automations.conditionValuesHint'),
              weekdays: [
                t('automations.day.0'),
                t('automations.day.1'),
                t('automations.day.2'),
                t('automations.day.3'),
                t('automations.day.4'),
                t('automations.day.5'),
                t('automations.day.6'),
              ],
            }}
          />
        </RuleDialog>
      ) : null}
    </WorkspaceShell>
  );
}
