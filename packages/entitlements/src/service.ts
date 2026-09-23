// The client TYPE comes from @brandspace/database, the only package permitted
// to import @prisma/client directly (docs/ARCHITECTURE.md §4.1).
import type { PrismaClient } from '@brandspace/database';
import { AppError, type Clock, systemClock } from '@brandspace/shared';
import { parseConfigPayload, type ConfigurationService } from '@brandspace/config';
import {
  resolveEntitlement,
  validateOverride,
  type EntitlementCatalogue,
  type EntitlementDecision,
  type FeatureDefinition,
  type FlagRule,
  type PlanEntitlementRule,
  type WorkspaceEntitlementContext,
} from './precedence';
import { findPlan, readPlanCatalogue, termsFor } from './plan-catalogue';
import { addMonthsClamped } from './credit-policy';
import type { PlanTerms } from './subscription';
import type { CreditLedgerService, LedgerTx } from './credit-ledger';

/**
 * The currency a subscription pins when the caller does not name one.
 *
 * NOT a business decision encoded in code: it is the fallback for an
 * assignment that did not specify, and the plan must actually carry a price in
 * it or the assignment is refused rather than pinned at zero. D-10 set SAR as
 * the launch currency; changing it is a configuration edit plus this constant,
 * and the refusal above is what makes a mismatch loud instead of silent.
 */
const DEFAULT_PIN_CURRENCY = 'SAR';

/**
 * Entitlement resolution against live configuration.
 *
 * The catalogue — features, plan entitlements and flag rules — comes from the
 * ACTIVE configuration versions of the `entitlements`, `plans` and
 * `feature-flags` domains. Nothing here contains a plan name, a price or an
 * allowance: those are configuration the owner controls (CLAUDE.md §2.2), and
 * D-06…D-12 are still unanswered, so this code invents none of them.
 *
 * Overrides are database rows because they are per-customer state with an
 * author, a reason and an expiry — an audit trail, not a setting.
 */

export const PLAN_ASSIGN_PERMISSION = 'platform.plan.assign';
export const OVERRIDE_PERMISSION = 'platform.entitlement.override';
export const WORKSPACE_READ_PERMISSION = 'platform.workspace.read';

export interface EntitlementActor {
  readonly platformUserId: string;
  readonly roleKey: string;
  readonly mfaVerified: boolean;
  readonly permissionKeys: readonly string[];
}

export interface PlanSummary {
  readonly key: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly status: string;
  readonly visibility: string;
  readonly monthlyCredits: number;
  readonly trialDays: number;
}

export interface EffectiveEntitlements {
  readonly workspaceId: string;
  readonly planKey: string | null;
  readonly decisions: readonly EntitlementDecision[];
}

/**
 * Where the catalogue comes from.
 *
 * The Control Center reads `configuration_version` directly on the PLATFORM
 * role. The customer application cannot: that table is platform-owned and the
 * tenant role has every privilege revoked on it. It therefore supplies its own
 * source backed by `entitlement_catalogue_snapshot` — a tenant-readable
 * projection the Configuration Service writes when it activates one of the
 * three customer-relevant domains.
 *
 * Both feed the SAME pure engine, so an operator and a customer looking at one
 * workspace can never be shown different answers.
 */
export interface CatalogueSource {
  /** The ACTIVE payload for one configuration domain, or an empty object. */
  load(domain: 'entitlements' | 'plans' | 'feature-flags'): Promise<Record<string, unknown>>;
  /**
   * Which configuration version that payload came from, or null when nothing
   * is active.
   *
   * A subscription PINS the price it was sold at (AC-04.7), and a pinned price
   * with no record of where it came from cannot be audited: "this workspace
   * pays 49" is only meaningful next to "because plans v7 said so on that
   * date". Both sources can answer, so this is not optional.
   */
  versionId(domain: 'entitlements' | 'plans' | 'feature-flags'): Promise<string | null>;
}

/** The platform-side source: the Configuration Service itself. */
export class ConfigurationCatalogueSource implements CatalogueSource {
  readonly #config: ConfigurationService;
  readonly #environment: 'DEVELOPMENT' | 'STAGING' | 'PRODUCTION';

  constructor(config: ConfigurationService, environment: 'DEVELOPMENT' | 'STAGING' | 'PRODUCTION') {
    this.#config = config;
    this.#environment = environment;
  }

  async load(domain: 'entitlements' | 'plans' | 'feature-flags'): Promise<Record<string, unknown>> {
    return (await this.#config.get(domain, this.#environment)) as Record<string, unknown>;
  }

  async versionId(domain: 'entitlements' | 'plans' | 'feature-flags'): Promise<string | null> {
    return this.#config.activeVersionId(domain, this.#environment);
  }
}

/**
 * The tenant-side source.
 *
 * Reads the projection, so the customer application never touches
 * `configuration_version` — which stays platform-owned with every privilege
 * revoked — and cannot reach any domain beyond the three its entitlements
 * depend on.
 */
export class TenantCatalogueSource implements CatalogueSource {
  readonly #prisma: PrismaClient;
  readonly #environment: 'DEVELOPMENT' | 'STAGING' | 'PRODUCTION';

