import 'server-only';
import { cache } from 'react';
import { TenantPublishingPolicySource } from '@brandspace/social-connectors';
import { getPrisma, withoutTenantContext } from '@brandspace/database';
import { currentEnvironment } from './customer-context';

/**
 * PR F (b), Q8 — THE CHANNELS AN ACCOUNT CAN BE CONNECTED FOR AT ALL: the
 * platforms the activated publishing policy has switched on
 * (`publishing.providers.<key>.enabled`), the same keys a post's channels use.
 * The same for every workspace, read per request (deduplicated in one render).
 *
 * While none of a post's channels is among them, nothing offers to schedule or
 * publish it — Schedule, Publish now, "Approve & schedule", "Approve & publish"
 * — and the server refuses the same (`CHANNELS_NOT_CONNECTABLE`). A proposed
 * time is kept, the calendar still shows the post, and Approve stays.
 */
export const connectableChannels = cache(async (): Promise<readonly string[]> => {
  const policy = await withoutTenantContext(
    async (db) => new TenantPublishingPolicySource(db as never, currentEnvironment()).load(),
    { prisma: getPrisma() },
  );
  const providers = policy.providers as unknown as Record<
    string,
    { enabled?: boolean } | undefined
  >;
  return Object.keys(providers).filter((key) => providers[key]?.enabled === true);
});

/** Whether a post on these channels can go out at all. */
export function canGoOut(platformKeys: readonly string[], connectable: readonly string[]): boolean {
  return platformKeys.some((key) => connectable.includes(key));
}
