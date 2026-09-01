import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Route contract — docs/SECURITY.md §4.5.
 *
 * Every route MUST declare its scope. Registration throws if `scope` is missing, so
 * an unprotected route cannot reach production: the failure happens at boot, not at
 * the first unauthorized request.
 */

export type RouteScope = 'public' | 'platform' | 'workspace';

export interface RouteContract {
  readonly scope: RouteScope;
  /** Required permission key. Mandatory for non-public routes. */
  readonly permission?: string;
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
  if (contract.scope !== 'public' && !contract.permission) {
    throw new Error(
      `Route ${method} ${url} has scope "${contract.scope}" but declares no permission. ` +
        `Non-public routes must name the permission they require.`,
    );
  }
  registry.push({ method, url, contract });
  app.route({ method, url, handler: handler as never });
}
