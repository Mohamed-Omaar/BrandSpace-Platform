import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getPlatformClient } from '@brandspace/database/platform';
import { createLogger } from '@brandspace/shared';
import { route } from '../route-contract';
import { commercePolicy, planCatalogue, providerFor, reconciler } from './phase9-context';

/**
 * The webhook endpoint — the ONE place a payment becomes a fact (§28).
 *
 * PUBLIC SCOPE, AND NOT UNPROTECTED. There is no session here because a payment
 * provider has none; the authentication is the SIGNATURE over the raw body, and
 * it is checked before the body is parsed. Declaring `scope: 'public'` is what
 * the route contract requires of a route with no permission, and this comment is
 * the answer to the question that declaration raises.
 *
 * RAW BYTES, PRESERVED. Fastify's default JSON parser would hand the handler a
 * parsed object and discard what was signed, so this route installs a parser
 * that keeps the Buffer. Verifying a re-serialized document is verifying a
 * DIFFERENT document, which is a well-worn way to accept a forgery that happens
 * to round-trip.
 *
 * ALWAYS 200 ONCE VERIFIED. A provider retries on any non-2xx, so an event we
 * recorded and could not apply must not be re-delivered forever — the row says
 * FAILED or UNRESOLVED and an operator can see it. An event that FAILS
 * VERIFICATION gets a 400 and leaves nothing behind at all.
 */

const log = createLogger({ context: { component: 'api.billing-webhook' } });

const providerParamSchema = z.object({ provider: z.string().min(1).max(64) });

export async function registerBillingWebhookRoutes(app: FastifyInstance): Promise<void> {
  /*
   * REGISTERED AS AN ENCAPSULATED PLUGIN, which is the whole point. The raw-body
   * parser below must apply to THIS route and to nothing else — installed on the
   * root instance it would replace JSON parsing for every route in the API, and
   * every other handler would start receiving a Buffer.
   */
  await app.register(async (scoped: FastifyInstance) => {
    // Keep the bytes, for every content type a provider might send.
    scoped.addContentTypeParser(
      ['application/json', 'application/x-www-form-urlencoded', 'text/plain'],
      { parseAs: 'buffer' },
      (_req, body, done) => {
        done(null, body);
      },
    );

    route(
      scoped,
      'POST',
      '/v1/billing/webhook/:provider',
      {
        scope: 'public',
        // A provider cannot present a session, so there is no permission to
        // declare. The signature is the credential — see the header.
        idempotent: true,
      },
      async (req: FastifyRequest, reply) => {
        const params = providerParamSchema.safeParse(req.params);
        if (!params.success) return reply.code(404).send();

        const adapter = providerFor(params.data.provider);
        if (!adapter) {
          // An unknown provider key is a 404, shaped like any other miss. It does
          // not say which providers exist.
          return reply.code(404).send();
        }

        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') headers[name.toLowerCase()] = value;
        }

        const [policy, catalogue] = await Promise.all([commercePolicy(), planCatalogue()]);

        const result = await reconciler().receive(
          /*
           * THE PLATFORM CLIENT, because the inbox is platform-owned, the
           * workspace is not known until it is resolved from a mapping we
           * wrote, and the reconciler must be able to OPEN the settlement
           * transaction.
           *
           * NO CAST. This argument used to be `getPlatformClient() as never`
           * against a parameter typed `TenantScopedClient` — a type whose whole
           * meaning is "you are already inside a transaction". The cast made
           * the mismatch compile, and the settlement autocommitted statement by
           * statement for as long as it survived. `receive` now names what it
           * actually needs (`ReconcilerClient`), so the types agree and the
           * next person to change this gets a compile error instead of silent
           * partial settlements.
           */
          getPlatformClient(),
          {
            providerKey: adapter.key,
            raw,
            headers,
            policy,
            plans: catalogue.plans,
            planVersionId: catalogue.versionId,
          },
        );

        if (!result.accepted) {
          // NOTHING WAS WRITTEN. The reason is a stable token — never the
          // signature, the secret or the body.
          log.warn('billing webhook refused', { provider: adapter.key, reason: result.reason });
          return reply.code(400).send({ error: { code: 'INVALID_SIGNATURE' } });
        }

        for (const event of result.results) {
          if (event.outcome === 'FAILED' || event.outcome === 'UNRESOLVED') {
            log.error('billing event not applied', {
              provider: adapter.key,
              outcome: event.outcome,
              type: event.type,
              reason: event.failureReason,
            });
          }
        }

        return reply.code(200).send({
          received: result.results.length,
          // The outcomes, so a provider's delivery log and ours can be compared.
          // No workspace id and no amount: this response goes to the provider.
          outcomes: result.results.map((event) => event.outcome),
        });
      },
    );
  });
}