  constructor(prisma: PrismaClient, environment: 'DEVELOPMENT' | 'STAGING' | 'PRODUCTION') {
    this.#prisma = prisma;
    this.#environment = environment;
  }

  async load(domain: 'entitlements' | 'plans' | 'feature-flags'): Promise<Record<string, unknown>> {
    const row = await this.#prisma.entitlementCatalogueSnapshot.findUnique({
      where: { domain_environment: { domain, environment: this.#environment } },
    });
    /*
     * PARSED, NOT CAST — and the difference is a customer-facing crash.
     *
     * `createDraft` stores the payload it is handed, and the precedence engine
     * reads fields like `flag.disabledForWorkspaces` positionally. A payload
     * that omits one — an operator editing a flag in Platform Admin and
     * supplying only the fields they care about, a script, a partial API write —
     * therefore reached `resolveOwnRules` with `undefined` where an array was
     * expected and threw `Cannot read properties of undefined`, which the
     * dashboard surfaced as "this page couldn't load" on every screen that
     * resolves an entitlement.
     *
     * Parsing applies the schema's own defaults, so a document written before a
     * field existed — or without one — comes back COMPLETE. It is the same
     * mechanism `TenantBrandBrainPolicySource` and `TenantAssetPolicySource`
     * already use, and this was the one projection reader that did not.
     * Found by the Phase 5B-1 end-to-end run.
     *
     * No snapshot yet still means nothing has been activated for this domain:
     * parsing `{}` yields the schema's defaults, which grant nothing. That is
     * the correct answer before the owner has approved any plan, not an error
     * to paper over.
     */
    return parseConfigPayload(domain, row?.payload ?? {}) as unknown as Record<string, unknown>;
  }

  async versionId(domain: 'entitlements' | 'plans' | 'feature-flags'): Promise<string | null> {
    const row = await this.#prisma.entitlementCatalogueSnapshot.findUnique({
      where: { domain_environment: { domain, environment: this.#environment } },
      select: { sourceVersionId: true },
    });
    return row?.sourceVersionId ?? null;
  }
}

export interface EntitlementServiceOptions {
  readonly prisma: PrismaClient;
  /** Either a Configuration Service (platform) or an explicit source (tenant). */
  readonly config?: ConfigurationService;
  readonly catalogueSource?: CatalogueSource;
  readonly environment: 'DEVELOPMENT' | 'STAGING' | 'PRODUCTION';
  readonly clock?: Clock;
  /**
   * The ledger, so a plan assignment can grant the credits it promises in the
   * SAME transaction as the subscription (A-3).
   *
   * Optional because the tenant-side service resolves entitlements and never
   * assigns a plan. When it is absent, `assignPlan` writes the subscription and
   * grants nothing — which is why the Control Center wires one in, and why the
   * absence is a deliberate configuration rather than a silent default.
   */
  readonly ledger?: CreditLedgerService;
  /**
   * How long a loaded catalogue may be reused. Short by design: a kill switch
   * must contain an incident, and docs/ADMIN-CONTROL-CENTER.md §5.5 puts that
   * at "within the cache TTL (seconds)". Activation also invalidates directly,
   * so this only bounds how stale ANOTHER process can be.
   */
  readonly cacheTtlMs?: number;
}

/** Seconds, not minutes — see `cacheTtlMs`. */
const DEFAULT_CATALOGUE_TTL_MS = 5_000;

export class EntitlementService {
  readonly #prisma: PrismaClient;
  readonly #source: CatalogueSource;
  readonly #clock: Clock;
  readonly #cacheTtlMs: number;
  readonly #ledger: CreditLedgerService | null;
  #catalogueCache: { value: EntitlementCatalogue; expiresAt: number } | null = null;

