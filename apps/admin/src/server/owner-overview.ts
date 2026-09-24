import { CONFIG_DOMAIN_KEYS, type ConfigDomain } from '@brandspace/config';
import {
  AI_CAPABILITIES,
  ConfigurationAiSource,
  REQUESTED_AI_CAPABILITIES,
  RoutingError,
  resolveRoute,
  tasksForCapability,
  type AiRoutingProfile,
} from '@brandspace/ai-gateway';
import { eventsNeedingAttention, type AttentionEvent } from '@brandspace/billing';
import {
  INTEGRATION_CATEGORY_DEFINITIONS,
  type IntegrationCategory,
  type IntegrationView,
} from '@brandspace/integrations';
import { evaluateHealth, tracingStatus, type HealthReport } from '@brandspace/observability';
import {
  WITHHELD,
  areaHref,
  integrationAreaState,
  plansAreaState,
  readinessVerdict,
  type ReadinessArea,
  type ReadinessAreaKey,
} from './owner-readiness';
import {
  currentEnvironment,
  getAiUsageExplorer,
  getConfigService,
  getIntegrationsService,
  getPlanCatalogue,
  getPlatformPrisma,
  getWorkspaceService,
  serviceActor,
} from './platform-context';

/**
 * THE OWNER'S VIEW, COMPOSED FROM THE EXISTING SERVICES (D-311).
 *
 * Nothing here writes, and nothing here is a second source of truth. Each
 * figure comes from the service that already owns it — the Integrations Hub's
 * views, the workspace directory, the configuration versions, the billing
 * inbox, the AI usage explorer, the health verdict — and each is withheld,
 * not guessed, when the reader's role may not see it.
 *
 * THREE READS HAVE NO SERVICE METHOD, and are plain aggregate queries on the
 * platform client: subscriptions by status, trials ending soon, and customers
 * per plan. They count; they read no customer content.
 */

type Actor = Parameters<typeof serviceActor>[0];

const may = (actor: Actor, permission: string) => actor.permissionKeys.includes(permission);

/* ------------------------------------------------------------------------ */
/* Readiness                                                                 */
/* ------------------------------------------------------------------------ */

const AREA_CATEGORIES: readonly { key: ReadinessAreaKey; category: IntegrationCategory }[] = [
  { key: 'email', category: 'email' },
  { key: 'storage', category: 'storage' },
  { key: 'ai', category: 'ai' },
  { key: 'social', category: 'social' },
  { key: 'payment', category: 'payment' },
];

export interface OwnerReadiness {
  readonly areas: readonly ReadinessArea[];
  readonly verdict: ReturnType<typeof readinessVerdict>;
  /** The Hub's views, when the reader may see them — reused by callers. */
  readonly views: readonly IntegrationView[] | null;
}

/**
 * The integration views need BOTH configuration read and secret read — the
 * latter because a view reports whether each credential is present (masked).
 * A role without either sees "you don't have permission", never a guess.
 */
export async function loadReadiness(actor: Actor): Promise<OwnerReadiness> {
  const environment = currentEnvironment();
  const mayReadIntegrations =
    may(actor, 'platform.configuration.read') && may(actor, 'platform.secret.read');
  const views = mayReadIntegrations
    ? await getIntegrationsService().list(serviceActor(actor), environment)
    : null;

  const areas: ReadinessArea[] = AREA_CATEGORIES.map(({ key, category }) => {
    const definition = INTEGRATION_CATEGORY_DEFINITIONS.find((c) => c.key === category);
    const derived = views
      ? integrationAreaState(views.filter((view) => view.category === category))
      : WITHHELD;
    return {
      key,
      required: definition?.requiredInProduction ?? false,
      href: areaHref(key),
      ...derived,
    };
  });

  const plans = may(actor, 'platform.configuration.read')
    ? plansAreaState((await getPlanCatalogue()).plans)
    : WITHHELD;
  areas.push({ key: 'plans', required: true, href: areaHref('plans'), ...plans });

  return { areas, verdict: readinessVerdict(areas), views };
}

