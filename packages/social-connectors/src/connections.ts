import {
  writeAuditEvent,
  type SocialConnection,
  type SocialProvider,
  type TenantScopedClient,
} from '@brandspace/database';
import { brandIdQueryFilter, systemClock, type Clock } from '@brandspace/shared';
import { socialConnectionNotFound } from './errors';
import { markNeedsReauth, type ReauthNotifier } from './reauth';
import { parsePublishingPolicy, PROVIDER_CONFIG_KEYS, type PublishingPolicy } from './policy';
import type { ConnectorRegistry } from './registry';
import type { ApplicationResolver, ConnectionQuota } from './oauth';
import type { SocialTokenVault } from './token-vault';
import type { CreatorPostingInfo } from './tiktok/options';

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
  /** Connectors A (W14) / B: the expiring-soon window, from `expiringWindow(policy)` (per platform). */
  readonly expiringWindowMs?: number | ((provider: SocialProvider) => number) | undefined;
  /** Connectors A (R3): who is told when a health check finds the account needs reconnecting. */
  readonly reauthNotifier?: ReauthNotifier | undefined;
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
  /**
   * The plan's ceiling on connected accounts, so `disconnect` can give the slot
   * back — OPTIONAL, for exactly the reason `vault` and `applications` are.
   *
   * A surface built for READING holds no quota adapter because reading consumes
   * nothing. `disconnect` is the only method here that moves the counter, and a
   * caller that can disconnect is a caller that must supply one: the refund is
   * not optional where a disconnection is possible, because a slot that is never
   * returned means a customer who disconnects an account is charged for it for
   * ever. `disconnect` therefore refuses rather than silently skipping the
   * refund — see the guard there.
   */
  readonly quota?: ConnectionQuota | undefined;
  readonly clock?: Clock;
}

/**
 * A token inside this window is treated as expiring.
 *
 * CONNECTORS A (W14) — CONFIGURATION, NOT A CONSTANT
 * (`publishing.dispatch.expiringSoonHours`, 24 unless the owner changes it): a
 * platform whose tokens last weeks wants the warning days ahead. Exported
 * (P6-11) so the Command Center's Pulse asks the SAME question the
 * integrations screen and publish readiness ask, from the same policy. A
 * second copy of the window would let Home say "fine" about an account the
 * integrations screen calls expiring.
 */
export function expiringSoonMs(
  policy: Pick<PublishingPolicy, 'dispatch'> & Partial<Pick<PublishingPolicy, 'providers'>>,
  provider?: SocialProvider,
): number {
  /*
   * CONNECTORS B (owner, #81) — PER PLATFORM WHEN THE PLATFORM SAYS SO
   * (`publishing.providers.<key>.expiringSoonHours`): Instagram's tokens last
   * about 60 days, so it is warned about days ahead; every other platform keeps
   * the dispatch window.
   */
  const own =
    provider && policy.providers
      ? (policy.providers[PROVIDER_CONFIG_KEYS[provider]]?.expiringSoonHours ?? null)
      : null;
  return (own ?? policy.dispatch.expiringSoonHours) * 60 * 60 * 1_000;
}

/** The expiring-soon window for each platform, from one policy. */
export function expiringWindow(
  policy: Pick<PublishingPolicy, 'dispatch' | 'providers'>,
): (provider: SocialProvider) => number {
  return (provider) => expiringSoonMs(policy, provider);
}

/**
 * The window when no activated policy is at hand: the SCHEMA's default, read
 * from the schema rather than restated here, so there is still one place a
 * default lives (CLAUDE.md §2.2).
 */
function defaultExpiringWindowMs(): number {
  return expiringSoonMs(parsePublishingPolicy({}));
}

/**
 * CONNECTORS A (W6) — is this token due for a proactive refresh? True once
 * `ratio` of its life (from `issuedAt` to `expiresAt`) has passed. A token with
 * no expiry is never due; one already expired is due (the expired-token path
 * handles it too). Pure, so the rule is unit-tested.
 */
export function refreshIsDue(input: {
  readonly issuedAt: Date;
  readonly expiresAt: Date | null;
  readonly ratio: number;
  readonly now: Date;
}): boolean {
  if (input.expiresAt === null) return false;
  const issued = input.issuedAt.getTime();
  const life = input.expiresAt.getTime() - issued;
  if (life <= 0) return true;
  return input.now.getTime() >= issued + life * input.ratio;
}

export function toConnectionView(
  connection: SocialConnection,
  now: Date,
  /** From `expiringWindow(policy)` (per platform) or `expiringSoonMs(policy)`. */
  expiringWindowMs: number | ((provider: SocialProvider) => number) = defaultExpiringWindowMs(),
): ConnectionView {
  const windowMs =
    typeof expiringWindowMs === 'function'
      ? expiringWindowMs(connection.provider)
      : expiringWindowMs;
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
      connection.tokenExpiresAt.getTime() - now.getTime() < windowMs,
  };
}

export class SocialConnectionService {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;
  readonly #registry: ConnectorRegistry;
  readonly #vault: SocialTokenVault | undefined;
  readonly #applications: ApplicationResolver | undefined;
  readonly #quota: ConnectionQuota | undefined;
  readonly #reauthNotifier: ReauthNotifier | undefined;
  readonly #expiringWindowMs: number | ((provider: SocialProvider) => number);
  readonly #clock: Clock;