  constructor(options: EntitlementServiceOptions) {
    this.#prisma = options.prisma;
    this.#cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CATALOGUE_TTL_MS;
    this.#ledger = options.ledger ?? null;
    const source =
      options.catalogueSource ??
      (options.config
        ? new ConfigurationCatalogueSource(options.config, options.environment)
        : null);
    if (!source) {
      // Fail closed and loudly: a service with no catalogue would resolve every
      // feature to "off" and look like an outage rather than a misconfiguration.
      throw new AppError(
        'INTERNAL',
        'EntitlementService needs either a ConfigurationService or a CatalogueSource.',
      );
    }
    this.#source = source;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Load the catalogue from the ACTIVE configuration versions.
   *
   * An empty configuration yields an empty catalogue, and an empty catalogue
   * grants nothing. That is the correct behaviour before the owner has approved
   * any plan: no feature is silently on because nobody configured it.
   */
  async catalogue(): Promise<EntitlementCatalogue> {
    const cached = this.#catalogueCache;
    if (cached && cached.expiresAt > this.#clock.now().getTime()) {
      return cached.value;
    }

    const [entitlements, flags, plans] = await Promise.all([
      this.#source.load('entitlements'),
      this.#source.load('feature-flags'),
      this.#source.load('plans'),
    ]);

    /*
     * `dependsOn` and `enumOptions` normalised to arrays: both come from a JSON
     * document through a cast, and a feature written before either field
     * existed carries neither. `undefined.length` in the resolver would be a
     * crash the compiler cannot see, because a cast is not a check.
     */
    const declaredFeatures = (
      (entitlements['features'] ?? []) as unknown as FeatureDefinition[]
    ).map((f) => ({
      ...f,
      dependsOn: f.dependsOn ?? [],
      enumOptions: f.enumOptions ?? [],
    }));
    /*
     * `enumValue` is normalised to null rather than left undefined (A-4).
     * These come from a JSON document through a cast, so a plan written before
     * enums existed carries no such key — and `undefined` reaching a field the
     * decision type declares as `string | null` is the kind of gap a cast hides
     * from the compiler and a caller finds at runtime.
     */
    const declaredEntitlements = (
      (entitlements['planEntitlements'] ?? []) as unknown as PlanEntitlementRule[]
    ).map((rule) => ({ ...rule, enumValue: rule.enumValue ?? null }));
    const planDocs = (plans['plans'] ?? []) as ReadonlyArray<Record<string, unknown>>;

    // THE PLAN'S QUOTAS ARE THE PLAN'S. They are projected into the catalogue
    // here rather than being maintained a second time in the `entitlements`
    // document, because two places to write a seat limit is two places for it
    // to disagree — and the one the engine reads would win silently.
    //
    // The projection is deterministic and one-directional: a quota written on
    // the plan appears as a plan entitlement under its canonical key. An
    // explicitly declared entitlement for the same pair still wins, so an owner
    // can express something the six fixed dimensions cannot.
    const projected = projectPlanQuotas(planDocs, declaredEntitlements);

    const value: EntitlementCatalogue = {
      features: withQuotaFeatures(declaredFeatures),
      planEntitlements: [...declaredEntitlements, ...projected],
      flags: (flags['flags'] ?? []) as unknown as FlagRule[],
    };

    this.#catalogueCache = {
      value,
      expiresAt: this.#clock.now().getTime() + this.#cacheTtlMs,
    };
    return value;
  }

  /**
   * Drop the cached catalogue.
   *
   * Called when a configuration version is activated or rolled back, so a kill
   * switch takes effect at once rather than at the end of a TTL (AC-05.8). The
   * TTL is the backstop for other processes; this is the fast path for the one
   * that made the change.
   */
  invalidate(): void {
    this.#catalogueCache = null;
  }

  /** Plans the owner has configured. Prices are deliberately not exposed here. */
  async plans(): Promise<PlanSummary[]> {
    const payload = await this.#source.load('plans');
    const raw = (payload['plans'] ?? []) as ReadonlyArray<Record<string, unknown>>;
    return raw.map((p) => {
      const name = (p['name'] ?? {}) as Record<string, string>;
      return {
        key: String(p['key'] ?? ''),
        nameEn: name['en'] ?? String(p['key'] ?? ''),
        nameAr: name['ar'] ?? String(p['key'] ?? ''),
        status: String(p['status'] ?? 'draft'),
        visibility: String(p['visibility'] ?? 'private'),
        monthlyCredits: Number(p['monthlyCredits'] ?? 0),
        trialDays: Number(p['trialDays'] ?? 0),
      };
    });
  }

  /** Materialise everything the pure engine needs for one workspace. */
  async contextFor(workspaceId: string): Promise<WorkspaceEntitlementContext> {
    const workspace = await this.#prisma.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { id: true, planKey: true, country: true },
    });
    if (!workspace) throw new AppError('NOT_FOUND', 'Workspace not found.');

