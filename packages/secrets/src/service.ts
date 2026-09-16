// The client TYPE comes from @brandspace/database, which is the only package
// permitted to import @prisma/client directly (docs/ARCHITECTURE.md §4.1).
// `Prisma` comes through the same approved seam — `packages/database` is the
// only package permitted to import `@prisma/client` directly, and it re-exports
// the namespace precisely so other packages can name Prisma's own types without
// crossing that boundary.
import type { Prisma, PrismaClient } from '@brandspace/database';
import { AppError, systemClock, type Clock } from '@brandspace/shared';
import {
  buildEncryptionContext,
  createKeyProvider,
  decryptSecret,
  encryptSecret,
  fingerprintValue,
  PLATFORM_SECRET_DOMAIN,
  type KeyProvider,
} from '@brandspace/vault';
import { isSecretCategory, type SecretCategory } from './categories';

/**
 * Secret Service.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE: a stored secret value never comes
 * back out except inside `resolveSecret()`, which is called by an integration
 * adapter immediately before handing the value to a provider SDK.
 *
 * Every other method returns `SecretMetadata` — masked hint, fingerprint,
 * timestamps, status — and there is deliberately no "reveal" operation
 * anywhere in the service, the API, or the UI (docs/SECURITY.md §5.1 rule 5).
 */

export type Environment = 'DEVELOPMENT' | 'STAGING' | 'PRODUCTION';

/** The ONLY shape ever returned to a caller outside the integration boundary. */
export interface SecretMetadata {
  readonly id: string;
  readonly ref: string;
  readonly name: string;
  readonly category: SecretCategory;
  readonly environment: Environment;
  readonly status: string;
  readonly description: string | null;
  /** At most the last four characters. Never the value. */
  readonly maskedHint: string | null;
  /** Non-reversible; lets an operator confirm "same key" without decrypting. */
  readonly fingerprint: string | null;
  readonly activeVersion: number | null;
  readonly createdAt: Date;
  readonly lastRotatedAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly expiresAt: Date | null;
}

/**
 * The pagination contract — F-53.
 *
 * Offset-based rather than cursor-based, deliberately. The Control Center needs
 * a total, a current range and page navigation; a cursor gives none of those
 * without a separate count anyway, and an operator auditing platform
 * credentials wants to know there are 853 of them, not merely that there are
 * more.
 */
export interface SecretListQuery {
  readonly environment?: Environment;
  readonly category?: string;
  /** Free text over name and ref, case-insensitive. Blank means no filter. */
  readonly search?: string;
  /** 1-based. Out of range is clamped, never an error — see `listSecrets`. */
  readonly page?: number;
  readonly pageSize?: number;
}

export interface SecretPage {
  /** Masked metadata only. Never a value, ciphertext or key material. */
  readonly items: readonly SecretMetadata[];
  /** The page ACTUALLY returned, which may differ from the one requested. */
  readonly page: number;
  readonly pageSize: number;
  /** Total matching records, not the number on this page. */
  readonly total: number;
  readonly totalPages: number;
  /** 1-based inclusive range of `items` within `total`. Both 0 when empty. */
  readonly from: number;
  readonly to: number;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
}

/** Page sizes the Control Center offers. */
export const SECRET_PAGE_SIZES = [10, 25, 50, 100] as const;
export const DEFAULT_SECRET_PAGE_SIZE = 25;
/** A bound on one request's result set, NOT on how much an operator may see. */
export const MAX_SECRET_PAGE_SIZE = 100;

export interface SecretActor {
  readonly platformUserId: string;
  readonly roleKey: string;
  readonly mfaVerified: boolean;
  /**
   * The actor's resolved permissions. REQUIRED: the service is the
   * authorization boundary, not the page that called it. A server action is a
   * public HTTP endpoint, so a check that lives only in the UI layer is not a
   * check at all.
   */
  readonly permissionKeys: readonly string[];
}

