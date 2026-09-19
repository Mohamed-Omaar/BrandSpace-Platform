import Fastify from 'fastify';
import {
  createLogger,
  currentEnvironment,
  internalErrorFields,
  validateStartupConfiguration,
} from '@brandspace/shared';
import { registerBrandBrainRoutes } from './routes/brand-brain';
import { registerContentRoutes } from './routes/content';
import { registerCreativeRoutes } from './routes/creative';
import { registerHealthRoutes } from './routes/health';
import { registerInternalEmailRoutes } from './routes/internal-email';
import { registerSocialRoutes } from './routes/social';
import { registerAnalyticsRoutes } from './routes/analytics';
import { registerAutomationRoutes } from './routes/automation';
import { registerCommerceRoutes } from './routes/commerce';
import { registerBillingWebhookRoutes } from './routes/billing-webhook';
import { registerBillingHostedPageRoutes } from './routes/billing-hosted-page';
import { registerAccountRoutes } from './routes/account';
import { registerOnboardingRoutes } from './routes/onboarding';
import { registerCopilotRoutes } from './routes/copilot';
import { registeredRoutes } from './route-contract';
import { MaintenanceScheduler } from './scheduler';

/**
 * BrandSpace API — modular monolith HTTP surface (docs/ARCHITECTURE.md §2).
 *
 * Phase 1 exposed health and readiness only. Phase 5 adds the first domain
 * router: Brand Brain chat, which is here rather than in the dashboard because
 * the AI Gateway requires the platform database identity that F-07 keeps out of
 * tenant-facing apps.
 */
export async function buildServer() {
  const app = Fastify({ logger: false, disableRequestLogging: true });
  const log = createLogger({ context: { service: 'api' } });

  /*
   * PHASE 10 §18 — VALIDATE THE ENVIRONMENT BEFORE A ROUTE EXISTS.
   *
   * The schema in `@brandspace/shared` has described this contract since Phase
   * 1 and, until Phase 10, nothing but a unit test ever ran it: the two session
   * realms differing, no placeholder secret, a separate platform role — all
   * asserted against a fixture and enforced nowhere. In production this throws
   * and the API does not come up. Outside production it logs, because a
   * developer with half an environment should get a readable warning and a
   * running server.
   */
  const configuration = validateStartupConfiguration(process.env, 'api');
  if (!configuration.ok) {
    log.warn('configuration is incomplete', {
      environment: configuration.environment,
      problems: configuration.problems,
    });
  }

  app.addHook('onRequest', async (req, reply) => {
    // Correlation id on every request — docs/ARCHITECTURE.md §3.10.
    const requestId = (req.headers['x-request-id'] as string | undefined) ?? crypto.randomUUID();
    reply.header('x-request-id', requestId);
    // Security headers on API responses too.
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  });

  registerHealthRoutes(app);
  registerInternalEmailRoutes(app);
  // Phase 5. The customer-initiated AI surface lives here rather than in the
  // dashboard: the gateway needs the platform identity, and F-07 keeps that out
  // of tenant-facing apps. See routes/brand-brain.ts for the full reasoning.
  registerBrandBrainRoutes(app);
  registerContentRoutes(app);
  // Phase 8 — the AI Creative Studio (D-195, AC-28).
  registerCreativeRoutes(app);
  registerSocialRoutes(app);
  /*
   * Phase 7. Each of these calls the AI Gateway or performs an external action
   * behind a human confirmation, and both need the PLATFORM identity that F-07
   * keeps out of the customer dashboard. Reading analytics needs neither and
   * stays in the dashboard on the tenant identity, where it belongs.
   */
  registerAnalyticsRoutes(app);
  registerCopilotRoutes(app);
  registerAutomationRoutes(app);

  /*
   * Phase 9. Commerce, signup and onboarding are here for the same reason every
   * phase since Phase 5: they read the PLATFORM-owned commercial catalogue, call
   * a payment adapter, or create a workspace — and F-07 keeps all three out of
   * the customer dashboard.
   *
   * THE WEBHOOK IS REGISTERED AS ITS OWN PLUGIN so its raw-body parser applies
   * to that route and to nothing else. See routes/billing-webhook.ts.
   */
  registerAccountRoutes(app);
  registerOnboardingRoutes(app);
  registerCommerceRoutes(app);
  await registerBillingWebhookRoutes(app);
  await registerBillingHostedPageRoutes(app);

  log.info('routes registered', { count: registeredRoutes().length });
  return app;
}

/*
 * Only start a listener — and the scheduler — when executed directly, so tests
 * can import `buildServer()` without a process-wide timer starting behind them.
 */
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  const port = Number(process.env['PORT'] ?? 3003);
  const startupLog = createLogger({ context: { service: 'api' } });

  buildServer()
    .then(async (app) => {
      await app.listen({ port, host: '0.0.0.0' });

      /*
       * BACKGROUND MAINTENANCE RUNS HERE because both of its sweeps begin with
       * a cross-tenant question, and this is the designated platform surface.
       * See scheduler.ts. A failure to start it must not take the API down: the
       * HTTP surface is what customers are waiting on, and an unstarted sweep
       * is an operator problem that the log makes visible.
       */
      const scheduler = new MaintenanceScheduler({ environment: currentEnvironment() });
      await scheduler.start().catch((error: unknown) => {
        startupLog.error('maintenance scheduler did not start', internalErrorFields(error));
      });

      const shutdown = async (signal: string): Promise<void> => {
        startupLog.info('api stopping', { signal });
        scheduler.stop();
        await app.close();
        process.exit(0);
      };
      process.on('SIGTERM', () => void shutdown('SIGTERM'));
      process.on('SIGINT', () => void shutdown('SIGINT'));
    })
    .catch((e: unknown) => {
      console.error(e);
      process.exit(1);
    });
}
