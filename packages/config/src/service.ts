import { createHash } from 'node:crypto';
// The client TYPE comes from @brandspace/database, which is the only package
// permitted to import @prisma/client directly (docs/ARCHITECTURE.md §4.1).
import { Prisma, type PrismaClient } from '@brandspace/database';
import { AppError, systemClock, type Clock } from '@brandspace/shared';
import {
  CONFIG_DOMAINS,
  defaultPayload,
  isConfigDomain,
  type ConfigDomain,
  type ConfigPayload,
} from './domains';
import {
  buildImpactPreview,
  withAffectedWorkspaces,
  type ImpactPreview,
  type WorkspaceUsageSnapshot,
} from './impact';
import { validateConfiguration, type ConfigContext, type ValidationReport } from './validation';

/**
 * Configuration Service — docs/ARCHITECTURE.md §7.
 *
 * The reason the Platform Owner can run BrandSpace without an engineering
 * release. Every operational value lives here, in versioned documents with a
 * lifecycle:
 *
 *   DRAFT -> VALIDATED -> ACTIVE -> SUPERSEDED
 *
 * Guarantees:
 *   - ATOMIC activation. Exactly one ACTIVE version per (domain, environment),
 *     enforced by a partial unique index, not merely by application logic.
 *   - IMMUTABLE history. Rollback activates a NEW version carrying an older
 *     payload; it never rewrites what was previously deployed.
 *   - OPTIMISTIC CONCURRENCY. An update must present the lockVersion it read,
 *     so two administrators editing the same draft cannot silently overwrite
 *     each other — the loser gets a conflict, not a lost edit.
 *   - ENVIRONMENT SEPARATION. development / staging / production have wholly
 *     independent version chains.
 *   - NO SECRETS. Payloads carry `secretRef` strings; values live in the Secret
 *     Service and are resolved server-side at point of use.
 */

export type Environment = 'DEVELOPMENT' | 'STAGING' | 'PRODUCTION';

export interface ConfigActor {
  readonly platformUserId: string;
  readonly roleKey: string;
  readonly mfaVerified: boolean;
  /**
   * The actor's resolved permissions. REQUIRED: this service is the
   * authorization boundary. A check that lives only in a page or a server
   * action is not a check — the action is a public HTTP endpoint.
   */
  readonly permissionKeys: readonly string[];
}

/** Viewing configuration and its version history. */
/**
 * The only domains ever projected into the tenant-readable catalogue.
 *
 * A set rather than a convention, mirrored by a CHECK constraint on the table,
 * so neither a future caller nor a direct write can put an operational or
 * integration payload where a customer can read it.
 */