  constructor(options: ConnectionServiceOptions) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#registry = options.registry;
    this.#vault = options.vault;
    this.#applications = options.applications;
    this.#quota = options.quota;
    this.#reauthNotifier = options.reauthNotifier;
    this.#expiringWindowMs = options.expiringWindowMs ?? defaultExpiringWindowMs();
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
    return rows.map((row) => toConnectionView(row, now, this.#expiringWindowMs));
  }

  /** One connection, scoped. Out-of-scope reads the same as never existed. */
  async get(connectionId: string, brandScope: readonly string[]): Promise<ConnectionView> {
    const row = await this.#db.socialConnection.findFirst({
      where: { id: connectionId, ...brandIdQueryFilter({ brandScope }) },
    });
    if (!row) throw socialConnectionNotFound();
    return toConnectionView(row, this.#clock.now(), this.#expiringWindowMs);
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

    /*
     * THE PLAN'S SLOT GOES BACK.
     *
     * `limit.social_accounts` counts CONNECTIONS THAT EXIST, not connections
     * ever made, so a disconnection must return the slot or a customer who
     * rotates an account eventually cannot connect anything. The key is the
     * connection's own id — the same one `#connect` consumed on, under its own
     * prefix — so disconnect twice, or retry it, and the slot comes back exactly
     * once, while a later reconnection of the same account takes a fresh slot
     * rather than replaying a spent key. THE PREFIX IS NOT DECORATION: consume
     * and refund share one unique index on the usage event, and reusing the
     * consumption's key here would be refused as a conflicting movement.
     *
     * A CALLER THAT CAN DISCONNECT MUST BE ABLE TO REFUND. Skipping the refund
     * silently because no adapter was supplied would charge the customer for an
     * account they no longer have, so this refuses instead. Read-only surfaces
     * never reach here.
     */
    if (!this.#quota) {
      throw new Error(
        'SocialConnectionService.disconnect needs a quota adapter to return the plan slot.',
      );
    }
    await this.#quota.refund(`social-account-refund:${connection.id}`);

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

    return toConnectionView(updated, now, this.#expiringWindowMs);
  }

  /**
   * A lightweight liveness probe.
   *
   * ROLLING FAILURE COUNT RATHER THAN A SINGLE VERDICT. One failed probe is
   * usually the platform having a moment; a run of them is a connection that
   * needs the customer. Counting is what lets the UI say which of the two it is
   * looking at.
   */
  /**
   * CONNECTORS C — WHAT THIS ACCOUNT MAY POST RIGHT NOW (TikTok's
   * `creator_info`), asked fresh each time, as TikTok's guidelines require.
   * Brand-scoped like every read here: an account outside the caller's brands
   * is the same refusal as one that does not exist. Null when the platform has
   * no such question. Writes nothing; the token is opened, used and dropped.
   */
  async postingOptions(input: {
    connectionId: string;
    brandScope: readonly string[];
  }): Promise<CreatorPostingInfo | null> {
    const connection = await this.#db.socialConnection.findFirst({
      where: {
        id: input.connectionId,
        status: 'ACTIVE',
        ...brandIdQueryFilter({ brandScope: input.brandScope }),
      },
    });
    if (!connection) throw socialConnectionNotFound();
    const adapter = this.#registry.get(connection.provider);
    if (!adapter.postingOptions) return null;
    const live = await this.#db.socialCredential.findFirst({
      where: { workspaceId: this.#workspaceId, socialConnectionId: connection.id, retiredAt: null },
      orderBy: { version: 'desc' },
    });
    if (!live || !this.#vault) throw socialConnectionNotFound();
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
    return adapter.postingOptions({ credentials: material });
  }

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
      // R3 (connectors A): the same write as before, and the owner is told once.
      await markNeedsReauth({
        db: this.#db,
        workspaceId: this.#workspaceId,
        connectionId: connection.id,
        failureClass: 'NOT_CONNECTED',
        now,
        notifier: this.#reauthNotifier,
      });
      return this.#viewOf(connection.id, now);
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

    if (!health.healthy) {
      // R3 (connectors A): the same write as before, and the owner is told once.
      await markNeedsReauth({
        db: this.#db,
        workspaceId: this.#workspaceId,
        connectionId: connection.id,
        failureClass: health.failureClass ?? 'UNKNOWN',
        now,
        notifier: this.#reauthNotifier,
      });
      return this.#viewOf(connection.id, now);
    }
    const updated = await this.#db.socialConnection.update({
      where: { id: connection.id },
      data: {
        status: connection.status === 'NEEDS_REAUTH' ? 'NEEDS_REAUTH' : 'ACTIVE',
        lastCheckedAt: now,
        lastSyncedAt: now,
        consecutiveFailureCount: 0,
        lastFailureClass: null,
      },
    });
    return toConnectionView(updated, now, this.#expiringWindowMs);
  }

  async #viewOf(connectionId: string, now: Date): Promise<ConnectionView> {
    const row = await this.#db.socialConnection.findFirstOrThrow({
      where: { id: connectionId, workspaceId: this.#workspaceId },
    });
    return toConnectionView(row, now, this.#expiringWindowMs);
  }
}
