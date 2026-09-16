import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ConfigurationService } from '@brandspace/config';
import { CUSTOMER_REALM, CustomerAuthService } from '@brandspace/auth';
import { getPrisma, withWorkspace, type SocialProvider } from '@brandspace/database';
import { getPlatformClient } from '@brandspace/database/platform';
import { SecretService } from '@brandspace/secrets';
import {
  createConnectorRegistry,
  resolvePublishingPolicy,
  SocialConnectionService,
  SocialOAuthService,
  SocialTokenVault,
  SOCIAL_PROVIDERS,
  type AdapterApplication,
  type ApplicationResolver,
} from '@brandspace/social-connectors';
import { createLogger, internalErrorFields, isAppError } from '@brandspace/shared';
import { route } from '../route-contract';

/**
 * Social account connection — the OAuth half of Phase 6.
 *
 * WHY THIS LIVES IN apps/api AND NOT IN THE DASHBOARD. The same seam the Brand
 * Brain chat and the Content Studio already crossed. Completing an OAuth
 * exchange needs the PLATFORM app's own client secret, which lives in
 * `integrations.social-apps` and resolves through the Secret Service — and F-07
 * forbids the customer dashboard from importing that path at all. `apps/api` is
 * the designated platform surface.
 *
 * THE TWO IDENTITIES DO TWO DIFFERENT THINGS AND NEITHER BORROWS THE OTHER'S
 * REACH:
 *   - PLATFORM identity: reading `integrations.social-apps` and decrypting the
 *     client secret. It touches no tenant table.
 *   - TENANT identity (`withWorkspace`): the OAuth state row, the connection and
 *     the encrypted customer token, all under RLS.
 *
 * THE CLIENT SECRET NEVER LEAVES THIS PROCESS. It is resolved per request,
 * handed to the adapter, and never written to a row, a log, a span or a
 * response. The only thing that reaches the browser is an authorization URL.
 */

const log = createLogger({ context: { component: 'api.social' } });

const CONNECT_PERMISSION = 'integrations.manage';
const READ_PERMISSION = 'integrations.read';

const startSchema = z.object({
  provider: z.enum(SOCIAL_PROVIDERS),
  brandId: z.string().uuid(),
});

/**
 * The path parameter, matched case-insensitively against the provider set.
 *
 * `callbackUriFor()` lower-cases the provider when it builds the URL, so that
 * is what a provider redirects back with. Parsing it here rather than trusting
 * it keeps an unknown value from ever reaching the registry.
 */
const providerParamSchema = z.object({
  provider: z
    .string()
    .transform((value) => value.toUpperCase())
    .pipe(z.enum(SOCIAL_PROVIDERS)),
});

/**
 * What a provider puts in the query string of its redirect.
 *
 * `code` AND `state` ARE OPTIONAL IN THE SCHEMA and required by the handler,
 * because a denial carries `error` and neither of the other two. Making them
 * mandatory here would turn "the customer pressed Cancel" into a validation
 * failure and lose the one case worth telling them apart from a fault.
 */
const callbackQuerySchema = z.object({
  state: z.string().min(1).max(512).optional(),
  code: z.string().min(1).max(4_096).optional(),
  error: z.string().max(256).optional(),
  // ACCEPTED AND DISCARDED. A provider's `error_description` echoes the
  // request, which carried a code; it is parsed so an unexpected key cannot
  // fail the request, and never read.
  error_description: z.string().max(2_048).optional(),
});

const selectionTokenSchema = z.object({
  selectionToken: z.string().min(1).max(512),
});

const chooseTargetSchema = selectionTokenSchema.extend({
  externalAccountId: z.string().min(1).max(256),
});

let cachedConfiguration: ConfigurationService | null = null;
let cachedSecrets: SecretService | null = null;

function configurationService(): ConfigurationService {
  cachedConfiguration ??= new ConfigurationService({ prisma: getPlatformClient() });
  return cachedConfiguration;
}

function secretService(): SecretService {
  cachedSecrets ??= new SecretService({ prisma: getPlatformClient() });
  return cachedSecrets;
}

function currentEnvironment(): 'DEVELOPMENT' | 'STAGING' | 'PRODUCTION' {
  const appEnv = process.env['APP_ENV'] ?? 'development';
  if (appEnv === 'production') return 'PRODUCTION';
  if (appEnv === 'staging') return 'STAGING';
  return 'DEVELOPMENT';
}

