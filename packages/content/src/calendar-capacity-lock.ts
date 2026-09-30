import { createHash } from 'node:crypto';
import type { TenantScopedClient } from '@brandspace/database';

/**
 * PHASE 2B-3 PR 2 (owner decision D7) — ONE WORKSPACE'S CALENDAR CAPACITY IS
 * DECIDED BY ONE AUTOMATION AT A TIME.
 *
 * "Schedule in the next free slot" reads which days are free and then takes
 * one. Two runs doing that at once would both see the same day free and both
 * take it — two posts on a brand's "free" day, or a day past the workspace's
 * per-day cap. So the search and the scheduling happen under a
 * TRANSACTION-SCOPED PostgreSQL ADVISORY LOCK keyed by the workspace:
 *
 *   - no table, no column, no schema change; nothing in memory, nothing in
 *     Redis — the lock lives exactly as long as the tenant transaction that
 *     took it, and a crashed worker releases it by ending its transaction;
 *   - keyed at WORKSPACE level because the per-day cap is workspace-wide;
 *   - NOT a `FOR UPDATE` on the workspace row: the automation engine already
 *     holds `FOR SHARE` on that row for its pending-deletion check, and two
 *     runs upgrading the same row's lock would deadlock each other.
 *
 * THE KEY. `pg_advisory_xact_lock(bigint)` takes one signed 64-bit key. It is
 * the first eight bytes of SHA-256 over a fixed namespace and the workspace
 * id, read big-endian as a signed 64-bit integer:
 *
 *     key = int64_be(sha256("brandspace:calendar-capacity:v1:" + workspaceId)[0..8])
 *
 * Deterministic (the same workspace always gets the same key), namespaced (no
 * other advisory lock in the product can share it by accident), and changing
 * the namespace's version is how it would ever be changed. A collision
 * between two workspaces' keys only makes them wait for each other; it never
 * lets two runs of one workspace in together.
 */
const NAMESPACE = 'brandspace:calendar-capacity:v1:';

export function calendarCapacityLockKey(workspaceId: string): bigint {
  const digest = createHash('sha256').update(`${NAMESPACE}${workspaceId}`).digest();
  return digest.readBigInt64BE(0);
}

/**
 * Wait for, then hold until the end of the caller's transaction, the
 * workspace's calendar-capacity lock. Re-entrant within one transaction.
 */
export async function lockCalendarCapacity(
  db: TenantScopedClient,
  workspaceId: string,
): Promise<void> {
  const key = calendarCapacityLockKey(workspaceId);
  await db.$executeRaw`SELECT pg_advisory_xact_lock(${key}::bigint)`;
}
