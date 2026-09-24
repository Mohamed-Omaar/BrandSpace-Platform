import type { TenantScopedClient } from '@brandspace/database';
import { NotificationService } from '@brandspace/notifications';
import type { PublishNotifier } from '@brandspace/social-connectors';

/**
 * Who hears about a publish, and what they are told.
 *
 * ONE RECIPIENT: whoever scheduled the post. A broadcast to everyone holding
 * `publishing.read` would tell members who never asked, and — for a
 * brand-restricted member — about a brand they may not see. A notification
 * states that content exists, in that brand, and what became of it; that is a
 * disclosure, and the narrowest correct audience is the person waiting for the
 * answer.
 *
 * A NOTIFICATION IS A POINTER, NOT A COPY. It carries the platform, the account
 * name and a failure CLASS the reader's own dashboard translates into their own
 * language. It never carries the caption, the provider's sentence, or anything
 * derived from a token. Following the link runs the ordinary permission checks;
 * copying content in would route around them.
 *
 * IDEMPOTENT ON THE JOB. A retried delivery reuses the same key, so a duplicate
 * queue message cannot produce a second inbox entry for one outcome.
 */
export function publishNotifier(input: {
  db: TenantScopedClient;
  workspaceId: string;
  accountNameFor(jobId: string): Promise<{ accountName: string } | null>;
}): PublishNotifier {
  const notifications = new NotificationService({ db: input.db, workspaceId: input.workspaceId });

  return {
    async published(event) {
      if (!event.notifyUserId) return;
      const account = await input.accountNameFor(event.jobId);
      await notifications.create({
        userIds: [event.notifyUserId],
        templateKey: 'publishing.published',
        payload: {
          providerKey: event.provider,
          ...(account ? { accountName: account.accountName } : {}),
        },
        // D-277 §33/§40: to the Published tab, where the post and its link are.
        linkPath: '/publishing?tab=published',
        brandId: event.brandId,
        resourceType: 'PublishJob',
        resourceId: event.jobId,
        idempotencyKey: `publishing.published:${event.jobId}`,
      });
    },

    async failed(event) {
      if (!event.notifyUserId) return;
      const account = await input.accountNameFor(event.jobId);
      await notifications.create({
        userIds: [event.notifyUserId],
        // A BROKEN CONNECTION AND A REJECTED POST ARE DIFFERENT PROBLEMS with
        // different fixes, so they are different messages rather than one
        // message with a conditional sentence.
        templateKey: event.needsReconnect
          ? 'publishing.connection_needs_reauth'
          : 'publishing.failed',
        payload: {
          providerKey: event.provider,
          // THE CLASS, never the provider's own words.
          failureClass: event.failureClass,
          ...(account ? { accountName: account.accountName } : {}),
        },
        // D-277 §33/§40: to the Failed tab, where the reason, Reconnect and
        // Retry sit beside the post rather than on the connections page.
        linkPath: '/publishing?tab=failed',
        brandId: event.brandId,
        resourceType: 'PublishJob',
        resourceId: event.jobId,
        idempotencyKey: `publishing.failed:${event.jobId}:${event.failureClass}`,
      });
    },
  };
}
