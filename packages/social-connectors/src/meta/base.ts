import type { PublishFailureClass, SocialProvider } from '@brandspace/database';
import type {
  AdapterApplication,
  AdapterCredentials,
  AuthorizationRequest,
  ConnectionHealth,
  PublishFailure,
  PublishOutcome,
  PublishRequest,
  PublishTarget,
  SocialConnectorAdapter,
  TokenBundle,
} from '../adapter';
import type { ProviderCapabilities } from '../policy';
import {
  classifyMetaError,
  graphRequest,
  META_DIALOG_HOST,
  META_SAFE_SUMMARIES,
  metaFailureCode,
  MetaShapeError,
  optionalString,
  stringField,
  type GraphFetch,
} from './graph';

/**
 * CONNECTORS B — WHAT THE FACEBOOK AND INSTAGRAM ADAPTERS SHARE: ONE META APP,
 * ONE LOGIN (D-505 O2/O3).
 *
 * Both are reached through Facebook Login for Business: the same dialog, the
 * same token endpoint, the same app-scoped user id. This class is that login
 * and the Graph plumbing; each subclass is only what differs — which targets a
 * grant offers, what a target's token is, and how a post is made.
 *
 * META HAS NO REFRESH TOKEN for these grants. A short-lived user token is
 * exchanged at once for a long-lived one (about 60 days, Meta's figure); a
 * Page token derived from a long-lived user token does not expire. When a
 * token stops working the connection needs the customer to reconnect, which
 * the product already handles (`AUTH_REVOKED` → NEEDS_REAUTH).
 *
 * NOT YET RUN AGAINST META. Every request and answer shape here is Meta's
 * documented one (cited per call) and is exercised by recorded fixtures
 * (`tests/unit/connectors-b-meta-adapters.test.ts`). The first real run is the
 * owner's, on staging, with the Meta app in development mode (D-533).
 */

export interface MetaAdapterOptions {
  readonly fetch?: GraphFetch;
  /** Per-call ceiling. Default 30 s. */
  readonly timeoutMs?: number;
}

export abstract class MetaAdapterBase implements SocialConnectorAdapter {
  readonly provider: SocialProvider;
  readonly capabilities: ProviderCapabilities;
  protected readonly apiVersion: string;
  readonly #fetch: GraphFetch;
  readonly #timeoutMs: number | undefined;

  constructor(
    provider: SocialProvider,
    capabilities: ProviderCapabilities,
    options: MetaAdapterOptions = {},
  ) {
    if (capabilities.apiVersion === null) {
      throw new Error(
        `The ${provider} adapter needs publishing.providers.${provider.toLowerCase()}.apiVersion.`,
      );
    }
    this.provider = provider;
    this.capabilities = capabilities;
    this.apiVersion = capabilities.apiVersion;
    this.#fetch = options.fetch ?? (globalThis.fetch as unknown as GraphFetch);
    this.#timeoutMs = options.timeoutMs;
  }