/**
 * Where the callback lives, and why it is configuration rather than a constant.
 *
 * STAGING WILL BE `api-staging.brandspace.cc` AND PRODUCTION WILL NOT, and
 * neither is known to this file. `PUBLIC_API_BASE_URL` is read at request time
 * so a new environment is a variable, never a code change — which is the whole
 * requirement behind "OAuth callback URLs must be configurable".
 *
 * The URI recorded when a flow starts is the one the callback is checked
 * against, so changing this variable does not retroactively invalidate a flow
 * already in progress: it simply fails the exact-match check, which is the
 * correct outcome.
 */
function callbackUriFor(provider: SocialProvider): string {
  const base = process.env['PUBLIC_API_BASE_URL'];
  if (!base) {
    throw new Error(
      'PUBLIC_API_BASE_URL is required to build an OAuth callback URL. ' +
        'Set it per environment; it is never hard-coded.',
    );
  }
  return `${base.replace(/\/+$/, '')}/v1/social/callback/${provider.toLowerCase()}`;
}

/**
 * The platform app's own identity for one provider.
 *
 * READS CONFIGURATION, THEN THE VAULT, IN THAT ORDER, and refuses loudly if
 * either is missing. A half-configured provider must not produce an
 * authorization URL that sends a customer to a consent screen which then fails.
 */
function applicationResolver(): ApplicationResolver {
  return {
    async resolve(provider: SocialProvider): Promise<AdapterApplication> {
      const environment = currentEnvironment();
      const document = (await configurationService().get(
        'integrations.social-apps',
        environment,
      )) as {
        applications?: readonly {
          providerKey: string;
          appId: string;
          clientSecretRef: string | null;
          status: string;
        }[];
      };
      const key = provider.toLowerCase();
      const application = document.applications?.find(
        (candidate) => candidate.providerKey === key && candidate.status === 'active',
      );
      if (!application) {
        throw new Error(`No active social application is configured for ${key}.`);
      }
      if (!application.clientSecretRef) {
        throw new Error(`The social application for ${key} has no client secret configured.`);
      }
      const clientSecret = await secretService().resolveSecret(
        application.clientSecretRef,
        environment,
      );
      return {
        appId: application.appId,
        clientSecret,
        // THE REDIRECT COMES FROM THE ENVIRONMENT, not from the document, so a
        // single activated configuration is correct in every environment.
        redirectUri: callbackUriFor(provider),
      };
    },
  };
}

function sessionTokenFrom(req: FastifyRequest): string | null {
  const header = req.headers['authorization'];
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7);
  const cookie = req.headers['cookie'];
  if (typeof cookie !== 'string') return null;
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === CUSTOMER_REALM.cookieName) return rest.join('=');
  }
  return null;
}

interface Caller {
  readonly userId: string;
  readonly workspaceId: string;
  readonly brandScope: readonly string[];
}

/**
 * Resolve the caller, or the reply that refuses.
 *
 * A missing session is a 401. Everything else — no active workspace, a
 * membership since removed, a member without the permission — is a 404 shaped
 * exactly like a genuine miss (CLAUDE.md §2.1).
 */
async function resolveCaller(
  req: FastifyRequest,
  reply: FastifyReply,
  permission: string,
): Promise<Caller | null> {
  const token = sessionTokenFrom(req);
  if (!token) {
    await reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
    return null;
  }
  const auth = new CustomerAuthService({ prisma: getPrisma() });
  const customer = await auth.resolve(token).catch(() => null);
  if (!customer) {
    await reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
    return null;
  }
  const workspaces = await auth.listWorkspaces(token).catch(() => null);
  const workspace = workspaces?.find((w) => w.workspaceId === customer.activeWorkspaceId);
  if (!workspace || !workspace.permissionKeys.includes(permission)) {
    await reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    return null;
  }
  return {
    userId: customer.userId,
    workspaceId: workspace.workspaceId,
    brandScope: workspace.brandScope,
  };
}

