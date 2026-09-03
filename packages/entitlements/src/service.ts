// The client TYPE comes from @brandspace/database, the only package permitted
// to import @prisma/client directly (docs/ARCHITECTURE.md §4.1).
import type { PrismaClient } from '@brandspace/database';
import { AppError, type Clock, systemClock } from '@brandspace/shared';
import type { ConfigurationService } from '@brandspace/config';
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
    // No snapshot yet means nothing has been activated for this domain. An
    // empty catalogue grants nothing, which is the correct answer before the
    // owner has approved any plan — not an error to paper over.
    return (row?.payload as Record<string, unknown> | undefined) ?? {};
  }
}

export interface EntitlementServiceOptions {
  readonly prisma: PrismaClient;
  /** Either a Configuration Service (platform) or an explicit source (tenant). */
  readonly config?: ConfigurationService;
  readonly catalogueSource?: CatalogueSource;
  readonly environment: 'DEVELOPMENT' | 'STAGING' | 'PRODUCTION';
  readonly clock?: Clock;
}

export class EntitlementService {
  readonly #prisma: PrismaClient;
  readonly #source: CatalogueSource;
  readonly #clock: Clock;

  constructor(options: EntitlementServiceOptions) {
    this.#prisma = options.prisma;
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
    const [entitlements, flags] = await Promise.all([
      this.#source.load('entitlements'),
      this.#source.load('feature-flags'),
    ]);

    return {
      features: (entitlements['features'] ?? []) as unknown as FeatureDefinition[],
      planEntitlements: (entitlements['planEntitlements'] ??
        []) as unknown as PlanEntitlementRule[],
      flags: (flags['flags'] ?? []) as unknown as FlagRule[],
    };
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

    const overrides = await this.#prisma.workspaceOverride.findMany({
      where: { workspaceId, status: 'ACTIVE' },
      orderBy: { effectiveFrom: 'desc' },
    });

    return {
      workspaceId: workspace.id,
      planKey: workspace.planKey,
      country: workspace.country,
      // Beta cohorts are a Phase 3 targeting dimension; the engine supports
      // them today and reads an empty set until they exist.
      betaGroups: [],
      overrides: overrides.map((o) => ({
        featureKey: o.featureKey,
        enabled: o.enabled,
        limitValue: o.limitValue,
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
  ): Promise<void> {
    await this.#authorize(actor, 'entitlements.assign_plan', PLAN_ASSIGN_PERMISSION);

    if (planKey !== null) {
      const available = await this.plans();
      const plan = available.find((p) => p.key === planKey);
      if (!plan) throw new AppError('VALIDATION_FAILED', `Unknown plan "${planKey}".`);
      if (plan.status === 'retired') {
        throw new AppError('VALIDATION_FAILED', `Plan "${planKey}" is retired.`);
      }
    }

    const before = await this.#prisma.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { planKey: true },
    });
    if (!before) throw new AppError('NOT_FOUND', 'Workspace not found.');

    await this.#prisma.$transaction(async (tx) => {
      await tx.workspace.update({
        where: { id: workspaceId },
        data: {
          planKey,
          planAssignedAt: this.#clock.now(),
          planAssignedByPlatformUserId: actor.platformUserId,
        },
      });
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
          after: { planKey },
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