/* ------------------------------------------------------------------------ */
/* Customers                                                                 */
/* ------------------------------------------------------------------------ */

export interface CustomerCounts {
  readonly total: number;
  readonly active: number;
  readonly trialing: number;
  readonly pastDue: number;
  readonly suspended: number;
}

/**
 * Counts by status through the directory's own filter — `total` is the full
 * matching count, so a one-row page is a count. No new query path.
 */
export async function loadCustomerCounts(actor: Actor): Promise<CustomerCounts> {
  const service = getWorkspaceService();
  const count = async (status?: 'ACTIVE' | 'TRIALING' | 'PAST_DUE' | 'SUSPENDED') =>
    (
      await service.list(serviceActor(actor), {
        ...(status ? { status } : {}),
        page: 1,
        pageSize: 25,
      })
    ).total;
  const [total, active, trialing, pastDue, suspended] = await Promise.all([
    count(),
    count('ACTIVE'),
    count('TRIALING'),
    count('PAST_DUE'),
    count('SUSPENDED'),
  ]);
  return { total, active, trialing, pastDue, suspended };
}

export interface TrialEnding {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly planKey: string;
  readonly trialEndsAt: Date;
}

/** Trials that end within `days`. Bounded; counts are exact. */
export async function loadTrialsEnding(
  days: number,
  take = 10,
): Promise<{ readonly count: number; readonly items: readonly TrialEnding[] }> {
  const now = new Date();
  const until = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const where = { status: 'TRIALING' as const, trialEndsAt: { gte: now, lte: until } };
  const prisma = getPlatformPrisma();
  const [count, rows] = await Promise.all([
    prisma.workspaceSubscription.count({ where }),
    prisma.workspaceSubscription.findMany({
      where,
      orderBy: [{ trialEndsAt: 'asc' }, { workspaceId: 'asc' }],
      take,
      select: {
        workspaceId: true,
        planKey: true,
        trialEndsAt: true,
        workspace: { select: { name: true } },
      },
    }),
  ]);
  return {
    count,
    items: rows.map((row) => ({
      workspaceId: row.workspaceId,
      workspaceName: row.workspace.name,
      planKey: row.planKey,
      trialEndsAt: row.trialEndsAt as Date,
    })),
  };
}

/** Subscriptions grouped by status and by plan — two counts, no content. */
export async function loadSubscriptionMix(): Promise<{
  readonly byStatus: readonly { readonly status: string; readonly count: number }[];
  readonly byPlan: readonly { readonly planKey: string; readonly count: number }[];
}> {
  const prisma = getPlatformPrisma();
  const [byStatus, byPlan] = await Promise.all([
    prisma.workspaceSubscription.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.workspaceSubscription.groupBy({
      by: ['planKey'],
      where: { status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } },
      _count: { _all: true },
    }),
  ]);
  return {
    byStatus: byStatus
      .map((row) => ({ status: row.status, count: row._count._all }))
      .sort((a, b) => b.count - a.count),
    byPlan: byPlan
      .map((row) => ({ planKey: row.planKey, count: row._count._all }))
      .sort((a, b) => b.count - a.count),
  };
}

/**
 * Customers on each plan, from the workspace's own plan — the figure the plan
 * change preview needs ("17 customers currently use this plan"). A workspace
 * that has been archived, cancelled or deleted is not "using" anything.
 */
export async function loadCustomersPerPlan(): Promise<ReadonlyMap<string, number>> {
  const rows = await getPlatformPrisma().workspace.groupBy({
    by: ['planKey'],
    where: {
      planKey: { not: null },
      status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE', 'SUSPENDED'] },
    },
    _count: { _all: true },
  });
  return new Map(
    rows
      .filter((row) => row.planKey !== null)
      .map((row) => [row.planKey as string, row._count._all]),
  );
}

/* ------------------------------------------------------------------------ */
/* Pending changes, billing, AI                                              */
/* ------------------------------------------------------------------------ */

export interface PendingChange {
  readonly domain: ConfigDomain;
  readonly versionNumber: number;
  readonly validated: boolean;
  readonly createdAt: Date;
}

