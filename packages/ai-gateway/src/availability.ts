import type { AiConfiguration } from './gateway';
import { AI_TASKS, type AiTaskKey } from './tasks';
import { RoutingError, resolveRoute } from './routing';

/**
 * PR F (b), Q9 — IS AI AVAILABLE FOR THIS TASK, FOR THIS WORKSPACE, RIGHT NOW?
 *
 * The same answer the gateway would reach if asked to run the task, without
 * running it: a routing rule resolves for the task (workspace, plan and global
 * rules, then the capability route), and at least one model in its chain
 * belongs to a provider that is ACTIVE in `ai.providers` and has an adapter
 * registered in this process.
 *
 * A DEVELOPMENT DOUBLE NEVER COUNTS IN PRODUCTION. The caller passes the
 * adapters it actually registered; production registers none for the mock
 * (and `MockProviderAdapter` refuses to be built there), and `production`
 * drops any development-only provider key besides, so the answer cannot be
 * "yes" because a stand-in would have replied.
 *
 * Read per request from the active configuration: activating a provider and a
 * route in the Control Center makes it true on the next request, with no
 * release. Pure, so every branch is unit-tested.
 */
export function aiAvailableFor(
  taskKey: string,
  query: { readonly workspaceId: string; readonly planKey: string | null },
  configuration: Pick<
    AiConfiguration,
    'providers' | 'models' | 'routingRules' | 'capabilityRouting'
  >,
  adapters: {
    readonly registered: ReadonlySet<string>;
    readonly production: boolean;
    /** Adapter keys that are development doubles (the registry's `developmentOnly`). */
    readonly developmentOnly: ReadonlySet<string>;
  },
): boolean {
  let chain: readonly string[];
  try {
    chain = resolveRoute(
      { taskKey, workspaceId: query.workspaceId, planKey: query.planKey },
      configuration.routingRules,
      configuration.models,
      ...(configuration.capabilityRouting ? [configuration.capabilityRouting] : []),
    ).chain;
  } catch (error) {
    if (error instanceof RoutingError) return false;
    throw error;
  }
  return chain.some((modelKey) => {
    const model = configuration.models.find((candidate) => candidate.key === modelKey);
    if (!model) return false;
    const provider = configuration.providers.find(
      (candidate) => candidate.key === model.providerKey,
    );
    if (!provider || provider.status !== 'active') return false;
    // D-573 — judged by the ADAPTER the record names, which is what the
    // gateway will call; a provider record keyed differently is the same
    // adapter, and a development double is one wherever it is named.
    const adapterKey = provider.adapterKey ?? provider.key;
    if (adapters.production && adapters.developmentOnly.has(adapterKey)) return false;
    if (adapters.production && adapters.developmentOnly.has(model.providerKey)) return false;
    return adapters.registered.has(adapterKey);
  });
}

/** Every task's answer, keyed by task — the only shape a customer surface ever sees. */
export function aiAvailability(
  query: Parameters<typeof aiAvailableFor>[1],
  configuration: Parameters<typeof aiAvailableFor>[2],
  adapters: Parameters<typeof aiAvailableFor>[3],
): Record<AiTaskKey, boolean> {
  return Object.fromEntries(
    AI_TASKS.map((task) => [task.key, aiAvailableFor(task.key, query, configuration, adapters)]),
  ) as Record<AiTaskKey, boolean>;
}
