import {
  writeAuditEvent,
  type PublishFailureClass,
  type SocialProvider,
  type TenantScopedClient,
} from '@brandspace/database';

/**
 * CONNECTORS A (R3) — THE MOMENT AN ACCOUNT NEEDS RECONNECTING, SOMEONE IS TOLD.
 *
 * Until now the customer learned it only when a post finally failed — up to the
 * lateness deadline later, with the post already late — or from the Home card
 * if they happened to look. Every path that turns a connection NEEDS_REAUTH
 * goes through `markNeedsReauth`: a publish the platform refused for the
 * account (the worker), a refresh the platform refused (the API's sweep), a
 * health check that failed. The notice goes out ONCE, on the transition from
 * ACTIVE, not on every later failure of an account already waiting.
 *
 * A PORT, as the publish notifier is: `@brandspace/notifications` is not on
 * this package's import list, and WHO may be told is decided where the other
 * authorization lives.
 */
export interface ReauthNotifier {
  connectionNeedsReauth(input: {
    readonly connectionId: string;
    readonly brandId: string;
    readonly provider: SocialProvider;
    readonly accountName: string;
    /** Whoever connected the account — the person who can reconnect it. */
    readonly notifyUserId: string | null;
    readonly failureClass: PublishFailureClass;
    /** The instant of the transition: one notice per transition. */
    readonly at: Date;
  }): Promise<void>;
}

/**
 * Mark a connection NEEDS_REAUTH, and tell its owner if it just became so.
 * Returns whether this call made the transition.
 *
 * THE STATE IT LEAVES IS EXACTLY WHAT EACH CALLER WROTE BEFORE: status
 * NEEDS_REAUTH, the class, the check time, one more consecutive failure. The
 * conditional first write only decides whether this is the transition.
 */
export async function markNeedsReauth(input: {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly failureClass: PublishFailureClass;
  readonly now: Date;
  readonly notifier?: ReauthNotifier | undefined;
}): Promise<boolean> {
  const data = {
    status: 'NEEDS_REAUTH' as const,
    lastFailureClass: input.failureClass,
    lastCheckedAt: input.now,
    consecutiveFailureCount: { increment: 1 },
  };
  const turned = await input.db.socialConnection.updateMany({
    where: { id: input.connectionId, workspaceId: input.workspaceId, status: 'ACTIVE' },
    data,
  });
  if (turned.count === 0) {
    await input.db.socialConnection.updateMany({
      where: { id: input.connectionId, workspaceId: input.workspaceId },
      data,
    });
    return false;
  }

  const connection = await input.db.socialConnection.findFirst({
    where: { id: input.connectionId, workspaceId: input.workspaceId },
    select: { brandId: true, provider: true, displayName: true, connectedByUserId: true },
  });
  if (!connection) return true;
  await writeAuditEvent(input.db, input.workspaceId, {
    action: 'social.connection.needs_reauth',
    actorType: 'SYSTEM',
    resourceType: 'SocialConnection',
    resourceId: input.connectionId,
    brandId: connection.brandId,
    before: { status: 'ACTIVE' },
    // The CLASS only: never the platform's words, never a token.
    after: { status: 'NEEDS_REAUTH', failureClass: input.failureClass },
  });
  await input.notifier?.connectionNeedsReauth({
    connectionId: input.connectionId,
    brandId: connection.brandId,
    provider: connection.provider,
    accountName: connection.displayName,
    notifyUserId: connection.connectedByUserId,
    failureClass: input.failureClass,
    at: input.now,
  });
  return true;
}
