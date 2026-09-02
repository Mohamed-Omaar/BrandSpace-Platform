// The client TYPE comes from @brandspace/database, which is the only package
// permitted to import @prisma/client directly (docs/ARCHITECTURE.md §4.1).
import type { PrismaClient } from '@brandspace/database';
import { AppError, systemClock, type Clock } from '@brandspace/shared';
import { buildEncryptionContext, decryptSecret, encryptSecret, fingerprintValue } from './crypto';
import { createKeyProvider, type KeyProvider } from './key-provider';
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

export interface SecretActor {
  readonly platformUserId: string;
  readonly roleKey: string;
  readonly mfaVerified: boolean;
}

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

function assertActor(actor: SecretActor, operation: string): void {
  if (!actor?.platformUserId) {
    throw new AppError('FORBIDDEN', `${operation} requires a platform actor.`);
  }
  // D-27: every secret operation is a step-up action.
  if (!actor.mfaVerified) {
    throw new AppError('FORBIDDEN', `${operation} requires verified MFA (D-27).`);
  }
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
    this.#keyProvider = options.keyProvider ?? createKeyProvider(options.env);
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
    assertActor(actor, 'Creating a secret');
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

    return this.getSecret(record.id);
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
    assertActor(actor, 'Rotating a secret');
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

    return this.getSecret(record.id);
  }

  /** Disable: the secret stops resolving but its material is retained. */
  async disableSecret(
    actor: SecretActor,
    secretId: string,
    reason: string,
  ): Promise<SecretMetadata> {
    assertActor(actor, 'Disabling a secret');
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
    return this.getSecret(secretId);
  }

  async enableSecret(
    actor: SecretActor,
    secretId: string,
    reason: string,
  ): Promise<SecretMetadata> {
    assertActor(actor, 'Enabling a secret');
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
    return this.getSecret(secretId);
  }

  /** Revoke: permanent. The secret can never resolve again. */
  async revokeSecret(
    actor: SecretActor,
    secretId: string,
    reason: string,
  ): Promise<SecretMetadata> {
    assertActor(actor, 'Revoking a secret');
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
    return this.getSecret(secretId);
  }

  async getSecret(secretId: string): Promise<SecretMetadata> {
    const record = await this.#prisma.secretRecord.findUnique({
      where: { id: secretId },
      include: { versions: { where: { status: 'ACTIVE' }, take: 1 } },
    });
    if (!record) throw new AppError('NOT_FOUND', 'Secret not found');
    return toMetadata(record);
  }

  async listSecrets(
    filter: {
      environment?: Environment;
      category?: string;
    } = {},
  ): Promise<SecretMetadata[]> {
    const records = await this.#prisma.secretRecord.findMany({
      where: {
        ...(filter.environment ? { environment: filter.environment } : {}),
        ...(filter.category ? { category: filter.category } : {}),
      },
      include: { versions: { where: { status: 'ACTIVE' }, take: 1 } },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });
    return records.map(toMetadata);
  }

  /**
   * Resolve a secret to its plaintext value.
   *
   * ============================ THE ONLY DECRYPT PATH ========================
   * Call this ONLY from inside a server-side integration adapter, immediately
   * before handing the value to a provider SDK. Never log the result, never
   * return it from an API, never put it in a template or an error.
   * ===========================================================================
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
  async matchesStoredValue(secretId: string, candidate: string): Promise<boolean> {
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
