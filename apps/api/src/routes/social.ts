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

const callbackSchema = z.object({
  provider: z.enum(SOCIAL_PROVIDERS),
  state: z.string().min(1).max(512),
  code: z.string().min(1).max(4_096),
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
   * Finish an authorization.
   *
   * THE PROVIDER REDIRECTS A BROWSER HERE, so the session cookie is what
   * identifies the workspace — the state proves the flow, the session proves
   * the person. Both must agree: a state belonging to another workspace simply
   * does not match the `workspaceId` predicate and is refused as invalid.
   */
  route(
    app,
    'POST',
    '/v1/social/callback',
    {
      scope: 'workspace',
      permission: CONNECT_PERMISSION,
      confirmation: 'required',
      idempotent: true,
    },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, CONNECT_PERMISSION);
      if (!caller) return;

      const parsed = callbackSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });
      }

      try {
        const result = await oauthServiceFor(caller.workspaceId, (service) =>
          service.complete({
            state: parsed.data.state,
            code: parsed.data.code,
            redirectUri: callbackUriFor(parsed.data.provider),
          }),
        );
        return reply.code(201).send({
          // IDENTITY AND STATUS ONLY. No token, no scope secret, no provider
          // payload — this response reaches a browser.
          connection: {
            id: result.connection.id,
            provider: result.connection.provider,
            displayName: result.connection.displayName,
            status: result.connection.status,
            targetKind: result.connection.targetKind,
          },
          missingScopes: result.missingScopes,
        });
      } catch (error: unknown) {
        await sendFailure(reply, error, 'callback');
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
          service.refresh(connectionId),
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
