import type { FastifyInstance } from 'fastify';
import { route } from '../route-contract';

/**
 * Liveness and readiness — docs/SECURITY.md §14.1.
 * Public by design; deliberately reveals no version or dependency detail to
 * unauthenticated callers.
 */
export function registerHealthRoutes(app: FastifyInstance): void {
  route(app, 'GET', '/health/live', { scope: 'public' }, async () => ({ status: 'ok' }));

  route(app, 'GET', '/health/ready', { scope: 'public' }, async () => {
    // Phase 2 wires real database/Redis/storage probes behind this contract.
    return { status: 'ok', checks: { database: 'not_wired', redis: 'not_wired' } };
  });
}
