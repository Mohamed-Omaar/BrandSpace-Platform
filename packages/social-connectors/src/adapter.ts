import type { PublishFailureClass, SocialProvider } from '@brandspace/database';
import type { ProviderCapabilities } from './policy';

/**
 * The connector contract — docs/SOCIAL-INTEGRATIONS.md §2.1.
 *
 * EVERY EXTERNAL PLATFORM IS REACHED THROUGH THIS AND NOTHING ELSE. Adding
 * Meta, TikTok, LinkedIn or X for real means writing an implementation of this
 * interface and activating it in configuration — no business logic changes, no
 * new branch in the pipeline, no `if (provider === …)` anywhere above this line.
 *
 * WHAT THE INTERFACE DELIBERATELY DOES NOT HAVE:
 *
 *   - No database. An adapter is given what it needs and returns what it found;
 *     it cannot read a token, a connection or a content item for itself.
 *   - No credential RESOLUTION. `AdapterCredentials` arrives already decrypted
 *     by the one code path allowed to do that, on the server, and the adapter
 *     must not log it, attach it to a span, or put it in an error.
 *   - No retry. Retrying is a decision about a workspace's schedule and quota,
 *     which an adapter cannot see. It classifies; the pipeline decides.
 *
 * CAPABILITIES ARE DECLARED, NOT ASSUMED EQUAL (docs/SOCIAL-INTEGRATIONS.md
 * §1.7). Anything a provider cannot do is absent from its capabilities and the
 * pipeline refuses BEFORE any external call, with `UNSUPPORTED` — never by
 * letting the platform reject it and calling that a content error.
 */

/** Already-decrypted OAuth material. Never logged, never serialized. */
export interface AdapterCredentials {
  readonly accessToken: string;
  readonly refreshToken: string | null;
}

/** The platform app's own identity, resolved from platform configuration. */
export interface AdapterApplication {
  readonly appId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

export interface AuthorizationRequest {
  /** Opaque, single-use, already bound to a workspace and a user. */
  readonly state: string;
  /** PKCE challenge, derived from a verifier the caller keeps encrypted. */
  readonly codeChallenge: string;
  readonly scopes: readonly string[];
  readonly application: AdapterApplication;
}

export interface TokenBundle {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresInSeconds: number | null;
  /** What the provider ACTUALLY granted, which may be less than we asked for. */
  readonly grantedScopes: readonly string[];
}

export interface PublishTarget {
  /** The provider's own id for the page / channel / profile. */
  readonly externalAccountId: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  /** page, business_account, organization, profile, … */
  readonly targetKind: string;
}

/**
 * ONE MEDIA ITEM ON A PUBLISH REQUEST (AC-29.3).
 *
 * WHAT THE ADAPTER IS GIVEN, AND WHAT IT IS NOT. It gets an identity, a type,
 * a size, dimensions and the BYTES. It does NOT get a storage key, a signed
 * url or anything it could use to reach into the library on its own: an
 * adapter is a translator to one provider's API, and handing it a way to fetch
 * a tenant's files would make every adapter a place tenant isolation could
 * fail.
 *
 * THE BYTES ARE RESOLVED BY THE PIPELINE, after it has checked that the asset
 * belongs to this workspace, this brand and this member's scope, that it is
 * READY and CLEAN, and that the provider accepts its type — all before an
 * adapter is called at all.
 */
export interface PublishMedia {
  /** The asset's id, so a provider error can be traced back to a file. */
  readonly assetId: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly width: number | null;
  readonly height: number | null;
  /** The file name to present to the provider. Never a path. */
  readonly fileName: string;
  readonly bytes: Uint8Array;
}

export interface PublishRequest {
  readonly externalAccountId: string;
  readonly body: string;
  readonly hashtags: readonly string[];
  readonly firstComment: string | null;
  /**
   * PHASE 8 — the media to publish with this post, in the author's order.
   *
   * EMPTY IS NORMAL: a text post is the commonest thing this product sends. An
   * adapter whose provider cannot accept media at all should refuse a
   * non-empty list rather than dropping it — but it will not have to, because
   * the pipeline checks the capability first and never builds the request.
   */
  readonly media: readonly PublishMedia[];
  /**
   * Passed through to providers that accept a client-side idempotency token, so
   * a duplicate request is de-duplicated at the far end too rather than only at
   * ours.
   */
  readonly idempotencyKey: string;
}

export interface PublishSuccess {
  readonly ok: true;
  readonly externalPostId: string;
  readonly externalPostUrl: string | null;
  readonly providerStatusCode: number;
}

export interface PublishFailure {
  readonly ok: false;
  readonly failureClass: PublishFailureClass;
  /** Stable machine code for the UI. NEVER the provider's own message. */
  readonly failureCode: string;
  readonly providerStatusCode: number | null;
  readonly providerErrorCode: string | null;
  /** Short, redacted, bounded. Safe to store and to show support. */
  readonly safeSummary: string;
  /** Honoured for `RATE_LIMITED`, where the provider tells us when to return. */
  readonly retryAfterSeconds?: number;
}

export type PublishOutcome = PublishSuccess | PublishFailure;

/**
 * What an adapter can say about a connection.
 *
 * NO TIMESTAMP. The adapter reports the ANSWER; the caller stamps WHEN, with
 * the clock it was injected with. An adapter reading its own clock would make
 * every health path untestable without freezing real time, and the platform's
 * lint rule says so — correctly.
 */
export interface ConnectionHealth {
  readonly healthy: boolean;
  readonly failureClass: PublishFailureClass | null;
}

export interface SocialConnectorAdapter {
  readonly provider: SocialProvider;
  readonly capabilities: ProviderCapabilities;

  /** Where to send the customer's browser. Never contains the client secret. */
  buildAuthorizationUrl(request: AuthorizationRequest): string;

  exchangeCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly application: AdapterApplication;
  }): Promise<TokenBundle>;

  refreshToken(input: {
    readonly refreshToken: string;
    readonly application: AdapterApplication;
  }): Promise<TokenBundle>;

  /**
   * Revoke at the provider. Best effort by contract: a provider that is down
   * must not stop a customer from disconnecting on our side, so the caller
   * marks the connection revoked either way and records that the remote
   * revocation did not land.
   */
  revoke(input: {
    readonly credentials: AdapterCredentials;
    readonly application: AdapterApplication;
  }): Promise<void>;

  /** Pages / channels / profiles this grant can publish to. */
  listTargets(input: {
    readonly credentials: AdapterCredentials;
  }): Promise<readonly PublishTarget[]>;

  checkHealth(input: { readonly credentials: AdapterCredentials }): Promise<ConnectionHealth>;

  publish(input: {
    readonly request: PublishRequest;
    readonly credentials: AdapterCredentials;
  }): Promise<PublishOutcome>;

  /**
   * "Did this post land?" — the answer that turns an indeterminate attempt into
   * a decision. OPTIONAL, and its absence is load-bearing: where a provider
   * cannot be asked, `capabilities.supportsPostLookup` is false and the
   * pipeline refuses to retry an indeterminate attempt at all, because a
   * duplicate post is worse than a missing one.
   */
  findPostByIdempotencyKey?(input: {
    readonly externalAccountId: string;
    readonly idempotencyKey: string;
    readonly credentials: AdapterCredentials;
  }): Promise<{ externalPostId: string; externalPostUrl: string | null } | null>;

  /** Turn whatever went wrong into a class the pipeline can act on. */
  classifyError(error: unknown): PublishFailureClass;
}
