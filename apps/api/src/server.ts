import Fastify from 'fastify';
import { createLogger } from '@brandspace/shared';
import { registerHealthRoutes } from './routes/health';
import { registeredRoutes } from './route-contract';

/**
 * BrandSpace API — modular monolith HTTP surface (docs/ARCHITECTURE.md §2).
 * Phase 1 exposes health and readiness only; domain routers arrive with their phases.
 */
export async function buildServer() {
  const app = Fastify({ logger: false, disableRequestLogging: true });
  const log = createLogger({ context: { service: 'api' } });

  app.addHook('onRequest', async (req, reply) => {
    // Correlation id on every request — docs/ARCHITECTURE.md §3.10.
    const requestId = (req.headers['x-request-id'] as string | undefined) ?? crypto.randomUUID();
    reply.header('x-request-id', requestId);
    // Security headers on API responses too.
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  });

  registerHealthRoutes(app);

  log.info('routes registered', { count: registeredRoutes().length });
  return app;
}

// Only start a listener when executed directly, so tests can import buildServer().
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  const port = Number(process.env['PORT'] ?? 3003);
  buildServer()
    .then((app) => app.listen({ port, host: '0.0.0.0' }))
    .catch((e: unknown) => {
      console.error(e);
      process.exit(1);
    });
}