/** Drafts waiting to be checked or activated, across every domain. */
export async function loadPendingChanges(actor: Actor): Promise<readonly PendingChange[] | null> {
  if (!may(actor, 'platform.configuration.read')) return null;
  const environment = currentEnvironment();
  const config = getConfigService();
  const perDomain = await Promise.all(
    CONFIG_DOMAIN_KEYS.map(async (domain) =>
      (await config.listVersions(serviceActor(actor), domain, environment))
        .filter((version) => version.status === 'DRAFT' || version.status === 'VALIDATED')
        .map((version) => ({
          domain,
          versionNumber: version.versionNumber,
          validated: version.status === 'VALIDATED',
          createdAt: version.createdAt,
        })),
    ),
  );
  return perDomain.flat();
}

/** The billing inbox's own read. Bounded at 200; a full page reads "200+". */
export async function loadBillingIssues(): Promise<{
  readonly count: number;
  readonly capped: boolean;
  readonly items: readonly AttentionEvent[];
}> {
  const items = await eventsNeedingAttention(getPlatformPrisma(), { limit: 200 });
  return { count: items.length, capped: items.length >= 200, items };
}

export interface AiSummary {
  readonly profile: AiRoutingProfile;
  /** Credits used in the window, when the reader may see AI usage. */
  readonly usage: { readonly creditsMilli: bigint; readonly entries: number } | null;
  /** Requests past their deadline and never finished — the explorer's figure. */
  readonly stuckRequests: number | null;
}

export async function loadAiSummary(actor: Actor, days = 30): Promise<AiSummary> {
  const environment = currentEnvironment();
  const routing = await getConfigService().get('ai.capability-routing', environment);
  let usage: AiSummary['usage'] = null;
  let stuckRequests: number | null = null;
  if (may(actor, 'platform.ai.usage.read')) {
    const explorer = getAiUsageExplorer();
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const [rows, leaks] = await Promise.all([
      explorer.rollup(serviceActor(actor), 'taskKey', { since }),
      explorer.leakCount(serviceActor(actor)),
    ]);
    usage = {
      creditsMilli: rows.reduce((sum, row) => sum + row.creditsChargedMilli, 0n),
      entries: rows.reduce((sum, row) => sum + row.requests, 0),
    };
    stuckRequests = leaks;
  }
  return { profile: routing.activeProfile, usage, stuckRequests };
}

/**
 * WHAT EACH PROFILE WOULD ACTUALLY PICK — computed by the router itself.
 *
 * For every capability a shipping feature requests, the first model in the
 * chain `resolveCapabilityRoute` returns under the given profile, from the
 * same catalogue mapping the gateway loads (prices included). A capability no
 * model can serve says so; nothing is ranked here.
 */
export interface CapabilityPreview {
  readonly capability: string;
  readonly modelKey: string | null;
  readonly outcome: 'served' | 'switched_off' | 'no_model';
  /** A task rule answered, so no profile changes this row. */
  readonly fixedByRule: boolean;
}

export async function previewProfile(
  profile: AiRoutingProfile,
): Promise<{ readonly rows: readonly CapabilityPreview[]; readonly pricedModels: number }> {
  const configuration = await new ConfigurationAiSource(
    getConfigService(),
    currentEnvironment(),
  ).load();
  const routing = {
    activeProfile: profile,
    routes: configuration.capabilityRouting?.routes ?? [],
  };
  const rows = AI_CAPABILITIES.filter((capability) =>
    REQUESTED_AI_CAPABILITIES.includes(capability.key),
  ).map((capability): CapabilityPreview => {
    const task = tasksForCapability(capability.key).find((candidate) => candidate.mvpApproved);
    const none = { capability: capability.key, modelKey: null, fixedByRule: false };
    if (!task) return { ...none, outcome: 'no_model' };
    try {
      // The router's full entry point: a global task rule wins outright, and
      // only when none applies does the capability layer — and so the profile
      // — decide. Planless and workspace-less, so only global rules apply.
      const route = resolveRoute(
        { taskKey: task.key, workspaceId: '00000000-0000-0000-0000-000000000000', planKey: null },
        configuration.routingRules,
        configuration.models,
        routing,
      );
      return {
        capability: capability.key,
        modelKey: route.chain[0] ?? null,
        outcome: 'served',
        fixedByRule: route.resolvedBy === 'task',
      };
    } catch (error: unknown) {
      if (error instanceof RoutingError && error.reason === 'capability_disabled') {
        return { ...none, outcome: 'switched_off' };
      }
      return { ...none, outcome: 'no_model' };
    }
  });
  const pricedModels = configuration.models.filter(
    (model) =>
      (model.inputCostPerUnitMicroMinor ?? null) !== null ||
      (model.imageCostPerImageMicroMinor ?? null) !== null,
  ).length;
  return { rows, pricedModels };
}

