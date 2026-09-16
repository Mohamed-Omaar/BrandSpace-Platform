import { createHash } from 'node:crypto';
import type { PublishFailureClass, SocialProvider } from '@brandspace/database';
import type {
  AdapterApplication,
  AdapterCredentials,
  AuthorizationRequest,
  ConnectionHealth,
  PublishOutcome,
  PublishRequest,
  PublishTarget,
  SocialConnectorAdapter,
  TokenBundle,
} from './adapter';
import type { ProviderCapabilities } from './policy';

/**
 * Deterministic mock connectors.
 *
 * WHY THESE EXIST AND WHAT THEY ARE FOR. Every platform in this phase requires
 * business verification and app review before it will issue a production
 * credential — a multi-week, owner-driven process (D-18, D-19). A milestone
 * that could not be tested until that finished would be a milestone tested by
 * nobody. So the CONTRACT is exercised end to end against adapters that behave
 * like the real ones and never leave the process.
 *
 * WHAT THEY ARE NOT. They are not stubs that return success. They model the
 * failures that matter — rejection, rate limiting, an expired token, a timeout
 * whose outcome is unknown — because those are the paths the pipeline's
 * correctness actually rests on, and a mock that only succeeds tests the one
 * case that was never in doubt.
 *
 * DETERMINISTIC BY CONSTRUCTION. Behaviour is a pure function of the
 * idempotency key, so a test naming a key gets the same outcome on every run,
 * on every machine, for ever. There is no clock, no randomness and no shared
 * state — a flaky publishing test would be indistinguishable from the bug it is
 * meant to catch.
 *
 * PRODUCTION NEVER GETS THESE. `createConnectorRegistry` selects an
 * implementation by environment and there is no real one registered yet, so a
 * production build fails loudly rather than quietly publishing to nowhere.
 */

/**
 * The behaviour a mock exhibits, chosen by a marker inside the idempotency key.
 *
 * A MARKER RATHER THAN A CONFIGURED SWITCH, so one test can exercise success
 * and failure in the same run without mutating anything a parallel test can
 * see.
 */
const BEHAVIOUR_MARKERS = {
  'reject-content': 'CONTENT_REJECTED',
  'rate-limit': 'RATE_LIMITED',
  'auth-expired': 'AUTH_EXPIRED',
  'auth-revoked': 'AUTH_REVOKED',
  'platform-down': 'PLATFORM_UNAVAILABLE',
  timeout: 'TIMEOUT',
  duplicate: 'DUPLICATE_CONTENT',
  'media-invalid': 'MEDIA_INVALID',
  'target-gone': 'TARGET_UNAVAILABLE',
} as const satisfies Record<string, PublishFailureClass>;

function behaviourFor(idempotencyKey: string): PublishFailureClass | null {
  for (const [marker, failureClass] of Object.entries(BEHAVIOUR_MARKERS)) {
    if (idempotencyKey.includes(marker)) return failureClass as PublishFailureClass;
  }
  return null;
}

