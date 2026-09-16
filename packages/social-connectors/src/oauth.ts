import { createHash, randomBytes } from 'node:crypto';
import {
  Prisma,
  writeAuditEvent,
  type SocialConnection,
  type SocialProvider,
  type TenantScopedClient,
} from '@brandspace/database';
import { brandIdQueryFilter, brandScopeFilter, systemClock, type Clock } from '@brandspace/shared';
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

/**
 * What a completed callback produced.
 *
 * TWO OUTCOMES, NOT ONE (D-142). A grant that offered exactly one target is
 * `connected` and a connection exists. A grant that offered several is
 * `selection_required`: the token is sealed on the authorization row, the
 * offered targets are recorded, and NOTHING is connected until the customer
 * says which of their pages they meant.
 */
export type CompleteConnectionResult =
  | {
      readonly outcome: 'connected';
      readonly connection: SocialConnection;
      readonly targets: readonly PublishTarget[];
      /** True when the provider granted less than we asked for. */
      readonly missingScopes: readonly string[];
    }
  | {
      readonly outcome: 'selection_required';
      /**
       * The single-use secret authorising the choice. Returned ONCE, handed to
       * the browser that completed the callback, and never stored in the clear
       * — only its hash is, exactly as the state is.
       */
      readonly selectionToken: string;
      readonly targets: readonly PublishTarget[];
      readonly missingScopes: readonly string[];
    };

