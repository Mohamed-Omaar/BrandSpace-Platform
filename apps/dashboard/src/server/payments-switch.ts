import 'server-only';
import { cache } from 'react';
import { paymentsEnabled, TenantCommercePolicySource } from '@brandspace/billing';
import { getPrisma, withoutTenantContext } from '@brandspace/database';
import { currentEnvironment } from './customer-context';

/**
 * PR F (a), Q6 — whether payments are switched on (`commerce.payments.enabled`).
 *
 * Read from the activated catalogue on every request (deduplicated within one
 * render), with no workspace in hand: the switch is the same for everyone, and
 * the proxy routes ask it before any session is read. While it is off, every
 * payment surface is left out and every payment route answers the same bare
 * 404 an unknown path does.
 */
export const paymentsSwitchedOn = cache(async (): Promise<boolean> => {
  const policy = await withoutTenantContext(
    async (db) => new TenantCommercePolicySource(db, currentEnvironment()).load(),
    { prisma: getPrisma() },
  );
  return paymentsEnabled(policy);
});
