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
import { buildImpactPreview, type ImpactPreview } from './impact';
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
const CUSTOMER_VISIBLE_DOMAINS = new Set(['entitlements', 'plans', 'feature-flags']);

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
const DUAL_CONTROL_DOMAINS = new Set<ConfigDomain>(['plans', 'ai.credit-rules']);

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

    const preview = buildImpactPreview(
      version.domain,
      active?.payload ?? defaultPayload(version.domain),
      version.payload,
    );
    await this.#prisma.configurationVersion.update({
      where: { id: versionId },
      data: { impactPreview: preview as never },
    });
    return preview;
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