/** Viewing masked metadata. Never a value — no permission grants that. */
export const SECRET_READ_PERMISSION = 'platform.secret.read';
/** Creating, rotating, disabling, enabling or revoking a secret. */
export const SECRET_MANAGE_PERMISSION = 'platform.secret.manage';

export interface SecretServiceOptions {
  readonly prisma: PrismaClient;
  readonly keyProvider?: KeyProvider;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Injected so expiry can be tested without waiting for a real expiry date,
   * and so rotation timestamps are deterministic in tests.
   */
  readonly clock?: Clock;
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
function denialReason(actor: SecretActor, operation: string, permission: string): string | null {
  if (!actor?.platformUserId) return `${operation} requires a platform actor.`;
  // D-27: every platform operation is a step-up action.
  if (!actor.mfaVerified) return `${operation} requires verified MFA (D-27).`;
  if (!actor.permissionKeys?.includes(permission)) {
    return `${operation} requires ${permission}.`;
  }
  return null;
}

export class SecretService {
  readonly #prisma: PrismaClient;
  readonly #keyProvider: KeyProvider;
  readonly #clock: Clock;

  constructor(options: SecretServiceOptions) {
    this.#prisma = options.prisma;
    this.#clock = options.clock ?? systemClock;
    // Fails closed when encryption is unconfigured — the service cannot be
    // constructed at all, rather than degrading to plaintext.
    this.#keyProvider =
      options.keyProvider ?? createKeyProvider(options.env, PLATFORM_SECRET_DOMAIN);
  }

  /** Create a secret and its first version, in one transaction. */
  async createSecret(
    actor: SecretActor,
    input: {
      ref: string;
      name: string;
      category: string;
      environment: Environment;
      value: string;
      description?: string;
      expiresAt?: Date;
    },
  ): Promise<SecretMetadata> {
    await this.#authorize(actor, 'Creating a secret', SECRET_MANAGE_PERMISSION);
    if (!isSecretCategory(input.category)) {
      throw new AppError('VALIDATION_FAILED', `Unknown secret category: ${input.category}`);
    }
    if (!input.value || input.value.trim() === '') {
      throw new AppError('VALIDATION_FAILED', 'A secret value is required.');
    }

    const existing = await this.#prisma.secretRecord.findUnique({
      where: { ref_environment: { ref: input.ref, environment: input.environment } },
    });
    if (existing) {
      throw new AppError(
        'CONFLICT',
        `A secret with ref "${input.ref}" already exists in ${input.environment}. Rotate it instead.`,
      );
    }