/* ------------------------------------------------------------------------ */
/* System                                                                    */
/* ------------------------------------------------------------------------ */

export interface SystemState {
  readonly databaseOk: boolean;
  readonly report: HealthReport;
  readonly tracingExporting: boolean;
}

/**
 * The same verdict the health page and `/health/ready` reach: a live database
 * probe and the tracing export, through `evaluateHealth`.
 */
export async function loadSystemState(): Promise<SystemState> {
  let databaseOk = false;
  try {
    await getPlatformPrisma().$queryRaw`SELECT 1`;
    databaseOk = true;
  } catch {
    databaseOk = false;
  }
  const tracing = tracingStatus();
  const report = evaluateHealth([
    { name: 'database', state: databaseOk ? 'ok' : 'down', required: true },
    {
      name: 'tracing',
      state: tracing.exporting ? 'ok' : 'not_configured',
      required: false,
      capability: 'observability',
    },
  ]);
  return { databaseOk, report, tracingExporting: tracing.exporting };
}

/* ------------------------------------------------------------------------ */
/* Customers — the facts a directory card shows                              */
/* ------------------------------------------------------------------------ */

export interface CustomerFacts {
  readonly subscriptionStatus: string | null;
  readonly trialEndsAt: Date | null;
  readonly brands: number;
  readonly creditsMilli: bigint | null;
  readonly socialAccounts: number;
}

/**
 * Per-card facts for ONE PAGE of the directory — bounded by the page's ids,
 * four grouped reads regardless of page size. Counts and a balance only; no
 * customer content is read.
 */
export async function loadCustomerFacts(
  workspaceIds: readonly string[],
): Promise<ReadonlyMap<string, CustomerFacts>> {
  if (workspaceIds.length === 0) return new Map();
  const prisma = getPlatformPrisma();
  const ids = [...workspaceIds];
  const [subscriptions, brands, wallets, connections] = await Promise.all([
    prisma.workspaceSubscription.findMany({
      where: { workspaceId: { in: ids } },
      select: { workspaceId: true, status: true, trialEndsAt: true },
    }),
    prisma.brand.groupBy({
      by: ['workspaceId'],
      where: { workspaceId: { in: ids }, status: { not: 'ARCHIVED' } },
      _count: { _all: true },
    }),
    prisma.creditWallet.findMany({
      where: { workspaceId: { in: ids } },
      select: { workspaceId: true, balanceMilliCredits: true },
    }),
    prisma.socialConnection.groupBy({
      by: ['workspaceId'],
      where: { workspaceId: { in: ids }, status: 'ACTIVE' },
      _count: { _all: true },
    }),
  ]);
  return new Map(
    ids.map((id) => {
      const subscription = subscriptions.find((row) => row.workspaceId === id);
      return [
        id,
        {
          subscriptionStatus: subscription?.status ?? null,
          trialEndsAt:
            subscription?.status === 'TRIALING' ? (subscription.trialEndsAt ?? null) : null,
          brands: brands.find((row) => row.workspaceId === id)?._count._all ?? 0,
          creditsMilli: wallets.find((row) => row.workspaceId === id)?.balanceMilliCredits ?? null,
          socialAccounts: connections.find((row) => row.workspaceId === id)?._count._all ?? 0,
        },
      ];
    }),
  );
}