/** A stable fake external id: same input, same id, for ever. */
function deterministicId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16)}`;
}

const SAFE_SUMMARIES: Record<PublishFailureClass, string> = {
  CONTENT_REJECTED: 'The platform rejected this post.',
  RATE_LIMITED: 'The platform is rate limiting this account.',
  AUTH_EXPIRED: 'The access token has expired.',
  AUTH_REVOKED: 'Authorization was revoked at the platform.',
  INSUFFICIENT_SCOPE: 'The granted permissions do not cover publishing.',
  PLATFORM_UNAVAILABLE: 'The platform is temporarily unavailable.',
  TIMEOUT: 'The platform did not answer in time.',
  DUPLICATE_CONTENT: 'The platform reports this post already exists.',
  MEDIA_INVALID: 'The attached media was not accepted.',
  TARGET_UNAVAILABLE: 'The destination account is no longer reachable.',
  APPROVAL_REVOKED: 'Approval was withdrawn before publishing.',
  NOT_CONNECTED: 'The account is not connected.',
  UNSUPPORTED: 'The platform does not support this action.',
  UNKNOWN: 'The platform returned an unexpected response.',
};

const STATUS_FOR: Partial<Record<PublishFailureClass, number>> = {
  CONTENT_REJECTED: 400,
  MEDIA_INVALID: 400,
  RATE_LIMITED: 429,
  AUTH_EXPIRED: 401,
  AUTH_REVOKED: 401,
  INSUFFICIENT_SCOPE: 403,
  TARGET_UNAVAILABLE: 404,
  DUPLICATE_CONTENT: 409,
  PLATFORM_UNAVAILABLE: 503,
};

/** How many targets each provider's mock offers, so the picker is exercised. */
const MOCK_TARGET_COUNT: Record<SocialProvider, number> = {
  FACEBOOK: 2,
  INSTAGRAM: 1,
  TIKTOK: 1,
  LINKEDIN: 2,
  X: 1,
};

const TARGET_LABEL: Record<SocialProvider, string> = {
  FACEBOOK: 'Page',
  INSTAGRAM: 'Business account',
  TIKTOK: 'Creator account',
  LINKEDIN: 'Organization',
  X: 'Account',
};

export class MockSocialConnectorAdapter implements SocialConnectorAdapter {
  readonly provider: SocialProvider;
  readonly capabilities: ProviderCapabilities;
  /** Where a mock "post" would live. Never resolves; it is evidence, not a link. */
  readonly #baseUrl: string;

  constructor(provider: SocialProvider, capabilities: ProviderCapabilities) {
    this.provider = provider;
    this.capabilities = capabilities;
    this.#baseUrl = `https://mock.invalid/${provider.toLowerCase()}`;
  }

  buildAuthorizationUrl(request: AuthorizationRequest): string {
    /*
     * THE SECRET IS NOT IN THIS URL, and that is worth asserting rather than
     * assuming: this string goes to a browser. Only the app id, the exact
     * redirect, the scopes, the state and the PKCE challenge travel.
     */
    const url = new URL(`${this.#baseUrl}/oauth/authorize`);
    url.searchParams.set('client_id', request.application.appId);
    url.searchParams.set('redirect_uri', request.application.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', request.scopes.join(' '));
    url.searchParams.set('state', request.state);
    url.searchParams.set('code_challenge', request.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  async exchangeCode(input: {
    code: string;
    codeVerifier: string;
    application: AdapterApplication;
  }): Promise<TokenBundle> {
    if (input.code.includes('invalid')) {
      throw new Error('mock provider refused the authorization code');
    }
    /*
     * THE MOCK GRANTS LESS THAN ASKED when told to, because that is the case
     * the product has to handle well: a partial grant must become
     * `needs_reauth`, not a connection that looks fine and fails at publish
     * time (docs/SOCIAL-INTEGRATIONS.md §4).
     */
    const partial = input.code.includes('partial-scope');
    const granted = partial
      ? this.capabilities.scopes.slice(0, Math.max(0, this.capabilities.scopes.length - 1))
      : this.capabilities.scopes;
    return {
      accessToken: deterministicId('mock-access', this.provider, input.code),
      refreshToken: input.code.includes('no-refresh')
        ? null
        : deterministicId('mock-refresh', this.provider, input.code),
      expiresInSeconds: 3_600,
      grantedScopes: granted,
    };
  }

  async refreshToken(input: {
    refreshToken: string;
    application: AdapterApplication;
  }): Promise<TokenBundle> {
    if (input.refreshToken.includes('revoked')) {
      throw new Error('mock provider reports the refresh token was revoked');
    }
    return {
      // ROTATED, because the providers that rotate are the ones that break a
      // naive implementation: reusing a spent refresh token is an error the
      // customer only sees at the worst moment.
      accessToken: deterministicId('mock-access', this.provider, input.refreshToken, 'refreshed'),
      refreshToken: deterministicId('mock-refresh', this.provider, input.refreshToken, 'rotated'),
      expiresInSeconds: 3_600,
      grantedScopes: this.capabilities.scopes,
    };
  }

  async revoke(input: {
    credentials: AdapterCredentials;
    application: AdapterApplication;
  }): Promise<void> {
    if (input.credentials.accessToken.includes('revoke-fails')) {
      throw new Error('mock provider could not revoke');
    }
  }

  async listTargets(input: { credentials: AdapterCredentials }): Promise<readonly PublishTarget[]> {
    const count = MOCK_TARGET_COUNT[this.provider];
    return Array.from({ length: count }, (_unused, index) => ({
      externalAccountId: deterministicId(
        'mock-target',
        this.provider,
        input.credentials.accessToken,
        String(index),
      ),
      displayName: `${TARGET_LABEL[this.provider]} ${index + 1}`,
      avatarUrl: null,
      targetKind: this.capabilities.targetKind,
    }));
  }

  async checkHealth(input: { credentials: AdapterCredentials }): Promise<ConnectionHealth> {
    const unhealthy = input.credentials.accessToken.includes('unhealthy');
    return { healthy: !unhealthy, failureClass: unhealthy ? 'AUTH_EXPIRED' : null };
  }

  async publish(input: {
    request: PublishRequest;
    credentials: AdapterCredentials;
  }): Promise<PublishOutcome> {
    const forced = behaviourFor(input.request.idempotencyKey);
    if (forced) {
      return {
        ok: false,
        failureClass: forced,
        failureCode: `mock.${forced.toLowerCase()}`,
        providerStatusCode: STATUS_FOR[forced] ?? null,
        providerErrorCode: `MOCK_${forced}`,
        safeSummary: SAFE_SUMMARIES[forced],
        ...(forced === 'RATE_LIMITED' ? { retryAfterSeconds: 60 } : {}),
      };
    }

    /*
     * THE CEILING IS CHECKED HERE TOO, not only in the pipeline. An adapter is
     * the last thing between us and a platform, and a caption that overruns is
     * a rejection the real provider would issue — so the mock issues it, and
     * the pipeline's pre-flight is proven to be a convenience rather than the
     * only thing standing between a customer and a failed post.
     */
    if (input.request.body.length > this.capabilities.maxBodyCharacters) {
      return {
        ok: false,
        failureClass: 'CONTENT_REJECTED',
        failureCode: 'mock.body_too_long',
        providerStatusCode: 400,
        providerErrorCode: 'MOCK_BODY_TOO_LONG',
        safeSummary: SAFE_SUMMARIES.CONTENT_REJECTED,
      };
    }
    if (input.request.firstComment !== null && !this.capabilities.supportsFirstComment) {
      return {
        ok: false,
        failureClass: 'UNSUPPORTED',
        failureCode: 'mock.first_comment_unsupported',
        providerStatusCode: 400,
        providerErrorCode: 'MOCK_UNSUPPORTED',
        safeSummary: SAFE_SUMMARIES.UNSUPPORTED,
      };
    }

    const externalPostId = deterministicId(
      'mock-post',
      this.provider,
      input.request.externalAccountId,
      // KEYED ON THE IDEMPOTENCY KEY, so publishing the same job twice yields
      // the SAME external id. That is what a real provider's idempotency token
      // buys, and modelling it means the duplicate-prevention tests are testing
      // the behaviour they claim to.
      input.request.idempotencyKey,
    );
    return {
      ok: true,
      externalPostId,
      externalPostUrl: `${this.#baseUrl}/p/${externalPostId}`,
      providerStatusCode: 201,
    };
  }

  async findPostByIdempotencyKey(input: {
    externalAccountId: string;
    idempotencyKey: string;
    credentials: AdapterCredentials;
  }): Promise<{ externalPostId: string; externalPostUrl: string | null } | null> {
    if (!this.capabilities.supportsPostLookup) return null;
    /*
     * THE CASE THIS EXISTS FOR. A job whose key says `timeout` is one whose
     * request left and whose answer did not return. Asking the provider is the
     * ONLY correct next step; sending again is how a customer gets two
     * identical posts. The mock answers "yes, it landed" for `timeout` and "no"
     * for `platform-down`, so both branches are exercised.
     */
    if (input.idempotencyKey.includes('timeout')) {
      const externalPostId = deterministicId(
        'mock-post',
        this.provider,
        input.externalAccountId,
        input.idempotencyKey,
      );
      return { externalPostId, externalPostUrl: `${this.#baseUrl}/p/${externalPostId}` };
    }
    return null;
  }

  classifyError(error: unknown): PublishFailureClass {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('revoked')) return 'AUTH_REVOKED';
    if (message.includes('expired')) return 'AUTH_EXPIRED';
    if (message.includes('timeout')) return 'TIMEOUT';
    if (message.includes('rate')) return 'RATE_LIMITED';
    // AND NOTHING ELSE. Guessing a class from an unrecognised message is how an
    // unknown failure becomes a retried one, and a retried unknown failure is
    // how a post goes out twice.
    return 'UNKNOWN';
  }
}
