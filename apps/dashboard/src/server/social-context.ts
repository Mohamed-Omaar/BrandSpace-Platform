import 'server-only';
import {
  createConnectorRegistry,
  PublishHistoryService,
  PublishPipelineService,
  SocialConnectionService,
  SocialTokenVault,
  TenantPublishingPolicySource,
  type ConnectorRegistry,
  type PublishingPolicy,
} from '@brandspace/social-connectors';
import { ContentApprovalService, TenantContentPolicySource } from '@brandspace/content';
import { CUSTOMER_REALM } from '@brandspace/auth';
import { cookies } from 'next/headers';
import { createLogger, internalErrorFields } from '@brandspace/shared';
import { currentEnvironment, inWorkspace, type ScopedServices } from './customer-context';

/**
 * Social Publishing wiring for the customer dashboard.
 *
 * WHAT THIS APP MAY DO AND WHAT IT MAY NOT. Everything that touches only tenant
 * tables under RLS happens here, directly: listing connected accounts, reading
 * publishing history, cancelling a queued post, retrying a failed one.
 *
 * ANYTHING NEEDING THE PLATFORM APP'S OWN CLIENT SECRET DOES NOT. Starting an
 * authorization, exchanging a code, refreshing a token and revoking a grant all
 * need `integrations.social-apps` and the Secret Service, and F-07 keeps that
 * path out of the app closest to a browser bundle. Those four run in `apps/api`
 * and this file calls them over HTTP with the customer's own session.
 *
 * THAT BOUNDARY IS ENFORCED BY THE TYPE, NOT BY A COMMENT: the
 * `SocialConnectionService` built here is constructed WITHOUT an
 * `ApplicationResolver`, so it has no way to reach a platform credential.
 *
 * EVERY POLICY VALUE COMES FROM VERSIONED CONFIGURATION. Capabilities, scopes,
 * retry schedule and lateness tolerance arrive through
 * `entitlement_catalogue_snapshot`, the projection the Configuration Service
 * writes on activation and the tenant role may read and may not write. Two
 * copies of a setting are two settings (CLAUDE.md §2.2).
 */

const log = createLogger({ context: { component: 'dashboard.social' } });

/**
 * A key provider that refuses.
 *
 * The dashboard must never decrypt a customer token: every path that needs to
 * runs in `apps/api` or the worker. This makes that structural rather than
 * conventional — nothing here can open a credential even if a future call site
 * asks, and the failure is immediate and obvious rather than a silent
 * acquisition of a capability this app is not supposed to have.
 */
const refusingKeyProvider = {
  name: 'refusing',
  currentKeyId: () => 'none',
  async wrapDataKey(): Promise<never> {
    throw new Error('The customer dashboard does not encrypt social tokens.');
  },
  async unwrapDataKey(): Promise<never> {
    throw new Error('The customer dashboard does not decrypt social tokens.');
  },
};

export interface SocialServices extends ScopedServices {
  policy(): Promise<PublishingPolicy>;
  registry(): Promise<ConnectorRegistry>;
  /** Reads only. Built with no application resolver, deliberately. */
  connections(): Promise<SocialConnectionService>;
  history(): PublishHistoryService;
  /** Cancel and retry. Tenant-only work; no provider call happens here. */
  pipeline(): Promise<PublishPipelineService>;
}

export async function inSocial<T>(
  workspaceId: string,
  fn: (services: SocialServices) => Promise<T>,
): Promise<T> {
  return inWorkspace(workspaceId, async (scoped) => {
    let cachedPolicy: PublishingPolicy | null = null;
    const policy = async (): Promise<PublishingPolicy> => {
      cachedPolicy ??= await new TenantPublishingPolicySource(
        scoped.db,
        currentEnvironment(),
      ).load();
      return cachedPolicy;
    };
    const registry = async (): Promise<ConnectorRegistry> =>
      createConnectorRegistry({ policy: await policy(), environment: currentEnvironment() });

    return fn({
      ...scoped,
      policy,
      registry,
      connections: async () =>
        new SocialConnectionService({
          db: scoped.db,
          workspaceId,
          registry: await registry(),
          // NO `vault` AND NO `applications`, and both absences are load-bearing.
          //
          // Reading a connection never decrypts anything, so this app needs no
          // key material — and therefore `SOCIAL_TOKEN_VAULT_KEK` is not
          // deployed to it at all. A key the process closest to a browser
          // bundle does not hold is a key that cannot leak from it.
          //
          // Disconnection and the health probe both DO open a credential, and
          // both live in `apps/api` where the key belongs.
        }),
      history: () => new PublishHistoryService({ db: scoped.db, workspaceId }),
      pipeline: async () =>
        new PublishPipelineService({
          db: scoped.db,
          workspaceId,
          policy: await policy(),
          registry: await registry(),
          /*
           * CANCEL AND RETRY ARE PURE STATE CHANGES. Neither reaches a
           * provider, so neither opens a credential — but the pipeline type
           * requires a vault because `execute()` does, and `execute()` runs on
           * the WORKER. Handing it one built from an absent key would fail at
           * construction; handing it one that refuses to decrypt is honest:
           * if anything on this surface ever tried to publish, it would fail
           * loudly here rather than quietly acquiring the ability to.
           */
          vault: new SocialTokenVault({ keyProvider: refusingKeyProvider }),
          approvals: new ContentApprovalService({
            db: scoped.db,
            workspaceId,
            policy: await new TenantContentPolicySource(scoped.db, currentEnvironment()).load(),
          }),
        }),
    });
  });
}

/**
 * Call an `apps/api` social route with the customer's own session.
 *
 * ONE CREDENTIAL IS FORWARDED AND NOTHING ELSE — the session cookie, as a
 * bearer token. Not the cookie jar, not the client's headers, not its origin: a
 * helper that replayed arbitrary headers would be a request-forgery primitive.
 *
 * THE PATH IS A CONSTANT AT EVERY CALL SITE. A target that came out of a form
 * field would let a browser aim this credential at any route the API exposes.
 */
export async function callSocialApi(
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; payload: unknown }> {
  const base = process.env['BRANDSPACE_API_URL'];
  if (!base) {
    log.warn('BRANDSPACE_API_URL is not configured; social account management is unavailable');
    return { ok: false, status: 503, payload: { error: { code: 'INTERNAL' } } };
  }
  const store = await cookies();
  const token = store.get(CUSTOMER_REALM.cookieName)?.value;
  if (!token) return { ok: false, status: 401, payload: { error: { code: 'UNAUTHENTICATED' } } };

  try {
    const upstream = await fetch(`${base.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body ?? {}),
    });
    const payload: unknown = await upstream.json().catch(() => ({ error: { code: 'INTERNAL' } }));
    return { ok: upstream.ok, status: upstream.status, payload };
  } catch (error: unknown) {
    // A network failure reaching the API. Logged with internals, answered with
    // a code — the browser never sees a hostname or a stack.
    log.error('social upstream failed', { path, ...internalErrorFields(error) });
    return { ok: false, status: 502, payload: { error: { code: 'INTERNAL' } } };
  }
}
