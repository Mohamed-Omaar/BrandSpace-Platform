import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Route contract — docs/SECURITY.md §4.5.
 *
 * Every route MUST declare its scope. Registration throws if `scope` is missing, so
 * an unprotected route cannot reach production: the failure happens at boot, not at
 * the first unauthorized request.
 */

/**
 * `internal` is SERVICE-TO-SERVICE, not a user scope.
 *
 * It exists for one reason: the customer dashboard must be able to ask for an
 * email to be sent without being able to read the provider credential that
 * sends it. There is no session on a signup or password-reset request, so the
 * caller is a PROCESS rather than a person — and a process is authenticated by
 * a shared service token, not by a permission key.
 *
 * An internal route must never be something a browser is meant to reach. The
 * contract records the scope so the route report shows exactly which surfaces
 * are service-only, and the handler checks the token itself.
 */
export type RouteScope = 'public' | 'platform' | 'workspace' | 'internal';

export interface RouteContract {
  readonly scope: RouteScope;
  /** Required permission key. Mandatory for non-public routes. */
  readonly permission?: string;
  /**
   * The route spends AI credits, so its handler also requires `copilot.use`
   * (Q18, D-315): `resolveCaller(req, reply, creditSpendingPermissions(<permission>))`.
   * `tests/unit/prototype-v90-phase2a.test.ts` pins the two together.
   */
  readonly spendsCredits?: true;
  /** Entitlement (plan feature) gate. Wired in Phase 3. */
  readonly entitlement?: string;
  /** High-impact actions require an explicit confirmation policy — CLAUDE.md §2.5. */
  readonly confirmation?: 'required' | 'not_required';
  readonly rateLimit?: string;
  readonly idempotent?: boolean;
}

export interface RegisteredRoute {
  readonly method: string;
  readonly url: string;
  readonly contract: RouteContract;
}

/** Populated at registration; emitted as the route/permission report for review. */
const registry: RegisteredRoute[] = [];

export function registeredRoutes(): readonly RegisteredRoute[] {
  return [...registry];
}

export function resetRouteRegistry(): void {
  registry.length = 0;
}

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown;

/**
 * Register a route with its security contract. Refuses to register a route that
 * does not declare a scope, or a non-public route with no permission.
 */
export function route(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  contract: RouteContract,
  handler: Handler,
): void {
  if (!contract || typeof contract.scope !== 'string') {
    throw new Error(`Route ${method} ${url} does not declare a scope. See docs/SECURITY.md §4.5.`);
  }
  if (contract.scope !== 'public' && contract.scope !== 'internal' && !contract.permission) {
    throw new Error(
      `Route ${method} ${url} has scope "${contract.scope}" but declares no permission. ` +
        `Non-public routes must name the permission they require. ` +
        `("internal" is the exception: it is a service caller, authenticated by token.)`,
    );
  }
  registry.push({ method, url, contract });
  app.route({ method, url, handler: handler as never });
}