    /*
     * A SUBSCRIPTION THAT HAS ENDED NO LONGER GRANTS ITS PLAN.
     *
     * `Workspace.planKey` is a denormalised copy of what the customer bought,
     * and it is not cleared when a subscription reaches its end — deliberately,
     * because the commercial record is history and history is not deleted. So
     * this resolver read it and went on granting the paid plan after the
     * subscription was CANCELLED or EXPIRED, while the cycle boundary, the
     * billing screen and the audit trail all said the relationship was over.
     * docs/BILLING-AND-CREDITS.md §3.4 says access continues UNTIL the period
     * end, not after it.
     *
     * THE FIX IS TO STOP CLAIMING THE PLAN, NOT TO DELETE ANYTHING. The
     * workspace resolves as one on no plan: quota dimensions become none rather
     * than unlimited, plan-granted capabilities fall back to their declared
     * defaults, and everything gated on a PERMISSION rather than on an
     * entitlement — reading, the billing screen, the invoice documents and the
     * accounting export — is untouched. That is what "data is retained and
     * export remains available" requires of this layer.
     *
     * `PAST_DUE` IS ABSENT ON PURPOSE: §3.5 gives it full access while dunning
     * runs. `SUSPENDED` IS ABSENT ON PURPOSE TOO: what a billing suspension
     * withdraws is an open product decision (D-234), and guessing it here would
     * be taking that decision rather than recording it.
     */
    const subscription = await this.#prisma.workspaceSubscription.findUnique({
      where: { workspaceId },
      select: { status: true },
    });
    /*
     * `planEnded` CARRIES THE REASON `planKey` IS NULL (P6-03b).
     *
     * Two opposite situations both end with no plan, and an unstated quota
     * wants opposite answers from them: a relationship that ENDED gets none,
     * per the paragraph above; a workspace that never had a plan at all — one
     * created minutes ago where no plan is configured — must still be usable.
     * Without this flag the engine cannot tell them apart, and fixing either
     * one breaks the other.
     */
    const planEnded =
      subscription !== null && TERMINAL_SUBSCRIPTION_STATUSES.has(subscription.status);
    const planKey = planEnded ? null : workspace.planKey;

    const overrides = await this.#prisma.workspaceOverride.findMany({
      where: { workspaceId, status: 'ACTIVE' },
      orderBy: { effectiveFrom: 'desc' },
    });

    // Phase 3: the real cohort memberships. Until this model existed the
    // engine's beta dimension read a hard-coded empty set, so a flag targeted
    // at a cohort could never match anyone.
    const cohorts = await this.#prisma.betaCohortMembership.findMany({
      where: { workspaceId },
      select: { cohortKey: true },
    });

    return {
      workspaceId: workspace.id,
      planKey,
      planEnded,
      country: workspace.country,
      betaGroups: cohorts.map((c) => c.cohortKey),
      overrides: overrides.map((o) => ({
        featureKey: o.featureKey,
        enabled: o.enabled,
        limitValue: o.limitValue,
        enumValue: o.enumValue,
        reason: o.reason,
        effectiveFrom: o.effectiveFrom,
        effectiveUntil: o.effectiveUntil,
      })),
    };
  }

  /**
   * Resolve one feature, with its trace.
   *
   * The SAME call answers "may this workspace do X?" and "why?", so the
   * explanation in the Control Center can never disagree with the decision.
   */
  async resolve(workspaceId: string, featureKey: string): Promise<EntitlementDecision> {
    const [catalogue, context] = await Promise.all([
      this.catalogue(),
      this.contextFor(workspaceId),
    ]);
    return resolveEntitlement(catalogue, context, featureKey, this.#clock.now());
  }

  /**
   * May this workspace do X?
   *
   * The named API docs/ADMIN-CONTROL-CENTER.md §5.1 requires application code
   * to use, so no call site ever writes `if (plan === 'growth')`. It is
   * `resolve()` reduced to a boolean, which means the answer and the trace that
   * explains it always come from the same evaluation.
   */
  async can(workspaceId: string, featureKey: string): Promise<boolean> {
    const decision = await this.resolve(workspaceId, featureKey);
    return decision.enabled;
  }

  /**
   * How many may it have?
   *
   * `null` means unlimited — the Enterprise "negotiated" case — and is
   * deliberately NOT zero. A caller that treats a missing limit as zero locks
   * out exactly the customers who paid for no limit, so the two are different
   * values and every consumer must handle both.
   *
   * A feature that is off returns 0: not unlimited, none.
   */
  async limit(workspaceId: string, featureKey: string): Promise<number | null> {
    const decision = await this.resolve(workspaceId, featureKey);
    if (!decision.enabled) return 0;
    return decision.limitValue;
  }

  /**
   * The decision AND its explanation, for the Control Center's trace view.
   *
   * Identical to `resolve()`; named separately so the intent at the call site
   * is legible, and so the trace is never quietly recomputed by a second path.
   */
  async explain(workspaceId: string, featureKey: string): Promise<EntitlementDecision> {
    return this.resolve(workspaceId, featureKey);
  }

  /** Resolve every configured feature — the "effective features" view. */
  async resolveAll(workspaceId: string): Promise<EffectiveEntitlements> {
    const [catalogue, context] = await Promise.all([
      this.catalogue(),
      this.contextFor(workspaceId),
    ]);
    const now = this.#clock.now();
    return {
      workspaceId,
      planKey: context.planKey,
      decisions: catalogue.features.map((f) => resolveEntitlement(catalogue, context, f.key, now)),
    };
  }

  /**
   * Assign or change a workspace plan.
   *
   * The plan key must exist in the active `plans` configuration: assigning a
   * plan that no version defines would leave the workspace resolving against
   * nothing, which reads as "everything off" and looks like an outage.
   */
  async assignPlan(
    actor: EntitlementActor,
    workspaceId: string,
    planKey: string | null,
    reason: string,
    options: { readonly currency?: string; readonly billingInterval?: 'MONTH' | 'YEAR' } = {},
  ): Promise<void> {
    await this.#authorize(actor, 'entitlements.assign_plan', PLAN_ASSIGN_PERMISSION);

    /*
     * A-3. ASSIGNING A PLAN USED TO WRITE A STRING.
     *
     * It set `workspace.planKey` and an audit event, and stopped. No
     * `WorkspaceSubscription` row was created, so the customer had no status,
     * no billing period, no trial and no pinned price; the Plan & Usage page
     * had nothing real to show; the cycle worker had nothing to advance; and
     * the credits the plan promises were never granted. The plan was a label
     * on a workspace rather than a commercial relationship.
     *
     * Everything the assignment implies now happens in ONE transaction:
     * the workspace's plan key, the subscription with its pinned price and
     * pinned configuration version, the trial when the plan offers one and the
     * workspace has never had one, and the matching credit grant.
     *
     * IDEMPOTENT. Assigning the same plan twice is a no-op rather than a second
     * trial or a second allowance — the credit grants carry keys derived from
     * the workspace and the plan, and the trial is refused once
     * `trialStartedAt` is set. An operator who double-clicks must not cost the
     * business a month of credits.
     */
    const now = this.#clock.now();
    const currency = options.currency ?? DEFAULT_PIN_CURRENCY;

    let terms: PlanTerms | null = null;
    if (planKey !== null) {
      const payload = await this.#source.load('plans');
      const plan = findPlan(readPlanCatalogue(payload), planKey);
      if (!plan) throw new AppError('VALIDATION_FAILED', `Unknown plan "${planKey}".`);
      if (plan.status === 'retired') {
        throw new AppError('VALIDATION_FAILED', `Plan "${planKey}" is retired.`);
      }
      const versionId = await this.#source.versionId('plans');
      terms = termsFor(plan, currency, versionId);
      if (!terms) {
        throw new AppError(
          'VALIDATION_FAILED',
          `Plan "${planKey}" has no price in ${currency}, so there is nothing to pin.`,
        );
      }
    }

    const before = await this.#prisma.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { planKey: true },
    });
    if (!before) throw new AppError('NOT_FOUND', 'Workspace not found.');

    const apply = async (tx: LedgerTx) => {
      await tx.workspace.update({
        where: { id: workspaceId },
        data: {
          planKey,
          planAssignedAt: now,
          planAssignedByPlatformUserId: actor.platformUserId,
        },
      });

      /*
       * UNASSIGNING. The subscription is CANCELLED rather than deleted: it is
       * the record of what the customer was sold and when, and deleting it
       * would destroy the only evidence of a price that was once pinned.
       */
      if (terms === null) {
        const existing = await tx.workspaceSubscription.findUnique({ where: { workspaceId } });
        if (existing && existing.status !== 'CANCELLED') {
          await tx.workspaceSubscription.update({
            where: { workspaceId },
            data: { status: 'CANCELLED', cancelledAt: now },
          });
        }
        return { subscriptionStatus: 'CANCELLED' as const, grantedCredits: 0, trialStarted: false };
      }

      const existing = await tx.workspaceSubscription.findUnique({ where: { workspaceId } });
      // One trial per workspace, ever (D-09). `trialStartedAt` is the record,
      // so a workspace that has trialed cannot be given another by reassigning.
      const mayTrial = terms.trialDays > 0 && (existing?.trialStartedAt ?? null) === null;
      const samePlan = existing !== null && existing.planKey === terms.planKey;
      /*
       * WHEN THE BILLING PERIOD IS PRESERVED.
       *
       * Re-assigning the plan a workspace already has must not open a new
       * period — otherwise every click starts a fresh month and, with it, a
       * fresh allowance. A workspace mid-trial keeps its trial period too: the
       * trial belongs to the workspace, not to the plan, so changing plan
       * inside it must neither cut it short nor restart it.
       */
      const keepPeriod =
        existing !== null && !mayTrial && (samePlan || existing.status === 'TRIALING');
      const pinned = {
        currency: terms.pricing.currency.toUpperCase(),
        pinnedMonthlyMinor: terms.pricing.monthlyMinor,
        pinnedAnnualMinor: terms.pricing.annualMinor,
        pinnedMonthlyCredits: terms.monthlyCredits,
        pinnedFromVersionId: terms.sourceVersionId,
      };
      const billingInterval = options.billingInterval ?? existing?.billingInterval ?? 'MONTH';

      const periodStart = keepPeriod ? existing.currentPeriodStart : now;
      const periodEnd = mayTrial
        ? new Date(now.getTime() + terms.trialDays * 86_400_000)
        : keepPeriod
          ? existing.currentPeriodEnd
          : addMonthsClamped(now, billingInterval === 'YEAR' ? 12 : 1);

      await tx.workspaceSubscription.upsert({
        where: { workspaceId },
        create: {
          workspaceId,
          planKey: terms.planKey,
          status: mayTrial ? 'TRIALING' : 'ACTIVE',
          billingInterval,
          ...pinned,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          ...(mayTrial ? { trialStartedAt: now, trialEndsAt: periodEnd } : {}),
        },
        update: {
          planKey: terms.planKey,
          // A workspace mid-trial that is moved to another plan STAYS in its
          // trial: the trial is the workspace's one evaluation period, not the
          // plan's, and re-dating it would silently extend it.
          status: existing?.status === 'TRIALING' ? 'TRIALING' : mayTrial ? 'TRIALING' : 'ACTIVE',
          billingInterval,
          ...pinned,
          // A scheduled downgrade is superseded by an explicit assignment.
          pendingPlanKey: null,
          pendingPlanEffectiveAt: null,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          ...(mayTrial ? { trialStartedAt: now, trialEndsAt: periodEnd } : {}),
        },
      });

      /*
       * THE CREDITS. A trial grants its own one-off allowance (D-09); a
       * non-trial assignment grants the plan's monthly allowance for the period
       * just opened.
       *
       * The keys are derived from the workspace and the plan, never from the
       * clock, so a retried or double-submitted assignment reuses the same key
       * and grants once. `#grantWithin` is not reachable from here, so the
       * ledger is called with its own idempotency contract instead.
       */
      /*
       * WHO GETS CREDITS, AND WHEN.
       *
       *   - A TRIAL grants its one-off allowance (D-09).
       *   - A NEW PERIOD — a first assignment, or a plan change on an active
       *     subscription — grants that plan's monthly allowance.
       *   - EVERYTHING ELSE grants nothing: re-assigning the same plan, or
       *     changing plan mid-trial, where the trial credits already ARE the
       *     allowance. Granting there would let an operator mint credits by
       *     toggling between two plans.
       *
       * The keys are derived from the workspace, the plan and the PERIOD the
       * subscription actually holds — never from the clock. A key built from
       * `now` differs on every call, which is not idempotency, it is a
       * duplicate grant with extra steps.
       */
      const credits = mayTrial ? terms.trialCredits : keepPeriod ? 0 : terms.monthlyCredits;
      if (credits > 0 && this.#ledger) {
        await this.#ledger.grantWithin(tx, {
          workspaceId,
          source: mayTrial ? 'TRIAL_GRANT' : 'PLAN_GRANT',
          credits,
          reason: mayTrial
            ? `Trial allowance for plan ${terms.planKey}.`
            : `Plan allowance for ${terms.planKey}.`,
          idempotencyKey: mayTrial
            ? `trial-grant:${workspaceId}:${terms.planKey}`
            : `plan-assign:${workspaceId}:${terms.planKey}:${periodStart.toISOString()}`,
          actor: { actorType: 'PLATFORM_USER', actorId: actor.platformUserId },
        });
      }

      return {
        subscriptionStatus: mayTrial ? ('TRIALING' as const) : ('ACTIVE' as const),
        grantedCredits: credits,
        trialStarted: mayTrial,
      };
    };

    await this.#prisma.$transaction(async (tx) => {
      const outcome = await apply(tx);
      // THE AUDIT EVENT COMMITS WITH THE CHANGE IT DESCRIBES (A-10). Written
      // after the work so it can report what actually happened, and inside the
      // same transaction so a rolled-back assignment leaves no record claiming
      // it succeeded.
      await tx.auditEvent.create({
        data: {
          workspaceId,
          actorType: 'PLATFORM_USER',
          actorId: actor.platformUserId,
          action: 'platform.plan.assigned',
          resourceType: 'workspace',
          resourceId: workspaceId,
          severity: 'NOTICE',
          outcome: 'SUCCESS',
          reason,
          before: { planKey: before.planKey },
          after: {
            planKey,
            subscriptionStatus: outcome.subscriptionStatus,
            trialStarted: outcome.trialStarted,
            grantedCredits: outcome.grantedCredits,
          },
        },
      });
    });
  }

  /**
   * Grant a per-customer override.
   *
   * Validated against the catalogue first — unknown feature, wrong value type,
   * an unmet dependency, or a kill switch all refuse the write. Only one ACTIVE
   * override per (workspace, feature) can exist, enforced by a partial unique
   * index, so the previous one is revoked in the same transaction.
   */
  async setOverride(
    actor: EntitlementActor,
    workspaceId: string,
    featureKey: string,
    enabled: boolean,
    limitValue: number | null,
    reason: string,
    effectiveUntil: Date | null = null,
    /** The chosen option for an `enum` feature (A-4). Null for every other type. */
    enumValue: string | null = null,
  ): Promise<void> {
    await this.#authorize(actor, 'entitlements.set_override', OVERRIDE_PERMISSION);

    if (reason.trim().length < 8) {
      throw new AppError(
        'VALIDATION_FAILED',
        'An override requires a written reason of at least 8 characters.',
      );
    }

    const [catalogue, context] = await Promise.all([
      this.catalogue(),
      this.contextFor(workspaceId),
    ]);
    const invalid = validateOverride(
      catalogue,
      context,
      featureKey,
      enabled,
      limitValue,
      this.#clock.now(),
      enumValue,
    );
    if (invalid !== null) throw new AppError('VALIDATION_FAILED', invalid);

    const now = this.#clock.now();
    await this.#prisma.$transaction(async (tx) => {
      await tx.workspaceOverride.updateMany({
        where: { workspaceId, featureKey, status: 'ACTIVE' },
        data: { status: 'REVOKED', revokedAt: now },
      });
      await tx.workspaceOverride.create({
        data: {
          workspaceId,
          featureKey,
          enabled,
          limitValue,
          enumValue,
          reason: reason.trim(),
          grantedByPlatformUserId: actor.platformUserId,
          effectiveFrom: now,
          effectiveUntil,
        },
      });
      await tx.auditEvent.create({
        data: {
          workspaceId,
          actorType: 'PLATFORM_USER',
          actorId: actor.platformUserId,
          action: 'platform.entitlement.override_set',
          resourceType: 'workspace_override',
          resourceId: workspaceId,
          severity: 'NOTICE',
          outcome: 'SUCCESS',
          reason: reason.trim(),
          after: { featureKey, enabled, limitValue },
        },
      });
    });
  }

  /** Revoke an override, returning the workspace to plan-derived behaviour. */
  async revokeOverride(
    actor: EntitlementActor,
    workspaceId: string,
    featureKey: string,
  ): Promise<void> {
    await this.#authorize(actor, 'entitlements.revoke_override', OVERRIDE_PERMISSION);

    const now = this.#clock.now();
    const revoked = await this.#prisma.workspaceOverride.updateMany({
      where: { workspaceId, featureKey, status: 'ACTIVE' },
      data: { status: 'REVOKED', revokedAt: now },
    });
    if (revoked.count === 0)
      throw new AppError('NOT_FOUND', 'No active override for that feature.');

    await this.#prisma.auditEvent.create({
      data: {
        workspaceId,
        actorType: 'PLATFORM_USER',
        actorId: actor.platformUserId,
        action: 'platform.entitlement.override_revoked',
        resourceType: 'workspace_override',
        resourceId: workspaceId,
        severity: 'NOTICE',
        outcome: 'SUCCESS',
        before: { featureKey },
      },
    });
  }

  async listOverrides(workspaceId: string): Promise<
    ReadonlyArray<{
      readonly featureKey: string;
      readonly enabled: boolean;
      readonly limitValue: number | null;
      readonly reason: string;
      readonly effectiveFrom: Date;
      readonly effectiveUntil: Date | null;
    }>
  > {
    const rows = await this.#prisma.workspaceOverride.findMany({
      where: { workspaceId, status: 'ACTIVE' },
      orderBy: { featureKey: 'asc' },
    });
    return rows.map((o) => ({
      featureKey: o.featureKey,
      enabled: o.enabled,
      limitValue: o.limitValue,
      reason: o.reason,
      effectiveFrom: o.effectiveFrom,
      effectiveUntil: o.effectiveUntil,
    }));
  }

  async #authorize(actor: EntitlementActor, operation: string, permission: string): Promise<void> {
    const denial = entitlementDenialReason(actor, operation, permission);
    if (denial === null) return;

    if (actor?.platformUserId) {
      try {
        await this.#prisma.auditEvent.create({
          data: {
            workspaceId: null,
            actorType: 'PLATFORM_USER',
            actorId: actor.platformUserId,
            action: 'platform.entitlement.access.denied',
            resourceType: 'workspace_override',
            severity: 'WARNING',
            outcome: 'DENIED',
            reason: denial,
          },
        });
      } catch {
        // A denial that cannot be recorded is still a denial.
      }
    }
    throw new AppError('FORBIDDEN', denial);
  }
}