async function oauthServiceFor<T>(
  workspaceId: string,
  fn: (service: SocialOAuthService) => Promise<T>,
): Promise<T> {
  const environment = currentEnvironment();
  const policy = await resolvePublishingPolicy(configurationService(), environment);
  return withWorkspace(workspaceId, async (db) =>
    fn(
      new SocialOAuthService({
        db,
        workspaceId,
        policy,
        registry: createConnectorRegistry({ policy, environment }),
        vault: new SocialTokenVault(),
        applications: applicationResolver(),
      }),
    ),
  );
}

async function connectionServiceFor<T>(
  workspaceId: string,
  fn: (service: SocialConnectionService) => Promise<T>,
): Promise<T> {
  const environment = currentEnvironment();
  const policy = await resolvePublishingPolicy(configurationService(), environment);
  return withWorkspace(workspaceId, async (db) =>
    fn(
      new SocialConnectionService({
        db,
        workspaceId,
        registry: createConnectorRegistry({ policy, environment }),
        vault: new SocialTokenVault(),
        // THE RESOLVER IS PRESENT HERE and absent in the dashboard. That is the
        // whole reason disconnection lives on this surface.
        applications: applicationResolver(),
      }),
    ),
  );
}

export function registerSocialRoutes(app: FastifyInstance): void {
  /**
   * Begin an authorization.
   *
   * A HIGH-IMPACT ACTION: it ends with BrandSpace able to post as the customer,
   * so it declares a confirmation policy and writes an audit event
   * (CLAUDE.md §2.5).
   */
  route(
    app,
    'POST',
    '/v1/social/connect',
    {
      scope: 'workspace',
      permission: CONNECT_PERMISSION,
      confirmation: 'required',
      idempotent: false,
    },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, CONNECT_PERMISSION);
      if (!caller) return;

      const parsed = startSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });
      }

      try {
        const result = await oauthServiceFor(caller.workspaceId, (service) =>
          service.start({
            provider: parsed.data.provider,
            brandId: parsed.data.brandId,
            actor: { userId: caller.userId, brandScope: caller.brandScope },
          }),
        );
        // THE URL AND THE EXPIRY. The state travels inside the URL and is not
        // repeated as a field: a value echoed in a JSON body is a value that
        // ends up in a browser console, a proxy log and a bug report.
        return reply.code(201).send({
          authorizationUrl: result.authorizationUrl,
          expiresAt: result.expiresAt.toISOString(),
        });
      } catch (error: unknown) {
        await sendFailure(reply, error, 'connect');
        return;
      }
    },
  );

  /**
   * Finish an authorization — the URL every provider is actually given.
   *
   * IT IS A `GET`, AND THE PATH CARRIES THE PROVIDER, because that is what
   * `callbackUriFor()` registers and what a provider does with it. The first
   * implementation registered `POST /v1/social/callback` while handing
   * providers `/v1/social/callback/<provider>` and expecting a JSON body: two
   * separate reasons the redirect could never have arrived. A browser
   * completing an OAuth flow performs a top-level GET navigation with `code`
   * and `state` in the query string — there is no body, no JSON, and no way for
   * the provider to send one.
   *
   * IT IS `scope: 'public'`, AND THAT IS THE ONLY CORRECT ANSWER HERE — NOT A
   * RELAXATION (D-141).
   *
   * The customer session cookie is `__Host-bs_customer_session`. The `__Host-`
   * prefix FORBIDS a `Domain` attribute, so the cookie is locked to the exact
   * origin that set it. In the staging topology the dashboard is
   * `staging.brandspace.cc` and this API is `api-staging.brandspace.cc`: the
   * browser will not send that cookie here, and it must not — widening it to
   * `.brandspace.cc` would hand every subdomain the session, which is precisely
   * what the prefix exists to prevent. There is no session to resolve on this
   * request, and pretending otherwise is what made the original route
   * unreachable in the first place.
   *
   * SO THE STATE IS THE IDENTITY, which is what OAuth state is FOR. It is 32
   * bytes of CSPRNG, stored only as a hash, single-use, bound when it was
   * created to one workspace, one brand and one user, and consumed by a
   * conditional UPDATE. Possession of it proves the flow; the row it matches
   * names the workspace. Nothing here trusts the request for any of that:
   * `workspaceId` comes from the row, never from the query.
   *
   * AND NOTHING IS ANSWERED TO THE BROWSER BUT A REDIRECT. Success, an expired
   * state, a forged state, a replayed state and a provider-side denial all end
   * at the same dashboard URL differing only by a coarse status — no JSON, no
   * error code, and nothing that distinguishes "that state was wrong" from
   * "that state belongs to someone else".
   */
  route(
    app,
    'GET',
    '/v1/social/callback/:provider',
    {
      scope: 'public',
      confirmation: 'required',
      idempotent: true,
    },
    async (req, reply) => {
      const params = providerParamSchema.safeParse(req.params);
      if (!params.success) return redirectToDashboard(reply, 'invalid');
      const provider = params.data.provider;

      const query = callbackQuerySchema.safeParse(req.query);
      if (!query.success) return redirectToDashboard(reply, 'invalid');

      /*
       * THE PROVIDER SAID NO. A customer who pressed Cancel on the consent
       * screen is not an error and must not read like one; the provider's own
       * `error_description` is discarded rather than echoed, because it
       * routinely repeats the request.
       */
      if (query.data.error) return redirectToDashboard(reply, 'declined');
      if (!query.data.code || !query.data.state) return redirectToDashboard(reply, 'invalid');

      /*
       * WHICH WORKSPACE. Resolved from the state's own row and nowhere else.
       *
       * The lookup runs on the PLATFORM client because there is no tenant
       * context yet — that is the thing being resolved — and it reads exactly
       * one column, `workspaceId`, by the hash of a secret the caller had to
       * already possess. It consumes nothing: the single-use claim still
       * happens inside `complete()`, under the tenant client, as a conditional
       * UPDATE. This is the same platform-client routing the publishing sweep
       * already does, and it is why `apps/api` is the platform surface.
       */
      const stateHash = createHash('sha256').update(query.data.state).digest('hex');
      const located = await getPlatformClient().socialOAuthState.findFirst({
        where: { stateHash },
        select: { workspaceId: true },
      });
      if (!located) return redirectToDashboard(reply, 'invalid');

      try {
        const result = await oauthServiceFor(located.workspaceId, (service) =>
          service.complete({
            state: query.data.state as string,
            code: query.data.code as string,
            // THE URI IS REBUILT FROM CONFIGURATION, and `complete()` compares
            // it with the one recorded when the flow started. Comparing against
            // the request's own value would compare it with itself.
            redirectUri: callbackUriFor(provider),
          }),
        );

        if (result.outcome === 'selection_required') {
          /*
           * SEVERAL PAGES WERE OFFERED AND NOBODY HAS CHOSEN (D-142). The
           * selection secret goes back through the browser that completed the
           * callback — over the dashboard's own origin, where the session lives
           * — and the choice is made there, authenticated, before any
           * connection exists.
           */
          return redirectToDashboard(reply, 'select', {
            select: result.selectionToken,
            provider: provider.toLowerCase(),
          });
        }

        return redirectToDashboard(
          reply,
          result.missingScopes.length > 0 ? 'partial' : 'connected',
          { provider: provider.toLowerCase() },
        );
      } catch (error: unknown) {
        /*
         * ONE OUTCOME FOR EVERY FAILURE. An expired state, a state already
         * used, a forged one, a provider that refused the exchange and a
         * half-configured application all land here and all redirect
         * identically. The correlation id joins it to a redacted server log;
         * the browser gets a word.
         */
        if (!isAppError(error)) {
          log.error('social callback failed', {
            action: 'callback',
            ...internalErrorFields(error),
          });
        }
        return redirectToDashboard(reply, 'invalid');
      }
    },
  );

  /**
   * What a pending multi-target grant is offering.
   *
   * SESSION-AUTHENTICATED, unlike the callback: this one IS called by the
   * dashboard, server to server, with the customer's own session forwarded. So
   * the secret is not the only lock — the workspace, the permission, the brand
   * scope and the identity of the person who started the flow are all checked
   * as well, inside `pendingSelection()`.
   */
  route(
    app,
    'POST',
    '/v1/social/connections/selection',
    { scope: 'workspace', permission: CONNECT_PERMISSION, idempotent: true },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, CONNECT_PERMISSION);
      if (!caller) return;

      const parsed = selectionTokenSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });
      }

      try {
        const view = await oauthServiceFor(caller.workspaceId, (service) =>
          service.pendingSelection({
            selectionToken: parsed.data.selectionToken,
            actor: { userId: caller.userId, brandScope: caller.brandScope },
          }),
        );
        return reply.send({
          provider: view.provider,
          expiresAt: view.expiresAt.toISOString(),
          // THE CUSTOMER'S OWN PAGES, and nothing else. No token, no scope, no
          // provider payload.
          targets: view.targets.map((target) => ({
            externalAccountId: target.externalAccountId,
            displayName: target.displayName,
            avatarUrl: target.avatarUrl,
            targetKind: target.targetKind,
          })),
        });
      } catch (error: unknown) {
        await sendFailure(reply, error, 'selection');
        return;
      }
    },
  );

  /**
   * Bind a pending grant to the page the customer chose.
   *
   * A HIGH-IMPACT ACTION for the same reason `connect` is: it ends with
   * BrandSpace able to post as the customer, to a specific page they named.
   */
  route(
    app,
    'POST',
    '/v1/social/connections/select',
    {
      scope: 'workspace',
      permission: CONNECT_PERMISSION,
      confirmation: 'required',
      idempotent: false,
    },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, CONNECT_PERMISSION);
      if (!caller) return;

      const parsed = chooseTargetSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });
      }

      try {
        const connection = await oauthServiceFor(caller.workspaceId, (service) =>
          service.chooseTarget({
            selectionToken: parsed.data.selectionToken,
            externalAccountId: parsed.data.externalAccountId,
            actor: { userId: caller.userId, brandScope: caller.brandScope },
          }),
        );
        return reply.code(201).send({
          connection: {
            id: connection.id,
            provider: connection.provider,
            displayName: connection.displayName,
            status: connection.status,
            targetKind: connection.targetKind,
          },
        });
      } catch (error: unknown) {
        await sendFailure(reply, error, 'select');
        return;
      }
    },
  );

  /**
   * Refresh a connection's token.
   *
   * ON THE API BECAUSE IT NEEDS THE CLIENT SECRET. The worker cannot do this,
   * which is why a publish that meets an expired token classifies and stops
   * rather than refreshing in place.
   */
  route(
    app,
    'POST',
    '/v1/social/connections/:connectionId/refresh',
    { scope: 'workspace', permission: CONNECT_PERMISSION, idempotent: true },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, CONNECT_PERMISSION);
      if (!caller) return;
      const { connectionId } = req.params as { connectionId?: string };
      if (!connectionId) return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });

      try {
        const connection = await oauthServiceFor(caller.workspaceId, (service) =>
          // THE SCOPE TRAVELS WITH THE ID (D-132/D-134). It was resolved from
          // the session above and was already being resolved before this fix —
          // it simply was not passed, so a member restricted to one brand could
          // rotate another brand's token by knowing its id.
          service.refresh({ connectionId, brandScope: caller.brandScope }),
        );
        return reply.send({
          connection: {
            id: connection.id,
            status: connection.status,
            tokenExpiresAt: connection.tokenExpiresAt?.toISOString() ?? null,
          },
        });
      } catch (error: unknown) {
        await sendFailure(reply, error, 'refresh');
        return;
      }
    },
  );

  /**
   * Disconnect.
   *
   * ON THE API BECAUSE REVOKING AT THE PROVIDER NEEDS THE CLIENT SECRET. The
   * dashboard could clear the local credential by itself, but a disconnect that
   * leaves the grant live at the platform is not a disconnect — it only stops
   * US from using it, while leaving the customer's account authorized to an
   * application they believe they removed.
   *
   * A HIGH-IMPACT ACTION: it stops scheduled posts going out. It declares a
   * confirmation policy and writes an audit event (CLAUDE.md §2.5).
   */
  route(
    app,
    'POST',
    '/v1/social/connections/:connectionId/disconnect',
    {
      scope: 'workspace',
      permission: CONNECT_PERMISSION,
      confirmation: 'required',
      idempotent: true,
    },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, CONNECT_PERMISSION);
      if (!caller) return;
      const { connectionId } = req.params as { connectionId?: string };
      if (!connectionId) return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });

      try {
        const view = await connectionServiceFor(caller.workspaceId, (service) =>
          service.disconnect({
            connectionId,
            actorUserId: caller.userId,
            brandScope: caller.brandScope,
          }),
        );
        return reply.send({ connection: { id: view.id, status: view.status } });
      } catch (error: unknown) {
        await sendFailure(reply, error, 'disconnect');
        return;
      }
    },
  );

  /** A liveness probe for one connection, run on demand from the screen. */
  route(
    app,
    'POST',
    '/v1/social/connections/:connectionId/check',
    { scope: 'workspace', permission: READ_PERMISSION, idempotent: true },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, READ_PERMISSION);
      if (!caller) return;
      const { connectionId } = req.params as { connectionId?: string };
      if (!connectionId) return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });

      try {
        const view = await connectionServiceFor(caller.workspaceId, (service) =>
          service.checkHealth({ connectionId, brandScope: caller.brandScope }),
        );
        return reply.send({
          connection: {
            id: view.id,
            status: view.status,
            lastCheckedAt: view.lastCheckedAt?.toISOString() ?? null,
            consecutiveFailureCount: view.consecutiveFailureCount,
          },
        });
      } catch (error: unknown) {
        await sendFailure(reply, error, 'check');
        return;
      }
    },
  );

  /** Which providers may be connected at all, and what each can do. */
  route(
    app,
    'GET',
    '/v1/social/providers',
    { scope: 'workspace', permission: READ_PERMISSION, idempotent: true },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, READ_PERMISSION);
      if (!caller) return;
      const environment = currentEnvironment();
      const policy = await resolvePublishingPolicy(configurationService(), environment);
      const registry = createConnectorRegistry({ policy, environment });
      return reply.send({
        providers: registry.enabledProviders().map((provider) => ({
          provider,
          // CAPABILITIES ARE DECLARED, and the UI is generated from them, so an
          // option a platform cannot do never appears.
          capabilities: registry.get(provider).capabilities,
        })),
      });
    },
  );
}

