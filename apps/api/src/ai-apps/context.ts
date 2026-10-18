import { ConfigurationService, type ConfigPayload, type Environment } from '@brandspace/config';
import { getPrisma, type PrismaClient, type TenantScopedClient } from '@brandspace/database';
import { getPlatformClient } from '@brandspace/database/platform';
import {
  AI_APPS_FEATURE,
  EntitlementService,
  TenantCatalogueSource,
} from '@brandspace/entitlements';
import { currentEnvironment, systemClock, type Clock } from '@brandspace/shared';
import { addressesFrom, type AiAppsAddresses } from './oauth-core';

/**
 * D-566 — WHAT THE CONNECTED-AI-APPS SURFACE RUNS ON.
 *
 * The tenant pool for everything a person's grant touches (RLS applies to every
 * tool call), the platform pool for the two things no workspace owns — the app
 * registry (RFC 7591 writes it) and the `ai-apps` configuration — and the clock.
 * One object, so the isolation suite can hand in a clock and an uncached
 * configuration reader without a second code path.
 */
export interface AiAppsContext {
  readonly tenant: PrismaClient;
  readonly platform: PrismaClient;
  readonly configuration: ConfigurationService;
  readonly environment: Environment;
  readonly clock: Clock;
  readonly addresses: () => AiAppsAddresses | null;
}

let current: AiAppsContext | null = null;

export function aiAppsContext(): AiAppsContext {
  if (!current) {
    const platform = getPlatformClient();
    current = {
      tenant: getPrisma(),
      platform,
      configuration: new ConfigurationService({ prisma: platform }),
      environment: currentEnvironment(),
      clock: systemClock,
      addresses: () => addressesFrom(),
    };
  }
  return current;
}

/** Test seam: replace parts of the context (a fixed clock, an uncached reader). */
export function setAiAppsContextForTests(overrides: Partial<AiAppsContext> | null): void {
  current = overrides === null ? null : { ...aiAppsContext(), ...overrides };
}

export type AiAppsSettings = ConfigPayload<'ai-apps'>;

export async function aiAppsSettings(
  ctx: AiAppsContext = aiAppsContext(),
): Promise<AiAppsSettings> {
  return ctx.configuration.get('ai-apps', ctx.environment);
}

/**
 * Why a workspace may not use AI apps right now, or null when it may.
 *
 *   - `off`  — the whole feature is switched off (`ai-apps.enabled`);
 *   - `plan` — the workspace's plan does not include `feature.ai_apps`, or its
 *              kill switch is on (the entitlement engine decides both, kill
 *              switch first).
 *
 * Read inside the caller's workspace transaction, from the tenant-side
 * catalogue projection — the same source the dashboard and the Copilot use.
 */
export async function aiAppsRefusal(
  db: TenantScopedClient,
  workspaceId: string,
  settings: AiAppsSettings,
  ctx: AiAppsContext = aiAppsContext(),
): Promise<'off' | 'plan' | null> {
  if (!settings.enabled) return 'off';
  const entitlements = new EntitlementService({
    prisma: db as never,
    catalogueSource: new TenantCatalogueSource(db as never, ctx.environment),
    environment: ctx.environment,
  });
  return (await entitlements.can(workspaceId, AI_APPS_FEATURE)) ? null : 'plan';
}