/** One choice on offer, as a screen renders it. Identity only, never a token. */
export interface PendingSelectionView {
  readonly provider: SocialProvider;
  readonly brandId: string;
  readonly targets: readonly PublishTarget[];
  readonly expiresAt: Date;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** RFC 7636 S256: base64url(sha256(verifier)). */
function codeChallengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Read back the offered targets a callback recorded.
 *
 * PARSED, NOT CAST. It is a `Json` column, so its runtime shape is whatever was
 * written — and what is done with it is comparing an `externalAccountId` from a
 * request against it, which is an authorization decision. A cast would make a
 * malformed row an authorization bypass instead of an empty list.
 */
function parseOfferedTargets(value: unknown): readonly PublishTarget[] {
  if (!Array.isArray(value)) return [];
  const targets: PublishTarget[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    if (typeof row['externalAccountId'] !== 'string' || row['externalAccountId'] === '') continue;
    targets.push({
      externalAccountId: row['externalAccountId'],
      displayName: typeof row['displayName'] === 'string' ? row['displayName'] : '',
      avatarUrl: typeof row['avatarUrl'] === 'string' ? row['avatarUrl'] : null,
      targetKind: typeof row['targetKind'] === 'string' ? row['targetKind'] : '',
    });
  }
  return targets;
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

    if (targets.length === 0) throw oauthStateInvalid();

    /*
     * A GRANT THAT OFFERS SEVERAL TARGETS IS NOT FINISHED (D-142).
     *
     * The first version took `targets[0]` and persisted an ACTIVE connection to
     * it. Meta returns every Page the person administers and LinkedIn every
     * organization they can post as; "the first one" is an ordering accident of
     * the provider's API, and the consequence of getting it wrong is that a
     * customer's scheduled posts go to the wrong Page of their own — published,
     * publicly, under their brand. BrandSpace does not get to decide that.
     *
     * So the flow PAUSES. The token is sealed onto this authorization row
     * rather than onto a connection, because a connection row IS a chosen
     * target and nobody has chosen one yet.
     */
    if (targets.length > 1) {
      return this.#pauseForSelection({ record, stateHash, bundle, targets, missingScopes, now });
    }

    const only = targets[0];
    if (!only) throw oauthStateInvalid();

    const connection = await this.#connect({
      record,
      target: only,
      bundle,
      missingScopes,
      now,
    });

    return { outcome: 'connected', connection, targets, missingScopes };
  }

  /**
   * Hold a multi-target grant until the customer chooses.
   *
   * WHAT IS STORED AND WHAT IS NOT. The token is sealed under its own
   * encryption context; the offered targets are stored in the clear because
   * they are the customer's own page names, under the customer's own RLS, and a
   * screen has to render them. The selection secret is stored HASHED, for the
   * same reason the state is: a database read must not be replayable as a
   * choice.
   */
  async #pauseForSelection(input: {
    record: { id: string; brandId: string; provider: SocialProvider; startedByUserId: string };
    stateHash: string;
    bundle: TokenBundle;
    targets: readonly PublishTarget[];
    missingScopes: readonly string[];
    now: Date;
  }): Promise<CompleteConnectionResult> {
    const selectionToken = randomBytes(32).toString('base64url');
    const sealed = await this.#vault.sealPendingGrant({
      workspaceId: this.#workspaceId,
      stateHash: input.stateHash,
      material: { accessToken: input.bundle.accessToken, refreshToken: input.bundle.refreshToken },
    });

    await this.#db.socialOAuthState.update({
      where: { id: input.record.id },
      data: {
        pendingCiphertext: sealed.ciphertext,
        pendingIv: sealed.iv,
        pendingAuthTag: sealed.authTag,
        pendingWrappedDataKey: sealed.wrappedDataKey,
        pendingKeyProvider: sealed.keyProvider,
        pendingKeyId: sealed.keyId,
        pendingEncryptionContext: sealed.encryptionContext,
        offeredTargets: input.targets.map((target) => ({
          externalAccountId: target.externalAccountId,
          displayName: target.displayName,
          avatarUrl: target.avatarUrl,
          targetKind: target.targetKind,
        })),
        grantedScopes: [...input.bundle.grantedScopes],
        selectionTokenHash: sha256(selectionToken),
        // THE SAME TTL THE AUTHORIZATION HAD. A grant left unchosen expires
        // with its flow rather than lingering as a usable token indefinitely.
        selectionExpiresAt: new Date(
          input.now.getTime() + this.#policy.oauth.stateTtlSeconds * 1_000,
        ),
      },
    });

    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'social.connection.selection_required',
      actorType: 'USER',
      actorId: input.record.startedByUserId,
      resourceType: 'SocialConnection',
      brandId: input.record.brandId,
      // A COUNT, NOT THE LIST. How many pages somebody administers is not
      // something the audit trail needs, and the names are theirs.
      after: { provider: input.record.provider, offeredTargetCount: input.targets.length },
    });

    return {
      outcome: 'selection_required',
      selectionToken,
      targets: input.targets,
      missingScopes: input.missingScopes,
    };
  }

  /**
   * What a pending selection offers, for the screen that renders the choice.
   *
   * THE SECRET IS THE KEY AND THE SESSION IS THE SECOND LOCK. The row is found
   * by the hash of the selection token — 32 bytes of CSPRNG, so unguessable —
   * AND the caller must be inside the same workspace, AND the brand must be in
   * their scope as a query predicate, AND they must be the person who started
   * the authorization. Any one of those failing produces the identical refusal.
   */
  async pendingSelection(input: {
    selectionToken: string;
    actor: OAuthActor;
  }): Promise<PendingSelectionView> {
    const record = await this.#loadPendingSelection(input);
    return {
      provider: record.provider,
      brandId: record.brandId,
      targets: parseOfferedTargets(record.offeredTargets),
      // The non-null assertion is unnecessary: the database CHECK
      // `social_oauth_state_pending_grant_is_whole` makes a row with a
      // selection hash and no expiry unrepresentable, and the loader below
      // already required the hash to match.
      expiresAt: record.selectionExpiresAt ?? record.expiresAt,
    };
  }

  /**
   * Bind the grant to the target the customer chose.
   *
   * THE CHOICE MUST BE ONE OF THE OFFERED TARGETS, checked against the list
   * recorded at callback time rather than against anything the request says.
   * That is what stops this being a target-enumeration primitive: an
   * `externalAccountId` invented by the caller, or lifted from another
   * workspace, is not in this row's list and is refused exactly as a forged
   * selection token is.
   *
   * SINGLE-USE, ENFORCED BY THE DATABASE. The conditional UPDATE that consumes
   * `selectionConsumedAt` is the same pattern the state itself uses, so two
   * concurrent choices cannot both create a connection.
   */
  async chooseTarget(input: {
    selectionToken: string;
    externalAccountId: string;
    actor: OAuthActor;
  }): Promise<SocialConnection> {
    const record = await this.#loadPendingSelection(input);

    const target = parseOfferedTargets(record.offeredTargets).find(
      (candidate) => candidate.externalAccountId === input.externalAccountId,
    );
    if (!target) throw oauthStateInvalid();

    const now = this.#clock.now();
    const consumed = await this.#db.socialOAuthState.updateMany({
      where: {
        id: record.id,
        workspaceId: this.#workspaceId,
        selectionConsumedAt: null,
        selectionExpiresAt: { gt: now },
      },
      data: { selectionConsumedAt: now },
    });
    if (consumed.count !== 1) throw oauthStateInvalid();

    const material = await this.#vault.openPendingGrant({
      ciphertext: record.pendingCiphertext ?? '',
      iv: record.pendingIv ?? '',
      authTag: record.pendingAuthTag ?? '',
      wrappedDataKey: record.pendingWrappedDataKey ?? '',
      keyProvider: record.pendingKeyProvider ?? '',
      keyId: record.pendingKeyId ?? '',
      algorithm: 'AES-256-GCM',
      encryptionContext: record.pendingEncryptionContext ?? '',
      maskedHint: '',
      fingerprint: '',
    });

    const granted = new Set(record.grantedScopes);
    const missingScopes = record.requestedScopes.filter((scope) => !granted.has(scope));

    const connection = await this.#connect({
      record,
      target,
      bundle: {
        accessToken: material.accessToken,
        refreshToken: material.refreshToken,
        // THE EXPIRY IS NOT CARRIED ACROSS THE PAUSE. We know when the token
        // was issued only approximately by now, and a token we claim expires
        // later than it does is a publish that fails at dispatch. Null means
        // "unknown", which the health probe and the refresh path both handle.
        expiresInSeconds: null,
        grantedScopes: record.grantedScopes,
      },
      missingScopes,
      now,
    });

    /*
     * THE SEALED GRANT IS ERASED once it has become a credential. Two copies of
     * a live token is two things to revoke, and the one nobody is looking at is
     * the one that outlives the disconnect.
     */
    await this.#db.socialOAuthState.update({
      where: { id: record.id },
      data: {
        pendingCiphertext: null,
        pendingIv: null,
        pendingAuthTag: null,
        pendingWrappedDataKey: null,
        pendingKeyProvider: null,
        pendingKeyId: null,
        pendingEncryptionContext: null,
        // `Prisma.DbNull`, not `null` and not `JsonNull`. For a nullable Json
        // column Prisma distinguishes a database NULL from the JSON value
        // `null`, and it is the DATABASE null the wholeness CHECK requires once
        // the grant has been consumed — the JSON null would satisfy
        // `IS NOT NULL` and fail the constraint.
        offeredTargets: Prisma.DbNull,
        selectionTokenHash: null,
        selectionExpiresAt: null,
      },
    });

    return connection;
  }

  /**
   * Find the pending selection this caller is allowed to act on, or refuse.
   *
   * FOUR PREDICATES, ALL IN THE `where`, ONE REFUSAL. The hash, the workspace,
   * the brand scope (D-134) and the person who started the flow. A row failing
   * any of them is never retrieved, so a caller cannot tell which one they
   * failed — or that the row exists at all.
   */
  async #loadPendingSelection(input: { selectionToken: string; actor: OAuthActor }) {
    const record = await this.#db.socialOAuthState.findFirst({
      where: {
        selectionTokenHash: sha256(input.selectionToken),
        workspaceId: this.#workspaceId,
        selectionConsumedAt: null,
        selectionExpiresAt: { gt: this.#clock.now() },
        // THE PERSON WHO AUTHORIZED IS THE PERSON WHO CHOOSES. Another member
        // of the same workspace holding the secret is still refused: they did
        // not stand in front of the provider's consent screen.
        startedByUserId: input.actor.userId,
        ...brandIdQueryFilter({ brandScope: input.actor.brandScope }),
      },
    });
    if (!record) throw oauthStateInvalid();
    return record;
  }

  /**
   * Create the connection and store its first credential.
   *
   * ONE PLACE, reached by both the single-target callback and the chosen-target
   * path, so the two cannot drift into recording different things.
   */
  async #connect(input: {
    record: { brandId: string; provider: SocialProvider; startedByUserId: string };
    target: PublishTarget;
    bundle: TokenBundle;
    missingScopes: readonly string[];
    now: Date;
  }): Promise<SocialConnection> {
    const capabilities = capabilitiesFor(this.#policy, input.record.provider);
    const expiresAt =
      input.bundle.expiresInSeconds === null
        ? null
        : new Date(input.now.getTime() + input.bundle.expiresInSeconds * 1_000);

    const connection = await this.#db.socialConnection.create({
      data: {
        workspaceId: this.#workspaceId,
        brandId: input.record.brandId,
        provider: input.record.provider,
        externalAccountId: input.target.externalAccountId,
        displayName: input.target.displayName,
        avatarUrl: input.target.avatarUrl,
        targetKind: input.target.targetKind || capabilities.targetKind,
        status: input.missingScopes.length > 0 ? 'NEEDS_REAUTH' : 'ACTIVE',
        grantedScopes: [...input.bundle.grantedScopes],
        connectedByUserId: input.record.startedByUserId,
        connectedAt: input.now,
        tokenExpiresAt: expiresAt,
        lastSyncedAt: input.now,
        lastCheckedAt: input.now,
        ...(input.missingScopes.length > 0
          ? { lastFailureClass: 'INSUFFICIENT_SCOPE' as const }
          : {}),
      },
    });

    await this.#storeCredential({
      connectionId: connection.id,
      version: 1,
      bundle: input.bundle,
      expiresAt,
    });

    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'social.connection.connected',
      actorType: 'USER',
      actorId: input.record.startedByUserId,
      resourceType: 'SocialConnection',
      resourceId: connection.id,
      brandId: input.record.brandId,
      // Identity and status. NO TOKEN, no scope VALUES that could identify the
      // grant, no provider response.
      after: {
        provider: connection.provider,
        status: connection.status,
        targetKind: connection.targetKind,
        missingScopeCount: input.missingScopes.length,
      },
    });

    return connection;
  }

  /**
   * Refresh a connection's token.
   *
   * WRITES A NEW VERSION AND RETIRES THE OLD ONE rather than overwriting, so a
   * rotation that half-fails leaves the previous token usable instead of
   * leaving the connection holding nothing.
   *
   * THE BRAND SCOPE IS A QUERY PREDICATE (D-132/D-134), and this method is the
   * reason the rule is written as "every read", not "every read that returns
   * something to a browser". It returns no connection detail a caller could not
   * already see — and it still ROTATES A CREDENTIAL, calls the provider, and
   * moves a connection between states. The first version took only an id and
   * scoped by workspace, so a member restricted to brand A who knew a brand B
   * connection id could rotate brand B's token: a write across a boundary they
   * cannot read across, which is the worse half of the same violation.
   *
   * THE SCOPE IS IN THE `where`, SO THE ROW IS NEVER RETRIEVED. An out-of-scope
   * id and an id that never existed both produce the identical refusal, and
   * neither reaches `#liveCredential` — no credential row is opened, nothing is
   * decrypted, and nothing is rotated on the refused path.
   */
  async refresh(input: {
    connectionId: string;
    brandScope: readonly string[];
  }): Promise<SocialConnection> {
    const connection = await this.#db.socialConnection.findFirst({
      where: {
        id: input.connectionId,
        workspaceId: this.#workspaceId,
        ...brandIdQueryFilter({ brandScope: input.brandScope }),
      },
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
