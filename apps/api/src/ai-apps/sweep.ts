import type { ConfigurationService, Environment } from '@brandspace/config';
import type { PrismaClient } from '@brandspace/database';

/**
 * D-566 — THE CONNECTED-AI-APPS PART OF THE MAINTENANCE SWEEP.
 *
 * Cross-tenant by nature (it asks "which rows anywhere are past their time?"),
 * so it runs on the platform pool like every other purge in the scheduler. It
 * deletes only what has no further use:
 *
 *   - authorization codes an hour past their expiry (used or not);
 *   - tokens a day past their expiry — a REVOKED token is kept until then,
 *     because presenting a rotated refresh token again must still be
 *     recognised as reuse and revoke the connection;
 *   - rate-limit windows older than a day;
 *   - registered apps that never got a connection, once they are older than
 *     `ai-apps.oauth.unusedClientRetentionDays` (30 by default; owner
 *     addition to the approved plan). Audited as a COUNT only: the names of
 *     apps nobody connected are nobody's business.
 *
 * Connections themselves, active or revoked, are never purged here: they are
 * the customer's record of who could act for them.
 */
export async function purgeAiApps(options: {
  readonly platform: PrismaClient;
  readonly configuration: ConfigurationService;
  readonly environment: Environment;
  readonly now: Date;
  readonly batch: number;
}): Promise<{ codes: number; tokens: number; windows: number; clients: number }> {
  const { platform, now, batch } = options;
  const hour = 3_600_000;
  const day = 24 * hour;
  const settings = await options.configuration.get('ai-apps', options.environment);

  const deleteIn = async <T extends { id: string }>(
    find: () => Promise<T[]>,
    remove: (ids: string[]) => Promise<{ count: number }>,
  ): Promise<number> => {
    const rows = await find();
    return rows.length === 0 ? 0 : (await remove(rows.map((row) => row.id))).count;
  };

  const codes = await deleteIn(
    () =>
      platform.aiAppAuthorizationCode.findMany({
        where: { expiresAt: { lt: new Date(now.getTime() - hour) } },
        select: { id: true },
        take: batch,
      }),
    (ids) => platform.aiAppAuthorizationCode.deleteMany({ where: { id: { in: ids } } }),
  );
  const tokens = await deleteIn(
    () =>
      platform.aiAppToken.findMany({
        where: { expiresAt: { lt: new Date(now.getTime() - day) } },
        select: { id: true },
        take: batch,
      }),
    (ids) => platform.aiAppToken.deleteMany({ where: { id: { in: ids } } }),
  );
  const windows = (
    await platform.aiAppRateWindow.deleteMany({
      where: { windowStart: { lt: new Date(now.getTime() - day) } },
    })
  ).count;

  const cutoff = new Date(now.getTime() - settings.oauth.unusedClientRetentionDays * day);
  const clients = await deleteIn(
    () =>
      platform.aiAppClient.findMany({
        where: { createdAt: { lt: cutoff }, connections: { none: {} } },
        select: { id: true },
        take: batch,
      }),
    // Re-asserted at delete time: an app that got its first connection in
    // between is kept (and the foreign key would refuse it anyway).
    (ids) =>
      platform.aiAppClient.deleteMany({
        where: { id: { in: ids }, createdAt: { lt: cutoff }, connections: { none: {} } },
      }),
  );
  if (clients > 0) {
    await platform.auditEvent.create({
      data: {
        workspaceId: null,
        actorType: 'SYSTEM',
        action: 'ai_app.client.purged',
        resourceType: 'ai_app_client',
        reason: 'Registered AI apps that never got a connection, past the retention window.',
        after: { count: clients, olderThanDays: settings.oauth.unusedClientRetentionDays },
      },
    });
  }
  return { codes, tokens, windows, clients };
}
