import type { TenantScopedClient } from '@brandspace/database';
import { NotificationService } from './service';

/**
 * CONNECTORS A (R3) — "THIS ACCOUNT NEEDS RECONNECTING", said at the moment it
 * happens rather than when a post finally fails.
 *
 * ONE IMPLEMENTATION for every surface that can turn a connection NEEDS_REAUTH
 * — the worker (a publish the platform refused for the account) and the API
 * (a refresh the platform refused, a failed health check) — so the two cannot
 * word it differently or address it to different people. It uses the existing
 * `publishing.connection_needs_reauth` template; nothing new is sent.
 *
 * TO WHOEVER CONNECTED THE ACCOUNT, the person who can reconnect it, scoped to
 * the account's brand. A POINTER, NOT A COPY: the platform, the account's
 * display name and a failure CLASS the reader's own dashboard translates —
 * never the platform's words, never anything derived from a token.
 *
 * ONCE PER TRANSITION: the key carries the instant the account turned, so a
 * retried delivery is the same notice and a later transition is a new one.
 */
export function connectionReauthNotifier(input: {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
}): {
  connectionNeedsReauth(event: {
    readonly connectionId: string;
    readonly brandId: string;
    readonly provider: string;
    readonly accountName: string;
    readonly notifyUserId: string | null;
    readonly failureClass: string;
    readonly at: Date;
  }): Promise<void>;
} {
  const notifications = new NotificationService({ db: input.db, workspaceId: input.workspaceId });
  return {
    async connectionNeedsReauth(event) {
      if (!event.notifyUserId) return;
      await notifications.create({
        userIds: [event.notifyUserId],
        templateKey: 'publishing.connection_needs_reauth',
        payload: {
          providerKey: event.provider,
          failureClass: event.failureClass,
          accountName: event.accountName,
        },
        linkPath: '/publishing?tab=accounts',
        brandId: event.brandId,
        resourceType: 'SocialConnection',
        resourceId: event.connectionId,
        idempotencyKey: `publishing.connection_needs_reauth:${event.connectionId}:${event.at.getTime()}`,
      });
    },
  };
}
