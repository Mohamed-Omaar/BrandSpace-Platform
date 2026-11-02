import 'server-only';
import { CONFIG_DOMAINS } from '@brandspace/config';
import { currentEnvironment, inWorkspace } from './customer-context';

/**
 * PR B (D-591) — HOW LONG THE COPILOT CONVERSATION IS KEPT, for the line under
 * its composer ("Kept for 90 days, then its content is cleared"). Read from
 * the tenant-readable catalogue projection of the `copilot` domain — the same
 * row `TenantCopilotPolicySource` reads in the API — through the domain's own
 * schema, so its default applies when nothing is configured. Null when it
 * cannot be read: the line is then not drawn, never guessed.
 */
export async function copilotRetentionDays(workspaceId: string): Promise<number | null> {
  try {
    return await inWorkspace(workspaceId, async ({ db }) => {
      const row = await db.entitlementCatalogueSnapshot.findUnique({
        where: { domain_environment: { domain: 'copilot', environment: currentEnvironment() } },
        select: { payload: true },
      });
      const parsed = CONFIG_DOMAINS.copilot.schema.safeParse(row?.payload ?? {});
      return parsed.success
        ? (parsed.data as { conversation: { retentionDays: number } }).conversation.retentionDays
        : null;
    });
  } catch {
    return null;
  }
}