const CUSTOMER_VISIBLE_DOMAINS = new Set([
  'entitlements',
  'plans',
  'feature-flags',
  // Phase 3. The credit POLICY — expiry windows, rollover, the hard stop — is
  // what the customer's own Plan & Usage page explains to them ("packs expire
  // after 12 months"). It carries no price, no provider and no other tenant's
  // data, so it is projected like the other three rather than being restated
  // in the dashboard where it could drift from the rule actually applied.
  'credits',
  // Phase 5. The Brand Brain OPERATIONAL policy — accepted file types, the
  // upload ceiling, the review interval, the chunking parameters and the D-78
  // retention window. Every one of them is something the customer's own screen
  // states or enforces: the upload control has to know what it may accept, and
  // the chat notice has to promise the window an owner actually set. Restating
  // them in the dashboard is what Phase 5A did, and a restated setting is a
  // second setting. It carries no provider, no model, no price and no
  // credential — see the schema in domains.ts.
  'brand-brain',
  // Phase 5B-1. The Asset Library OPERATIONAL policy — accepted media types per
  // kind, the size ceilings, the version and derivative bounds, the upload
  // session window, the download-grant window and the retention windows. The
  // customer upload control has to know what it may accept BEFORE it sends a
  // byte, and the library screen has to state the ceiling it is enforcing.
  // Restating them in the dashboard is what Phase 5A did, and a restated
  // setting is a second setting. It carries no provider, no model, no price and
  // no credential — the storage VENDOR lives in `integrations.storage`, and the
  // storage QUOTA in `plans`, neither of which is projected.
  'assets',
  // Phase 5B-2. The Content Studio policy the CUSTOMER's own screen states or
  // enforces: which dialects they may pick (D-115), which platforms a variant
  // may target and the character limit each imposes, the brief ceiling, and the
  // retention floor their own control is bounded by (D-117). The composer has
  // to know the limit BEFORE the caption is too long, and the settings screen
  // has to state the floor it is enforcing. Restating any of it in the
  // dashboard would be a second setting.
  'content',
  // Phase 6. The PUBLISHING policy the customer's own screens state and
  // enforce: which platforms can be connected at all, what each one accepts
  // (post kinds, character ceiling, media count, first comment, delete), the
  // retry schedule the publishing history explains, and the lateness tolerance
  // that decides whether a post goes out or waits. Capabilities are declared,
  // never assumed equal (docs/SOCIAL-INTEGRATIONS.md §1.7), and the UI is
  // generated from them — so an option a platform cannot do never appears
  // rather than failing at publish time.
  //
  // NO CREDENTIAL IS PROJECTED. App ids and secret refs live in
  // `integrations.social-apps`, which is deliberately NOT on this list.
  'publishing',
  /*
   * Phase 7. The ANALYTICS policy the customer's own screens state and enforce:
   * what "stale" means before a chart labels itself stale, the freshness window
   * a freshness badge is computed from, the export ceiling the export control
   * has to know BEFORE the customer picks a wider range, and the anomaly
   * threshold an anomaly card states so the customer can disagree with it.
   * Restating any of it in the dashboard would be a second setting that drifts
   * from the first (CLAUDE.md §2.2).
   *
   * NO CREDENTIAL AND NO PROVIDER IS PROJECTED. Analytics reads a CUSTOMER token
   * from `social_credential` on the worker; nothing about a credential is in
   * this document at all.
   */
  'analytics',
  /*
   * Phase 7. The COPILOT policy the customer's own panel states: the plan
   * ceiling, how long a confirmation stays valid (the panel counts it down), how
   * long the undo path is open (the panel offers it), and the conversation
   * retention the settings screen explains.
   *
   * THE CONFIRMATION REQUIREMENT IS NOT IN THIS DOCUMENT AT ALL — it is a CHECK
   * constraint on `copilot_action_plan`. A projected key that could switch it
   * off would put CLAUDE.md §2.5 within reach of an operator screen.
   */
  'copilot',
  /*
   * Phase 7. The AUTOMATION ceilings the rule editor states and enforces: how
   * many rules a brand may hold, the daily run ceiling a rule may set, and how
   * long a proposed external action waits for a person. The trigger, condition
   * and action registries are closed sets in code and are not configuration.
   */
  'automations',
]);

export const CONFIG_READ_PERMISSION = 'platform.configuration.read';
/** Drafting and editing. Does NOT grant deployment. */
export const CONFIG_MANAGE_PERMISSION = 'platform.configuration.manage';
/** Activation and rollback — the high-impact half, held separately. */
export const CONFIG_ACTIVATE_PERMISSION = 'platform.configuration.activate';

export interface ConfigVersionSummary {
  readonly id: string;
  readonly domain: string;
  readonly environment: Environment;
  readonly versionNumber: number;
  readonly status: string;
  readonly changeReason: string;
  readonly lockVersion: number;
  readonly createdAt: Date;
  readonly activatedAt: Date | null;
  readonly createdByPlatformUserId: string;
  readonly activatedByPlatformUserId: string | null;
  readonly validationReport: ValidationReport | null;
  readonly impactPreview: ImpactPreview | null;
}

/** Domains where activation is a financial change and needs dual control. */
// Phase 3 adds `credits`: expiry and rollover decide how much of a customer's
// balance survives a cycle, which is the same class of decision as a price.
const DUAL_CONTROL_DOMAINS = new Set<ConfigDomain>(['plans', 'ai.credit-rules', 'credits']);