    const context = buildEncryptionContext({
      ref: input.ref,
      environment: input.environment,
      version: 1,
    });
    const material = await encryptSecret(input.value, context, this.#keyProvider);

    const record = await this.#prisma.$transaction(async (tx) => {
      const created = await tx.secretRecord.create({
        data: {
          ref: input.ref,
          name: input.name,
          category: input.category,
          environment: input.environment,
          description: input.description ?? null,
          expiresAt: input.expiresAt ?? null,
          status: 'ACTIVE',
          createdByPlatformUserId: actor.platformUserId,
        },
      });

      await tx.secretVersion.create({
        data: {
          secretRecordId: created.id,
          version: 1,
          status: 'ACTIVE',
          activatedAt: this.#clock.now(),
          createdByPlatformUserId: actor.platformUserId,
          ...material,
        },
      });

      // Audit carries the ref and actor — never the value, never the ciphertext.
      await tx.auditEvent.create({
        data: {
          workspaceId: null,
          actorType: 'PLATFORM_USER',
          actorId: actor.platformUserId,
          action: 'secret.created',
          resourceType: 'secret',
          resourceId: created.id,
          severity: 'NOTICE',
          outcome: 'SUCCESS',
          reason: `Created secret ${input.ref} in ${input.environment}`,
          after: {
            ref: input.ref,
            category: input.category,
            environment: input.environment,
            maskedHint: material.maskedHint,
            fingerprint: material.fingerprint,
          },
        },
      });

      return created;
    });

    return this.#readSecret(record.id);
  }

  /**
   * Rotate: create a new version and retire the previous one.
   *
   * Zero-downtime where the provider allows it — the new version is written and
   * activated in the same transaction that retires the old one, so there is
   * never a moment with no active version, and never two.
   */
  async rotateSecret(
    actor: SecretActor,
    secretId: string,
    newValue: string,
    reason: string,
  ): Promise<SecretMetadata> {
    await this.#authorize(actor, 'Rotating a secret', SECRET_MANAGE_PERMISSION);
    if (!reason || reason.trim().length < 8) {
      throw new AppError('FORBIDDEN', 'Rotating a secret requires a written reason.');
    }

    const record = await this.#prisma.secretRecord.findUnique({
      where: { id: secretId },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
    });
    if (!record) throw new AppError('NOT_FOUND', 'Secret not found');
    if (record.status === 'REVOKED') {
      throw new AppError('CONFLICT', 'A revoked secret cannot be rotated.');
    }

    const nextVersion = (record.versions[0]?.version ?? 0) + 1;
    const context = buildEncryptionContext({
      ref: record.ref,
      environment: record.environment,
      version: nextVersion,
    });
    const material = await encryptSecret(newValue, context, this.#keyProvider);

    await this.#prisma.$transaction(async (tx) => {
      await tx.secretVersion.updateMany({
        where: { secretRecordId: record.id, status: 'ACTIVE' },
        data: { status: 'RETIRED', retiredAt: this.#clock.now() },
      });
      await tx.secretVersion.create({
        data: {
          secretRecordId: record.id,
          version: nextVersion,
          status: 'ACTIVE',
          activatedAt: this.#clock.now(),
          createdByPlatformUserId: actor.platformUserId,
          ...material,
        },
      });
      await tx.secretRecord.update({
        where: { id: record.id },
        data: { status: 'ACTIVE', lastRotatedAt: this.#clock.now() },
      });
      await tx.auditEvent.create({
        data: {
          workspaceId: null,
          actorType: 'PLATFORM_USER',
          actorId: actor.platformUserId,
          action: 'secret.rotated',
          resourceType: 'secret',
          resourceId: record.id,
          severity: 'WARNING',
          outcome: 'SUCCESS',
          reason,
          after: { ref: record.ref, version: nextVersion, maskedHint: material.maskedHint },
        },
      });
    });

    return this.#readSecret(record.id);
  }

  /** Disable: the secret stops resolving but its material is retained. */
  async disableSecret(
    actor: SecretActor,
    secretId: string,
    reason: string,
  ): Promise<SecretMetadata> {
    await this.#authorize(actor, 'Disabling a secret', SECRET_MANAGE_PERMISSION);
    if (!reason || reason.trim().length < 8) {
      throw new AppError('FORBIDDEN', 'Disabling a secret requires a written reason.');
    }
    await this.#prisma.$transaction(async (tx) => {
      await tx.secretRecord.update({
        where: { id: secretId },
        data: { status: 'DISABLED', disabledAt: this.#clock.now() },
      });
      await tx.auditEvent.create({
        data: {
          workspaceId: null,
          actorType: 'PLATFORM_USER',
          actorId: actor.platformUserId,
          action: 'secret.disabled',
          resourceType: 'secret',
          resourceId: secretId,
          severity: 'WARNING',
          outcome: 'SUCCESS',
          reason,
        },
      });
    });
    return this.#readSecret(secretId);
  }

  async enableSecret(
    actor: SecretActor,
    secretId: string,
    reason: string,
  ): Promise<SecretMetadata> {
    await this.#authorize(actor, 'Enabling a secret', SECRET_MANAGE_PERMISSION);
    const record = await this.#prisma.secretRecord.findUnique({ where: { id: secretId } });
    if (!record) throw new AppError('NOT_FOUND', 'Secret not found');
    if (record.status === 'REVOKED') {
      throw new AppError('CONFLICT', 'A revoked secret cannot be re-enabled. Create a new one.');
    }
    await this.#prisma.$transaction(async (tx) => {
      await tx.secretRecord.update({
        where: { id: secretId },
        data: { status: 'ACTIVE', disabledAt: null },
      });
      await tx.auditEvent.create({
        data: {
          workspaceId: null,
          actorType: 'PLATFORM_USER',
          actorId: actor.platformUserId,
          action: 'secret.enabled',
          resourceType: 'secret',
          resourceId: secretId,
          severity: 'NOTICE',
          outcome: 'SUCCESS',
          reason,
        },
      });
    });
    return this.#readSecret(secretId);
  }

  /** Revoke: permanent. The secret can never resolve again. */
  async revokeSecret(
    actor: SecretActor,
    secretId: string,
    reason: string,
  ): Promise<SecretMetadata> {
    await this.#authorize(actor, 'Revoking a secret', SECRET_MANAGE_PERMISSION);
    if (!reason || reason.trim().length < 8) {
      throw new AppError('FORBIDDEN', 'Revoking a secret requires a written reason.');
    }
    await this.#prisma.$transaction(async (tx) => {
      await tx.secretVersion.updateMany({
        where: { secretRecordId: secretId },
        data: { status: 'REVOKED' },
      });
      await tx.secretRecord.update({
        where: { id: secretId },
        data: { status: 'REVOKED', revokedAt: this.#clock.now() },
      });
      await tx.auditEvent.create({
        data: {
          workspaceId: null,
          actorType: 'PLATFORM_USER',
          actorId: actor.platformUserId,
          action: 'secret.revoked',
          resourceType: 'secret',
          resourceId: secretId,
          severity: 'CRITICAL',
          outcome: 'SUCCESS',
          reason,
        },
      });
    });
    return this.#readSecret(secretId);
  }

  async getSecret(actor: SecretActor, secretId: string): Promise<SecretMetadata> {
    await this.#authorize(actor, 'Viewing secret metadata', SECRET_READ_PERMISSION);
    return this.#readSecret(secretId);
  }

  /**
   * The authorization boundary for this service.
   *
   * Async because a denial is audited. An attempt to touch a credential without
   * the permission for it is precisely the event an operator wants to see.
   */
  async #authorize(actor: SecretActor, operation: string, permission: string): Promise<void> {
    const denial = denialReason(actor, operation, permission);
    if (denial === null) return;

    if (actor?.platformUserId) {
      await this.#prisma.auditEvent
        .create({
          data: {
            workspaceId: null,
            actorType: 'PLATFORM_USER',
            actorId: actor.platformUserId,
            action: 'secret.access.denied',
            resourceType: 'secret',
            severity: 'WARNING',
            outcome: 'DENIED',
            // Operation and permission only. The value the caller submitted is
            // never written anywhere, denied or not.
            reason: denial,
          },
        })
        .catch(() => {
          // A failed audit write must not turn a denial into anything else; the
          // throw below happens regardless, so this cannot fail open.
        });
    }

    throw new AppError('FORBIDDEN', denial);
  }

  /** Internal read with no permission check — every caller above has one. */
  async #readSecret(secretId: string): Promise<SecretMetadata> {
    const record = await this.#prisma.secretRecord.findUnique({
      where: { id: secretId },
      include: { versions: { where: { status: 'ACTIVE' }, take: 1 } },
    });
    if (!record) throw new AppError('NOT_FOUND', 'Secret not found');
    return toMetadata(record);
  }

  /**
   * One PAGE of secrets — F-53.
   *
   * This method used to return every matching record. That is what the Control
   * Center rendered, and with 853 records accumulated in a long-lived database
   * the page took long enough to blow a ten-second test ceiling. The query was
   * never the problem (3.8ms); loading and rendering an unbounded result set
   * was.
   *
   * TWO BOUNDED QUERIES, never the whole table:
   *
   *   1. `count` over the filter — reads an index, returns a number.
   *   2. `findMany` with `skip`/`take` — reads at most `pageSize` rows.
   *
   * ORDERING IS TOTAL. `[category, name, id]` — the `id` tie-breaker is what
   * makes offset pagination correct: with a partial order, two records sharing
   * a category and name could swap between the count and the fetch, and a row
   * would appear on two pages or on none.
   *
   * OUT-OF-RANGE RECOVERS RATHER THAN FAILING. A page beyond the end returns
   * the LAST page and says so in `page`, so a stale bookmark or a deleted-down
   * dataset shows something useful instead of an error or an empty table. The
   * caller renders the page it is given, not the page it asked for.
   *
   * `pageSize` IS CAPPED, AND THAT IS NOT A DISPLAY CAP. The bound is on how
   * many rows one request may materialise — a crafted URL cannot ask for a
   * million. Every record stays reachable by paging and `total` always reports
   * the true count, so nothing is hidden; the requirement F-53 records is that
   * an operator must never silently stop seeing secrets, and they never do.
   */
  async listSecrets(actor: SecretActor, query: SecretListQuery = {}): Promise<SecretPage> {
    // Even masked metadata is operational intelligence: which providers are
    // wired up, when a key was last rotated, which environments are live.
    await this.#authorize(actor, 'Listing secrets', SECRET_READ_PERMISSION);

    const pageSize = normalisePageSize(query.pageSize);
    const where = buildSecretWhere(query);

    const total = await this.#prisma.secretRecord.count({ where });
    const totalPages = total === 0 ? 1 : Math.ceil(total / pageSize);
    const requested = Number.isFinite(query.page) ? Math.trunc(query.page ?? 1) : 1;
    const page = Math.min(Math.max(requested, 1), totalPages);

    const records = await this.#prisma.secretRecord.findMany({
      where,
      include: { versions: { where: { status: 'ACTIVE' }, take: 1 } },
      // The `id` tie-breaker makes the order total. Without it the page
      // boundaries are undefined for records that agree on category and name.
      orderBy: [{ category: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    const items = records.map(toMetadata);
    return {
      items,
      page,
      pageSize,
      total,
      totalPages,
      // 1-based and inclusive, so the UI can render them directly. Both are 0
      // for an empty result: "showing 1–0 of 0" would be nonsense.
      from: total === 0 ? 0 : (page - 1) * pageSize + 1,
      to: total === 0 ? 0 : (page - 1) * pageSize + items.length,
      hasPrevious: page > 1,
      hasNext: page < totalPages,
    };
  }

  /**
   * How many secrets match — without loading any of them.
   *
   * The console overview needs a NUMBER for its stat tile and was calling
   * `listSecrets` to take `.length` of it, which is the F-53 defect in its
   * purest form: every row read, every version joined, to render one integer.
   */
  async countSecrets(actor: SecretActor, query: SecretListQuery = {}): Promise<number> {
    await this.#authorize(actor, 'Counting secrets', SECRET_READ_PERMISSION);
    return this.#prisma.secretRecord.count({ where: buildSecretWhere(query) });
  }

  /**
   * Resolve a secret to its plaintext value.
   *
   * ============================ THE ONLY DECRYPT PATH ========================
   * Call this ONLY from inside a server-side integration adapter, immediately
   * before handing the value to a provider SDK. Never log the result, never
   * return it from an API, never put it in a template or an error.
   * ===========================================================================
   *
   * Deliberately takes NO actor. This is a SYSTEM path, not an operator one:
   * its callers are the MFA step (which runs before any actor exists) and
   * provider adapters acting on their own behalf. Adding an operator permission
   * here would be theatre — there is no operator — and would break sign-in.
   * The control that matters is that nothing reachable from a browser calls it:
   * `@brandspace/secrets` is a restricted module (docs/ARCHITECTURE.md §4.1a).
   */
  async resolveSecret(ref: string, environment: Environment): Promise<string> {
    const record = await this.#prisma.secretRecord.findUnique({
      where: { ref_environment: { ref, environment } },
      include: { versions: { where: { status: 'ACTIVE' }, take: 1 } },
    });

    if (!record) {
      throw new AppError('NOT_FOUND', `No secret configured for "${ref}" in ${environment}.`);
    }
    if (record.status !== 'ACTIVE') {
      throw new AppError(
        'FORBIDDEN',
        `Secret "${ref}" is ${record.status.toLowerCase()} and cannot be used.`,
      );
    }
    if (record.expiresAt && record.expiresAt.getTime() < this.#clock.now().getTime()) {
      throw new AppError('FORBIDDEN', `Secret "${ref}" expired and must be rotated.`);
    }

    const version = record.versions[0];
    if (!version) {
      throw new AppError('INTERNAL', `Secret "${ref}" has no active version.`);
    }

    const value = await decryptSecret(version, this.#keyProvider);

    // Usage tracking proves an old version is safe to retire during rotation.
    await this.#prisma.secretRecord
      .update({ where: { id: record.id }, data: { lastUsedAt: this.#clock.now() } })
      .catch(() => {
        // Never fail a provider call because usage tracking failed.
      });

    return value;
  }

  /** Compare a candidate against the stored fingerprint without decrypting. */
  async matchesStoredValue(
    actor: SecretActor,
    secretId: string,
    candidate: string,
  ): Promise<boolean> {
    // An unauthenticated oracle here would let anyone confirm a guessed key.
    await this.#authorize(actor, 'Comparing a secret fingerprint', SECRET_READ_PERMISSION);
    const record = await this.#prisma.secretRecord.findUnique({
      where: { id: secretId },
      include: { versions: { where: { status: 'ACTIVE' }, take: 1 } },
    });
    const version = record?.versions[0];
    if (!record || !version) return false;
    return fingerprintValue(candidate, version.encryptionContext) === version.fingerprint;
  }
}

interface RecordWithVersions {
  id: string;
  ref: string;
  name: string;
  category: string;
  environment: string;
  status: string;
  description: string | null;
  createdAt: Date;
  lastRotatedAt: Date | null;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  versions: { version: number; maskedHint: string; fingerprint: string }[];
}

/**
 * Clamp a requested page size into the supported range.
 *
 * A non-numeric, zero or negative size falls back to the default rather than
 * throwing: this value arrives from a URL an operator can edit, and a broken
 * query string should show the list, not an error page.
 */
function normalisePageSize(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_SECRET_PAGE_SIZE;
  const size = Math.trunc(requested);
  if (size < 1) return DEFAULT_SECRET_PAGE_SIZE;
  return Math.min(size, MAX_SECRET_PAGE_SIZE);
}

/**
 * The filter, shared by the page query and the count.
 *
 * Built once so the two cannot disagree — a count computed over a different
 * predicate than the fetch produces a total that does not match the rows, and
 * "showing 1–25 of 40" would be a lie.
 *
 * The search is server-side. Filtering in the page component would mean
 * shipping every row to filter it, which is the defect this exists to remove.
 */
function buildSecretWhere(query: SecretListQuery): Prisma.SecretRecordWhereInput {
  const search = query.search?.trim();
  return {
    ...(query.environment ? { environment: query.environment } : {}),
    ...(query.category ? { category: query.category } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' as const } },
            { ref: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };
}

function toMetadata(record: RecordWithVersions): SecretMetadata {
  const active = record.versions[0];
  return {
    id: record.id,
    ref: record.ref,
    name: record.name,
    category: record.category as SecretCategory,
    environment: record.environment as Environment,
    status: record.status,
    description: record.description,
    maskedHint: active?.maskedHint ?? null,
    fingerprint: active?.fingerprint ?? null,
    activeVersion: active?.version ?? null,
    createdAt: record.createdAt,
    lastRotatedAt: record.lastRotatedAt,
    lastUsedAt: record.lastUsedAt,
    expiresAt: record.expiresAt,
  };
}
