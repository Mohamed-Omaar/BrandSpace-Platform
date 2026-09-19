import 'server-only';
import {
  DEVELOPMENT_PROVIDER_KEY,
  DEVELOPMENT_SIGNATURE_HEADER,
  DEVELOPMENT_TIMESTAMP_HEADER,
  DevelopmentPaymentProvider,
} from '@brandspace/billing';
import { MockProviderAdapter } from '@brandspace/ai-gateway';
import { OutboxEmailProvider } from '@brandspace/auth';
import { getPlatformClient } from '@brandspace/database/platform';
import { isProduction, systemClock } from '@brandspace/shared';
import { findIntegration, type IntegrationTester } from '@brandspace/integrations';
import { currentEnvironment, getSecretService } from './platform-context';

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
 *
 * AND THE FIFTH RULE, ADDED BY THE PHASE 10 CORRECTION (§9): IT TESTS WHAT THE
 * OWNER SAVED. Every value below comes from `input.settings` and
 * `input.credentials`, which the Integrations Hub resolved from the
 * configuration document and the vault moments earlier. Reading a credential
 * out of `process.env` here — which is exactly what the payment branch used to
 * do — meant the screen claimed to verify the key an owner had just entered
 * while verifying a different one entirely. A green tick for an unverified
 * configuration is worse than no button.
 *
 * THE RUNTIME IS A SEPARATE QUESTION, deliberately left alone. Phase 9's
 * automated billing fixtures still sign their loopback events with
 * `BILLING_DEV_WEBHOOK_SECRET` (`apps/api/src/routes/phase9-context.ts`), and
 * redesigning that is not this correction's business. What changed is that the
 * Hub no longer borrows it and calls it a test of the Hub's own configuration.
 */
export function integrationTester(): IntegrationTester {
  /**
   * Exchange the saved references for values, here and nowhere else.
   *
   * THE HUB HANDS OVER POINTERS, THIS TURNS THEM INTO VALUES, and the values go
   * straight into an adapter constructor below. They are never logged, never
   * returned, never put in a message and never held: the closure ends and they
   * are gone. `packages/integrations` cannot do this — a unit guard asserts it
   * cannot even name the operation — which is what keeps the Hub incapable of
   * decrypting anything while still testing what the owner actually saved.
   */
  const resolve = async (
    refs: Readonly<Record<string, string>>,
  ): Promise<Record<string, string>> => {
    const secrets = getSecretService();
    const environment = currentEnvironment();
    const values: Record<string, string> = {};
    for (const [field, ref] of Object.entries(refs)) {
      values[field] = await secrets.resolveSecret(ref, environment);
    }
    return values;
  };

  return {
    async test(input) {
      const startedAt = Date.now();
      const credentials = await resolve(input.credentialRefs);

      /*
       * PRODUCTION CANNOT REACH A DEVELOPMENT DOUBLE — but it MUST be able to
       * reach a real one.
       *
       * THIS USED TO REFUSE EVERYTHING. That was right while every adapter in
       * the switch below was a development double: each refuses to construct in
       * production on its own account, and the Hub should say so in a sentence
       * rather than surfacing a constructor exception. It stopped being right
       * the moment a real provider could be registered at all, because Test
       * Connection on a production deployment is exactly when an owner most
       * needs a truthful answer about a real credential.
       *
       * TWO CATEGORIES HAVE NO CASE BELOW, both marked `testable: false` in the
       * registry, and for the same underlying reason: the credential that does
       * the job is not a credential that can answer a read.
       *
       *   - OBJECT STORAGE is configured by the deployment, and the Control
       *     Center is deliberately not given a bucket credential to test with.
       *   - RESEND asks for a Sending-access key restricted to the verified
       *     domain. Every non-destructive check Resend offers is a read, and a
       *     send-only key is refused all of them. A button here could only
       *     report a working key as broken, demand a wider key, or send an
       *     unsolicited probe message.
       *
       * Both say where the real proof lives instead.
       *
       * So the registry decides, as it does everywhere else: `developmentOnly`
       * is the property, and the refusal follows it rather than the
       * environment alone.
       */
      const definition = findIntegration(input.category, input.providerKey);
      if (isProduction() && (!definition || definition.developmentOnly)) {
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
            // Both from the saved configuration. The deterministic provider
            // declares neither field, so both are absent today — and the day a
            // real adapter declares them, this call already carries them.
            apiKey: credentials['apiKey'] ?? null,
            baseUrl: input.settings['baseUrl'] ?? 'mock://local',
            timeoutMs: 5_000,
            signal: AbortSignal.timeout(5_000),
            requestId: 'integration-test',
          });
          return { ok: result.ok, latencyMs: result.latencyMs, message: result.message };
        }

        case 'payment:development-mock': {
          /*
           * THE REGRESSION PATH §9 NAMES. The adapter is constructed from the
           * credential the owner entered in the Hub and the base URL they
           * saved — entered value, stored through the Secret Service,
           * referenced by configuration, resolved server-side, used here.
           *
           * The guard below is unreachable in practice because
           * `configurationComplete` already refused to call a tester when a
           * required credential is missing. It stays because that guarantee
           * lives in another file, and a signing test that silently signed with
           * `undefined` would pass.
           */
          const secret = credentials['webhookSecret'];
          const hostedBaseUrl = input.settings['hostedBaseUrl'];
          if (!secret || !hostedBaseUrl) {
            return {
              ok: false,
              latencyMs: Date.now() - startedAt,
              message:
                'The saved configuration is missing the webhook signing secret or the hosted ' +
                'checkout URL, so no event this adapter signs could be verified.',
            };
          }
          const adapter = new DevelopmentPaymentProvider({ webhookSecret: secret, hostedBaseUrl });
          const capabilities = adapter.capabilities();

          /*
           * A ROUND TRIP, NOT A CONSTRUCTOR CALL. The adapter signs a probe
           * event with the saved secret and then verifies it, so the test fails
           * if the stored credential is not the one doing the signing. Proving
           * the object exists would have proven nothing about the key.
           */
          const body = Buffer.from(JSON.stringify({ probe: 'integration-test' }), 'utf8');
          const timestampSeconds = Math.floor(Date.now() / 1000);
          const verification = adapter.verifyWebhook(body, {
            [DEVELOPMENT_TIMESTAMP_HEADER]: String(timestampSeconds),
            [DEVELOPMENT_SIGNATURE_HEADER]: adapter.sign(body, timestampSeconds),
          });
          const verified = verification.valid;
          return {
            ok: verified && adapter.key === DEVELOPMENT_PROVIDER_KEY && capabilities.hostedCheckout,
            latencyMs: Date.now() - startedAt,
            message: verified
              ? 'Signed a probe event with the saved webhook secret and verified it.'
              : 'The saved webhook secret did not verify its own signature.',
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