export function entitlementDenialReason(
  actor: EntitlementActor | null | undefined,
  operation: string,
  permission: string,
): string | null {
  if (!actor?.platformUserId) return `${operation} requires a platform actor.`;
  if (!actor.mfaVerified) return `${operation} requires verified MFA (D-27).`;
  if (!actor.permissionKeys?.includes(permission)) return `${operation} requires ${permission}.`;
  return null;
}

/**
 * Subscription statuses after which the plan no longer applies.
 *
 * ONLY THE ENDINGS. A cancelled subscription reached the end of the period the
 * customer paid for; an expired one is a trial that was never converted. Both
 * are terminal — `dueForCycle` stops offering them and no later boundary
 * revives them — so continuing to resolve the paid plan would be the resolver
 * disagreeing with every other record of the relationship.
 */
const TERMINAL_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set(['CANCELLED', 'EXPIRED']);

// ---------------------------------------------------------------------------
// The plan-quota projection
// ---------------------------------------------------------------------------

/**
 * The six quota dimensions, as feature definitions.
 *
 * The engine refuses an unknown feature key — failing closed, so a typo cannot
 * grant access — which means the projected quota entitlements need matching
 * feature definitions to resolve against. Declaring them here rather than
 * requiring the owner to re-type six rows in every environment keeps the KEYS
 * in code (where docs/ADMIN-CONTROL-CENTER.md §5.1 puts them) and every NUMBER
 * in configuration (where AC-04.3 requires it).
 *
 * `defaultValue: null` matters: a workspace on no plan gets no quota, not an
 * invented one.
 */
