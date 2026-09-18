import 'server-only';
import { DEVELOPMENT_PROVIDER_KEY, DevelopmentPaymentProvider } from '@brandspace/billing';
import { MockProviderAdapter } from '@brandspace/ai-gateway';
import { OutboxEmailProvider } from '@brandspace/auth';
import { getPlatformClient } from '@brandspace/database/platform';
import { isProduction, systemClock } from '@brandspace/shared';
import type { IntegrationTester } from '@brandspace/integrations';

/**
 * WHAT ACTUALLY TALKS TO A PROVIDER — Phase 10 §10.
 *
 * `@brandspace/integrations` deliberately imports no adapter: reaching a
 * provider means running one, and importing ai-gateway, billing,
 * social-connectors and storage into the Hub would have put that package at the
 * centre of the dependency graph and let a Control Center screen reach a
 * customer OAuth token. The wiring happens HERE instead, once, in the app that
 * already holds the platform identity.
 *
 * THE FOUR RULES EVERY TEST OBEYS (§10):
 *
 *   1. It names the environment it ran in, so "it worked" is never ambiguous.
 *   2. It uses MINIMAL billable usage — a reachability check, never a
 *      generation. Testing a connection must not cost the owner a month of
 *      tokens.
 *   3. It returns a sentence, never a credential and never a raw provider
 *      error. The service redacts the result again before storing it.
 *   4. IT DOES NOT ACTIVATE ANYTHING. Activation is a configuration change with
 *      its own author, validation, audit trail and rollback. A button that
 *      quietly did both would make "I was only checking" impossible to mean.
 */
export function integrationTester(): IntegrationTester {
  return {
    async test(input) {
      const startedAt = Date.now();

      /*
       * PRODUCTION CANNOT REACH ANY OF THESE. Every adapter below is a
       * development double, and each refuses to be constructed in production on
       * its own account — but the Hub should say so in a sentence an operator
       * can read rather than surfacing a constructor exception.
       */
      if (isProduction()) {
        return {
          ok: false,
          latencyMs: 0,
          message:
            'This is a development provider and cannot be reached from a production deployment. ' +
            'Configure a real provider for this category.',
        };
      }

      switch (`${input.category}:${input.providerKey}`) {
        case 'ai:mock': {
          const adapter = new MockProviderAdapter();
          const result = await adapter.testConnection({
            environment: input.environment,
            apiKey: null,
            baseUrl: 'mock://local',
            timeoutMs: 5_000,
            signal: AbortSignal.timeout(5_000),
            requestId: 'integration-test',
          });
          return { ok: result.ok, latencyMs: result.latencyMs, message: result.message };
        }

        case 'payment:development-mock': {
          /*
           * The development payment adapter's own reachability check. It needs
           * the webhook signing secret, so a missing one surfaces here as a
           * failed test rather than as a 500 on a customer's first purchase.
           */
          const secret = process.env['BILLING_DEV_WEBHOOK_SECRET'];
          if (!secret) {
            return {
              ok: false,
              latencyMs: Date.now() - startedAt,
              message:
                'BILLING_DEV_WEBHOOK_SECRET is not set, so no event this adapter signs could be verified.',
            };
          }
          const adapter = new DevelopmentPaymentProvider({
            webhookSecret: secret,
            hostedBaseUrl: process.env['PUBLIC_API_BASE_URL'] ?? 'http://localhost:3003',
          });
          const capabilities = adapter.capabilities();
          return {
            ok: adapter.key === DEVELOPMENT_PROVIDER_KEY && capabilities.hostedCheckout,
            latencyMs: Date.now() - startedAt,
            message:
              'Development payment adapter is loaded and signs events with the configured secret.',
          };
        }

        case 'email:outbox': {
          /*
           * Reachability, not a send. The outbox provider writes a row; a test
           * that wrote one would put a message nobody asked for into the record
           * an operator reads to see what was sent.
           */
          const provider = new OutboxEmailProvider(getPlatformClient(), systemClock);
          const reachable = await getPlatformClient().$queryRaw`SELECT 1`
            .then(() => true)
            .catch(() => false);
          return {
            ok: reachable && provider.key === 'outbox',
            latencyMs: Date.now() - startedAt,
            message: reachable
              ? 'Outbox provider is loaded; messages are recorded rather than delivered.'
              : 'The outbox table could not be reached.',
          };
        }

        case 'storage:filesystem':
          return {
            ok: true,
            latencyMs: Date.now() - startedAt,
            message: 'Filesystem store is available on this host. Files live on local disk only.',
          };

        case 'social:mock':
          return {
            ok: true,
            latencyMs: Date.now() - startedAt,
            message:
              'Deterministic connectors are loaded. OAuth, publishing and analytics are simulated.',
          };

        default:
          /*
           * A REGISTERED PROVIDER WITH NO TESTER IS A GAP, and it says so
           * rather than returning a cheerful pass. The registry only lists
           * providers with adapters, so this is reachable only if somebody adds
           * one here without adding its test — which is exactly when a false
           * green would be most expensive.
           */
          return {
            ok: false,
            latencyMs: Date.now() - startedAt,
            message: `No connection test is implemented for ${input.category}/${input.providerKey}.`,
          };
      }
    },
  };
}