  /** One Graph call on this adapter's version and transport. */
  protected graph(input: {
    method?: 'GET' | 'POST' | 'DELETE';
    path: string;
    query?: Record<string, string>;
    form?: Record<string, string>;
    accessToken?: string;
  }): Promise<Record<string, unknown>> {
    return graphRequest({
      fetch: this.#fetch,
      apiVersion: this.apiVersion,
      ...input,
      ...(this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs }),
    });
  }

  /**
   * The Facebook Login dialog (developers.facebook.com/docs/facebook-login/
   * guides/advanced/manual-flow). With a Facebook Login for Business
   * configuration id (`settings.loginConfigId`) the configuration states the
   * permissions and `scope` is not sent; without one, the configured scopes
   * are. PKCE is sent as Meta documents it for manually built flows
   * (…/guides/advanced/oidc-token); `state` remains the request's binding.
   */
  buildAuthorizationUrl(request: AuthorizationRequest): string {
    const url = new URL(`${META_DIALOG_HOST}/${this.apiVersion}/dialog/oauth`);
    url.searchParams.set('client_id', request.application.appId);
    url.searchParams.set('redirect_uri', request.application.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', request.state);
    const configId = request.application.settings?.['loginConfigId'];
    if (configId) url.searchParams.set('config_id', configId);
    else url.searchParams.set('scope', request.scopes.join(','));
    url.searchParams.set('code_challenge', request.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  /**
   * Code → short-lived user token → long-lived user token, then who granted it
   * and what they granted (…/manual-flow; …/access-tokens/get-long-lived).
   */
  async exchangeCode(input: {
    code: string;
    codeVerifier: string;
    application: AdapterApplication;
  }): Promise<TokenBundle> {
    const short = await this.graph({
      path: 'oauth/access_token',
      query: {
        client_id: input.application.appId,
        client_secret: input.application.clientSecret,
        redirect_uri: input.application.redirectUri,
        code: input.code,
        code_verifier: input.codeVerifier,
      },
    });
    const long = await this.graph({
      path: 'oauth/access_token',
      query: {
        grant_type: 'fb_exchange_token',
        client_id: input.application.appId,
        client_secret: input.application.clientSecret,
        fb_exchange_token: stringField(short, 'access_token'),
      },
    });
    const accessToken = stringField(long, 'access_token');
    const expiresIn = long['expires_in'];
    const me = await this.graph({ path: 'me', query: { fields: 'id' }, accessToken });
    const permissions = await this.graph({ path: 'me/permissions', accessToken });
    return {
      accessToken,
      refreshToken: null,
      expiresInSeconds: typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn : null,
      grantedScopes: grantedPermissions(permissions),
      subjectId: stringField(me, 'id'),
    };
  }

  async refreshToken(): Promise<TokenBundle> {
    // Meta issues no refresh token for these grants: the customer reconnects.
    throw new MetaShapeError('Meta grants have no refresh token');
  }

  /**
   * NOT REVOKED AT META, ON PURPOSE. One Meta grant covers every Page and
   * Instagram account the person connected, in every brand; removing it
   * (`DELETE /me/permissions`) to disconnect one account would silently
   * disconnect the others. The caller records "not revoked at the platform",
   * and the person removes the app in their Facebook settings — which reaches
   * our deauthorize callback (D-533).
   */
  async revoke(): Promise<void> {
    throw new MetaShapeError('a Meta grant is not revoked for one account');
  }

  async checkHealth(input: { credentials: AdapterCredentials }): Promise<ConnectionHealth> {
    try {
      await this.graph({
        path: 'me',
        query: { fields: 'id' },
        accessToken: input.credentials.accessToken,
      });
      return { healthy: true, failureClass: null };
    } catch (error) {
      return { healthy: false, failureClass: classifyMetaError(error) };
    }
  }

  classifyError(error: unknown): PublishFailureClass {
    return classifyMetaError(error);
  }

  abstract listTargets(input: {
    credentials: AdapterCredentials;
  }): Promise<readonly PublishTarget[]>;

  abstract publish(input: {
    request: PublishRequest;
    credentials: AdapterCredentials;
  }): Promise<PublishOutcome>;

  /** Every Page the grant reaches, following Meta's cursor (bounded). */
  protected async pagesOf(accessToken: string, fields: string): Promise<Record<string, unknown>[]> {
    const pages: Record<string, unknown>[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_TARGET_PAGES; page += 1) {
      const answer: Record<string, unknown> = await this.graph({
        path: 'me/accounts',
        query: { fields, limit: '100', ...(after ? { after } : {}) },
        accessToken,
      });
      const data = answer['data'];
      if (!Array.isArray(data)) throw new MetaShapeError('me/accounts without data');
      pages.push(...data.filter(isRecord));
      const paging = isRecord(answer['paging']) ? answer['paging'] : null;
      const cursors = paging && isRecord(paging['cursors']) ? paging['cursors'] : null;
      after = paging?.['next'] && cursors ? optionalString(cursors, 'after') : null;
      if (!after) break;
    }
    return pages;
  }

  /** A caught Graph error as a publish failure, in Meta's numbers and our words. */
  protected failure(error: unknown): PublishFailure {
    const failureClass = classifyMetaError(error);
    const status =
      error !== null && typeof error === 'object' && 'status' in error
        ? Number((error as { status: unknown }).status)
        : null;
    const code =
      error !== null && typeof error === 'object' && 'code' in error
        ? (error as { code: unknown }).code
        : null;
    return {
      ok: false,
      failureClass,
      failureCode: metaFailureCode(error),
      providerStatusCode: Number.isFinite(status) ? status : null,
      providerErrorCode: typeof code === 'number' ? String(code) : null,
      safeSummary: META_SAFE_SUMMARIES[failureClass],
    };
  }

  /** A refusal decided before any call. */
  protected refused(failureClass: PublishFailureClass, failureCode: string): PublishFailure {
    return {
      ok: false,
      failureClass,
      failureCode,
      providerStatusCode: null,
      providerErrorCode: null,
      safeSummary: META_SAFE_SUMMARIES[failureClass],
    };
  }
}

/** Meta caps nothing here; we stop after this many pages of Pages (100 each). */
const MAX_TARGET_PAGES = 10;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `GET /me/permissions` → the permissions whose status is `granted`. */
export function grantedPermissions(answer: Record<string, unknown>): string[] {
  const data = answer['data'];
  if (!Array.isArray(data)) throw new MetaShapeError('me/permissions without data');
  return data
    .filter(isRecord)
    .filter((row) => row['status'] === 'granted' && typeof row['permission'] === 'string')
    .map((row) => row['permission'] as string);
}

/** The caption Meta receives: the author's text, then the hashtags. */
export function captionOf(request: Pick<PublishRequest, 'body' | 'hashtags'>): string {
  const tags = request.hashtags
    .map((tag) => tag.replace(/^#+/, '').trim())
    .filter((tag) => tag.length > 0)
    .map((tag) => `#${tag}`)
    .join(' ');
  return tags.length === 0 ? request.body : `${request.body}\n\n${tags}`;
}
