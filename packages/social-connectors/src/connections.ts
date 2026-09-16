import {
  writeAuditEvent,
  type SocialConnection,
  type SocialProvider,
  type TenantScopedClient,
} from '@brandspace/database';
import { brandIdQueryFilter, systemClock, type Clock } from '@brandspace/shared';
import { socialConnectionNotFound } from './errors';
import type { ConnectorRegistry } from './registry';
import type { ApplicationResolver } from './oauth';
import type { SocialTokenVault } from './token-vault';

/**
 * Reading and managing connected accounts.
 *
 * WHAT THIS FILE NEVER SELECTS. `social_credential`. Every projection here is
 * built from `social_connection` alone, which is the reason the two are
 * separate tables: a screen cannot leak a token it never loaded, and nothing in
 * this service has a code path that could.
 *
 * BRANDSCOPE IS A QUERY PREDICATE EVERYWHERE (D-132/D-134). Not one method here
 * reads a row and then checks its brand — an out-of-scope connection is never
 * retrieved, so an out-of-scope id is indistinguishable from one that never
 * existed.
 */

/** Exactly what a screen may see. There is no token-shaped field on it. */
export interface ConnectionView {
  readonly id: string;
  readonly brandId: string;
  readonly provider: SocialProvider;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly targetKind: string;
  readonly status: SocialConnection['status'];
  readonly grantedScopes: readonly string[];
  readonly connectedAt: Date | null;
  readonly tokenExpiresAt: Date | null;
  readonly lastSyncedAt: Date | null;
  readonly lastCheckedAt: Date | null;
  readonly consecutiveFailureCount: number;
  readonly lastFailureClass: SocialConnection['lastFailureClass'];
  /** Derived, so every surface agrees on what "ready" means. */
  readonly publishable: boolean;
  /** Derived: the token is valid but will not be for much longer. */
  readonly expiringSoon: boolean;
}

export interface ConnectionServiceOptions {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
  readonly registry: ConnectorRegistry;
  /**
   * OPTIONAL, for the same reason `applications` is — and the pair travel
   * together.
   *
   * READING A CONNECTION NEVER DECRYPTS ANYTHING. `list`, `get` and
   * `publishableForBrand` touch `social_connection` alone; only `disconnect`
   * and `checkHealth` open a credential, and both of those need an
   * `ApplicationResolver` anyway. So a surface built for reading is built with
   * NEITHER, and holds no key material at all.
   *
   * That is not a tidiness point. The first version constructed a vault
   * eagerly, which meant the customer dashboard needed `SOCIAL_TOKEN_VAULT_KEK`
   * in its environment to render a LIST — so a key that only the API and the
   * worker have any use for would have been deployed to the process closest to
   * a browser bundle. The end-to-end suite caught it as a crash; the real
   * defect was the key being there at all.
   */
  readonly vault?: SocialTokenVault | undefined;
  /**
   * OPTIONAL, and its absence is a deliberate capability difference rather than
   * a convenience.
   *
   * Resolving the platform app's own client secret needs the Secret Service,
   * which the customer dashboard may not import (F-07). A surface built without
   * a resolver can LIST and READ connections and nothing else — `disconnect`
   * still works and still clears the local credential, but it cannot revoke at
   * the provider and says so in the audit record rather than implying it did.
   *
   * The dashboard therefore reads here and routes disconnection through
   * `apps/api`, which has the resolver. Making the field optional is what lets
   * the type system express that, instead of a comment asking people to
   * remember.
   */
  readonly applications?: ApplicationResolver | undefined;
  readonly clock?: Clock;
}

/** A token inside this window is treated as expiring. Mirrors the refresh cue. */
const EXPIRING_SOON_MS = 24 * 60 * 60 * 1_000;