const QUOTA_FEATURE_DEFINITIONS: readonly FeatureDefinition[] = [
  { key: 'limit.seats', valueType: 'quota', defaultValue: null, dependsOn: [], enumOptions: [] },
  { key: 'limit.brands', valueType: 'quota', defaultValue: null, dependsOn: [], enumOptions: [] },
  {
    key: 'limit.social_accounts',
    valueType: 'quota',
    defaultValue: null,
    dependsOn: [],
    enumOptions: [],
  },
  {
    key: 'limit.scheduled_posts',
    valueType: 'quota',
    defaultValue: null,
    dependsOn: [],
    enumOptions: [],
  },
  {
    key: 'limit.storage_gb',
    valueType: 'quota',
    defaultValue: null,
    dependsOn: [],
    enumOptions: [],
  },
  {
    key: 'limit.analytics_retention_days',
    valueType: 'quota',
    defaultValue: null,
    dependsOn: [],
    enumOptions: [],
  },
];

/** Plan quota field -> canonical feature key, and the window it counts over. */
const QUOTA_FIELD_MAP: ReadonlyArray<{
  readonly field: string;
  readonly featureKey: string;
  readonly period: 'month' | 'total';
}> = [
  { field: 'seats', featureKey: 'limit.seats', period: 'total' },
  { field: 'brands', featureKey: 'limit.brands', period: 'total' },
  { field: 'socialAccounts', featureKey: 'limit.social_accounts', period: 'total' },
  { field: 'scheduledPostsPerMonth', featureKey: 'limit.scheduled_posts', period: 'month' },
  { field: 'storageGb', featureKey: 'limit.storage_gb', period: 'total' },
  {
    field: 'analyticsRetentionDays',
    featureKey: 'limit.analytics_retention_days',
    period: 'total',
  },
];