function checksum(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * Why this actor may not perform the operation, or null when it may.
 *
 * The message names the operation and the missing permission — useful to an
 * operator and to the audit trail, and safe because it is derived from our own
 * constants, never from input. It also never reaches a browser verbatim: the
 * server actions map every failure to a fixed public code (see
 * `@brandspace/shared` `toPublicErrorCode`).
 */
function denialReason(actor: ConfigActor, operation: string, permission: string): string | null {
  if (!actor?.platformUserId) return `${operation} requires a platform actor.`;
  // D-27: every platform operation is a step-up action.
  if (!actor.mfaVerified) return `${operation} requires verified MFA (D-27).`;
  if (!actor.permissionKeys?.includes(permission)) {
    return `${operation} requires ${permission}.`;
  }
  return null;
}

export interface ConfigCache {
  get(key: string): unknown | undefined;
  set(key: string, value: unknown, ttlMs: number): void;
  invalidate(key: string): void;
  clear(): void;
}

/**
 * In-process cache with a short TTL. Activation invalidates the key directly, so
 * a change propagates immediately in this process; the TTL bounds staleness in
 * other processes until Redis pub/sub invalidation lands (F-10).
 */
export class InMemoryConfigCache implements ConfigCache {
  readonly #entries = new Map<string, { value: unknown; expiresAt: number }>();

  get(key: string): unknown | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.value;
  }
  set(key: string, value: unknown, ttlMs: number): void {
    this.#entries.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
  invalidate(key: string): void {
    this.#entries.delete(key);
  }
  clear(): void {
    this.#entries.clear();
  }
}

export interface ConfigurationServiceOptions {
  readonly prisma: PrismaClient;
  readonly cache?: ConfigCache;
  readonly cacheTtlMs?: number;
  /** Injected so activation timestamps and cache expiry are testable. */
  readonly clock?: Clock;
}

export class ConfigurationService {
  readonly #prisma: PrismaClient;
  readonly #cache: ConfigCache;
  readonly #ttl: number;
  readonly #clock: Clock;

  constructor(options: ConfigurationServiceOptions) {
    this.#prisma = options.prisma;
    this.#cache = options.cache ?? new InMemoryConfigCache();
    this.#ttl = options.cacheTtlMs ?? 30_000;
    this.#clock = options.clock ?? systemClock;
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /**
   * The typed accessor every module uses. Returns the ACTIVE payload, or the
   * domain's empty-but-valid default when nothing has been activated yet — so a
   * fresh installation behaves predictably instead of throwing.
   */
  async get<D extends ConfigDomain>(
    domain: D,
    environment: Environment,
  ): Promise<ConfigPayload<D>> {
    const cacheKey = `${domain}:${environment}`;
    const cached = this.#cache.get(cacheKey);
    if (cached !== undefined) return cached as ConfigPayload<D>;

    const active = await this.#prisma.configurationVersion.findFirst({
      where: { domain, environment, status: 'ACTIVE' },
    });

    const payload = active
      ? (CONFIG_DOMAINS[domain].schema.parse(active.payload) as ConfigPayload<D>)
      : defaultPayload(domain);

    this.#cache.set(cacheKey, payload, this.#ttl);
    return payload;
  }

  /** Every domain's active payload, for cross-domain semantic validation. */
  /**
   * The id of the ACTIVE version for one domain, or null when none is active.
   *
   * Deliberately uncached, unlike `get`. It is read when a subscription pins a
   * price, which happens once per plan assignment rather than per request, and
   * pinning a version id that a stale cache says is current would defeat the
   * point of recording it.
   */
  async activeVersionId(domain: ConfigDomain, environment: Environment): Promise<string | null> {
    const active = await this.#prisma.configurationVersion.findFirst({
      where: { domain, environment, status: 'ACTIVE' },
      select: { id: true },
    });
    return active?.id ?? null;
  }

  async getContext(environment: Environment): Promise<ConfigContext> {
    const rows = await this.#prisma.configurationVersion.findMany({
      where: { environment, status: 'ACTIVE' },
    });
    const context: ConfigContext = {};
    for (const row of rows) {
      const domain: string = row.domain;
      if (isConfigDomain(domain)) {
        context[domain] = row.payload as unknown;
      }
    }
    return context;
  }

  async listVersions(
    actor: ConfigActor,
    domain: ConfigDomain,
    environment: Environment,
  ): Promise<ConfigVersionSummary[]> {
    await this.#authorize(actor, 'Listing configuration versions', CONFIG_READ_PERMISSION);
    const rows = await this.#prisma.configurationVersion.findMany({
      where: { domain, environment },
      orderBy: { versionNumber: 'desc' },
    });
    return rows.map(toSummary);
  }

  async getVersion(
    actor: ConfigActor,
    versionId: string,
  ): Promise<ConfigVersionSummary & { payload: unknown }> {
    await this.#authorize(actor, 'Viewing a configuration version', CONFIG_READ_PERMISSION);
    const row = await this.#prisma.configurationVersion.findUnique({ where: { id: versionId } });
    if (!row) throw new AppError('NOT_FOUND', 'Configuration version not found');
    return { ...toSummary(row), payload: row.payload };
  }

  // -------------------------------------------------------------------------
  // Drafting
  // -------------------------------------------------------------------------

  /** Create a draft, seeded from the current active payload. */
  async createDraft(
    actor: ConfigActor,
    domain: ConfigDomain,
    environment: Environment,
    changeReason: string,
    payload?: unknown,
  ): Promise<ConfigVersionSummary> {
    await this.#authorize(actor, 'Creating a configuration draft', CONFIG_MANAGE_PERMISSION);
    if (!changeReason || changeReason.trim().length < 8) {
      throw new AppError(
        'VALIDATION_FAILED',
        'A change reason of at least 8 characters is required.',
      );
    }

    const latest = await this.#prisma.configurationVersion.findFirst({
      where: { domain, environment },
      orderBy: { versionNumber: 'desc' },
    });
    const active = await this.#prisma.configurationVersion.findFirst({
      where: { domain, environment, status: 'ACTIVE' },
    });

    const seed = payload ?? active?.payload ?? defaultPayload(domain);
    const created = await this.#prisma.configurationVersion.create({
      data: {
        domain,
        environment,
        versionNumber: (latest?.versionNumber ?? 0) + 1,
        schemaVersion: CONFIG_DOMAINS[domain].schemaVersion,
        payload: seed as never,
        payloadChecksum: checksum(seed),
        status: 'DRAFT',
        previousVersionId: active?.id ?? null,
        createdByPlatformUserId: actor.platformUserId,
        changeReason,
      },
    });
    await this.#audit(actor, 'config.draft.created', created.id, changeReason, {
      domain,
      environment,
      versionNumber: created.versionNumber,
    });
    return toSummary(created);
  }

  /**
   * Update a draft's payload.
   *
   * `expectedLockVersion` is the value the caller read. If it no longer matches,
   * another administrator saved in the meantime and this write is refused —
   * the whole point of optimistic concurrency.
   */
  async updateDraft(
    actor: ConfigActor,
    versionId: string,
    payload: unknown,
    expectedLockVersion: number,
  ): Promise<ConfigVersionSummary> {
    await this.#authorize(actor, 'Updating a configuration draft', CONFIG_MANAGE_PERMISSION);

    const existing = await this.#prisma.configurationVersion.findUnique({
      where: { id: versionId },
    });
    if (!existing) throw new AppError('NOT_FOUND', 'Configuration version not found');
    if (existing.status !== 'DRAFT' && existing.status !== 'VALIDATED') {
      throw new AppError(
        'CONFLICT',
        `Only a draft can be edited; this version is ${existing.status}. Create a new draft.`,
      );
    }

    // Conditional update: the WHERE clause carries the expected lockVersion, so
    // the check and the write are one atomic statement rather than a read
    // followed by a hopeful write.
    const result = await this.#prisma.configurationVersion.updateMany({
      where: { id: versionId, lockVersion: expectedLockVersion },
      data: {
        payload: payload as never,
        payloadChecksum: checksum(payload),
        status: 'DRAFT',
        // Editing invalidates any previous validation and impact preview: the
        // operator must re-run both before this can be activated. `DbNull`
        // rather than `undefined`, which under exactOptionalPropertyTypes means
        // "leave unchanged" and would keep a stale report attached.
        validationReport: Prisma.DbNull,
        impactPreview: Prisma.DbNull,
        lockVersion: { increment: 1 },
      },
    });

    if (result.count === 0) {
      throw new AppError(
        'CONFLICT',
        'This draft was changed by someone else since you loaded it. ' +
          'Reload to see their changes before saving, so neither edit is lost.',
        { expectedLockVersion, actualLockVersion: existing.lockVersion },
      );
    }

    const updated = await this.#prisma.configurationVersion.findUniqueOrThrow({
      where: { id: versionId },
    });
    return toSummary(updated);
  }

  /** Validate a draft and record the report. */
  async validateDraft(actor: ConfigActor, versionId: string): Promise<ValidationReport> {
    await this.#authorize(actor, 'Validating a configuration draft', CONFIG_MANAGE_PERMISSION);
    const version = await this.#prisma.configurationVersion.findUnique({
      where: { id: versionId },
    });
    if (!version) throw new AppError('NOT_FOUND', 'Configuration version not found');
    if (!isConfigDomain(version.domain)) {
      throw new AppError('VALIDATION_FAILED', `Unknown configuration domain: ${version.domain}`);
    }

    const context = await this.getContext(version.environment as Environment);
    const report = validateConfiguration(version.domain, version.payload, context);

    await this.#prisma.configurationVersion.update({
      where: { id: versionId },
      data: {
        validationReport: report as never,
        status: report.valid ? 'VALIDATED' : 'DRAFT',
      },
    });
    return report;
  }

  /** Compute and store the impact preview against the current active version. */
  async previewImpact(actor: ConfigActor, versionId: string): Promise<ImpactPreview> {
    await this.#authorize(actor, 'Previewing configuration impact', CONFIG_MANAGE_PERMISSION);
    const version = await this.#prisma.configurationVersion.findUnique({
      where: { id: versionId },
    });
    if (!version) throw new AppError('NOT_FOUND', 'Configuration version not found');
    if (!isConfigDomain(version.domain)) {
      throw new AppError('VALIDATION_FAILED', `Unknown configuration domain: ${version.domain}`);
    }

    const active = await this.#prisma.configurationVersion.findFirst({
      where: { domain: version.domain, environment: version.environment, status: 'ACTIVE' },
    });

    const diff = buildImpactPreview(
      version.domain,
      active?.payload ?? defaultPayload(version.domain),
      version.payload,
    );

    // AC-04.5. A plan change is previewed against who is actually ON those
    // plans, not just as a document diff — "12 would exceed their new brand
    // limit" is the sentence the owner needs before confirming.
    const preview =
      version.domain === 'plans'
        ? withAffectedWorkspaces(diff, version.payload, await this.#workspaceUsage())
        : diff;

    await this.#prisma.configurationVersion.update({
      where: { id: versionId },
      data: { impactPreview: preview as never },
    });
    return preview;
  }

  /**
   * Every workspace's current consumption, for the over-limit analysis.
   *
   * HONESTY NOTE. Only the dimensions that have real data are reported. Seats
   * are counted from active memberships, which exist. Brands, social accounts
   * and scheduled posts come from the usage counters, which are populated as
   * those features ship — until then a workspace simply is not reported against
   * those dimensions, rather than being reported as zero. A confident "nobody
   * is over their brand limit" derived from a table nothing writes to yet would
   * be worse than saying nothing.
   */
  async #workspaceUsage(): Promise<WorkspaceUsageSnapshot[]> {
    const workspaces = await this.#prisma.workspace.findMany({
      where: { deletedAt: null, planKey: { not: null } },
      select: {
        id: true,
        slug: true,
        planKey: true,
        _count: { select: { memberships: { where: { status: 'ACTIVE' } } } },
      },
    });
    if (workspaces.length === 0) return [];

    const counters = await this.#prisma.usageCounter.findMany({
      where: {
        workspaceId: { in: workspaces.map((w) => w.id) },
        periodEnd: { gt: this.#clock.now() },
      },
      select: { workspaceId: true, featureKey: true, usedValue: true },
    });

    const byWorkspace = new Map<string, Record<string, number>>();
    for (const counter of counters) {
      const dimension = USAGE_KEY_FOR_FEATURE[counter.featureKey];
      if (!dimension) continue;
      const bucket = byWorkspace.get(counter.workspaceId) ?? {};
      bucket[dimension] = counter.usedValue;
      byWorkspace.set(counter.workspaceId, bucket);
    }

    return workspaces.map((w) => ({
      workspaceId: w.id,
      slug: w.slug,
      planKey: w.planKey ?? '',
      usage: { seats: w._count.memberships, ...(byWorkspace.get(w.id) ?? {}) },
    }));
  }

  // -------------------------------------------------------------------------
  // Activation
  // -------------------------------------------------------------------------

  /**
   * Activate a version. Atomic: supersede the current active row and promote
   * this one inside a single transaction, so there is never a moment with zero
   * or two active versions.
   */
  async activate(
    actor: ConfigActor,
    versionId: string,
    options: { acknowledgeHighImpact?: boolean } = {},
  ): Promise<ConfigVersionSummary> {
    await this.#authorize(actor, 'Activating configuration', CONFIG_ACTIVATE_PERMISSION);

    const version = await this.#prisma.configurationVersion.findUnique({
      where: { id: versionId },
    });
    if (!version) throw new AppError('NOT_FOUND', 'Configuration version not found');
    if (!isConfigDomain(version.domain)) {
      throw new AppError('VALIDATION_FAILED', `Unknown configuration domain: ${version.domain}`);
    }
    if (version.status === 'ACTIVE') {
      throw new AppError('CONFLICT', 'This version is already active.');
    }
    if (version.status === 'SUPERSEDED' || version.status === 'DISCARDED') {
      throw new AppError(
        'CONFLICT',
        `A ${version.status.toLowerCase()} version cannot be activated. Roll back to it instead, ` +
          'which creates a new version carrying its payload.',
      );
    }

    // Re-validate at activation time: the world may have changed since the
    // draft was validated — a model it routes to could have been disabled.
    const context = await this.getContext(version.environment as Environment);
    const report = validateConfiguration(version.domain, version.payload, context);
    if (!report.valid) {
      throw new AppError(
        'VALIDATION_FAILED',
        'Configuration is not valid and cannot be activated.',
        {
          errorCount: report.issues.filter((i) => i.severity === 'error').length,
        },
      );
    }

    const preview = buildImpactPreview(
      version.domain,
      (
        await this.#prisma.configurationVersion.findFirst({
          where: { domain: version.domain, environment: version.environment, status: 'ACTIVE' },
        })
      )?.payload ?? defaultPayload(version.domain),
      version.payload,
    );

    if (preview.highImpactCount > 0 && !options.acknowledgeHighImpact) {
      throw new AppError(
        'CONFLICT',
        `This activation has ${preview.highImpactCount} high-impact change(s) and must be ` +
          'explicitly acknowledged.',
        { highImpactCount: preview.highImpactCount },
      );
    }

    // Separation of duties on financial domains (docs/SECURITY.md §4.4).
    if (
      DUAL_CONTROL_DOMAINS.has(version.domain) &&
      version.createdByPlatformUserId === actor.platformUserId &&
      actor.roleKey !== 'platform_owner'
    ) {
      throw new AppError(
        'FORBIDDEN',
        'Financial configuration requires dual control: the person who drafted it may not ' +
          'activate it. Ask the Platform Owner to review and activate.',
      );
    }

    const now = this.#clock.now();
    const activated = await this.#prisma.$transaction(async (tx) => {
      await tx.configurationVersion.updateMany({
        where: { domain: version.domain, environment: version.environment, status: 'ACTIVE' },
        data: { status: 'SUPERSEDED', deactivatedAt: now },
      });
      const row = await tx.configurationVersion.update({
        where: { id: versionId },
        data: {
          status: 'ACTIVE',
          activatedAt: now,
          activatedByPlatformUserId: actor.platformUserId,
          validationReport: report as never,
          impactPreview: preview as never,
        },
      });

      // Project the three customer-relevant domains into the tenant-readable
      // catalogue snapshot, in the SAME transaction as the activation, so the
      // two can never disagree.
      //
      // `configuration_version` stays platform-owned with every privilege
      // revoked from the tenant role. The customer application resolves its own
      // entitlements from this projection instead, which carries feature keys,
      // plan keys, limits and flag rules — and none of the `integrations.*` or
      // `operations` payloads that are no customer's business.
      if (CUSTOMER_VISIBLE_DOMAINS.has(version.domain)) {
        await tx.entitlementCatalogueSnapshot.upsert({
          where: {
            domain_environment: { domain: version.domain, environment: version.environment },
          },
          create: {
            domain: version.domain,
            environment: version.environment,
            payload: version.payload as never,
            sourceVersionId: row.id,
          },
          update: { payload: version.payload as never, sourceVersionId: row.id },
        });
      }
      return row;
    });

    this.#cache.invalidate(`${version.domain}:${version.environment}`);
    await this.#audit(actor, 'config.activated', versionId, version.changeReason, {
      domain: version.domain,
      environment: version.environment,
      versionNumber: version.versionNumber,
      highImpactCount: preview.highImpactCount,
    });
    return toSummary(activated);
  }

  /**
   * Roll back to a previous version.
   *
   * Creates a NEW version whose payload equals the old one and activates it.
   * History is never rewritten — docs/ARCHITECTURE.md §7.2.
   */
  async rollback(
    actor: ConfigActor,
    targetVersionId: string,
    reason: string,
  ): Promise<ConfigVersionSummary> {
    await this.#authorize(actor, 'Rolling back configuration', CONFIG_ACTIVATE_PERMISSION);
    if (!reason || reason.trim().length < 8) {
      throw new AppError(
        'VALIDATION_FAILED',
        'A rollback reason of at least 8 characters is required.',
      );
    }

    const target = await this.#prisma.configurationVersion.findUnique({
      where: { id: targetVersionId },
    });
    if (!target) throw new AppError('NOT_FOUND', 'Configuration version not found');
    if (!isConfigDomain(target.domain)) {
      throw new AppError('VALIDATION_FAILED', `Unknown configuration domain: ${target.domain}`);
    }

    const latest = await this.#prisma.configurationVersion.findFirst({
      where: { domain: target.domain, environment: target.environment },
      orderBy: { versionNumber: 'desc' },
    });

    const created = await this.#prisma.configurationVersion.create({
      data: {
        domain: target.domain,
        environment: target.environment,
        versionNumber: (latest?.versionNumber ?? 0) + 1,
        schemaVersion: target.schemaVersion,
        payload: target.payload as never,
        payloadChecksum: target.payloadChecksum,
        status: 'VALIDATED',
        rollbackOfVersionId: target.id,
        createdByPlatformUserId: actor.platformUserId,
        changeReason: `Rollback to v${target.versionNumber}: ${reason}`,
      },
    });

    // A rollback is by definition returning to a known-good state, so its
    // high-impact changes are pre-acknowledged.
    return this.activate(actor, created.id, { acknowledgeHighImpact: true });
  }

  async discardDraft(actor: ConfigActor, versionId: string, reason: string): Promise<void> {
    await this.#authorize(actor, 'Discarding a configuration draft', CONFIG_MANAGE_PERMISSION);
    const version = await this.#prisma.configurationVersion.findUnique({
      where: { id: versionId },
    });
    if (!version) throw new AppError('NOT_FOUND', 'Configuration version not found');
    if (version.status === 'ACTIVE') {
      throw new AppError('CONFLICT', 'The active version cannot be discarded.');
    }
    await this.#prisma.configurationVersion.update({
      where: { id: versionId },
      data: { status: 'DISCARDED' },
    });
    await this.#audit(actor, 'config.draft.discarded', versionId, reason, {
      domain: version.domain,
      environment: version.environment,
    });
  }

  /** Test seam and cache-invalidation hook for `config.activated` events. */
  invalidateCache(domain?: ConfigDomain, environment?: Environment): void {
    if (domain && environment) this.#cache.invalidate(`${domain}:${environment}`);
    else this.#cache.clear();
  }

  /**
   * The authorization boundary for this service.
   *
   * Async because a denial is audited: repeated refusals are a detection
   * signal, and an operator who tried something they may not do is exactly what
   * a platform audit log is for.
   */
  async #authorize(actor: ConfigActor, operation: string, permission: string): Promise<void> {
    const denial = denialReason(actor, operation, permission);
    if (denial === null) return;

    if (actor?.platformUserId) {
      await this.#prisma.auditEvent
        .create({
          data: {
            workspaceId: null,
            actorType: 'PLATFORM_USER',
            actorId: actor.platformUserId,
            action: 'config.access.denied',
            resourceType: 'configuration_version',
            severity: 'WARNING',
            outcome: 'DENIED',
            // The permission and the operation — never the payload the caller
            // was trying to write.
            reason: denial,
          },
        })
        .catch(() => {
          // A failed audit write must not turn a denial into anything else.
          // Unlike the rate-limit counter, this cannot fail open: the throw
          // below happens regardless.
        });
    }

    throw new AppError('FORBIDDEN', denial);
  }

  async #audit(
    actor: ConfigActor,
    action: string,
    resourceId: string,
    reason: string,
    after: Record<string, unknown>,
  ): Promise<void> {
    await this.#prisma.auditEvent.create({
      data: {
        workspaceId: null,
        actorType: 'PLATFORM_USER',
        actorId: actor.platformUserId,
        action,
        resourceType: 'configuration_version',
        resourceId,
        severity: action === 'config.activated' ? 'WARNING' : 'NOTICE',
        outcome: 'SUCCESS',
        reason,
        after: after as never,
      },
    });
  }
}

