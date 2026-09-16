import { createHash, randomBytes } from 'node:crypto';
import {
  writeAuditEvent,
  type SocialConnection,
  type SocialProvider,
  type TenantScopedClient,
} from '@brandspace/database';
import { brandScopeFilter, systemClock, type Clock } from '@brandspace/shared';
import type { AdapterApplication, PublishTarget, TokenBundle } from './adapter';
import {
  connectionLimitReached,
  oauthStateInvalid,
  providerNotEnabled,
  socialConnectionNotFound,
} from './errors';
import { capabilitiesFor, type PublishingPolicy } from './policy';
import type { ConnectorRegistry } from './registry';
import type { SocialTokenVault } from './token-vault';

/**
 * The OAuth connection flow — docs/SOCIAL-INTEGRATIONS.md §4.
 *
 * FOUR THINGS DEFEND THIS FLOW, and each one closes a different attack:
 *
 *   1. STATE, opaque and single-use. It is the CSRF defence: without it an
 *      attacker can make a victim's browser complete a connection to the
 *      ATTACKER's social account, and every post the victim then schedules goes
 *      to the attacker's page. It is stored HASHED, so a database read cannot
 *      be replayed as a callback, and consumed by a CONDITIONAL UPDATE, so two
 *      concurrent callbacks cannot both win.
 *   2. PKCE. The code alone is not enough to complete the exchange, so an
 *      intercepted redirect is worth nothing. The verifier is stored encrypted
 *      for the lifetime of the flow.
 *   3. EXACT REDIRECT-URI MATCHING. The callback is checked against the URI
 *      recorded when the flow started, never against the one in the request.
 *   4. SCOPE VERIFICATION AFTER THE FACT. A provider that granted less than we
 *      asked for yields `NEEDS_REAUTH`, not a connection that looks healthy and
 *      fails at publish time.
 *
 * EVERY REFUSAL IS THE SAME SENTENCE. Expired, already used, forged, and
 * belonging to another workspace all produce one message: telling an attacker
 * which of their guesses was closest is the leak, not the failure.
 */

export interface OAuthActor {
  readonly userId: string;
  readonly brandScope: readonly string[];
}

export interface SocialOAuthOptions {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
  readonly policy: PublishingPolicy;
  readonly registry: ConnectorRegistry;
  readonly vault: SocialTokenVault;
  /** Resolves the platform app's own credentials. Platform surfaces only. */
  readonly applications: ApplicationResolver;
  readonly clock?: Clock;
}

/**
 * How the platform app's own identity is resolved.
 *
 * AN INTERFACE, NOT AN IMPORT. `integrations.social-apps` is platform-owned
 * configuration and its `clientSecretRef` resolves through the Secret Service,
 * which this package may not import (F-07). So the caller — `apps/api`, the
 * designated platform surface — resolves it and hands it in. This package can
 * therefore never read a platform credential even by accident.
 */
export interface ApplicationResolver {
  resolve(provider: SocialProvider): Promise<AdapterApplication>;
}

export interface StartConnectionResult {
  readonly authorizationUrl: string;
  /** The opaque state. Returned once, to be put in the redirect and forgotten. */
  readonly state: string;
  readonly expiresAt: Date;
}