/**
 * Where a completed callback sends the browser.
 *
 * BACK TO THE DASHBOARD, ALWAYS, AND TO A CONFIGURED ORIGIN. The API has no UI
 * and must not grow one: a JSON body rendered in a browser address bar is not a
 * result a customer can act on. `PUBLIC_DASHBOARD_BASE_URL` is read per request
 * for the same reason `PUBLIC_API_BASE_URL` is — staging and production differ
 * and neither is known here.
 *
 * THE STATUS IS COARSE ON PURPOSE. `connected`, `partial`, `select`,
 * `declined`, `invalid`. Every failure — expired, replayed, forged, belonging
 * to another workspace, a provider that refused the exchange — is `invalid`,
 * because a redirect is the most public surface in the product and telling an
 * attacker which of their guesses was closest is the leak.
 */
function redirectToDashboard(
  reply: FastifyReply,
  status: 'connected' | 'partial' | 'select' | 'declined' | 'invalid',
  extra: Record<string, string> = {},
): FastifyReply {
  const base = process.env['PUBLIC_DASHBOARD_BASE_URL'];
  if (!base) {
    // NO GUESSED HOST. Redirecting to a default origin would be an open
    // redirect with extra steps; a misconfigured environment fails closed.
    log.error('PUBLIC_DASHBOARD_BASE_URL is not configured; cannot complete a social callback');
    return reply.code(500).send({ error: { code: 'INTERNAL' } });
  }
  const query = new URLSearchParams({ social: status, ...extra });
  /*
   * 303, not 302. The browser arrived by GET and must continue by GET; 303 says
   * so unambiguously rather than leaving it to the agent.
   */
  return reply
    .code(303)
    .header('location', `${base.replace(/\/+$/, '')}/integrations?${query.toString()}`)
    .header('cache-control', 'no-store')
    .send();
}

/**
 * One refusal shape for every failure on this surface.
 *
 * A typed AppError becomes its own code; anything else becomes INTERNAL with a
 * correlation id and nothing else. A provider's own message must never reach a
 * customer: it routinely echoes the request, and the request carried a code.
 */
async function sendFailure(reply: FastifyReply, error: unknown, action: string): Promise<void> {
  if (isAppError(error)) {
    await reply.code(error.httpStatus).send({ error: { code: error.code } });
    return;
  }
  // The correlation id is the only thing joining this refusal to the server
  // log, and the log is redacted. A provider's own message never reaches here.
  log.error('social action failed', { action, ...internalErrorFields(error) });
  await reply.code(500).send({ error: { code: 'INTERNAL' } });
}