interface VersionRow {
  id: string;
  domain: string;
  environment: string;
  versionNumber: number;
  status: string;
  changeReason: string;
  lockVersion: number;
  createdAt: Date;
  activatedAt: Date | null;
  createdByPlatformUserId: string;
  activatedByPlatformUserId: string | null;
  validationReport: unknown;
  impactPreview: unknown;
}

function toSummary(row: VersionRow): ConfigVersionSummary {
  return {
    id: row.id,
    domain: row.domain,
    environment: row.environment as Environment,
    versionNumber: row.versionNumber,
    status: row.status,
    changeReason: row.changeReason,
    lockVersion: row.lockVersion,
    createdAt: row.createdAt,
    activatedAt: row.activatedAt,
    createdByPlatformUserId: row.createdByPlatformUserId,
    activatedByPlatformUserId: row.activatedByPlatformUserId,
    validationReport: (row.validationReport as ValidationReport | null) ?? null,
    impactPreview: (row.impactPreview as ImpactPreview | null) ?? null,
  };
}

/**
 * Quota feature key -> the usage dimension the impact preview compares against.
 *
 * Mirrors the projection in `@brandspace/entitlements`. It is repeated here
 * rather than imported because `packages/config` may not depend on
 * `packages/entitlements` — that edge would be a cycle, since the entitlement
 * service reads its catalogue from this service.
 */
const USAGE_KEY_FOR_FEATURE: Readonly<Record<string, string>> = {
  'limit.seats': 'seats',
  'limit.brands': 'brands',
  'limit.social_accounts': 'socialAccounts',
  'limit.scheduled_posts': 'scheduledPostsPerMonth',
  'limit.storage_gb': 'storageGb',
};