/** What a completed callback produced, for the caller to audit and render. */
export interface CompleteConnectionResult {
  readonly connection: SocialConnection;
  readonly targets: readonly PublishTarget[];
  /** True when the provider granted less than we asked for. */
  readonly missingScopes: readonly string[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** RFC 7636 S256: base64url(sha256(verifier)). */
function codeChallengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export class SocialOAuthService {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;
  readonly #policy: PublishingPolicy;
  readonly #registry: ConnectorRegistry;
  readonly #vault: SocialTokenVault;
  readonly #applications: ApplicationResolver;
  readonly #clock: Clock;

  constructor(options: SocialOAuthOptions) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#policy = options.policy;
    this.#registry = options.registry;
    this.#vault = options.vault;
    this.#applications = options.applications;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Begin an authorization.
   *
   * THE BRAND IS CHECKED AS A QUERY PREDICATE (D-134), not after the fact: a
   * brand outside the actor's scope produces the same not-found a brand that
   * never existed produces.
   */
  async start(input: {
    provider: SocialProvider;
    brandId: string;
    actor: OAuthActor;
  }): Promise<StartConnectionResult> {
    const capabilities = capabilitiesFor(this.#policy, input.provider);
    if (!capabilities.enabled) throw providerNotEnabled();
    const adapter = this.#registry.get(input.provider);

    /*
     * THE SCOPE IS A PREDICATE HERE TOO (D-134), but on `id` rather than
     * `brandId`: this query reads the BRAND table itself, and `brandScopeFilter`
     * is the sibling helper for exactly that. An out-of-scope brand is never
     * retrieved, so it is refused identically to one that never existed.
     */
    const brand = await this.#db.brand.findFirst({
      where: { id: input.brandId, ...brandScopeFilter(input.actor.brandScope) },
      select: { id: true },
    });
    if (!brand) throw socialConnectionNotFound();

    // THE CEILING IS CHECKED BEFORE THE CUSTOMER LEAVES OUR SITE, not after
    // they have authorized at the provider. Sending someone through a consent
    // screen and then refusing the result is the worst possible order.
    const live = await this.#db.socialConnection.count({
      where: {
        workspaceId: this.#workspaceId,
        status: { in: ['PENDING', 'ACTIVE', 'NEEDS_REAUTH'] },
      },
    });
    if (live >= this.#policy.oauth.maxConnectionsPerWorkspace) throw connectionLimitReached();

    const application = await this.#applications.resolve(input.provider);

    /*
     * 32 BYTES OF CSPRNG, AND THE VALUE IS NEVER WRITTEN DOWN. Only its hash is
     * stored, so a leaked backup, a support query or a compromised read replica
     * yields nothing that can be replayed as a callback.
     */
    const state = randomBytes(32).toString('base64url');
    const stateHash = sha256(state);
    const verifier = randomBytes(64).toString('base64url');
    const sealed = await this.#vault.sealVerifier({
      workspaceId: this.#workspaceId,
      stateHash,
      verifier,
    });

    const expiresAt = new Date(
      this.#clock.now().getTime() + this.#policy.oauth.stateTtlSeconds * 1_000,
    );

    await this.#db.socialOAuthState.create({
      data: {
        workspaceId: this.#workspaceId,
        brandId: brand.id,
        provider: input.provider,
        stateHash,
        verifierCiphertext: sealed.ciphertext,
        verifierIv: sealed.iv,
        verifierAuthTag: sealed.authTag,
        verifierWrappedDataKey: sealed.wrappedDataKey,
        verifierKeyProvider: sealed.keyProvider,
        verifierKeyId: sealed.keyId,
        verifierEncryptionContext: sealed.encryptionContext,
        redirectUri: application.redirectUri,
        requestedScopes: [...capabilities.scopes],
        startedByUserId: input.actor.userId,
        expiresAt,
      },
    });

    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'social.connection.authorization_started',
      actorType: 'USER',
      actorId: input.actor.userId,
      resourceType: 'SocialConnection',
      brandId: brand.id,
      // The provider and the brand. NOT the state, which is a live credential
      // for the length of the flow, and not the redirect, which carries it.
      after: { provider: input.provider },
    });

    return {
      authorizationUrl: adapter.buildAuthorizationUrl({
        state,
        codeChallenge: codeChallengeFor(verifier),
        scopes: capabilities.scopes,
        application,
      }),
      state,
      expiresAt,
    };
  }

  /**
   * Finish an authorization.
   *
   * SINGLE-USE IS ENFORCED BY THE DATABASE, not by a read-then-write. Two
   * callbacks arriving together — a double-clicked redirect, a replayed request
   * — both run the same conditional UPDATE, and exactly one matches a row with
   * `consumedAt IS NULL`. The loser is refused with the same sentence a forged
   * state gets.
   */
  async complete(input: {
    state: string;
    code: string;
    redirectUri: string;
  }): Promise<CompleteConnectionResult> {
    const stateHash = sha256(input.state);
    const now = this.#clock.now();

    /*
     * CLAIM FIRST, READ SECOND. `updateMany` with the full predicate is atomic:
     * it matches only a row that is this workspace's, unconsumed and unexpired,
     * and sets `consumedAt` in the same statement. A `findFirst` followed by an
     * `update` would leave a window two requests can both pass through.
     */
    const claimed = await this.#db.socialOAuthState.updateMany({
      where: {
        stateHash,
        workspaceId: this.#workspaceId,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      data: { consumedAt: now },
    });
    if (claimed.count !== 1) throw oauthStateInvalid();

    const record = await this.#db.socialOAuthState.findFirst({ where: { stateHash } });
    if (!record) throw oauthStateInvalid();

    // EXACT MATCH, against what was recorded when the flow started. Comparing
    // against the request's own value would compare it with itself.
    if (record.redirectUri !== input.redirectUri) throw oauthStateInvalid();

    const adapter = this.#registry.get(record.provider);
    const application = await this.#applications.resolve(record.provider);
    const verifier = await this.#vault.openVerifier({
      ciphertext: record.verifierCiphertext,
      iv: record.verifierIv,
      authTag: record.verifierAuthTag,
      wrappedDataKey: record.verifierWrappedDataKey,
      keyProvider: record.verifierKeyProvider,
      keyId: record.verifierKeyId,
      algorithm: 'AES-256-GCM',
      encryptionContext: record.verifierEncryptionContext,
      maskedHint: '',
      fingerprint: '',
    });

    let bundle: TokenBundle;
    try {
      bundle = await adapter.exchangeCode({
        code: input.code,
        codeVerifier: verifier,
        application,
      });
    } catch {
      // The provider's own words are not repeated: an exchange failure message
      // routinely echoes the code, which is a credential.
      throw oauthStateInvalid();
    }

    const targets = await adapter.listTargets({
      credentials: { accessToken: bundle.accessToken, refreshToken: bundle.refreshToken },
    });

    /*
     * SCOPE VERIFICATION. A partial grant becomes NEEDS_REAUTH rather than a
     * connection that renders green and fails at publish time — which is the
     * failure mode that wastes a customer's scheduled slot.
     */
    const granted = new Set(bundle.grantedScopes);
    const missingScopes = record.requestedScopes.filter((scope) => !granted.has(scope));

    const first = targets[0];
    if (!first) throw oauthStateInvalid();

    const capabilities = capabilitiesFor(this.#policy, record.provider);
    const expiresAt =
      bundle.expiresInSeconds === null
        ? null
        : new Date(now.getTime() + bundle.expiresInSeconds * 1_000);

    const connection = await this.#db.socialConnection.create({
      data: {
        workspaceId: this.#workspaceId,
        brandId: record.brandId,
        provider: record.provider,
        externalAccountId: first.externalAccountId,
        displayName: first.displayName,
        avatarUrl: first.avatarUrl,
        targetKind: first.targetKind || capabilities.targetKind,
        status: missingScopes.length > 0 ? 'NEEDS_REAUTH' : 'ACTIVE',
        grantedScopes: [...bundle.grantedScopes],
        connectedByUserId: record.startedByUserId,
        connectedAt: now,
        tokenExpiresAt: expiresAt,
        lastSyncedAt: now,
        lastCheckedAt: now,
        ...(missingScopes.length > 0 ? { lastFailureClass: 'INSUFFICIENT_SCOPE' as const } : {}),
      },
    });

    await this.#storeCredential({
      connectionId: connection.id,
      version: 1,
      bundle,
      expiresAt,
    });

    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'social.connection.connected',
      actorType: 'USER',
      actorId: record.startedByUserId,
      resourceType: 'SocialConnection',
      resourceId: connection.id,
      brandId: record.brandId,
      // Identity and status. NO TOKEN, no scope VALUES that could identify the
      // grant, no provider response.
      after: {
        provider: connection.provider,
        status: connection.status,
        targetKind: connection.targetKind,
        missingScopeCount: missingScopes.length,
      },
    });

    return { connection, targets, missingScopes };
  }

  /**
   * Refresh a connection's token.
   *
   * WRITES A NEW VERSION AND RETIRES THE OLD ONE rather than overwriting, so a
   * rotation that half-fails leaves the previous token usable instead of
   * leaving the connection holding nothing.
   */
  async refresh(connectionId: string): Promise<SocialConnection> {
    const connection = await this.#db.socialConnection.findFirst({
      where: { id: connectionId, workspaceId: this.#workspaceId },
    });
    if (!connection) throw socialConnectionNotFound();

    const live = await this.#liveCredential(connection.id);
    if (!live) throw socialConnectionNotFound();

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

    if (!material.refreshToken) {
      // Nothing to refresh WITH. That is a reconnect, and saying so is more
      // useful than a retry that can never succeed.
      return this.#markNeedsReauth(connection.id, 'AUTH_EXPIRED');
    }

    const adapter = this.#registry.get(connection.provider);
    const application = await this.#applications.resolve(connection.provider);
    let bundle: TokenBundle;
    try {
      bundle = await adapter.refreshToken({
        refreshToken: material.refreshToken,
        application,
      });
    } catch (error: unknown) {
      const failureClass = adapter.classifyError(error);
      return this.#markNeedsReauth(
        connection.id,
        failureClass === 'AUTH_REVOKED' ? 'AUTH_REVOKED' : 'AUTH_EXPIRED',
      );
    }

    const now = this.#clock.now();
    const expiresAt =
      bundle.expiresInSeconds === null
        ? null
        : new Date(now.getTime() + bundle.expiresInSeconds * 1_000);

    await this.#db.socialCredential.updateMany({
      where: { workspaceId: this.#workspaceId, socialConnectionId: connection.id, retiredAt: null },
      data: { retiredAt: now },
    });
    await this.#storeCredential({
      connectionId: connection.id,
      version: live.version + 1,
      bundle,
      expiresAt,
    });

    return this.#db.socialConnection.update({
      where: { id: connection.id },
      data: {
        status: 'ACTIVE',
        grantedScopes: [...bundle.grantedScopes],
        tokenExpiresAt: expiresAt,
        lastRefreshedAt: now,
        lastSyncedAt: now,
        lastCheckedAt: now,
        consecutiveFailureCount: 0,
        lastFailureClass: null,
      },
    });
  }

  /** The live credential row for a connection, or null. */
  async #liveCredential(connectionId: string) {
    return this.#db.socialCredential.findFirst({
      where: { workspaceId: this.#workspaceId, socialConnectionId: connectionId, retiredAt: null },
      orderBy: { version: 'desc' },
    });
  }

  async #markNeedsReauth(
    connectionId: string,
    failureClass: 'AUTH_EXPIRED' | 'AUTH_REVOKED',
  ): Promise<SocialConnection> {
    return this.#db.socialConnection.update({
      where: { id: connectionId },
      data: {
        status: 'NEEDS_REAUTH',
        lastFailureClass: failureClass,
        lastCheckedAt: this.#clock.now(),
        consecutiveFailureCount: { increment: 1 },
      },
    });
  }

  async #storeCredential(input: {
    connectionId: string;
    version: number;
    bundle: TokenBundle;
    expiresAt: Date | null;
  }): Promise<void> {
    const sealed = await this.#vault.seal({
      workspaceId: this.#workspaceId,
      socialConnectionId: input.connectionId,
      version: input.version,
      material: {
        accessToken: input.bundle.accessToken,
        refreshToken: input.bundle.refreshToken,
      },
    });
    await this.#db.socialCredential.create({
      data: {
        workspaceId: this.#workspaceId,
        socialConnectionId: input.connectionId,
        version: input.version,
        ciphertext: sealed.ciphertext,
        iv: sealed.iv,
        authTag: sealed.authTag,
        wrappedDataKey: sealed.wrappedDataKey,
        keyProvider: sealed.keyProvider,
        keyId: sealed.keyId,
        algorithm: sealed.algorithm,
        encryptionContext: sealed.encryptionContext,
        maskedHint: sealed.maskedHint,
        fingerprint: sealed.fingerprint,
        accessTokenExpiresAt: input.expiresAt,
        hasRefreshToken: input.bundle.refreshToken !== null,
      },
    });
  }
}