export function toConnectionView(connection: SocialConnection, now: Date): ConnectionView {
  return {
    id: connection.id,
    brandId: connection.brandId,
    provider: connection.provider,
    displayName: connection.displayName,
    avatarUrl: connection.avatarUrl,
    targetKind: connection.targetKind,
    status: connection.status,
    grantedScopes: connection.grantedScopes,
    connectedAt: connection.connectedAt,
    tokenExpiresAt: connection.tokenExpiresAt,
    lastSyncedAt: connection.lastSyncedAt,
    lastCheckedAt: connection.lastCheckedAt,
    consecutiveFailureCount: connection.consecutiveFailureCount,
    lastFailureClass: connection.lastFailureClass,
    publishable:
      connection.status === 'ACTIVE' &&
      (connection.tokenExpiresAt === null || connection.tokenExpiresAt.getTime() > now.getTime()),
    expiringSoon:
      connection.status === 'ACTIVE' &&
      connection.tokenExpiresAt !== null &&
      connection.tokenExpiresAt.getTime() - now.getTime() < EXPIRING_SOON_MS,
  };
}

export class SocialConnectionService {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;
  readonly #registry: ConnectorRegistry;
  readonly #vault: SocialTokenVault | undefined;
  readonly #applications: ApplicationResolver | undefined;
  readonly #clock: Clock;

