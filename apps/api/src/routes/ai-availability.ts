import type { FastifyInstance } from 'fastify';
import { ConfigurationAiSource, aiAvailability } from '@brandspace/ai-gateway';
import { ConfigurationService } from '@brandspace/config';
import { getPlatformClient } from '@brandspace/database/platform';
import { integrationsInCategory } from '@brandspace/integrations';
import { route } from '../route-contract';
import { currentEnvironment, resolveCaller, workspaceFacts } from './phase7-context';

/**
 * PR F (b), Q9 — `GET /v1/ai/availability`: WHICH AI TASKS CAN RUN, FOR THE
 * CALLER'S OWN WORKSPACE, RIGHT NOW. Approved by the owner as the one
 * exception to Step 0 §b (no new API path), because the dashboard cannot read
 * AI configuration itself (F-07) and the answer must be read per request
 * (D-507).
 *
 * WHAT IT IS, AND IS NOT:
 *   - A signed-in session is required; the workspace is the session's own,
 *     never a parameter. Any member may ask (`workspace.read`, which every
 *     workspace role holds) — the answer decides what their screens show.
 *   - The answer is `{ tasks: { <taskKey>: true | false } }` and nothing else:
 *     no provider, model, key, route, price or error detail.
 *   - A development double never counts as available in production: no
 *     adapter is registered for it there, and its provider key is excluded by
 *     the registry's own `developmentOnly` flag besides.
 *   - Read per request from the ACTIVE configuration (a fresh source, no
 *     cross-request cache), so activating a provider and a route in the
 *     Control Center turns the controls on with no release.
 */

/** The adapters this process registers — the rule the gateways in `content.ts` and the other routes follow. */
export function registeredAdapters(production: boolean): ReadonlySet<string> {
  return new Set(production ? [] : ['mock']);
}

export const DEVELOPMENT_ONLY_AI: ReadonlySet<string> = new Set(
  integrationsInCategory('ai')
    .filter((definition) => definition.developmentOnly)
    .map((definition) => definition.providerKey),
);

export function registerAiAvailabilityRoutes(app: FastifyInstance): void {
  route(
    app,
    'GET',
    '/v1/ai/availability',
    { scope: 'workspace', permission: 'workspace.read' },
    async (req, reply) => {
      // Any member: `workspace.read` is the key every workspace role holds.
      const caller = await resolveCaller(req, reply, 'workspace.read');
      if (!caller) return reply;

      const environment = currentEnvironment();
      const production = environment === 'PRODUCTION';
      const [configuration, facts] = await Promise.all([
        // No cache: an activation in the Control Center is the next answer.
        new ConfigurationAiSource(
          new ConfigurationService({ prisma: getPlatformClient(), cacheTtlMs: 0 }),
          environment,
        ).load(),
        workspaceFacts(caller.workspaceId),
      ]);
      const tasks = aiAvailability(
        { workspaceId: caller.workspaceId, planKey: facts.planKey },
        configuration,
        {
          registered: registeredAdapters(production),
          production,
          developmentOnly: DEVELOPMENT_ONLY_AI,
        },
      );
      return reply.header('cache-control', 'private, no-store').send({ tasks });
    },
  );
}
