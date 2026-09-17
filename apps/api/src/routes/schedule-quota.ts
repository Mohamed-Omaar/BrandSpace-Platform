import { createScheduleQuota, type ScheduleQuotaAdapter } from '@brandspace/entitlements';
import type { TenantScopedClient } from '@brandspace/database';
import { currentEnvironment } from './phase7-context';

/**
 * The plan's monthly scheduling ceiling, for this app's routes.
 *
 * THE IMPLEMENTATION LIVES IN `@brandspace/entitlements` (P7-R6). It used to
 * live here, which is why the automation worker — outside this app — could not
 * reach it and wired a no-op instead. This is now the app's one-line binding of
 * the environment; everything else is the shared rule.
 */
export function scheduleQuota(db: TenantScopedClient, workspaceId: string): ScheduleQuotaAdapter {
  return createScheduleQuota({ db, workspaceId, environment: currentEnvironment() });
}
