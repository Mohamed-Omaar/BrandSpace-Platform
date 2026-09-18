import type { FastifyInstance } from 'fastify';
import { getPrisma } from '@brandspace/database';
import {
  evaluateHealth,
  publicView,
  readinessHttpStatus,
  tracingStatus,
  type DependencyCheck,
} from '@brandspace/observability';
import { queueUrl } from '@brandspace/jobs';
import { currentEnvironment } from '@brandspace/shared';
import { route } from '../route-contract';

/**
 * Liveness and readiness — docs/SECURITY.md §14.1, Phase 10 §19.
 *
 * WHAT CHANGED IN PHASE 10. Readiness used to answer `{ database: 'not_wired',
 * redis: 'not_wired' }` — a placeholder from Phase 1 that reported the same
 * cheerful `status: 'ok'` whether or not the database existed. A readiness
 * probe that cannot fail is worse than none: it teaches an orchestrator that
 * every instance is fine.
 *
 * LIVENESS STILL CHECKS NOTHING EXTERNAL, and that is not laziness. A liveness
 * probe that touched the database would restart every process in the fleet the
 * moment the database blinked, turning a brief dependency problem into a total
 * outage.
 *
 * NEITHER ENDPOINT REVEALS DETAIL. Both are public, so they answer with a
 * state per named check and nothing else — no hostname, no role, no driver
 * error, no version. The full report, with operator detail, is on the Control
 * Center health screen, behind a platform session.
 */
export function registerHealthRoutes(app: FastifyInstance): void {
  route(app, 'GET', '/health/live', { scope: 'public' }, async () => ({ status: 'ok' }));

  route(app, 'GET', '/health/ready', { scope: 'public' }, async (_req, reply) => {
    const report = evaluateHealth(await probeDependencies());
    return reply.code(readinessHttpStatus(report.status)).send(publicView(report));
  });
}

/**
 * Ask each dependency whether it is there.
 *
 * EVERY PROBE IS BOUNDED AND SWALLOWS ITS OWN FAILURE. A readiness endpoint
 * that can hang is a readiness endpoint that takes the whole fleet out when a
 * dependency is slow rather than dead, so each check races a short deadline and
 * reports `down` instead of throwing.
 */
export async function probeDependencies(): Promise<readonly DependencyCheck[]> {
  const checks: DependencyCheck[] = [];

  checks.push(await probeDatabase());

  /*
   * THE QUEUE IS NOT REQUIRED FOR READINESS, and that is a deliberate reading
   * of §19. Without Redis the platform still serves every screen, every read
   * and every synchronous AI call; what stops is background work — publishing,
   * media processing, analytics ingestion. Answering "not ready" would remove
   * a working product from the load balancer to protect a queue.
   */
  const queueConfigured = queueUrl() !== undefined && queueUrl() !== null;
  checks.push({
    name: 'queue',
    state: queueConfigured ? 'ok' : 'not_configured',
    required: false,
    capability: 'background-jobs',
    ...(queueConfigured
      ? {}
      : { detail: 'REDIS_URL is not set, so no background job can be dispatched.' }),
  });

  /*
   * TRACING IS PURE OBSERVABILITY. Losing it costs visibility and nothing else,
   * so it never affects readiness — only the degraded list, so an operator can
   * see that the platform is running unobserved.
   */
  const tracing = tracingStatus();
  checks.push({
    name: 'tracing',
    state: tracing.exporting ? 'ok' : 'not_configured',
    required: false,
    capability: 'observability',
    detail: tracing.exporting
      ? `Exporting to ${tracing.endpointHost ?? 'the configured collector'}.`
      : 'Spans are created locally and nothing is exported.',
  });

  return checks;
}

async function probeDatabase(): Promise<DependencyCheck> {
  const startedAt = Date.now();
  try {
    /*
     * THE TENANT POOL, not the platform one. This process serves customer
     * traffic on the tenant identity, so that is the connection whose health
     * decides whether it can serve — and probing with the platform credential
     * would report a pool that customer requests never touch.
     */
    await withDeadline(getPrisma().$queryRaw`SELECT 1`, 2_000);
    return { name: 'database', state: 'ok', required: true, latencyMs: Date.now() - startedAt };
  } catch {
    return {
      name: 'database',
      state: 'down',
      required: true,
      latencyMs: Date.now() - startedAt,
      // No driver text: it names hosts, roles and ports.
      detail: 'The tenant database connection did not answer.',
    };
  }
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('probe deadline exceeded')), ms).unref?.(),
    ),
  ]);
}

/** Re-exported so the Control Center can label a report with its deployment. */
export { currentEnvironment };