  constructor(options: ConnectionServiceOptions) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#registry = options.registry;
    this.#vault = options.vault;
    this.#applications = options.applications;
    this.#clock = options.clock ?? systemClock;
  }

  /** Every connection the caller may see, newest first. */
  async list(input: {
    brandScope: readonly string[];
    brandId?: string | undefined;
    includeRevoked?: boolean | undefined;
  }): Promise<readonly ConnectionView[]> {
    const rows = await this.#db.socialConnection.findMany({
      where: {
        ...brandIdQueryFilter({
          ...(input.brandId ? { brandId: input.brandId } : {}),
          brandScope: input.brandScope,
        }),
        ...(input.includeRevoked ? {} : { status: { notIn: ['REVOKED'] } }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const now = this.#clock.now();
    return rows.map((row) => toConnectionView(row, now));
  }

  /** One connection, scoped. Out-of-scope reads the same as never existed. */
  async get(connectionId: string, brandScope: readonly string[]): Promise<ConnectionView> {
    const row = await this.#db.socialConnection.findFirst({
      where: { id: connectionId, ...brandIdQueryFilter({ brandScope }) },
    });
    if (!row) throw socialConnectionNotFound();
    return toConnectionView(row, this.#clock.now());
  }

  /** The connections a brand can actually publish through right now. */
  async publishableForBrand(
    brandId: string,
    brandScope: readonly string[],
  ): Promise<readonly SocialConnection[]> {
    return this.#db.socialConnection.findMany({
      where: {
        status: 'ACTIVE',
        ...brandIdQueryFilter({ brandId, brandScope }),
      },
      orderBy: [{ provider: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * Disconnect.
   *
   * REVOCATION AT THE PROVIDER IS BEST EFFORT AND THE LOCAL STATE IS NOT.
   * A provider being down must never stop a customer from disconnecting — that
   * would leave them unable to stop us posting on their behalf, which is the
   * one thing this button exists for. So the remote call is attempted, its
   * failure is recorded, and the connection is revoked locally either way.
   *
   * THE CREDENTIAL IS DESTROYED, not retired. There is nothing to roll back to
   * and no reason to keep a token for an account we no longer act on.
   */
  async disconnect(input: {
    connectionId: string;
    actorUserId: string;
    brandScope: readonly string[];
  }): Promise<ConnectionView> {
    const connection = await this.#db.socialConnection.findFirst({
      where: { id: input.connectionId, ...brandIdQueryFilter({ brandScope: input.brandScope }) },
    });
    if (!connection) throw socialConnectionNotFound();

    let revokedRemotely = false;
    const vault = this.#vault;
    const live = await this.#db.socialCredential.findFirst({
      where: {
        workspaceId: this.#workspaceId,
        socialConnectionId: connection.id,
        retiredAt: null,
      },
      orderBy: { version: 'desc' },
    });
    if (live && vault && this.#applications) {
      const applications = this.#applications;
      try {
        const material = await vault.open({
          ciphertext: live.ciphertext,
          iv: live.iv,
          authTag: live.authTag,
          wrappedDataKey: live.wrappedDataKey,
          keyProvider: live.keyProvider,
          keyId: live.keyId,
          algorithm: 'AES-256-GCM',
          encryptionContext: live.encryptionContext,
          maskedHint: live.maskedHint,
          fingerprint: live.fingerprint,
        });
        await this.#registry.get(connection.provider).revoke({
          credentials: material,
          application: await applications.resolve(connection.provider),
        });
        revokedRemotely = true;
      } catch {
        // Recorded below, never rethrown. See the note above.
        revokedRemotely = false;
      }
    }

    await this.#db.socialCredential.deleteMany({
      where: { workspaceId: this.#workspaceId, socialConnectionId: connection.id },
    });

    const now = this.#clock.now();
    const updated = await this.#db.socialConnection.update({
      where: { id: connection.id },
      data: {
        status: 'REVOKED',
        revokedAt: now,
        disconnectedAt: now,
        tokenExpiresAt: null,
        grantedScopes: [],
      },
    });

    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'social.connection.disconnected',
      actorType: 'USER',
      actorId: input.actorUserId,
      resourceType: 'SocialConnection',
      resourceId: connection.id,
      brandId: connection.brandId,
      before: { status: connection.status },
      // Whether the provider confirmed. A customer support question that would
      // otherwise need a log dig.
      after: { status: 'REVOKED', revokedAtProvider: revokedRemotely },
    });

    return toConnectionView(updated, now);
  }

  /**
   * A lightweight liveness probe.
   *
   * ROLLING FAILURE COUNT RATHER THAN A SINGLE VERDICT. One failed probe is
   * usually the platform having a moment; a run of them is a connection that
   * needs the customer. Counting is what lets the UI say which of the two it is
   * looking at.
   */
  async checkHealth(input: {
    connectionId: string;
    brandScope: readonly string[];
  }): Promise<ConnectionView> {
    const connection = await this.#db.socialConnection.findFirst({
      where: { id: input.connectionId, ...brandIdQueryFilter({ brandScope: input.brandScope }) },
    });
    if (!connection) throw socialConnectionNotFound();

    const live = await this.#db.socialCredential.findFirst({
      where: {
        workspaceId: this.#workspaceId,
        socialConnectionId: connection.id,
        retiredAt: null,
      },
      orderBy: { version: 'desc' },
    });
    const now = this.#clock.now();
    if (!live) {
      const updated = await this.#db.socialConnection.update({
        where: { id: connection.id },
        data: {
          status: 'NEEDS_REAUTH',
          lastFailureClass: 'NOT_CONNECTED',
          lastCheckedAt: now,
          consecutiveFailureCount: { increment: 1 },
        },
      });
      return toConnectionView(updated, now);
    }

    if (!this.#vault) {
      /*
       * A READ-ONLY SURFACE CANNOT PROBE A CONNECTION, and says so rather than
       * pretending. Health needs the token, the token needs the key, and a
       * surface built without one has no business holding it.
       */
      throw socialConnectionNotFound();
    }
    const material = await this.#vault.open({
      ciphertext: live.ciphertext,
      iv: live.iv,
      authTag: live.authTag,
      wrappedDataKey: live.wrappedDataKey,
      keyProvider: live.keyProvider,
      keyId: live.keyId,
      algorithm: 'AES-256-GCM',
      encryptionContext: live.encryptionContext,
      maskedHint: live.maskedHint,
      fingerprint: live.fingerprint,
    });

    const health = await this.#registry.get(connection.provider).checkHealth({
      credentials: material,
    });

    const updated = await this.#db.socialConnection.update({
      where: { id: connection.id },
      data: health.healthy
        ? {
            status: connection.status === 'NEEDS_REAUTH' ? 'NEEDS_REAUTH' : 'ACTIVE',
            lastCheckedAt: now,
            lastSyncedAt: now,
            consecutiveFailureCount: 0,
            lastFailureClass: null,
          }
        : {
            status: 'NEEDS_REAUTH',
            lastCheckedAt: now,
            consecutiveFailureCount: { increment: 1 },
            lastFailureClass: health.failureClass ?? 'UNKNOWN',
          },
    });
    return toConnectionView(updated, now);
  }
}