/** Add the quota definitions the owner has not declared themselves. */
function withQuotaFeatures(declared: readonly FeatureDefinition[]): readonly FeatureDefinition[] {
  const declaredKeys = new Set(declared.map((f) => f.key));
  return [...declared, ...QUOTA_FEATURE_DEFINITIONS.filter((f) => !declaredKeys.has(f.key))];
}

/**
 * Turn each plan's `quotas` block into plan entitlements.
 *
 * An explicitly declared entitlement for the same (plan, feature) pair is left
 * alone and this projection yields nothing for it, so the owner can always
 * override the projection by writing the row directly.
 *
 * A `null` quota is Enterprise's "negotiated": the feature is ENABLED with no
 * limit, which the engine and `limit()` both read as unlimited. Omitting the
 * row instead would have fallen through to the feature default and disabled it.
 */
function projectPlanQuotas(
  plans: ReadonlyArray<Record<string, unknown>>,
  declared: readonly PlanEntitlementRule[],
): readonly PlanEntitlementRule[] {
  const declaredPairs = new Set(declared.map((e) => `${e.planKey}::${e.featureKey}`));
  const projected: PlanEntitlementRule[] = [];

  for (const plan of plans) {
    const planKey = String(plan['key'] ?? '');
    if (!planKey) continue;
    const quotas = (plan['quotas'] ?? {}) as Record<string, unknown>;

    for (const mapping of QUOTA_FIELD_MAP) {
      if (declaredPairs.has(`${planKey}::${mapping.featureKey}`)) continue;
      if (!(mapping.field in quotas)) continue;

      const raw = quotas[mapping.field];
      const limitValue = raw === null || raw === undefined ? null : Number(raw);
      if (limitValue !== null && !Number.isFinite(limitValue)) continue;

      projected.push({
        planKey,
        featureKey: mapping.featureKey,
        enabled: true,
        limitValue,
        // A projected quota is never an enum: these six dimensions are counts.
        enumValue: null,
        limitPeriod: mapping.period,
      });
    }
  }

  return projected;
}
